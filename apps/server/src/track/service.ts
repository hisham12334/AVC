import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { inTransaction } from '../db.js';
import { AppError } from '../errors.js';
import { emit } from '../integration/outbox.js';
import { lockJob, recordEvent, type Stage } from '../jobs/lifecycle.js';
import { loadQuotes } from '../quotes/queries.js';

export const decisionSchema = z
  .object({
    quoteId: z.uuid(),
    quoteVersion: z.number().int().min(1),
    decisions: z
      .array(z.object({ itemId: z.uuid(), decision: z.enum(['approved', 'rejected']) }).strict())
      .min(1)
      .max(50),
  })
  .strict();

export type Credential = { linkId: string } | { customerTokenId: string };

const TIMELINE_LABELS: Record<
  string,
  (details: Record<string, unknown>, to: string) => string | null
> = {
  job_created: (d) => (d.arrival === 'pickup' ? 'Pickup booked' : 'Vehicle checked in'),
  inspection_started: () => 'Inspection started',
  inspection_submitted: () => 'Inspection completed. We are preparing your quote.',
  quote_sent: (d) =>
    d.kind === 'addendum'
      ? 'New finding priced and ready for your decision'
      : 'Your quote is ready',
  finding_raised: () => 'New finding spotted. It is paused until you decide.',
  quote_decided: () => 'You responded to the quote',
  transfer_started: (d) =>
    d.direction === 'pickup'
      ? 'Our driver is on the way to collect your car'
      : 'Our driver is on the way with your car',
  transfer_completed: (d) =>
    d.direction === 'pickup' ? 'Your car has been collected' : 'Your car has been delivered',
  stage_advanced: (_d, to) =>
    (
      ({
        in_progress: 'Work started',
        quality_check: 'Final quality check',
        ready: 'Ready',
        delivered: 'Delivered',
      }) as Record<string, string>
    )[to] ?? null,
};

// What a customer may see about a job. Findings and prices appear only once the advisor has posted
// them: until then the customer sees that the inspection is done and the quote is being prepared.
export async function buildJobView(db: Pool | PoolClient, jobId: string) {
  const job = await db.query(
    `SELECT j.job_number::text AS "jobNumber", j.work_stage AS stage, j.updated_at AS "updatedAt",
            j.arrival_method AS "arrivalMethod", j.return_method AS "returnMethod",
            v.make, v.model, v.model_year AS "modelYear", v.color, v.license_plate AS "licensePlate",
            b.name AS "branchName", s.display_name AS "advisorName"
     FROM avc.job_cards j JOIN avc.vehicles v ON v.id = j.vehicle_id
     JOIN avc.branches b ON b.id = j.branch_id JOIN avc.staff_members s ON s.id = j.responsible_staff_id
     WHERE j.id = $1`,
    [jobId],
  );
  if (!job.rows[0]) throw new AppError(404, 'JOB_NOT_FOUND', 'Job was not found');
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
  const pending = await db.query(
    `SELECT 1 FROM avc.finding_batches WHERE job_card_id = $1 AND status = 'awaiting_pricing' AND kind = 'addendum'`,
    [jobId],
  );
  const leg = await db.query(
    `SELECT t.direction, t.status, t.window_start AS "windowStart", t.window_end AS "windowEnd",
            d.display_name AS "driverName"
     FROM avc.transfers t LEFT JOIN avc.staff_members d ON d.id = t.driver_staff_id
     WHERE t.job_card_id = $1 AND t.status IN ('scheduled', 'en_route') ORDER BY t.created_at LIMIT 1`,
    [jobId],
  );
  const openQuote = quotes.find((q) => q.status === 'sent') ?? null;
  const pendingFinding = (pending.rowCount ?? 0) > 0;
  const timeline = events.rows.flatMap((e) => {
    const label = TIMELINE_LABELS[e.eventType]?.(e.details, e.toStatus);
    return label ? [{ at: e.occurredAt.toISOString(), type: e.eventType, label }] : [];
  });
  const visible = job.rows[0];
  return {
    job: { ...visible, stage: visible.stage as Stage },
    pricingPending: visible.stage === 'pricing',
    pendingFinding,
    workPaused: pendingFinding || openQuote?.kind === 'addendum',
    openQuote,
    decidedQuotes: quotes.filter((q) => q.status === 'decided'),
    timeline,
    transfer: leg.rows[0] ?? null,
  };
}

// One decision per quote, bound to the quote version, from either kind of customer credential.
export async function submitDecisions(
  db: Pool,
  jobId: string,
  credential: Credential,
  rawInput: unknown,
  userAgent: string | null,
) {
  const input = decisionSchema.parse(rawInput);
  const agent = userAgent?.slice(0, 300) ?? null;
  return inTransaction(db, async (client) => {
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
      throw new AppError(409, 'QUOTE_VERSION_MISMATCH', 'This quote changed; reload and review it');

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
      `INSERT INTO avc.quote_decisions(quote_id, link_id, customer_token_id, quote_version, choices, user_agent)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
      [
        quote.id,
        'linkId' in credential ? credential.linkId : null,
        'customerTokenId' in credential ? credential.customerTokenId : null,
        quote.version,
        JSON.stringify(input.decisions),
        agent,
      ],
    );

    // Approval is the start line: an initial quote with at least one approved line authorises work.
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
}
