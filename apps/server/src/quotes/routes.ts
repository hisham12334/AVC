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
    title: z.string().trim().min(1).max(200),
    detail: z.string().trim().max(2000).default(''),
    severity: z.enum(['critical', 'moderate', 'minor']),
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

type QuoteInput = z.infer<typeof quoteSchema>;

// Sales-plan rule: no photo or video, no authorization request for a yellow or red item.
async function attachEvidence(
  client: PoolClient,
  jobId: string,
  itemIds: string[],
  items: QuoteInput['items'],
): Promise<void> {
  const used = new Set<string>();
  for (const [index, item] of items.entries()) {
    const needsProof = item.severity !== 'minor';
    if (needsProof && item.evidenceIds.length === 0)
      throw new AppError(
        422,
        'EVIDENCE_REQUIRED',
        `"${item.title}" is ${item.severity}; attach a photo or video before asking for approval`,
      );
    for (const evidenceId of item.evidenceIds) {
      if (used.has(evidenceId))
        throw new AppError(422, 'EVIDENCE_REUSED', 'Evidence can back only one quote item');
      used.add(evidenceId);
    }
    if (item.evidenceIds.length === 0) continue;
    const linked = await client.query(
      `UPDATE avc.evidence SET quote_item_id = $1
       WHERE id = ANY($2::uuid[]) AND job_card_id = $3 AND quote_item_id IS NULL
         AND ($4::boolean = false OR kind IN ('photo', 'video'))`,
      [itemIds[index], item.evidenceIds, jobId, needsProof],
    );
    if (linked.rowCount !== item.evidenceIds.length)
      throw new AppError(
        422,
        'EVIDENCE_INVALID',
        'Evidence must belong to this job, be unused, and be a photo or video for yellow/red items',
      );
  }
}

async function createQuote(
  client: PoolClient,
  job: LockedJob,
  staffId: string,
  kind: 'initial' | 'addendum',
  items: QuoteInput['items'],
): Promise<{ quoteId: string; version: number; totalAed: number }> {
  const open = await client.query(
    "SELECT 1 FROM avc.quotes WHERE job_card_id = $1 AND status = 'sent'",
    [job.id],
  );
  if (open.rowCount)
    throw new AppError(409, 'QUOTE_OPEN', 'A quote is already waiting for the customer');
  const next = await client.query<{ version: number }>(
    'SELECT COALESCE(MAX(version), 0) + 1 AS version FROM avc.quotes WHERE job_card_id = $1',
    [job.id],
  );
  const version = next.rows[0]!.version;
  const quote = await client.query<{ id: string }>(
    `INSERT INTO avc.quotes(job_card_id, version, kind, status, sent_by_staff_id)
     VALUES ($1,$2,$3,'sent',$4) RETURNING id`,
    [job.id, version, kind, staffId],
  );
  const quoteId = quote.rows[0]!.id;
  const itemIds: string[] = [];
  for (const [index, item] of items.entries()) {
    const row = await client.query<{ id: string }>(
      `INSERT INTO avc.quote_items(quote_id, position, title, detail, severity, price_aed)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [quoteId, index + 1, item.title, item.detail, item.severity, item.priceAed],
    );
    itemIds.push(row.rows[0]!.id);
  }
  await attachEvidence(client, job.id, itemIds, items);
  const totalAed = items.reduce((sum, i) => sum + Math.round(i.priceAed * 100), 0) / 100;
  return { quoteId, version, totalAed };
}

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

  // Publish the first quote after inspection. Moves the job to `quote` and returns the customer's link.
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
        if (job.stage !== 'inspection')
          throw new AppError(
            422,
            'INVALID_TRANSITION',
            'A quote can only be published while the job is in inspection',
          );
        const quote = await createQuote(client, job, request.staff!.id, 'initial', input.items);
        const link = await issueCustomerLink(client, id, request.staff!.id);
        const next = await recordEvent(client, job, {
          type: 'quote_sent',
          actor: { type: 'staff', staffId: request.staff!.id },
          toStage: 'quote',
          details: { quoteId: quote.quoteId, quoteVersion: quote.version, kind: 'initial' },
        });
        await emit(client, {
          branchId: job.branchId,
          type: 'quote.sent',
          aggregateType: 'quote',
          aggregateId: quote.quoteId,
          payload: {
            jobId: id,
            jobNumber: job.jobNumber,
            quoteId: quote.quoteId,
            version: quote.version,
            kind: 'initial',
            itemCount: input.items.length,
            totalAed: quote.totalAed,
          },
        });
        await emit(client, {
          branchId: job.branchId,
          type: 'job.stage_changed',
          aggregateType: 'job',
          aggregateId: id,
          payload: { jobId: id, jobNumber: job.jobNumber, from: 'inspection', to: 'quote' },
        });
        return { quote, link, version: next.version };
      });
      return reply.status(201).send({
        quote: { id: result.quote.quoteId, version: result.quote.version, kind: 'initial' },
        jobVersion: result.version,
        customerLink: {
          token: result.link.token,
          path: result.link.path,
          expiresAt: result.link.expiresAt,
        },
      });
    },
  );

  // A technician finds something new mid-repair. The job keeps its stage, but work on the new item
  // must wait for the customer's yes or no (an open quote also blocks advancing the job).
  app.post(
    '/api/jobs/:id/findings',
    { preHandler: app.requirePermission('findings:raise') },
    async (request, reply) => {
      const { id } = idSchema.parse(request.params);
      const input = quoteSchema.parse(request.body);
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
        const quote = await createQuote(client, job, request.staff!.id, 'addendum', input.items);
        const next = await recordEvent(client, job, {
          type: 'finding_raised',
          actor: { type: 'staff', staffId: request.staff!.id },
          details: { quoteId: quote.quoteId, quoteVersion: quote.version, kind: 'addendum' },
        });
        await emit(client, {
          branchId: job.branchId,
          type: 'quote.sent',
          aggregateType: 'quote',
          aggregateId: quote.quoteId,
          payload: {
            jobId: id,
            jobNumber: job.jobNumber,
            quoteId: quote.quoteId,
            version: quote.version,
            kind: 'addendum',
            itemCount: input.items.length,
            totalAed: quote.totalAed,
          },
        });
        return { quote, version: next.version };
      });
      return reply.status(201).send({
        quote: { id: result.quote.quoteId, version: result.quote.version, kind: 'addendum' },
        jobVersion: result.version,
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

  // Re-issue the customer's tracking link (it is shown only once). Earlier links stop working.
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
