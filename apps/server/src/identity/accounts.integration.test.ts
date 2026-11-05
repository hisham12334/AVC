import { join } from 'node:path';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createApp } from '../app.js';
import { loadLocalEnvFile, type Config } from '../config.js';
import { migrate } from '../migrations.js';
import { hashPassword } from '../portal/passwords.js';

loadLocalEnvFile();
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !/avc.*test/i.test(new URL(testUrl).pathname)) {
  throw new Error('TEST_DATABASE_URL must point to a dedicated AVC test database');
}
const pool = new Pool({ connectionString: testUrl });
const config: Config = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: 3000,
  DATABASE_URL: testUrl,
  LOG_LEVEL: 'silent',
};
// No verifier injected: this exercises the real password sign-in and session path.
const app = createApp(config, pool);

const SUPER = 'super@example.test';
const SUPER_PASSWORD = 'correct-horse-battery';

async function signIn(email: string, password: string) {
  return app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
}
async function tokenFor(email: string, password: string): Promise<Record<string, string>> {
  const response = await signIn(email, password);
  expect(response.statusCode).toBe(200);
  return { authorization: `Bearer ${response.json().token}` };
}

beforeAll(async () => {
  await migrate(pool, join(__dirname, '..', '..', 'migrations'), 'up');
  await app.ready();
});
beforeEach(async () => {
  await pool.query(
    'TRUNCATE avc.outbox_events, avc.staff_members, avc.customers RESTART IDENTITY CASCADE',
  );
  await pool.query(
    `INSERT INTO avc.staff_members(external_subject, display_name, email, role, password_hash)
     VALUES ('local:super', 'Super Admin', $1, 'super_admin', $2)`,
    [SUPER, await hashPassword(SUPER_PASSWORD)],
  );
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe.sequential('staff sign-in and super admin account management', () => {
  it('signs in with email and password and rejects bad credentials', async () => {
    const bad = await signIn(SUPER, 'wrong-password-x');
    expect(bad.statusCode).toBe(401);
    expect((await signIn('nobody@example.test', 'whatever-123')).statusCode).toBe(401);
    const headers = await tokenFor(SUPER.toUpperCase(), SUPER_PASSWORD);
    const me = await app.inject({ url: '/api/staff/me', headers });
    expect(me.json().staff).toMatchObject({ email: SUPER, role: 'super_admin' });
  });

  it('locks the account after repeated failures', async () => {
    for (let i = 0; i < 5; i += 1) await signIn(SUPER, 'wrong-password-x');
    expect((await signIn(SUPER, SUPER_PASSWORD)).statusCode).toBe(401);
  });

  it('lets the super admin create staff, assign a role and branch, and the new staff must change the password', async () => {
    const admin = await tokenFor(SUPER, SUPER_PASSWORD);
    const branch = (await pool.query<{ id: string }>('SELECT id FROM avc.branches LIMIT 1'))
      .rows[0]!;
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/staff',
      headers: admin,
      payload: {
        displayName: 'Tariq Driver',
        email: 'Tariq@Example.test',
        role: 'driver',
        branchId: branch.id,
      },
    });
    expect(created.statusCode).toBe(201);
    const { staff, temporaryPassword } = created.json();
    expect(temporaryPassword).toBe('avc@2026');
    expect(staff).toMatchObject({
      role: 'driver',
      email: 'tariq@example.test',
      branchId: branch.id,
    });

    const driver = await tokenFor('tariq@example.test', temporaryPassword);
    const me = await app.inject({ url: '/api/staff/me', headers: driver });
    expect(me.json().staff.mustChangePassword).toBe(true);

    const change = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: driver,
      payload: { currentPassword: temporaryPassword, newPassword: 'a-brand-new-password' },
    });
    expect(change.statusCode).toBe(204);
    expect((await signIn('tariq@example.test', temporaryPassword)).statusCode).toBe(401);
    await tokenFor('tariq@example.test', 'a-brand-new-password');

    const promoted = await app.inject({
      method: 'PATCH',
      url: `/api/admin/staff/${staff.id}`,
      headers: admin,
      payload: { role: 'technician', branchId: null },
    });
    expect(promoted.json().staff).toMatchObject({ role: 'technician', branchId: null });
  });

  it('keeps account management away from every other role', async () => {
    const admin = await tokenFor(SUPER, SUPER_PASSWORD);
    await app.inject({
      method: 'POST',
      url: '/api/admin/staff',
      headers: admin,
      payload: {
        displayName: 'Plain Admin',
        email: 'admin@example.test',
        role: 'admin',
        temporaryPassword: 'temporary-pass-1',
      },
    });
    const plain = await tokenFor('admin@example.test', 'temporary-pass-1');
    expect((await app.inject({ url: '/api/admin/staff', headers: plain })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/admin/staff',
          headers: plain,
          payload: { displayName: 'X', email: 'x@example.test', role: 'super_admin' },
        })
      ).statusCode,
    ).toBe(403);
    expect((await app.inject('/api/admin/staff')).statusCode).toBe(401);
  });

  it('deactivating ends sessions, and the last super admin cannot be removed', async () => {
    const admin = await tokenFor(SUPER, SUPER_PASSWORD);
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/staff',
      headers: admin,
      payload: { displayName: 'Temp', email: 'temp@example.test', role: 'finance' },
    });
    const { staff, temporaryPassword } = created.json();
    const session = await tokenFor('temp@example.test', temporaryPassword);
    await app.inject({
      method: 'PATCH',
      url: `/api/admin/staff/${staff.id}`,
      headers: admin,
      payload: { active: false },
    });
    expect((await app.inject({ url: '/api/staff/me', headers: session })).statusCode).toBe(401);
    expect((await signIn('temp@example.test', temporaryPassword)).statusCode).toBe(401);

    const self = (await app.inject({ url: '/api/staff/me', headers: admin })).json().staff;
    const demote = await app.inject({
      method: 'PATCH',
      url: `/api/admin/staff/${self.id}`,
      headers: admin,
      payload: { role: 'admin' },
    });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().error.code).toBe('LAST_SUPER_ADMIN');
  });

  it('reset-password issues a new temporary password and signs the person out', async () => {
    const admin = await tokenFor(SUPER, SUPER_PASSWORD);
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/admin/staff',
        headers: admin,
        payload: { displayName: 'Reset Me', email: 'reset@example.test', role: 'technician' },
      })
    ).json();
    const session = await tokenFor('reset@example.test', created.temporaryPassword);
    const reset = await app.inject({
      method: 'POST',
      url: `/api/admin/staff/${created.staff.id}/reset-password`,
      headers: admin,
    });
    expect(reset.statusCode).toBe(200);
    expect((await app.inject({ url: '/api/staff/me', headers: session })).statusCode).toBe(401);
    await tokenFor('reset@example.test', reset.json().temporaryPassword);
  });
});
