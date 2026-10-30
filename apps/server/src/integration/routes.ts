import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { readEvents, START_CURSOR } from './outbox.js';
import { assertPublicHttpsUrl, EVENT_TYPES } from './webhooks.js';

const idSchema = z.object({ id: z.uuid() });
const keySchema = z.object({ name: z.string().trim().min(1).max(100) }).strict();
const webhookSchema = z
  .object({
    url: z.string().trim().max(500),
    eventTypes: z.array(z.enum(EVENT_TYPES)).max(EVENT_TYPES.length).default([]),
  })
  .strict();
const eventsQuery = z.object({
  cursor: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  types: z
    .string()
    .max(300)
    .optional()
    .transform((v) => (v ? v.split(',').map((t) => t.trim()) : []))
    .pipe(z.array(z.enum(EVENT_TYPES))),
});

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

// Integration clients authenticate with an AVC API key, never with a staff token.
async function authenticateApiKey(db: Pool, request: FastifyRequest, scope: string): Promise<void> {
  const header = request.headers.authorization ?? '';
  const match = /^Bearer (avck_([a-f0-9]{8})_[A-Za-z0-9_-]{43})$/.exec(header);
  if (!match) throw new AppError(401, 'API_KEY_REQUIRED', 'A valid API key is required');
  const row = await db.query<{ id: string; keyHash: string; scopes: string[] }>(
    `SELECT id, key_hash AS "keyHash", scopes FROM avc.api_keys
     WHERE key_prefix = $1 AND revoked_at IS NULL`,
    [match[2]],
  );
  const key = row.rows[0];
  const expected = Buffer.from(key?.keyHash ?? '0'.repeat(64), 'hex');
  const actual = Buffer.from(sha256(match[1]!), 'hex');
  if (!key || expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new AppError(401, 'API_KEY_INVALID', 'The API key is not valid');
  if (!key.scopes.includes(scope))
    throw new AppError(403, 'API_KEY_SCOPE', 'The API key cannot perform this action');
  await db.query(
    `UPDATE avc.api_keys SET last_used_at = now()
     WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
    [key.id],
  );
}

export function registerIntegrationRoutes(app: FastifyInstance, db: Pool): void {
  // ----- admin: manage keys and webhook subscriptions (staff sign-in required) -----
  app.post(
    '/api/integration/api-keys',
    { preHandler: app.requirePermission('integrations:manage') },
    async (request, reply) => {
      const { name } = keySchema.parse(request.body);
      const prefix = randomBytes(4).toString('hex');
      const key = `avck_${prefix}_${randomBytes(32).toString('base64url')}`;
      const created = await db.query(
        `INSERT INTO avc.api_keys(name, key_prefix, key_hash, scopes, created_by_staff_id)
         VALUES ($1,$2,$3,ARRAY['events:read'],$4)
         RETURNING id, name, key_prefix AS prefix, scopes, created_at AS "createdAt"`,
        [name, prefix, sha256(key), request.staff!.id],
      );
      // The key is shown once; only its hash is stored.
      return reply.status(201).send({ apiKey: created.rows[0], secret: key });
    },
  );

  app.get(
    '/api/integration/api-keys',
    { preHandler: app.requirePermission('integrations:manage') },
    async () => {
      const result = await db.query(
        `SELECT id, name, key_prefix AS prefix, scopes, created_at AS "createdAt",
                last_used_at AS "lastUsedAt", revoked_at AS "revokedAt"
         FROM avc.api_keys ORDER BY created_at DESC`,
      );
      return { apiKeys: result.rows };
    },
  );

  app.delete(
    '/api/integration/api-keys/:id',
    { preHandler: app.requirePermission('integrations:manage') },
    async (request, reply) => {
      const { id } = idSchema.parse(request.params);
      const result = await db.query(
        'UPDATE avc.api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
        [id],
      );
      if (!result.rowCount) throw new AppError(404, 'API_KEY_NOT_FOUND', 'API key was not found');
      return reply.status(204).send();
    },
  );

  app.post(
    '/api/integration/webhooks',
    { preHandler: app.requirePermission('integrations:manage') },
    async (request, reply) => {
      const input = webhookSchema.parse(request.body);
      assertPublicHttpsUrl(input.url);
      const secret = `whsec_${randomBytes(32).toString('base64url')}`;
      // A new subscription receives events from now on, not the whole history.
      const created = await db.query(
        `INSERT INTO avc.webhook_endpoints(url, signing_secret, event_types, created_by_staff_id,
                                           cursor_txid, cursor_seq)
         SELECT $1::text, $2::text, $3::text[], $4::uuid,
                COALESCE(MAX(txid), 0), COALESCE(MAX(seq) FILTER (WHERE txid = (SELECT MAX(txid) FROM avc.outbox_events)), 0)
         FROM avc.outbox_events
         RETURNING id, url, event_types AS "eventTypes", active, created_at AS "createdAt"`,
        [input.url, secret, input.eventTypes, request.staff!.id],
      );
      return reply.status(201).send({ webhook: created.rows[0], signingSecret: secret });
    },
  );

  app.get(
    '/api/integration/webhooks',
    { preHandler: app.requirePermission('integrations:manage') },
    async () => {
      const result = await db.query(
        `SELECT id, url, event_types AS "eventTypes", active, failure_count AS "failureCount",
                last_error AS "lastError", next_attempt_at AS "nextAttemptAt", created_at AS "createdAt"
         FROM avc.webhook_endpoints ORDER BY created_at DESC`,
      );
      return { webhooks: result.rows };
    },
  );

  app.delete(
    '/api/integration/webhooks/:id',
    { preHandler: app.requirePermission('integrations:manage') },
    async (request, reply) => {
      const { id } = idSchema.parse(request.params);
      const result = await db.query(
        'UPDATE avc.webhook_endpoints SET active = false WHERE id = $1 AND active',
        [id],
      );
      if (!result.rowCount) throw new AppError(404, 'WEBHOOK_NOT_FOUND', 'Webhook was not found');
      return reply.status(204).send();
    },
  );

  // ----- external systems (Zoho CRM sync, middleware): pull the event feed with an API key -----
  app.get('/api/integration/events', async (request, reply) => {
    await authenticateApiKey(db, request, 'events:read');
    const query = eventsQuery.parse(request.query);
    const page = await readEvents(db, {
      cursor: query.cursor ?? START_CURSOR,
      limit: query.limit,
      types: query.types,
    });
    reply.header('cache-control', 'no-store');
    return page;
  });
}
