import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { AppError } from '../errors.js';

const id = z.object({ id: z.uuid() });
const followupUpdate = z
  .object({
    status: z.enum(['open', 'contacted', 'booked', 'dismissed']).optional(),
    dueAt: z.iso.datetime().optional(),
  })
  .strict()
  .refine((v) => v.status !== undefined || v.dueAt !== undefined);
const actionUpdate = z
  .object({
    nextAction: z.string().trim().max(500),
    ownerStaffId: z.uuid().nullable(),
    promisedAt: z.iso.datetime().nullable(),
  })
  .strict();

export function registerEngagementRoutes(app: FastifyInstance, db: Pool): void {
  app.get(
    '/api/engagement/followups',
    { preHandler: app.requirePermission('followups:read') },
    async (request) => {
      const rows = await db.query(
        `SELECT f.id, f.kind, f.title, f.due_at AS "dueAt", f.status,
        f.customer_id AS "customerId", c.full_name AS "customerName", c.mobile_number AS "mobileNumber",
        c.service_reminders_opt_in AS "remindersOptIn", v.make, v.model, v.license_plate AS "licensePlate",
        j.job_number::text AS "jobNumber", j.id AS "jobId"
      FROM avc.service_followups f JOIN avc.customers c ON c.id = f.customer_id
      JOIN avc.vehicles v ON v.id = f.vehicle_id JOIN avc.job_cards j ON j.id = f.source_job_id
      WHERE ($1::uuid IS NULL OR j.branch_id = $1) AND f.status <> 'dismissed'
      ORDER BY (f.status = 'open') DESC, f.due_at ASC LIMIT 200`,
        [request.staff!.branchId],
      );
      return { followups: rows.rows };
    },
  );

  app.patch(
    '/api/engagement/followups/:id',
    { preHandler: app.requirePermission('followups:manage') },
    async (request) => {
      const { id: followupId } = id.parse(request.params);
      const input = followupUpdate.parse(request.body);
      const result = await db.query(
        `UPDATE avc.service_followups f SET
        status = COALESCE($2, f.status), due_at = COALESCE($3::timestamptz, f.due_at),
        contacted_at = CASE WHEN $2 = 'contacted' THEN now() ELSE f.contacted_at END,
        booked_at = CASE WHEN $2 = 'booked' THEN now() ELSE f.booked_at END
      FROM avc.job_cards j WHERE f.id = $1 AND j.id = f.source_job_id
        AND ($4::uuid IS NULL OR j.branch_id = $4)
      RETURNING f.id, f.status, f.due_at AS "dueAt"`,
        [followupId, input.status ?? null, input.dueAt ?? null, request.staff!.branchId],
      );
      if (!result.rows[0]) throw new AppError(404, 'FOLLOWUP_NOT_FOUND', 'Follow-up was not found');
      return { followup: result.rows[0] };
    },
  );

  app.get(
    '/api/engagement/messages',
    { preHandler: app.requirePermission('followups:read') },
    async (request) => {
      const result = await db.query(
        `SELECT m.id, m.kind, m.subject, m.status, m.attempts,
        m.last_error AS "lastError", m.created_at AS "createdAt", m.sent_at AS "sentAt",
        c.full_name AS "customerName", j.job_number::text AS "jobNumber"
      FROM avc.customer_messages m JOIN avc.customers c ON c.id = m.customer_id
      LEFT JOIN avc.job_cards j ON j.id = m.job_card_id
      WHERE ($1::uuid IS NULL OR j.branch_id = $1)
      ORDER BY m.created_at DESC LIMIT 100`,
        [request.staff!.branchId],
      );
      return { messages: result.rows };
    },
  );

  app.get(
    '/api/control-tower',
    { preHandler: app.requirePermission('dashboard:read') },
    async (request) => {
      const result = await db.query(
        `SELECT j.id, j.job_number::text AS "jobNumber", j.work_stage AS stage,
        j.created_at AS "createdAt", j.updated_at AS "updatedAt", c.full_name AS "customerName",
        v.make, v.model, v.license_plate AS "licensePlate",
        p.next_action AS "nextAction", p.promised_at AS "promisedAt", p.owner_staff_id AS "ownerStaffId",
        COALESCE(owner.display_name, responsible.display_name) AS "ownerName",
        CASE WHEN EXISTS (SELECT 1 FROM avc.finding_batches b WHERE b.job_card_id = j.id AND b.status = 'awaiting_pricing') THEN 'Needs pricing'
          WHEN EXISTS (SELECT 1 FROM avc.quotes q WHERE q.job_card_id = j.id AND q.status = 'sent') THEN 'Waiting for customer decision'
          WHEN j.work_stage = 'inspection' THEN 'Inspection in progress'
          WHEN j.work_stage = 'qc' THEN 'Quality check'
          WHEN j.work_stage = 'ready' THEN 'Ready for handover'
          ELSE 'Work in progress' END AS blocker,
        (p.promised_at < now()) AS overdue,
        CASE WHEN j.work_stage = 'pricing' THEN j.updated_at < now() - interval '2 hours'
          WHEN j.work_stage = 'quote' THEN j.updated_at < now() - interval '24 hours'
          WHEN j.work_stage = 'inspection' THEN j.updated_at < now() - interval '8 hours'
          WHEN j.work_stage = 'qc' THEN j.updated_at < now() - interval '4 hours'
          ELSE j.updated_at < now() - interval '48 hours' END AS "needsAttention"
      FROM avc.job_cards j JOIN avc.customers c ON c.id = j.customer_id
      JOIN avc.vehicles v ON v.id = j.vehicle_id
      JOIN avc.staff_members responsible ON responsible.id = j.responsible_staff_id
      LEFT JOIN avc.job_action_plans p ON p.job_card_id = j.id
      LEFT JOIN avc.staff_members owner ON owner.id = p.owner_staff_id
      WHERE j.work_stage <> 'delivered' AND ($1::uuid IS NULL OR j.branch_id = $1)
      ORDER BY (p.promised_at < now()) DESC NULLS LAST, j.updated_at ASC LIMIT 200`,
        [request.staff!.branchId],
      );
      return { jobs: result.rows };
    },
  );

  app.get(
    '/api/control-tower/staff',
    { preHandler: app.requirePermission('dashboard:read') },
    async (request) => {
      const result = await db.query(
        `SELECT id, display_name AS "displayName" FROM avc.staff_members
      WHERE active AND ($1::uuid IS NULL OR branch_id IS NULL OR branch_id = $1)
      ORDER BY display_name`,
        [request.staff!.branchId],
      );
      return { staff: result.rows };
    },
  );

  app.patch(
    '/api/control-tower/:id',
    { preHandler: app.requirePermission('control_tower:manage') },
    async (request) => {
      const { id: jobId } = id.parse(request.params);
      const input = actionUpdate.parse(request.body);
      const job = await db.query<{ branchId: string; stage: string }>(
        'SELECT branch_id AS "branchId", work_stage AS stage FROM avc.job_cards WHERE id = $1',
        [jobId],
      );
      if (
        !job.rows[0] ||
        (request.staff!.branchId && job.rows[0].branchId !== request.staff!.branchId)
      )
        throw new AppError(404, 'JOB_NOT_FOUND', 'Job was not found');
      if (job.rows[0].stage === 'delivered')
        throw new AppError(422, 'JOB_CLOSED', 'This job is complete');
      if (input.ownerStaffId) {
        const owner = await db.query(
          'SELECT 1 FROM avc.staff_members WHERE id = $1 AND active AND (branch_id IS NULL OR branch_id = $2)',
          [input.ownerStaffId, job.rows[0].branchId],
        );
        if (!owner.rowCount)
          throw new AppError(422, 'OWNER_INVALID', 'Owner must be active in this branch');
      }
      await db.query(
        `INSERT INTO avc.job_action_plans(job_card_id, next_action, owner_staff_id, promised_at, updated_by_staff_id)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT (job_card_id) DO UPDATE SET next_action = EXCLUDED.next_action,
      owner_staff_id = EXCLUDED.owner_staff_id, promised_at = EXCLUDED.promised_at,
      updated_by_staff_id = EXCLUDED.updated_by_staff_id, updated_at = now()`,
        [jobId, input.nextAction, input.ownerStaffId, input.promisedAt, request.staff!.id],
      );
      return { saved: true };
    },
  );
}
