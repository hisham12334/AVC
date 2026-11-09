import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { buildBill } from '../bills/bill.js';
import { AppError } from '../errors.js';
import { buildJobView, submitDecisions } from '../track/service.js';
import { digitsOnly, hashPassword, spendHashTime, verifyPassword } from './passwords.js';
import { authenticateCustomer, issueCustomerToken, type CustomerPrincipal } from './tokens.js';

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
    newPassword: z.string().min(8).max(200),
  })
  .strict();
const idSchema = z.object({ id: z.uuid() });
const reminderPreferenceSchema = z.object({ enabled: z.boolean() }).strict();

type AccountRow = {
  customerId: string;
  fullName: string;
  email: string;
  mobile: string;
  passwordHash: string;
  passwordIsDefault: boolean;
  lockedUntil: Date | null;
};

// The starting password is the mobile number, and people type it with spaces or a +, so while the
// password is still the default we also accept the digits-only form of what was typed.
async function passwordMatches(account: AccountRow, attempt: string): Promise<boolean> {
  if (await verifyPassword(attempt, account.passwordHash)) return true;
  return (
    account.passwordIsDefault && (await verifyPassword(digitsOnly(attempt), account.passwordHash))
  );
}

export function registerPortalRoutes(app: FastifyInstance, db: Pool): void {
  async function ownedJob(principal: CustomerPrincipal, jobId: string): Promise<void> {
    const owned = await db.query('SELECT 1 FROM avc.job_cards WHERE id = $1 AND customer_id = $2', [
      jobId,
      principal.customerId,
    ]);
    // Another customer's job looks the same as a job that does not exist.
    if (!owned.rowCount) throw new AppError(404, 'JOB_NOT_FOUND', 'Job was not found');
  }

  app.post('/api/portal/login', async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const found = await db.query<AccountRow>(
      `SELECT c.id AS "customerId", c.full_name AS "fullName", c.email, c.mobile_number AS mobile,
              a.password_hash AS "passwordHash", a.password_is_default AS "passwordIsDefault",
              a.locked_until AS "lockedUntil"
       FROM avc.customers c JOIN avc.customer_accounts a ON a.customer_id = c.id
       WHERE lower(c.email) = $1`,
      [input.email],
    );
    const account = found.rows[0];
    const failure = new AppError(
      401,
      'INVALID_LOGIN',
      'Email or password is incorrect, or the account is temporarily locked',
    );
    if (!account) {
      await spendHashTime(input.password);
      throw failure;
    }
    if (account.lockedUntil && account.lockedUntil > new Date()) {
      await spendHashTime(input.password);
      throw failure;
    }
    if (!(await passwordMatches(account, input.password))) {
      await db.query(
        `UPDATE avc.customer_accounts SET
           failed_attempts = CASE WHEN failed_attempts + 1 >= $2 THEN 0 ELSE failed_attempts + 1 END,
           locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + make_interval(mins => $3) END
         WHERE customer_id = $1`,
        [account.customerId, MAX_FAILURES, LOCK_MINUTES],
      );
      throw failure;
    }
    await db.query(
      'UPDATE avc.customer_accounts SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE customer_id = $1',
      [account.customerId],
    );
    const session = await issueCustomerToken(db, account.customerId, 'session', null);
    reply.header('cache-control', 'no-store');
    return {
      token: session.token,
      expiresAt: session.expiresAt,
      customer: { id: account.customerId, fullName: account.fullName, email: account.email },
      passwordIsDefault: account.passwordIsDefault,
    };
  });

  app.post('/api/portal/logout', async (request, reply) => {
    const principal = await authenticateCustomer(db, request);
    if (principal.kind === 'session')
      await db.query('UPDATE avc.customer_tokens SET revoked_at = now() WHERE id = $1', [
        principal.tokenId,
      ]);
    return reply.status(204).send();
  });

  // The profile: the customer, their vehicles and every job, newest first.
  app.get('/api/portal/me', async (request, reply) => {
    const principal = await authenticateCustomer(db, request);
    const customer = await db.query(
      `SELECT c.id, c.full_name AS "fullName", c.email, c.mobile_number AS "mobileNumber",
              a.password_is_default AS "passwordIsDefault",
              c.service_reminders_opt_in AS "serviceRemindersOptIn"
       FROM avc.customers c JOIN avc.customer_accounts a ON a.customer_id = c.id WHERE c.id = $1`,
      [principal.customerId],
    );
    const vehicles = await db.query(
      `SELECT id, make, model, model_year AS "modelYear", color, vin, license_plate AS "licensePlate"
       FROM avc.vehicles WHERE customer_id = $1 ORDER BY created_at`,
      [principal.customerId],
    );
    const jobs = await db.query(
      `SELECT j.id, j.job_number::text AS "jobNumber", j.work_stage AS stage, j.created_at AS "createdAt",
              j.updated_at AS "updatedAt", j.mileage_km AS "mileageKm",
              j.intake_condition AS "intakeCondition", v.make, v.model, v.license_plate AS "licensePlate",
              EXISTS (SELECT 1 FROM avc.quotes q WHERE q.job_card_id = j.id AND q.status = 'sent') AS "awaitingYou"
       FROM avc.job_cards j JOIN avc.vehicles v ON v.id = j.vehicle_id
       WHERE j.customer_id = $1 ORDER BY j.created_at DESC`,
      [principal.customerId],
    );
    reply.header('cache-control', 'no-store');
    return { customer: customer.rows[0], vehicles: vehicles.rows, jobs: jobs.rows };
  });

  app.get('/api/portal/jobs/:id', async (request, reply) => {
    const principal = await authenticateCustomer(db, request);
    const { id } = idSchema.parse(request.params);
    await ownedJob(principal, id);
    reply.header('cache-control', 'no-store');
    return buildJobView(db, id);
  });

  app.post('/api/portal/reminder-preference', async (request) => {
    const principal = await authenticateCustomer(db, request);
    const { enabled } = reminderPreferenceSchema.parse(request.body);
    await db.query('UPDATE avc.customers SET service_reminders_opt_in = $2 WHERE id = $1', [
      principal.customerId,
      enabled,
    ]);
    return { serviceRemindersOptIn: enabled };
  });

  app.get('/api/portal/messages', async (request, reply) => {
    const principal = await authenticateCustomer(db, request);
    const result = await db.query(
      `SELECT id, kind, subject, body, created_at AS "createdAt"
      FROM avc.customer_messages WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 30`,
      [principal.customerId],
    );
    reply.header('cache-control', 'no-store');
    return { messages: result.rows };
  });

  app.post('/api/portal/jobs/:id/decisions', async (request, reply) => {
    const principal = await authenticateCustomer(db, request);
    const { id } = idSchema.parse(request.params);
    await ownedJob(principal, id);
    const result = await submitDecisions(
      db,
      id,
      { customerTokenId: principal.tokenId },
      request.body,
      request.headers['user-agent'] ?? null,
    );
    reply.header('cache-control', 'no-store');
    return { result };
  });

  app.get('/api/portal/jobs/:id/bill', async (request, reply) => {
    const principal = await authenticateCustomer(db, request);
    const { id } = idSchema.parse(request.params);
    await ownedJob(principal, id);
    reply.header('cache-control', 'no-store');
    return { bill: await buildBill(db, id) };
  });

  // "Users" page: the customer replaces the starting password. Other sessions are signed out.
  app.post('/api/portal/password', async (request, reply) => {
    const principal = await authenticateCustomer(db, request);
    const input = passwordSchema.parse(request.body);
    const found = await db.query<AccountRow>(
      `SELECT c.id AS "customerId", c.full_name AS "fullName", c.email, c.mobile_number AS mobile,
              a.password_hash AS "passwordHash", a.password_is_default AS "passwordIsDefault",
              a.locked_until AS "lockedUntil"
       FROM avc.customers c JOIN avc.customer_accounts a ON a.customer_id = c.id WHERE c.id = $1`,
      [principal.customerId],
    );
    const account = found.rows[0]!;
    if (!(await passwordMatches(account, input.currentPassword)))
      throw new AppError(403, 'WRONG_PASSWORD', 'Your current password is not correct');
    if (digitsOnly(input.newPassword) === digitsOnly(account.mobile))
      throw new AppError(
        422,
        'PASSWORD_TOO_WEAK',
        'Choose a password that is not your phone number',
      );
    await db.query(
      `UPDATE avc.customer_accounts SET password_hash = $2, password_is_default = false,
         password_changed_at = now(), failed_attempts = 0, locked_until = NULL WHERE customer_id = $1`,
      [principal.customerId, await hashPassword(input.newPassword)],
    );
    await db.query(
      `UPDATE avc.customer_tokens SET revoked_at = now()
       WHERE customer_id = $1 AND kind = 'session' AND id <> $2 AND revoked_at IS NULL`,
      [principal.customerId, principal.tokenId],
    );
    return reply.status(204).send();
  });
}
