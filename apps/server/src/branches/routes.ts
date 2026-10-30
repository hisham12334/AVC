import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';

const createSchema = z
  .object({
    code: z.string().regex(/^[a-z0-9_]{2,32}$/, 'Code must be 2-32 lowercase letters, digits or _'),
    name: z.string().trim().min(1).max(120),
    timezone: z.string().trim().min(1).max(64).default('Asia/Dubai'),
    bayCapacity: z.number().int().min(1).max(1000),
  })
  .strict();

const columns = `id, code, name, timezone, bay_capacity AS "bayCapacity", active, created_at AS "createdAt"`;

export function registerBranchRoutes(app: FastifyInstance, db: Pool): void {
  app.get(
    '/api/branches',
    { preHandler: app.requirePermission('branches:read') },
    async (request) => {
      const result = await db.query(
        `SELECT ${columns} FROM avc.branches WHERE active AND ($1::uuid IS NULL OR id = $1) ORDER BY name`,
        [request.staff!.branchId],
      );
      return { branches: result.rows };
    },
  );

  // Adding an outlet is configuration, not a code change: new branch rows scope jobs, bays and KPIs.
  app.post(
    '/api/branches',
    { preHandler: app.requirePermission('branches:manage') },
    async (request, reply) => {
      const input = createSchema.parse(request.body);
      const result = await db.query(
        `INSERT INTO avc.branches(code, name, timezone, bay_capacity) VALUES ($1,$2,$3,$4) RETURNING ${columns}`,
        [input.code, input.name, input.timezone, input.bayCapacity],
      );
      return reply.status(201).send({ branch: result.rows[0] });
    },
  );
}
