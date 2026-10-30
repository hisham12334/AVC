import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { inTransaction } from '../db.js';
import { AppError } from '../errors.js';
import { emit } from '../integration/outbox.js';
import { lockJob, recordEvent, type Stage } from '../jobs/lifecycle.js';
import { loadQuotes } from '../quotes/queries.js';
import { hashToken } from './tokens.js';

const tokenSchema = z.object({ token: z.string().min(20).max(100) });
const decisionSchema = z
  .object({
    quoteId: z.uuid(),
    quoteVersion: z.number().int().min(1),
    decisions: z
      .array(z.object({ itemId: z.uuid(), decision: z.enum(['approved', 'rejected']) }).strict())
      .min(1)
      .max(50),
  })
  .strict();

// One generic error for unknown, expired and revoked links, so links cannot be probed.
const invalidLink = () =>
  new AppError(404, 'LINK_INVALID', 'This link is not valid or has expired');

async function resolveLink(
  db: Pool | PoolClient,
  token: string,
): Promise<{ linkId: string; jobId: string }> {
  const result = await db.query<{ linkId: string; jobId: string }>(
    `SELECT id AS "linkId", job_card_id AS "jobId" FROM avc.customer_access_links
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [hashToken(token)],
  );
  const row = result.rows[0];
  if (!row) throw invalidLink();
  return row;
}

const TIMELINE_LABELS: Record<
  string,
  (details: Record<string, unknown>, to: string) => string | null
> = {
  job_created: () => 'Vehicle checked in',
  inspection_started: () => 'Inspection started',
  quote_sent: () => 'Quote ready for your review',
  finding_raised: () => 'New finding needs your decision',
  quote_decided: () => 'You responded to the quote',
  stage_advanced: (_d, to) =>
    ({
      in_progress: 'Work started',
      quality_check: 'Final quality check',
      ready: 'Ready for collection',
      delivered: 'Delivered',
    })[to] ?? null,
};

export function registerTrackRoutes(app: FastifyInstance, db: Pool): void {
  // Customer view: no staff login. The unguessable link is the credential and is limited to one job.
  app.get('/api/track/:token', async (request, reply) => {
    const { token } = tokenSchema.parse(request.params);
    const { jobId } = await resolveLink(db, token);
    const job = await db.query(
      `SELECT j.job_number::text AS "jobNumber", j.work_stage AS stage, j.updated_at AS "updatedAt",
              v.make, v.model, v.model_year AS "modelYear", v.color, v.license_plate AS "licensePlate",
              b.name AS "branchName"
       FROM avc.job_cards j JOIN avc.vehicles v ON v.id = j.vehicle_id
       JOIN avc.branches b ON b.id = j.branch_id WHERE j.id = $1`,
      [jobId],
    );
    const events = await db.query<{
      eventType: string;
      toStatus: string;
      occurredAt: Date;
      details: Record<string, unknown>;
    }>(
      `SELECT event_type AS "eventType", to_status AS "toStatus", occurred_at AS "occurredAt", details
       FROM avc.job_events WHERE job_card_id = $1 ORDER BY job_version`,
      [jobId],
    );
    const quotes = await loadQuotes(db, jobId, { forCustomer: true });
    const timeline = events.rows.flatMap((e) => {
      const label = TIMELINE_LABELS[e.eventType]?.(e.details, e.toStatus);
      return label ? [{ at: e.occurredAt.toISOString(), type: e.eventType, label }] : [];
    });
    const openQuote = quotes.find((q) => q.status === 'sent') ?? null;
    reply.header('cache-control', 'no-store');
    return {
      job: { ...job.rows[0], stage: job.rows[0].stage as Stage },
      workPaused: openQuote?.kind === 'addendum',
      openQuote,
      decidedQuotes: quotes.filter((q) => q.status === 'decided'),
      timeline,
    };
  });

  app.post('/api/track/:token/decisions', async (request, reply) => {
    const { token } = tokenSchema.parse(request.params);
    const input = decisionSchema.parse(request.body);
    const agent = request.headers['user-agent']?.slice(0, 300) ?? null;
    const outcome = await inTransaction(db, async (client) => {
      const { linkId, jobId } = await resolveLink(client, token);
      const job = await lockJob(client, jobId);
      const quoteResult = await client.query<{
        id: string;
        version: number;
        kind: 'initial' | 'addendum';
        status: 'sent' | 'decided';
      }>('SELECT id, version, kind, status FROM avc.quotes WHERE id = $1 AND job_card_id = $2', [
        input.quoteId,
        jobId,
      ]);
      const quote = quoteResult.rows[0];
      if (!quote) throw new AppError(404, 'QUOTE_NOT_FOUND', 'Quote was not found');
      // Replay protection: a quote takes exactly one decision, even if the request is repeated.
      if (quote.status === 'decided')
        throw new AppError(409, 'QUOTE_ALREADY_DECIDED', 'This quote has already been answered');
      if (quote.version !== input.quoteVersion)
        throw new AppError(
          409,
          'QUOTE_VERSION_MISMATCH',
          'This quote changed; reload and review it',
        );

      const items = await client.query<{ id: string; priceAed: string }>(
        'SELECT id, price_aed::text AS "priceAed" FROM avc.quote_items WHERE quote_id = $1 FOR UPDATE',
        [quote.id],
      );
      const chosen = new Map(input.decisions.map((d) => [d.itemId, d.decision]));
      if (
        chosen.size !== input.decisions.length ||
        chosen.size !== items.rows.length ||
        items.rows.some((i) => !chosen.has(i.id))
      )
        throw new AppError(
          422,
          'INCOMPLETE_DECISIONS',
          'Every item in the quote needs an approve or reject answer',
        );

      let approved = 0;
      let approvedCents = 0;
      for (const item of items.rows) {
        const decision = chosen.get(item.id)!;
        if (decision === 'approved') {
          approved += 1;
          approvedCents += Math.round(Number(item.priceAed) * 100);
        }
        await client.query(
          'UPDATE avc.quote_items SET decision = $2, decided_at = now() WHERE id = $1',
          [item.id, decision],
        );
      }
      await client.query(
        "UPDATE avc.quotes SET status = 'decided', decided_at = now() WHERE id = $1",
        [quote.id],
      );
      await client.query(
        `INSERT INTO avc.quote_decisions(quote_id, link_id, quote_version, choices, user_agent)
         VALUES ($1,$2,$3,$4::jsonb,$5)`,
        [quote.id, linkId, quote.version, JSON.stringify(input.decisions), agent],
      );

      // Approval is the start line: an initial quote with at least one approved item authorises work.
      // Declining everything sends the car straight to collection. An addendum never changes the stage.
      const toStage: Stage | undefined =
        quote.kind === 'initial' ? (approved > 0 ? 'approved' : 'ready') : undefined;
      const rejected = items.rows.length - approved;
      const next = await recordEvent(client, job, {
        type: 'quote_decided',
        actor: { type: 'customer' },
        toStage,
        details: { quoteId: quote.id, quoteVersion: quote.version, approved, rejected },
      });
      await emit(client, {
        branchId: job.branchId,
        type: 'quote.decided',
        aggregateType: 'quote',
        aggregateId: quote.id,
        payload: {
          jobId,
          jobNumber: job.jobNumber,
          quoteId: quote.id,
          version: quote.version,
          kind: quote.kind,
          approved,
          rejected,
          approvedTotalAed: approvedCents / 100,
        },
      });
      if (toStage)
        await emit(client, {
          branchId: job.branchId,
          type: 'job.stage_changed',
          aggregateType: 'job',
          aggregateId: jobId,
          payload: { jobId, jobNumber: job.jobNumber, from: job.stage, to: toStage },
        });
      return { stage: next.stage, approved, rejected, approvedTotalAed: approvedCents / 100 };
    });
    reply.header('cache-control', 'no-store');
    return { result: outcome };
  });
}
