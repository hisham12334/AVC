import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { inTransaction } from '../db.js';
import { AppError } from '../errors.js';
import { emit } from '../integration/outbox.js';
import { completeDelivery } from '../jobs/delivery.js';
import {
  assertActiveDriver,
  assertBranchAccess,
  assertExpectedVersion,
  lockJob,
  recordEvent,
} from '../jobs/lifecycle.js';

const idSchema = z.object({ id: z.uuid() });
const scheduleSchema = z
  .object({
    direction: z.enum(['pickup', 'return']),
    address: z.string().trim().min(1).max(500),
    contactPhone: z.string().trim().max(40).optional(),
    windowStart: z.iso.datetime().optional(),
    windowEnd: z.iso.datetime().optional(),
    notes: z.string().trim().max(1000).default(''),
    driverStaffId: z.uuid().optional(),
  })
  .strict();
const assignSchema = z.object({ driverStaffId: z.uuid() }).strict();
const completeSchema = z
  .object({
    // Condition photos (a pickup) or handover photos (a return), plus the signed receipt.
    photoEvidenceIds: z.array(z.uuid()).min(1).max(20),
    signatureEvidenceId: z.uuid().optional(),
  })
  .strict();
const reverseSchema = z
  .object({ expectedVersion: z.number().int().min(1), reason: z.string().trim().min(3).max(500) })
  .strict();

type TransferRow = {
  id: string;
  jobId: string;
  direction: 'pickup' | 'return';
  status: 'scheduled' | 'en_route' | 'completed' | 'cancelled';
  driverStaffId: string | null;
};

async function loadTransfer(client: PoolClient, id: string): Promise<TransferRow> {
  const result = await client.query<TransferRow>(
    `SELECT id, job_card_id AS "jobId", direction, status, driver_staff_id AS "driverStaffId"
     FROM avc.transfers WHERE id = $1`,
    [id],
  );
  if (!result.rows[0]) throw new AppError(404, 'TRANSFER_NOT_FOUND', 'Transfer was not found');
  return result.rows[0];
}

export function registerTransferRoutes(app: FastifyInstance, db: Pool): void {
  // The pickup leg is created at intake. A return leg is scheduled by the lounge once the car is nearly done.
  app.post(
    '/api/jobs/:id/transfers',
    { preHandler: app.requirePermission('transfers:manage') },
    async (request, reply) => {
      const { id } = idSchema.parse(request.params);
      const input = scheduleSchema.parse(request.body);
      const transfer = await inTransaction(db, async (client) => {
        const job = await lockJob(client, id);
        assertBranchAccess(request.staff!, job.branchId);
        if (input.direction === 'pickup' && job.stage !== 'pickup')
          throw new AppError(
            422,
            'INVALID_TRANSITION',
            'Pickup can only be scheduled before arrival',
          );
        if (
          input.direction === 'return' &&
          !['approved', 'in_bay', 'qc', 'ready'].includes(job.stage)
        )
          throw new AppError(
            422,
            'INVALID_TRANSITION',
            'A return can be scheduled once work is approved',
          );
        if (input.driverStaffId) await assertActiveDriver(client, input.driverStaffId);
        const open = await client.query(
          `SELECT 1 FROM avc.transfers WHERE job_card_id = $1 AND direction = $2 AND status IN ('scheduled', 'en_route')`,
          [id, input.direction],
        );
        if (open.rowCount)
          throw new AppError(409, 'TRANSFER_OPEN', 'That leg is already scheduled');
        const created = await client.query(
          `INSERT INTO avc.transfers(job_card_id, direction, address, contact_phone, window_start, window_end,
              notes, driver_staff_id, scheduled_by_staff_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING id, direction, status, address, window_start AS "windowStart", window_end AS "windowEnd"`,
          [
            id,
            input.direction,
            input.address,
            input.contactPhone ?? null,
            input.windowStart ?? null,
            input.windowEnd ?? null,
            input.notes,
            input.driverStaffId ?? null,
            request.staff!.id,
          ],
        );
        if (input.direction === 'return')
          await client.query("UPDATE avc.job_cards SET return_method = 'delivery' WHERE id = $1", [
            id,
          ]);
        return created.rows[0];
      });
      return reply.status(201).send({ transfer });
    },
  );

  app.get(
    '/api/staff/drivers',
    { preHandler: app.requirePermission('transfers:manage') },
    async () => {
      const result = await db.query(
        'SELECT id, display_name AS "displayName" FROM avc.staff_members WHERE role = \'driver\' AND active ORDER BY display_name',
      );
      return { drivers: result.rows };
    },
  );

  app.post(
    '/api/transfers/:id/assign',
    { preHandler: app.requirePermission('transfers:manage') },
    async (request) => {
      const { id } = idSchema.parse(request.params);
      const { driverStaffId } = assignSchema.parse(request.body);
      await inTransaction(db, async (client) => {
        const transfer = await loadTransfer(client, id);
        const job = await lockJob(client, transfer.jobId);
        assertBranchAccess(request.staff!, job.branchId);
        if (!['scheduled', 'en_route'].includes(transfer.status))
          throw new AppError(422, 'INVALID_TRANSITION', 'This leg is already finished');
        await assertActiveDriver(client, driverStaffId);
        await client.query('UPDATE avc.transfers SET driver_staff_id = $2 WHERE id = $1', [
          id,
          driverStaffId,
        ]);
      });
      return { ok: true };
    },
  );

  // The driver's list: where to go, who to call, what car, when. Drivers see only their own legs.
  app.get(
    '/api/transfers/mine',
    { preHandler: app.requirePermission('transfers:work') },
    async (request) => {
      const result = await db.query(
        `SELECT t.id, t.direction, t.status, t.address, t.contact_phone AS "contactPhone", t.notes,
                t.window_start AS "windowStart", t.window_end AS "windowEnd",
                j.id AS "jobId", j.job_number::text AS "jobNumber", j.work_stage AS stage,
                v.make, v.model, v.color, v.license_plate AS "licensePlate",
                c.full_name AS "customerName", c.mobile_number AS "customerMobile"
         FROM avc.transfers t JOIN avc.job_cards j ON j.id = t.job_card_id
         JOIN avc.vehicles v ON v.id = j.vehicle_id JOIN avc.customers c ON c.id = j.customer_id
         WHERE t.driver_staff_id = $1 AND t.status IN ('scheduled', 'en_route')
         ORDER BY t.window_start NULLS LAST, t.created_at`,
        [request.staff!.id],
      );
      return { transfers: result.rows };
    },
  );

  app.post(
    '/api/transfers/:id/start',
    { preHandler: app.requirePermission('transfers:work') },
    async (request) => {
      const { id } = idSchema.parse(request.params);
      await inTransaction(db, async (client) => {
        const transfer = await loadTransfer(client, id);
        const job = await lockJob(client, transfer.jobId);
        assertBranchAccess(request.staff!, job.branchId);
        if (transfer.driverStaffId !== request.staff!.id)
          throw new AppError(404, 'TRANSFER_NOT_FOUND', 'Transfer was not found');
        if (transfer.status !== 'scheduled')
          throw new AppError(422, 'INVALID_TRANSITION', 'This leg has already started');
        await client.query(
          "UPDATE avc.transfers SET status = 'en_route', started_at = now() WHERE id = $1",
          [id],
        );
        await recordEvent(client, job, {
          type: 'transfer_started',
          actor: { type: 'staff', staffId: request.staff!.id },
          details: { transferId: id, direction: transfer.direction },
        });
      });
      return { ok: true };
    },
  );

  // Pickup: the car arrives at the workshop (stage intake). Return: the car is delivered, and the approved
  // amount is recorded as received. Both need photos so the handover is evidence.
  app.post(
    '/api/transfers/:id/complete',
    { preHandler: app.requirePermission('transfers:work') },
    async (request) => {
      const { id } = idSchema.parse(request.params);
      const input = completeSchema.parse(request.body);
      const result = await inTransaction(db, async (client) => {
        const transfer = await loadTransfer(client, id);
        const job = await lockJob(client, transfer.jobId);
        assertBranchAccess(request.staff!, job.branchId);
        if (transfer.driverStaffId !== request.staff!.id)
          throw new AppError(404, 'TRANSFER_NOT_FOUND', 'Transfer was not found');
        if (transfer.status !== 'en_route')
          throw new AppError(422, 'INVALID_TRANSITION', 'Start the leg before completing it');
        if (transfer.direction === 'return' && job.stage !== 'ready')
          throw new AppError(422, 'INVALID_TRANSITION', 'The car is not ready to go back yet');
        const ids = [
          ...input.photoEvidenceIds,
          ...(input.signatureEvidenceId ? [input.signatureEvidenceId] : []),
        ];
        const linked = await client.query(
          `UPDATE avc.evidence SET transfer_id = $1
           WHERE id = ANY($2::uuid[]) AND job_card_id = $3 AND transfer_id IS NULL AND finding_id IS NULL
             AND quote_item_id IS NULL
             AND (id = ANY($4::uuid[]) AND kind IN ('photo', 'video')
                  OR id = $5 AND kind = 'signature')`,
          [id, ids, job.id, input.photoEvidenceIds, input.signatureEvidenceId ?? null],
        );
        if (linked.rowCount !== ids.length)
          throw new AppError(
            422,
            'EVIDENCE_INVALID',
            'Handover evidence must be this job’s unused photos, and the receipt a signature',
          );
        await client.query(
          "UPDATE avc.transfers SET status = 'completed', completed_at = now() WHERE id = $1",
          [id],
        );
        const details = { transferId: id, direction: transfer.direction };
        const done = await recordEvent(client, job, {
          type: 'transfer_completed',
          actor: { type: 'staff', staffId: request.staff!.id },
          toStage: transfer.direction === 'pickup' ? 'intake' : undefined,
          details,
        });
        await emit(client, {
          branchId: job.branchId,
          type: 'transfer.completed',
          aggregateType: 'job',
          aggregateId: job.id,
          payload: { jobId: job.id, jobNumber: job.jobNumber, direction: transfer.direction },
        });
        if (transfer.direction === 'pickup') {
          await emit(client, {
            branchId: job.branchId,
            type: 'job.stage_changed',
            aggregateType: 'job',
            aggregateId: job.id,
            payload: { jobId: job.id, jobNumber: job.jobNumber, from: 'pickup', to: 'intake' },
          });
          return { stage: done.stage, amountAed: null as number | null };
        }
        const delivered = await completeDelivery(client, job, {
          type: 'staff',
          staffId: request.staff!.id,
        });
        return { stage: 'delivered', amountAed: delivered.amountAed };
      });
      return { result };
    },
  );

  // Client rule: delivery counts as payment received. If the lounge finds it was not, they flag it with a
  // reason, which takes the amount out of revenue and leaves an audit entry.
  app.post(
    '/api/jobs/:id/revenue/reverse',
    { preHandler: app.requirePermission('revenue:reverse') },
    async (request) => {
      const { id } = idSchema.parse(request.params);
      const input = reverseSchema.parse(request.body);
      await inTransaction(db, async (client) => {
        const job = await lockJob(client, id);
        assertBranchAccess(request.staff!, job.branchId);
        assertExpectedVersion(job, input.expectedVersion);
        const changed = await client.query<{ amount: string }>(
          `UPDATE avc.revenue_entries SET reversed_at = now(), reversed_by_staff_id = $2, reversal_reason = $3
           WHERE job_card_id = $1 AND reversed_at IS NULL RETURNING amount_aed::text AS amount`,
          [id, request.staff!.id, input.reason],
        );
        if (!changed.rows[0])
          throw new AppError(
            409,
            'NO_REVENUE_TO_REVERSE',
            'No recorded payment to reverse for this job',
          );
        await recordEvent(client, job, {
          type: 'revenue_reversed',
          actor: { type: 'staff', staffId: request.staff!.id },
          details: { reason: input.reason, amountAed: Number(changed.rows[0].amount) },
        });
        await emit(client, {
          branchId: job.branchId,
          type: 'revenue.reversed',
          aggregateType: 'job',
          aggregateId: id,
          payload: {
            jobId: id,
            jobNumber: job.jobNumber,
            amountAed: Number(changed.rows[0].amount),
            reason: input.reason,
          },
        });
      });
      return { ok: true };
    },
  );
}
