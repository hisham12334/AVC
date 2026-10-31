import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { inTransaction } from '../db.js';
import { AppError } from '../errors.js';
import { emit } from '../integration/outbox.js';
import {
  assertBranchAccess,
  assertExpectedVersion,
  lockJob,
  recordEvent,
  type LockedJob,
} from '../jobs/lifecycle.js';

const idSchema = z.object({ id: z.uuid() });
// Findings carry no price. The technician describes and proves; the advisor prices.
const findingSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    detail: z.string().trim().max(2000).default(''),
    severity: z.enum(['critical', 'moderate', 'minor']),
    evidenceIds: z.array(z.uuid()).max(20).default([]),
  })
  .strict();
const submitSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    // An empty list means the inspection found nothing to report; the advisor may still add service lines.
    findings: z.array(findingSchema).max(100),
  })
  .strict();
const raiseSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    findings: z.array(findingSchema).min(1).max(20),
  })
  .strict();

type FindingInput = z.infer<typeof findingSchema>;

// Sales-plan rule: no photo or video, no authorization request for a yellow or red finding.
async function saveBatch(
  client: PoolClient,
  job: LockedJob,
  staffId: string,
  kind: 'initial' | 'addendum',
  findings: FindingInput[],
): Promise<string> {
  const batch = await client.query<{ id: string }>(
    `INSERT INTO avc.finding_batches(job_card_id, kind, submitted_by_staff_id) VALUES ($1,$2,$3) RETURNING id`,
    [job.id, kind, staffId],
  );
  const batchId = batch.rows[0]!.id;
  const used = new Set<string>();
  for (const [index, finding] of findings.entries()) {
    const needsProof = finding.severity !== 'minor';
    if (needsProof && finding.evidenceIds.length === 0)
      throw new AppError(
        422,
        'EVIDENCE_REQUIRED',
        `"${finding.title}" is ${finding.severity}; attach a photo or video first`,
      );
    const row = await client.query<{ id: string }>(
      `INSERT INTO avc.findings(batch_id, position, title, detail, severity) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [batchId, index + 1, finding.title, finding.detail, finding.severity],
    );
    for (const evidenceId of finding.evidenceIds) {
      if (used.has(evidenceId))
        throw new AppError(422, 'EVIDENCE_REUSED', 'Evidence can back only one finding');
      used.add(evidenceId);
    }
    if (finding.evidenceIds.length === 0) continue;
    const linked = await client.query(
      `UPDATE avc.evidence SET finding_id = $1
       WHERE id = ANY($2::uuid[]) AND job_card_id = $3 AND finding_id IS NULL AND quote_item_id IS NULL
         AND transfer_id IS NULL AND ($4::boolean = false OR kind IN ('photo', 'video'))`,
      [row.rows[0]!.id, finding.evidenceIds, job.id, needsProof],
    );
    if (linked.rowCount !== finding.evidenceIds.length)
      throw new AppError(
        422,
        'EVIDENCE_INVALID',
        'Evidence must belong to this job, be unused, and be a photo or video for yellow/red findings',
      );
  }
  return batchId;
}

export function registerInspectionRoutes(app: FastifyInstance, db: Pool): void {
  // The technician finishes the inspection. The customer now sees "inspection complete, preparing your
  // quote" and nothing else; findings and prices are released only when the advisor posts the quote.
  app.post(
    '/api/jobs/:id/inspection/submit',
    { preHandler: app.requirePermission('inspection:submit') },
    async (request, reply) => {
      const { id } = idSchema.parse(request.params);
      const input = submitSchema.parse(request.body);
      const result = await inTransaction(db, async (client) => {
        const job = await lockJob(client, id);
        assertBranchAccess(request.staff!, job.branchId);
        assertExpectedVersion(job, input.expectedVersion);
        if (job.stage !== 'inspection')
          throw new AppError(
            422,
            'INVALID_TRANSITION',
            'An inspection can only be submitted while the job is in inspection',
          );
        const batchId = await saveBatch(client, job, request.staff!.id, 'initial', input.findings);
        const next = await recordEvent(client, job, {
          type: 'inspection_submitted',
          actor: { type: 'staff', staffId: request.staff!.id },
          toStage: 'pricing',
          details: { batchId, findingCount: input.findings.length },
        });
        await emit(client, {
          branchId: job.branchId,
          type: 'inspection.completed',
          aggregateType: 'job',
          aggregateId: id,
          payload: {
            jobId: id,
            jobNumber: job.jobNumber,
            findingCount: input.findings.length,
            critical: input.findings.filter((f) => f.severity === 'critical').length,
          },
        });
        await emit(client, {
          branchId: job.branchId,
          type: 'job.stage_changed',
          aggregateType: 'job',
          aggregateId: id,
          payload: { jobId: id, jobNumber: job.jobNumber, from: 'inspection', to: 'pricing' },
        });
        return { batchId, version: next.version };
      });
      return reply.status(201).send({ batch: { id: result.batchId }, jobVersion: result.version });
    },
  );

  // Something new while the car is being worked on. The item is paused, the customer is told it is being
  // priced, and the advisor prices it through the normal quote step.
  app.post(
    '/api/jobs/:id/findings',
    { preHandler: app.requirePermission('findings:raise') },
    async (request, reply) => {
      const { id } = idSchema.parse(request.params);
      const input = raiseSchema.parse(request.body);
      const result = await inTransaction(db, async (client) => {
        const job = await lockJob(client, id);
        assertBranchAccess(request.staff!, job.branchId);
        assertExpectedVersion(job, input.expectedVersion);
        if (!['approved', 'in_bay', 'qc'].includes(job.stage))
          throw new AppError(
            422,
            'INVALID_TRANSITION',
            'New findings can only be raised once work is approved and before the car is ready',
          );
        const open = await client.query(
          `SELECT 1 FROM avc.quotes WHERE job_card_id = $1 AND status = 'sent'
           UNION ALL SELECT 1 FROM avc.finding_batches WHERE job_card_id = $1 AND status = 'awaiting_pricing'`,
          [id],
        );
        if (open.rowCount)
          throw new AppError(
            409,
            'FINDING_OPEN',
            'Another finding is still waiting for the customer',
          );
        const batchId = await saveBatch(client, job, request.staff!.id, 'addendum', input.findings);
        const next = await recordEvent(client, job, {
          type: 'finding_raised',
          actor: { type: 'staff', staffId: request.staff!.id },
          details: { batchId, findingCount: input.findings.length },
        });
        await emit(client, {
          branchId: job.branchId,
          type: 'finding.raised',
          aggregateType: 'job',
          aggregateId: id,
          payload: { jobId: id, jobNumber: job.jobNumber, findingCount: input.findings.length },
        });
        return { batchId, version: next.version };
      });
      return reply.status(201).send({ batch: { id: result.batchId }, jobVersion: result.version });
    },
  );

  // The technician's queue: cars to inspect or being worked on. No customer contact details and no prices.
  app.get(
    '/api/work/queue',
    { preHandler: app.requirePermission('findings:read') },
    async (request) => {
      const result = await db.query(
        `SELECT j.id, j.job_number::text AS "jobNumber", j.work_stage AS stage, j.version,
                j.updated_at AS "updatedAt", j.intake_condition AS "intakeCondition", j.mileage_km AS "mileageKm",
                v.make, v.model, v.model_year AS "modelYear", v.color, v.license_plate AS "licensePlate",
                EXISTS (SELECT 1 FROM avc.finding_batches b WHERE b.job_card_id = j.id AND b.status = 'awaiting_pricing')
                  AS "awaitingPricing",
                (SELECT COUNT(*) FROM avc.findings f JOIN avc.finding_batches b ON b.id = f.batch_id
                  WHERE b.job_card_id = j.id)::int AS "findingCount"
         FROM avc.job_cards j JOIN avc.vehicles v ON v.id = j.vehicle_id
         WHERE j.work_stage IN ('inspection', 'pricing', 'approved', 'in_bay', 'qc')
           AND ($1::uuid IS NULL OR j.branch_id = $1)
         ORDER BY j.updated_at DESC LIMIT 100`,
        [request.staff!.branchId],
      );
      return { jobs: result.rows };
    },
  );

  // Findings without prices: what the technician and the advisor both work from.
  app.get(
    '/api/jobs/:id/findings',
    { preHandler: app.requirePermission('findings:read') },
    async (request) => {
      const { id } = idSchema.parse(request.params);
      const job = await db.query<{ branchId: string }>(
        'SELECT branch_id AS "branchId" FROM avc.job_cards WHERE id = $1',
        [id],
      );
      if (!job.rows[0]) throw new AppError(404, 'JOB_NOT_FOUND', 'Job card was not found');
      assertBranchAccess(request.staff!, job.rows[0].branchId);
      const batches = await db.query(
        `SELECT id, kind, status, submitted_at AS "submittedAt", priced_at AS "pricedAt"
         FROM avc.finding_batches WHERE job_card_id = $1 ORDER BY submitted_at`,
        [id],
      );
      const findings = await db.query(
        `SELECT f.id, f.batch_id AS "batchId", f.position, f.title, f.detail, f.severity,
                COALESCE(json_agg(json_build_object('id', e.id, 'kind', e.kind, 'caption', e.caption,
                  'storageKey', e.storage_key) ORDER BY e.captured_at) FILTER (WHERE e.id IS NOT NULL), '[]') AS evidence
         FROM avc.findings f JOIN avc.finding_batches b ON b.id = f.batch_id
         LEFT JOIN avc.evidence e ON e.finding_id = f.id
         WHERE b.job_card_id = $1 GROUP BY f.id ORDER BY f.batch_id, f.position`,
        [id],
      );
      return {
        batches: batches.rows.map((b) => ({
          ...b,
          findings: findings.rows.filter((f) => f.batchId === b.id),
        })),
      };
    },
  );
}
