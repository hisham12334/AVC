import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { assertBranchAccess } from '../jobs/lifecycle.js';
import { authenticateCustomer } from '../portal/tokens.js';
import { hashToken } from '../track/tokens.js';

const MAX_BYTES = 25 * 1024 * 1024;
const idSchema = z.object({ id: z.uuid() });
const uploadQuery = z.object({
  kind: z.enum(['photo', 'video', 'signature']).default('photo'),
  caption: z.string().trim().max(300).default(''),
});

type Sniffed = { ext: string; mime: string; family: 'image' | 'video' };

// Trust the bytes, not the label the browser sent. Only formats the app can display are accepted.
function sniff(buf: Buffer): Sniffed | null {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
    return { ext: 'jpg', mime: 'image/jpeg', family: 'image' };
  if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
    return { ext: 'png', mime: 'image/png', family: 'image' };
  if (
    buf.length > 12 &&
    buf.subarray(0, 4).toString() === 'RIFF' &&
    buf.subarray(8, 12).toString() === 'WEBP'
  )
    return { ext: 'webp', mime: 'image/webp', family: 'image' };
  if (buf.length > 12 && buf.subarray(4, 8).toString() === 'ftyp')
    return { ext: 'mp4', mime: 'video/mp4', family: 'video' };
  return null;
}
const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  mp4: 'video/mp4',
};

type EvidenceRow = {
  id: string;
  jobId: string;
  storageKey: string;
  branchId: string;
  customerId: string;
  released: boolean;
};

// Files are kept on local disk behind this small interface so object storage can replace it later.
export function registerEvidenceFiles(app: FastifyInstance, db: Pool, uploadDir: string): void {
  const root = resolve(uploadDir);

  app.addContentTypeParser(
    ['image/jpeg', 'image/png', 'image/webp', 'video/mp4'],
    { parseAs: 'buffer', bodyLimit: MAX_BYTES },
    (_request, body, done) => done(null, body),
  );

  app.post(
    '/api/jobs/:id/evidence/upload',
    { preHandler: app.requirePermission('evidence:create'), bodyLimit: MAX_BYTES },
    async (request, reply) => {
      const { id } = idSchema.parse(request.params);
      const query = uploadQuery.parse(request.query);
      const body = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0)
        throw new AppError(400, 'FILE_REQUIRED', 'Send the photo or video as the request body');
      const found = sniff(body);
      if (
        !found ||
        (query.kind !== 'video' && found.family === 'video') ||
        (query.kind === 'video' && found.family !== 'video')
      )
        throw new AppError(
          415,
          'FILE_TYPE_UNSUPPORTED',
          'Use a JPEG, PNG or WebP photo, or an MP4 video',
        );
      const job = await db.query<{ branchId: string }>(
        'SELECT branch_id AS "branchId" FROM avc.job_cards WHERE id = $1',
        [id],
      );
      if (!job.rows[0]) throw new AppError(404, 'JOB_NOT_FOUND', 'Job card was not found');
      assertBranchAccess(request.staff!, job.rows[0].branchId);

      const key = `${id}/${randomUUID()}.${found.ext}`;
      const path = join(root, key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body, { flag: 'wx' });
      const created = await db.query(
        `INSERT INTO avc.evidence(job_card_id, kind, storage_key, content_sha256, caption, captured_by_staff_id)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, kind, caption, captured_at AS "capturedAt"`,
        [
          id,
          query.kind,
          key,
          createHash('sha256').update(body).digest('hex'),
          query.caption,
          request.staff!.id,
        ],
      );
      return reply.status(201).send({ evidence: created.rows[0] });
    },
  );

  async function load(evidenceId: string): Promise<EvidenceRow> {
    const result = await db.query<EvidenceRow>(
      `SELECT e.id, e.job_card_id AS "jobId", e.storage_key AS "storageKey", j.branch_id AS "branchId",
              j.customer_id AS "customerId",
              (e.quote_item_id IS NOT NULL OR e.transfer_id IS NOT NULL) AS released
       FROM avc.evidence e JOIN avc.job_cards j ON j.id = e.job_card_id WHERE e.id = $1`,
      [evidenceId],
    );
    if (!result.rows[0]) throw new AppError(404, 'EVIDENCE_NOT_FOUND', 'File was not found');
    return result.rows[0];
  }

  function send(reply: import('fastify').FastifyReply, row: EvidenceRow) {
    const path = resolve(root, row.storageKey);
    // Stored keys are generated here, but never serve anything outside the upload folder.
    if (!path.startsWith(root + sep) || !existsSync(path))
      throw new AppError(404, 'EVIDENCE_NOT_FOUND', 'File was not found');
    const ext = path.split('.').pop() ?? '';
    return reply
      .header('content-type', MIME_BY_EXT[ext] ?? 'application/octet-stream')
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, max-age=300')
      .send(createReadStream(path));
  }

  app.get(
    '/api/evidence/:id/file',
    { preHandler: app.requirePermission('evidence:read') },
    async (request, reply) => {
      const { id } = idSchema.parse(request.params);
      const row = await load(id);
      assertBranchAccess(request.staff!, row.branchId);
      return send(reply, row);
    },
  );

  // Customers only receive evidence the advisor has released with a quote, and handover photos.
  app.get('/api/portal/evidence/:id/file', async (request, reply) => {
    const principal = await authenticateCustomer(db, request);
    const { id } = idSchema.parse(request.params);
    const row = await load(id);
    if (row.customerId !== principal.customerId || !row.released)
      throw new AppError(404, 'EVIDENCE_NOT_FOUND', 'File was not found');
    return send(reply, row);
  });

  app.get('/api/track/:token/evidence/:id/file', async (request, reply) => {
    const { token } = z.object({ token: z.string().min(20).max(100) }).parse(request.params);
    const { id } = idSchema.parse(request.params);
    const link = await db.query<{ jobId: string }>(
      `SELECT job_card_id AS "jobId" FROM avc.customer_access_links
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [hashToken(token)],
    );
    const row = await load(id);
    if (!link.rows[0] || row.jobId !== link.rows[0].jobId || !row.released)
      throw new AppError(404, 'EVIDENCE_NOT_FOUND', 'File was not found');
    return send(reply, row);
  });
}
