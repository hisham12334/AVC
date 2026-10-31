import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { buildBill } from '../bills/bill.js';
import { AppError } from '../errors.js';
import { buildJobView, submitDecisions } from './service.js';
import { hashToken } from './tokens.js';

const tokenSchema = z.object({ token: z.string().min(20).max(100) });

// One generic error for unknown, expired and revoked links, so links cannot be probed.
const invalidLink = () =>
  new AppError(404, 'LINK_INVALID', 'This link is not valid or has expired');

async function resolveLink(db: Pool, token: string): Promise<{ linkId: string; jobId: string }> {
  const result = await db.query<{ linkId: string; jobId: string }>(
    `SELECT id AS "linkId", job_card_id AS "jobId" FROM avc.customer_access_links
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [hashToken(token)],
  );
  const row = result.rows[0];
  if (!row) throw invalidLink();
  return row;
}

export function registerTrackRoutes(app: FastifyInstance, db: Pool): void {
  // Per-job customer view: no login. The unguessable link is the credential and covers one job.
  app.get('/api/track/:token', async (request, reply) => {
    const { token } = tokenSchema.parse(request.params);
    const { jobId } = await resolveLink(db, token);
    reply.header('cache-control', 'no-store');
    return buildJobView(db, jobId);
  });

  app.post('/api/track/:token/decisions', async (request, reply) => {
    const { token } = tokenSchema.parse(request.params);
    const { linkId, jobId } = await resolveLink(db, token);
    const result = await submitDecisions(
      db,
      jobId,
      { linkId },
      request.body,
      request.headers['user-agent'] ?? null,
    );
    reply.header('cache-control', 'no-store');
    return { result };
  });

  app.get('/api/track/:token/bill', async (request, reply) => {
    const { token } = tokenSchema.parse(request.params);
    const { jobId } = await resolveLink(db, token);
    reply.header('cache-control', 'no-store');
    return { bill: await buildBill(db, jobId) };
  });
}
