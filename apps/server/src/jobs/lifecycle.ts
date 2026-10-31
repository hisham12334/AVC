import type { PoolClient } from 'pg';
import { AppError } from '../errors.js';
import type { StaffPrincipal } from '../identity/auth.js';

// Customer-visible stages, in order. The stage is what the customer app shows;
// `status` is the coarser operational state kept alongside it.
export const STAGES = [
  'pickup',
  'intake',
  'inspection',
  'pricing',
  'quote',
  'approved',
  'in_bay',
  'qc',
  'ready',
  'delivered',
] as const;
export type Stage = (typeof STAGES)[number];

export const STATUS_FOR_STAGE: Record<Stage, string> = {
  pickup: 'pickup_scheduled',
  intake: 'intake_open',
  inspection: 'inspection_pending',
  pricing: 'pricing_pending',
  quote: 'awaiting_approval',
  approved: 'approved',
  in_bay: 'in_progress',
  qc: 'quality_check',
  ready: 'ready',
  delivered: 'delivered',
};

// Moves staff may trigger with the advance command. Leaving `quote` only happens when the customer
// decides, and entering `quote` only happens when a quote is published.
export const ADVANCE_TO: Partial<Record<Stage, Stage>> = {
  approved: 'in_bay',
  in_bay: 'qc',
  qc: 'ready',
  ready: 'delivered',
};

export type LockedJob = {
  id: string;
  jobNumber: string;
  branchId: string;
  customerId: string;
  vehicleId: string;
  vehicleLocation: string;
  arrivalMethod: 'pickup' | 'walk_in';
  returnMethod: 'delivery' | 'collect';
  stage: Stage;
  status: string;
  version: number;
};

export async function lockJob(client: PoolClient, id: string): Promise<LockedJob> {
  const result = await client.query<LockedJob>(
    `SELECT id, job_number::text AS "jobNumber", branch_id AS "branchId", customer_id AS "customerId",
            vehicle_id AS "vehicleId", vehicle_location AS "vehicleLocation",
            arrival_method AS "arrivalMethod", return_method AS "returnMethod", work_stage AS stage, status, version
     FROM avc.job_cards WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const job = result.rows[0];
  if (!job) throw new AppError(404, 'JOB_NOT_FOUND', 'Job card was not found');
  return job;
}

// Staff pinned to a branch only see that branch. Return 404 so other branches' ids are not revealed.
export function assertBranchAccess(staff: StaffPrincipal, branchId: string): void {
  if (staff.branchId && staff.branchId !== branchId)
    throw new AppError(404, 'JOB_NOT_FOUND', 'Job card was not found');
}

export function assertExpectedVersion(job: LockedJob, expected: number): void {
  if (job.version !== expected)
    throw new AppError(409, 'STALE_VERSION', 'Job card changed; reload before retrying');
}

export type Actor = { type: 'staff'; staffId: string } | { type: 'customer' } | { type: 'system' };

// Every change bumps the job version and appends exactly one audit event, so the history has no gaps.
export async function recordEvent(
  client: PoolClient,
  job: LockedJob,
  event: { type: string; actor: Actor; toStage?: Stage; details?: Record<string, unknown> },
): Promise<{ version: number; stage: Stage; status: string }> {
  const stage = event.toStage ?? job.stage;
  const status = event.toStage ? STATUS_FOR_STAGE[event.toStage] : job.status;
  const updated = await client.query<{ version: number }>(
    `UPDATE avc.job_cards SET version = version + 1, updated_at = now(), work_stage = $2, status = $3
     WHERE id = $1 RETURNING version`,
    [job.id, stage, status],
  );
  const version = updated.rows[0]!.version;
  await client.query(
    `INSERT INTO avc.job_events(job_card_id, job_version, event_type, from_status, to_status,
                                actor_type, actor_staff_id, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [
      job.id,
      version,
      event.type,
      job.status,
      status,
      event.actor.type,
      event.actor.type === 'staff' ? event.actor.staffId : null,
      JSON.stringify(event.details ?? {}),
    ],
  );
  return { version, stage, status };
}

export async function assertActiveDriver(client: PoolClient, staffId: string): Promise<void> {
  const found = await client.query(
    "SELECT 1 FROM avc.staff_members WHERE id = $1 AND role = 'driver' AND active",
    [staffId],
  );
  if (!found.rowCount)
    throw new AppError(422, 'DRIVER_NOT_FOUND', 'Driver does not exist or is inactive');
}

// A finding waiting for the advisor to price, or a priced quote waiting for the customer.
export async function hasOpenCustomerStep(client: PoolClient, jobId: string): Promise<boolean> {
  const open = await client.query(
    `SELECT 1 FROM avc.quotes WHERE job_card_id = $1 AND status = 'sent'
     UNION ALL SELECT 1 FROM avc.finding_batches WHERE job_card_id = $1 AND status = 'awaiting_pricing'`,
    [jobId],
  );
  return (open.rowCount ?? 0) > 0;
}
