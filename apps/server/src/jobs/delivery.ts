import type { PoolClient } from 'pg';
import { emit } from '../integration/outbox.js';
import { recordEvent, type Actor, type LockedJob } from './lifecycle.js';

// What the customer approved, across the first quote and any later findings.
export async function approvedTotalAed(client: PoolClient, jobId: string): Promise<number> {
  const result = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(i.price_aed), 0)::text AS total
     FROM avc.quote_items i JOIN avc.quotes q ON q.id = i.quote_id
     WHERE q.job_card_id = $1 AND i.decision = 'approved'`,
    [jobId],
  );
  return Number(result.rows[0]!.total);
}

// Client rule: once the car is delivered the approved amount counts as received, and the
// day's revenue includes it. The lounge can reverse it with a reason (see revenue routes).
export async function completeDelivery(
  client: PoolClient,
  job: LockedJob,
  actor: Actor,
): Promise<{ version: number; amountAed: number }> {
  const next = await recordEvent(client, job, {
    type: 'stage_advanced',
    actor,
    toStage: 'delivered',
  });
  const amountAed = await approvedTotalAed(client, job.id);
  await client.query(
    `INSERT INTO avc.revenue_entries(job_card_id, branch_id, amount_aed, recognised_by_staff_id)
     VALUES ($1,$2,$3,$4) ON CONFLICT (job_card_id) DO NOTHING`,
    [job.id, job.branchId, amountAed, actor.type === 'staff' ? actor.staffId : null],
  );
  await emit(client, {
    branchId: job.branchId,
    type: 'job.stage_changed',
    aggregateType: 'job',
    aggregateId: job.id,
    payload: { jobId: job.id, jobNumber: job.jobNumber, from: job.stage, to: 'delivered' },
  });
  await emit(client, {
    branchId: job.branchId,
    type: 'job.delivered',
    aggregateType: 'job',
    aggregateId: job.id,
    payload: { jobId: job.id, jobNumber: job.jobNumber, amountAed, paymentStatus: 'received' },
  });
  return { version: next.version, amountAed };
}
