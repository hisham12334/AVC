import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { buildBill } from '../bills/bill.js';
import { inTransaction } from '../db.js';
import { AppError } from '../errors.js';
import { emit } from '../integration/outbox.js';
import {
  assertBranchAccess,
  assertExpectedVersion,
  lockJob,
  recordEvent,
} from '../jobs/lifecycle.js';
import { issueCustomerLink } from '../track/tokens.js';
import { loadQuotes } from './queries.js';

const idSchema = z.object({ id: z.uuid() });
const money = z
  .number()
  .min(0)
  .max(10_000_000)
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'Price allows at most 2 decimals');
const itemSchema = z
  .object({
    // A line that answers a technician finding. Its severity and proof come from the finding.
    findingId: z.uuid().optional(),
    title: z.string().trim().min(1).max(200),
    detail: z.string().trim().max(2000).default(''),
    // Only for lines the advisor adds themselves (services, packages): always minor.
    severity: z.enum(['minor']).optional(),
    priceAed: money,
    evidenceIds: z.array(z.uuid()).max(20).default([]),
  })
  .strict();
const quoteSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    items: z.array(itemSchema).min(1).max(50),
  })
  .strict();
const evidenceSchema = z
  .object({
    kind: z.enum(['photo', 'video', 'signature', 'document']),
    storageKey: z.string().trim().min(1).max(500),
    contentSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    caption: z.string().trim().max(300).default(''),
  })
  .strict();
const linkSchema = z.object({ expectedVersion: z.number().int().min(1) }).strict();

export function registerQuoteRoutes(app: FastifyInstance, db: Pool): void {
  app.post(
    '/api/jobs/:id/evidence',
    { preHandler: app.requirePermission('evidence:create') },
    async (request, reply) => {
      const { id } = idSchema.parse(request.params);
      const input = evidenceSchema.parse(request.body);
      const job = await db.query<{ branchId: string }>(
        'SELECT branch_id AS "branchId" FROM avc.job_cards WHERE id = $1',
        [id],
      );
      if (!job.rows[0]) throw new AppError(404, 'JOB_NOT_FOUND', 'Job card was not found');
      assertBranchAccess(request.staff!, job.rows[0].branchId);
      const created = await db.query(
        `INSERT INTO avc.evidence(job_card_id, kind, storage_key, content_sha256, caption, captured_by_staff_id)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, kind, storage_key AS "storageKey", content_sha256 AS "contentSha256", caption,
                   captured_at AS "capturedAt"`,
        [
          id,
          input.kind,
          input.storageKey,
          input.contentSha256 ?? null,
          input.caption,
          request.staff!.id,
        ],
      );
      return reply.status(201).send({ evidence: created.rows[0] });
    },
  );

  // The advisor prices what the technician found and posts it. Only then does the customer see the
  // findings and the prices. The same call prices a mid-repair finding (job past `approved`).
  app.post(
    '/api/jobs/:id/quotes',
    { preHandler: app.requirePermission('quotes:publish') },
    async (request, reply) => {
      const { id } = idSchema.parse(request.params);
      const input = quoteSchema.parse(request.body);
      const result = await inTransaction(db, async (client) => {
        const job = await lockJob(client, id);
        assertBranchAccess(request.staff!, job.branchId);
        assertExpectedVersion(job, input.expectedVersion);
        const kind: 'initial' | 'addendum' | null =
          job.stage === 'pricing'
            ? 'initial'
            : ['approved', 'in_bay', 'qc'].includes(job.stage)
              ? 'addendum'
              : null;
        if (!kind)
          throw new AppError(
            422,
            'INVALID_TRANSITION',
            'A quote can only be posted after the technician submits findings',
          );
        const batch = await client.query<{ id: string }>(
          `SELECT id FROM avc.finding_batches
           WHERE job_card_id = $1 AND kind = $2 AND status = 'awaiting_pricing'`,
          [id, kind],
        );
        if (!batch.rows[0])
          throw new AppError(409, 'NOTHING_TO_PRICE', 'There are no findings waiting to be priced');
        const batchId = batch.rows[0].id;
        const findings = await client.query<{ id: string; title: string; severity: string }>(
          'SELECT id, title, severity FROM avc.findings WHERE batch_id = $1',
          [batchId],
        );
        const byId = new Map(findings.rows.map((f) => [f.id, f]));
        const priced = new Set<string>();
        for (const item of input.items) {
          if (!item.findingId) continue;
          if (!byId.has(item.findingId))
            throw new AppError(
              422,
              'FINDING_UNKNOWN',
              'A line refers to a finding from another job',
            );
          if (priced.has(item.findingId))
            throw new AppError(422, 'FINDING_DUPLICATED', 'A finding can only be priced once');
          priced.add(item.findingId);
        }
        // The advisor can reword and price, but cannot drop a technician finding silently.
        const missing = findings.rows.filter((f) => !priced.has(f.id));
        if (missing.length)
          throw new AppError(
            422,
            'FINDING_UNPRICED',
            `Every finding needs a price. Missing: ${missing.map((f) => f.title).join(', ')}`,
          );

        const next = await client.query<{ version: number }>(
          'SELECT COALESCE(MAX(version), 0) + 1 AS version FROM avc.quotes WHERE job_card_id = $1',
          [id],
        );
        const version = next.rows[0]!.version;
        const quote = await client.query<{ id: string }>(
          `INSERT INTO avc.quotes(job_card_id, version, kind, status, sent_by_staff_id, batch_id)
           VALUES ($1,$2,$3,'sent',$4,$5) RETURNING id`,
          [id, version, kind, request.staff!.id, batchId],
        );
        const quoteId = quote.rows[0]!.id;
        let totalCents = 0;
        for (const [index, item] of input.items.entries()) {
          const finding = item.findingId ? byId.get(item.findingId) : undefined;
          const row = await client.query<{ id: string }>(
            `INSERT INTO avc.quote_items(quote_id, position, title, detail, severity, price_aed, finding_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
            [
              quoteId,
              index + 1,
              item.title,
              item.detail,
              finding?.severity ?? 'minor',
              item.priceAed,
              finding?.id ?? null,
            ],
          );
          totalCents += Math.round(item.priceAed * 100);
          const itemId = row.rows[0]!.id;
          if (finding) {
            await client.query(
              'UPDATE avc.evidence SET quote_item_id = $1 WHERE finding_id = $2 AND quote_item_id IS NULL',
              [itemId, finding.id],
            );
          } else if (item.evidenceIds.length) {
            const linked = await client.query(
              `UPDATE avc.evidence SET quote_item_id = $1
               WHERE id = ANY($2::uuid[]) AND job_card_id = $3 AND quote_item_id IS NULL
                 AND finding_id IS NULL AND transfer_id IS NULL`,
              [itemId, item.evidenceIds, id],
            );
            if (linked.rowCount !== item.evidenceIds.length)
              throw new AppError(
                422,
                'EVIDENCE_INVALID',
                'Evidence must belong to this job and be unused',
              );
          }
        }
        await client.query(
          "UPDATE avc.finding_batches SET status = 'priced', priced_at = now() WHERE id = $1",
          [batchId],
        );
        const link =
          kind === 'initial' ? await issueCustomerLink(client, id, request.staff!.id) : null;
        const advanced = await recordEvent(client, job, {
          type: 'quote_sent',
          actor: { type: 'staff', staffId: request.staff!.id },
          toStage: kind === 'initial' ? 'quote' : undefined,
          details: { quoteId, quoteVersion: version, kind },
        });
        await emit(client, {
          branchId: job.branchId,
          type: 'quote.sent',
          aggregateType: 'quote',
          aggregateId: quoteId,
          payload: {
            jobId: id,
            jobNumber: job.jobNumber,
            quoteId,
            version,
            kind,
            itemCount: input.items.length,
            totalAed: totalCents / 100,
          },
        });
        if (kind === 'initial')
          await emit(client, {
            branchId: job.branchId,
            type: 'job.stage_changed',
            aggregateType: 'job',
            aggregateId: id,
            payload: { jobId: id, jobNumber: job.jobNumber, from: 'pricing', to: 'quote' },
          });
        return { quoteId, version, kind, link, jobVersion: advanced.version };
      });
      return reply.status(201).send({
        quote: { id: result.quoteId, version: result.version, kind: result.kind },
        jobVersion: result.jobVersion,
        customerLink: result.link
          ? { token: result.link.token, path: result.link.path, expiresAt: result.link.expiresAt }
          : null,
      });
    },
  );

  app.get(
    '/api/jobs/:id/quotes',
    { preHandler: app.requirePermission('quotes:read') },
    async (request) => {
      const { id } = idSchema.parse(request.params);
      const job = await db.query<{ branchId: string }>(
        'SELECT branch_id AS "branchId" FROM avc.job_cards WHERE id = $1',
        [id],
      );
      if (!job.rows[0]) throw new AppError(404, 'JOB_NOT_FOUND', 'Job card was not found');
      assertBranchAccess(request.staff!, job.rows[0].branchId);
      return { quotes: await loadQuotes(db, id, { forCustomer: false }) };
    },
  );

  // The professional bill built from the advisor's entries (estimate now, invoice once delivered).
  app.get(
    '/api/jobs/:id/bill',
    { preHandler: app.requirePermission('quotes:read') },
    async (request) => {
      const { id } = idSchema.parse(request.params);
      const job = await db.query<{ branchId: string }>(
        'SELECT branch_id AS "branchId" FROM avc.job_cards WHERE id = $1',
        [id],
      );
      if (!job.rows[0]) throw new AppError(404, 'JOB_NOT_FOUND', 'Job card was not found');
      assertBranchAccess(request.staff!, job.rows[0].branchId);
      return { bill: await buildBill(db, id) };
    },
  );

  // Re-issue the per-job tracking link (shown once). Earlier job links stop working.
  app.post(
    '/api/jobs/:id/customer-links',
    { preHandler: app.requirePermission('customer_links:issue') },
    async (request, reply) => {
      const { id } = idSchema.parse(request.params);
      const { expectedVersion } = linkSchema.parse(request.body);
      const link = await inTransaction(db, async (client) => {
        const job = await lockJob(client, id);
        assertBranchAccess(request.staff!, job.branchId);
        assertExpectedVersion(job, expectedVersion);
        const issued = await issueCustomerLink(client, id, request.staff!.id);
        await recordEvent(client, job, {
          type: 'customer_link_issued',
          actor: { type: 'staff', staffId: request.staff!.id },
          details: { linkId: issued.linkId },
        });
        return issued;
      });
      return reply
        .status(201)
        .send({ customerLink: { token: link.token, path: link.path, expiresAt: link.expiresAt } });
    },
  );
}
