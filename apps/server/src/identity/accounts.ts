import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { hashPassword, spendHashTime, verifyPassword } from '../portal/passwords.js';
import { STAFF_ROLES } from './permissions.js';
import { hashStaffToken, issueStaffSession, revokeStaffSessions } from './sessions.js';

const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

const loginSchema = z
  .object({
    email: z.string().trim().toLowerCase().max(200),
    password: z.string().min(1).max(200),
  })
  .strict();
const passwordSchema = z
  .object({
    currentPassword: z.string().min(1).max(200),
    newPassword: z.string().min(10).max(200),
  })
  .strict();
const roleSchema = z.enum(STAFF_ROLES);
const createSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120),
    email: z.string().trim().toLowerCase().max(200).pipe(z.email()),
    role: roleSchema,
    branchId: z.uuid().nullable().default(null),
    // Omit to have one generated; either way it is shown once and must be changed at first sign-in.
    temporaryPassword: z.string().min(10).max(200).optional(),
  })
  .strict();
const updateSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120).optional(),
    role: roleSchema.optional(),
    branchId: z.uuid().nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict();
const idSchema = z.object({ id: z.uuid() });

const memberColumns = `id, display_name AS "displayName", email, role, branch_id AS "branchId",
  active, must_change_password AS "mustChangePassword", last_login_at AS "lastLoginAt",
  created_at AS "createdAt"`;

const generatePassword = (): string => randomBytes(9).toString('base64url');
const bearer = (header: string | undefined): string => (header ?? '').slice(7);

export function registerStaffAccountRoutes(app: FastifyInstance, db: Pool): void {
  const loginFailure = () =>
    new AppError(
      401,
      'INVALID_LOGIN',
      'Email or password is incorrect, or the account is temporarily locked',
    );

  async function assertBranch(branchId: string | null | undefined): Promise<void> {
    if (!branchId) return;
    const branch = await db.query('SELECT 1 FROM avc.branches WHERE id = $1 AND active', [
      branchId,
    ]);
    if (!branch.rowCount) throw new AppError(400, 'BRANCH_NOT_FOUND', 'Branch was not found');
  }

  app.post('/api/auth/login', async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const found = await db.query<{
      id: string;
      password_hash: string | null;
      active: boolean;
      locked_until: Date | null;
    }>(
      'SELECT id, password_hash, active, locked_until FROM avc.staff_members WHERE lower(email) = $1',
      [input.email],
    );
    const member = found.rows[0];
    if (!member?.password_hash || !member.active) {
      await spendHashTime(input.password);
      throw loginFailure();
    }
    if (member.locked_until && member.locked_until > new Date()) {
      await spendHashTime(input.password);
      throw loginFailure();
    }
    if (!(await verifyPassword(input.password, member.password_hash))) {
      await db.query(
        `UPDATE avc.staff_members SET
           failed_attempts = CASE WHEN failed_attempts + 1 >= $2 THEN 0 ELSE failed_attempts + 1 END,
           locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + make_interval(mins => $3) END
         WHERE id = $1`,
        [member.id, MAX_FAILURES, LOCK_MINUTES],
      );
      throw loginFailure();
    }
    await db.query(
      'UPDATE avc.staff_members SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1',
      [member.id],
    );
    const session = await issueStaffSession(db, member.id);
    reply.header('cache-control', 'no-store');
    return session;
  });

  app.post(
    '/api/auth/logout',
    { preHandler: app.requirePermission('staff:self') },
    async (request, reply) => {
      await db.query('UPDATE avc.staff_sessions SET revoked_at = now() WHERE token_hash = $1', [
        hashStaffToken(bearer(request.headers.authorization)),
      ]);
      return reply.status(204).send();
    },
  );

  app.post(
    '/api/auth/password',
    { preHandler: app.requirePermission('staff:self') },
    async (request, reply) => {
      const input = passwordSchema.parse(request.body);
      const row = await db.query<{ password_hash: string | null }>(
        'SELECT password_hash FROM avc.staff_members WHERE id = $1',
        [request.staff!.id],
      );
      const hash = row.rows[0]?.password_hash;
      if (!hash || !(await verifyPassword(input.currentPassword, hash)))
        throw new AppError(400, 'WRONG_PASSWORD', 'Your current password is incorrect');
      if (input.newPassword === input.currentPassword)
        throw new AppError(
          400,
          'SAME_PASSWORD',
          'Choose a password different from the current one',
        );
      await db.query(
        'UPDATE avc.staff_members SET password_hash = $2, must_change_password = false WHERE id = $1',
        [request.staff!.id, await hashPassword(input.newPassword)],
      );
      // Other devices sign out; this one keeps its session.
      await db.query(
        'UPDATE avc.staff_sessions SET revoked_at = now() WHERE staff_id = $1 AND token_hash <> $2 AND revoked_at IS NULL',
        [request.staff!.id, hashStaffToken(bearer(request.headers.authorization))],
      );
      return reply.status(204).send();
    },
  );

  // ---- super admin: accounts, roles, branches ----
  const manage = { preHandler: app.requirePermission('staff:manage') };

  // Keeps at least one active super admin so nobody can lock the organisation out.
  async function assertNotLastSuperAdmin(id: string): Promise<void> {
    const others = await db.query(
      "SELECT 1 FROM avc.staff_members WHERE role = 'super_admin' AND active AND id <> $1",
      [id],
    );
    if (!others.rowCount)
      throw new AppError(409, 'LAST_SUPER_ADMIN', 'There must always be one active super admin');
  }

  app.get('/api/admin/staff', manage, async () => {
    const result = await db.query(
      `SELECT ${memberColumns} FROM avc.staff_members ORDER BY active DESC, display_name`,
    );
    return { staff: result.rows };
  });

  app.post('/api/admin/staff', manage, async (request, reply) => {
    const input = createSchema.parse(request.body);
    const temporary = input.temporaryPassword ?? generatePassword();
    const taken = await db.query('SELECT 1 FROM avc.staff_members WHERE lower(email) = $1', [
      input.email,
    ]);
    if (taken.rowCount)
      throw new AppError(409, 'EMAIL_IN_USE', 'A staff account with this email already exists');
    await assertBranch(input.branchId);
    const created = await db.query(
      `INSERT INTO avc.staff_members(external_subject, display_name, email, role, branch_id, password_hash, must_change_password)
       VALUES ('local:' || gen_random_uuid(), $1, $2, $3, $4, $5, true)
       RETURNING ${memberColumns}`,
      [input.displayName, input.email, input.role, input.branchId, await hashPassword(temporary)],
    );
    reply.header('cache-control', 'no-store');
    return reply.status(201).send({ staff: created.rows[0], temporaryPassword: temporary });
  });

  app.patch('/api/admin/staff/:id', manage, async (request) => {
    const { id } = idSchema.parse(request.params);
    const input = updateSchema.parse(request.body);
    const current = await db.query<{ role: string; active: boolean }>(
      'SELECT role, active FROM avc.staff_members WHERE id = $1',
      [id],
    );
    const member = current.rows[0];
    if (!member) throw new AppError(404, 'STAFF_NOT_FOUND', 'Staff member was not found');
    const losesSuperAdmin =
      member.role === 'super_admin' &&
      member.active &&
      ((input.role !== undefined && input.role !== 'super_admin') || input.active === false);
    if (losesSuperAdmin) await assertNotLastSuperAdmin(id);
    await assertBranch(input.branchId);
    const updated = await db.query(
      `UPDATE avc.staff_members SET
         display_name = COALESCE($2, display_name),
         role = COALESCE($3, role),
         branch_id = CASE WHEN $4::boolean THEN $5::uuid ELSE branch_id END,
         active = COALESCE($6, active)
       WHERE id = $1 RETURNING ${memberColumns}`,
      [
        id,
        input.displayName ?? null,
        input.role ?? null,
        input.branchId !== undefined,
        input.branchId ?? null,
        input.active ?? null,
      ],
    );
    if (input.active === false) await revokeStaffSessions(db, id);
    return { staff: updated.rows[0] };
  });

  app.post('/api/admin/staff/:id/reset-password', manage, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const temporary = generatePassword();
    const updated = await db.query(
      `UPDATE avc.staff_members SET password_hash = $2, must_change_password = true,
         failed_attempts = 0, locked_until = NULL
       WHERE id = $1 AND email IS NOT NULL RETURNING id`,
      [id, await hashPassword(temporary)],
    );
    if (!updated.rowCount)
      throw new AppError(
        404,
        'STAFF_NOT_FOUND',
        'Staff member was not found or has no email login',
      );
    await revokeStaffSessions(db, id);
    reply.header('cache-control', 'no-store');
    return { temporaryPassword: temporary };
  });
}
