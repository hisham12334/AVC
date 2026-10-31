import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { resolveBranch } from '../branches/scope.js';
import { inTransaction } from '../db.js';
import { AppError } from '../errors.js';
import { emit } from '../integration/outbox.js';
import {
  ADVANCE_TO,
  assertActiveDriver,
  assertBranchAccess,
  assertExpectedVersion,
  hasOpenCustomerStep,
  lockJob,
  recordEvent,
} from './lifecycle.js';
import { completeDelivery } from './delivery.js';

const intakeSchema = z
  .object({
    customerId: z.uuid(),
    vehicleId: z.uuid(),
    branchId: z.uuid().optional(),
    mileageKm: z.number().int().min(0).max(2000000),
    intakeCondition: z.string().trim().min(1).max(5000),
    // The mix is real: some cars come by concierge pickup, some are walked in. Same for the return.
    arrivalMethod: z.enum(['pickup', 'walk_in']).default('walk_in'),
    returnMethod: z.enum(['delivery', 'collect']).default('collect'),
    leadSource: z
      .enum(['google', 'meta', 'referral', 'partner', 'walk_in', 'repeat', 'other'])
      .optional(),
    pickup: z
      .object({
        address: z.string().trim().min(1).max(500),
        contactPhone: z.string().trim().max(40).optional(),
        windowStart: z.iso.datetime().optional(),
        windowEnd: z.iso.datetime().optional(),
        notes: z.string().trim().max(1000).default(''),
        driverStaffId: z.uuid().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (v) => v.arrivalMethod !== 'pickup' || !!v.pickup,
    'Pickup details are required for a pickup',
  );
const commandSchema = z.object({ expectedVersion: z.number().int().min(1) }).strict();
const idSchema = z.object({ id: z.uuid() });

export function registerJobRoutes(app: FastifyInstance, db: Pool): void {
  app.post(
    '/api/jobs/intake',
    { preHandler: app.requirePermission('jobs:create_intake') },
    async (request, reply) => {
      const input = intakeSchema.parse(request.body);
      const job = await inTransaction(db, async (client) => {
        const relationship = await client.query(
          'SELECT id FROM avc.vehicles WHERE id = $1 AND customer_id = $2',
          [input.vehicleId, input.customerId],
        );
        if (!relationship.rowCount)
          throw new AppError(
            422,
            'VEHICLE_CUSTOMER_MISMATCH',
            'Vehicle is not linked to this customer',
          );
        const branch = await resolveBranch(client, request.staff!, input.branchId);
        const startStage = input.arrivalMethod === 'pickup' ? 'pickup' : 'intake';
        const startStatus = input.arrivalMethod === 'pickup' ? 'pickup_scheduled' : 'intake_open';
        const created = await client.query(
          `INSERT INTO avc.job_cards(customer_id, vehicle_id, branch_id, mileage_km, intake_condition, status,
              vehicle_location, work_stage, responsible_staff_id, created_by_staff_id, version,
              arrival_method, return_method, lead_source)
         VALUES ($1,$2,$3,$4,$5,$8,$6,$9,$7,$7,1,$10,$11,$12)
         RETURNING id, job_number AS "jobNumber", customer_id AS "customerId", vehicle_id AS "vehicleId",
                   branch_id AS "branchId", mileage_km AS "mileageKm", intake_condition AS "intakeCondition",
                   status, vehicle_location AS "vehicleLocation", work_stage AS "workStage",
                   arrival_method AS "arrivalMethod", return_method AS "returnMethod",
                   lead_source AS "leadSource",
                   responsible_staff_id AS "responsibleStaffId", created_by_staff_id AS "createdByStaffId",
                   version, created_at AS "createdAt", updated_at AS "updatedAt"`,
          [
            input.customerId,
            input.vehicleId,
            branch.id,
            input.mileageKm,
            input.intakeCondition,
            branch.code,
            request.staff!.id,
            startStatus,
            startStage,
            input.arrivalMethod,
            input.returnMethod,
            input.leadSource ?? null,
          ],
        );
        const row = created.rows[0];
        await client.query(
          `INSERT INTO avc.job_events(job_card_id, job_version, event_type, from_status, to_status, actor_staff_id, details)
         VALUES ($1,1,'job_created',NULL,$4,$2,$3::jsonb)`,
          [
            row.id,
            request.staff!.id,
            JSON.stringify({
              mileageKm: input.mileageKm,
              intakeCondition: input.intakeCondition,
              arrival: input.arrivalMethod,
            }),
            startStatus,
          ],
        );
        if (input.pickup) {
          const pickup = input.pickup;
          if (pickup.driverStaffId) await assertActiveDriver(client, pickup.driverStaffId);
          await client.query(
            `INSERT INTO avc.transfers(job_card_id, direction, address, contact_phone, window_start, window_end,
                notes, driver_staff_id, scheduled_by_staff_id)
             VALUES ($1,'pickup',$2,$3,$4,$5,$6,$7,$8)`,
            [
              row.id,
              pickup.address,
              pickup.contactPhone ?? null,
              pickup.windowStart ?? null,
              pickup.windowEnd ?? null,
              pickup.notes,
              pickup.driverStaffId ?? null,
              request.staff!.id,
            ],
          );
        }
        await emit(client, {
          branchId: branch.id,
          type: 'job.created',
          aggregateType: 'job',
          aggregateId: row.id,
          payload: {
            jobId: row.id,
            jobNumber: String(row.jobNumber),
            customerId: row.customerId,
            vehicleId: row.vehicleId,
            branch: branch.code,
            mileageKm: input.mileageKm,
          },
        });
        return row;
      });
      return reply.status(201).send({ job });
    },
  );

  app.post(
    '/api/jobs/:id/commands/start-inspection',
    { preHandler: app.requirePermission('jobs:start_inspection') },
    async (request) => {
      const { id } = idSchema.parse(request.params);
      const { expectedVersion } = commandSchema.parse(request.body);
      const job = await inTransaction(db, async (client) => {
        const current = await lockJob(client, id);
        assertBranchAccess(request.staff!, current.branchId);
        assertExpectedVersion(current, expectedVersion);
        if (current.status !== 'intake_open')
          throw new AppError(
            422,
            'INVALID_TRANSITION',
            'Inspection cannot start from the current job status',
          );
        const next = await recordEvent(client, current, {
          type: 'inspection_started',
          actor: { type: 'staff', staffId: request.staff!.id },
          toStage: 'inspection',
        });
        await emit(client, {
          branchId: current.branchId,
          type: 'job.stage_changed',
          aggregateType: 'job',
          aggregateId: id,
          payload: {
            jobId: id,
            jobNumber: current.jobNumber,
            from: current.stage,
            to: 'inspection',
          },
        });
        return {
          id,
          status: next.status,
          version: next.version,
          vehicleLocation: current.vehicleLocation,
          workStage: next.stage,
        };
      });
      return { job };
    },
  );

  // Staff-driven moves after the customer has approved: approved -> in_bay -> qc -> ready -> delivered.
  // The move into and out of `quote` is owned by publishing and by the customer's decision.
  app.post(
    '/api/jobs/:id/commands/advance',
    { preHandler: app.requirePermission('jobs:advance') },
    async (request) => {
      const { id } = idSchema.parse(request.params);
      const { expectedVersion } = commandSchema.parse(request.body);
      const job = await inTransaction(db, async (client) => {
        const current = await lockJob(client, id);
        assertBranchAccess(request.staff!, current.branchId);
        assertExpectedVersion(current, expectedVersion);
        const target = ADVANCE_TO[current.stage];
        if (!target)
          throw new AppError(
            422,
            'INVALID_TRANSITION',
            current.stage === 'quote'
              ? 'Work cannot start until the customer approves the quote'
              : 'The job cannot be advanced from its current stage',
          );
        if (await hasOpenCustomerStep(client, id))
          throw new AppError(
            409,
            'AWAITING_CUSTOMER_DECISION',
            'A finding or quote is still open; the job cannot move on yet',
          );
        if (target === 'delivered') {
          if (current.returnMethod === 'delivery')
            throw new AppError(
              422,
              'DELIVERY_BY_DRIVER',
              'This car goes back by driver; the driver marks it delivered',
            );
          const done = await completeDelivery(client, current, {
            type: 'staff',
            staffId: request.staff!.id,
          });
          return { id, status: 'delivered', version: done.version, workStage: 'delivered' };
        }
        const next = await recordEvent(client, current, {
          type: 'stage_advanced',
          actor: { type: 'staff', staffId: request.staff!.id },
          toStage: target,
        });
        await emit(client, {
          branchId: current.branchId,
          type: 'job.stage_changed',
          aggregateType: 'job',
          aggregateId: id,
          payload: { jobId: id, jobNumber: current.jobNumber, from: current.stage, to: target },
        });
        return { id, status: next.status, version: next.version, workStage: next.stage };
      });
      return { job };
    },
  );

  app.get('/api/jobs', { preHandler: app.requirePermission('jobs:read') }, async (request) => {
    const result = await db.query(
      `SELECT j.id, j.job_number AS "jobNumber", j.status, j.vehicle_location AS "vehicleLocation",
              j.work_stage AS "workStage", j.version, j.created_at AS "createdAt", j.branch_id AS "branchId",
              c.full_name AS "customerName", v.make, v.model, v.license_plate AS "licensePlate",
              s.display_name AS "responsibleStaffName",
              EXISTS (SELECT 1 FROM avc.quotes q WHERE q.job_card_id = j.id AND q.status = 'sent')
                AS "awaitingCustomer",
              EXISTS (SELECT 1 FROM avc.finding_batches b WHERE b.job_card_id = j.id AND b.status = 'awaiting_pricing')
                AS "awaitingPricing",
              j.arrival_method AS "arrivalMethod", j.return_method AS "returnMethod"
       FROM avc.job_cards j JOIN avc.customers c ON c.id = j.customer_id
       JOIN avc.vehicles v ON v.id = j.vehicle_id
       JOIN avc.staff_members s ON s.id = j.responsible_staff_id
       WHERE $1::uuid IS NULL OR j.branch_id = $1
       ORDER BY j.created_at DESC LIMIT 100`,
      [request.staff!.branchId],
    );
    return { jobs: result.rows };
  });

  app.get('/api/jobs/:id', { preHandler: app.requirePermission('jobs:read') }, async (request) => {
    const { id } = idSchema.parse(request.params);
    const result = await db.query(
      `SELECT j.id, j.job_number AS "jobNumber", j.customer_id AS "customerId", j.vehicle_id AS "vehicleId",
              j.branch_id AS "branchId", j.mileage_km AS "mileageKm", j.intake_condition AS "intakeCondition",
              j.arrival_method AS "arrivalMethod", j.return_method AS "returnMethod", j.lead_source AS "leadSource",
              EXISTS (SELECT 1 FROM avc.finding_batches b WHERE b.job_card_id = j.id AND b.status = 'awaiting_pricing')
                AS "awaitingPricing",
              j.status, j.vehicle_location AS "vehicleLocation", j.work_stage AS "workStage", j.version,
              j.created_at AS "createdAt", j.updated_at AS "updatedAt",
              c.full_name AS "customerName", c.mobile_number AS "customerMobile",
              v.vin, v.license_plate AS "licensePlate", v.make, v.model,
              s.display_name AS "responsibleStaffName"
       FROM avc.job_cards j JOIN avc.customers c ON c.id = j.customer_id
       JOIN avc.vehicles v ON v.id = j.vehicle_id
       JOIN avc.staff_members s ON s.id = j.responsible_staff_id WHERE j.id = $1`,
      [id],
    );
    const job = result.rows[0];
    if (!job) throw new AppError(404, 'JOB_NOT_FOUND', 'Job card was not found');
    assertBranchAccess(request.staff!, job.branchId);
    const events = await db.query(
      `SELECT e.id, e.job_version AS "jobVersion", e.event_type AS "eventType", e.from_status AS "fromStatus",
              e.to_status AS "toStatus", e.actor_type AS "actorType", e.actor_staff_id AS "actorStaffId",
              COALESCE(s.display_name, CASE e.actor_type WHEN 'customer' THEN 'Customer' ELSE 'System' END)
                AS "actorStaffName",
              e.occurred_at AS "occurredAt", e.details
       FROM avc.job_events e LEFT JOIN avc.staff_members s ON s.id = e.actor_staff_id
       WHERE e.job_card_id = $1 ORDER BY e.job_version`,
      [id],
    );
    return { job, events: events.rows };
  });
}
