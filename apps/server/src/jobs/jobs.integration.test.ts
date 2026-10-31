import { join } from 'node:path';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createApp } from '../app.js';
import { loadLocalEnvFile, type Config } from '../config.js';
import { AppError } from '../errors.js';
import { migrate } from '../migrations.js';
import type { TokenVerifier } from '../identity/auth.js';

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
const verifier: TokenVerifier = {
  async verify(token) {
    if (token === 'manager-token') return 'test-manager';
    if (token === 'technician-token') return 'test-technician';
    throw new AppError(401, 'INVALID_TOKEN', 'Staff token is invalid');
  },
};
const app = createApp(config, pool, verifier);
let managerId: string;

const auth = (token = 'manager-token') => ({ authorization: `Bearer ${token}` });
async function customer(name = 'Test Owner', mobile = '+971 50 111 2222') {
  return app.inject({
    method: 'POST',
    url: '/api/customers',
    headers: auth(),
    payload: {
      fullName: name,
      mobileNumber: mobile,
      email: `${name.toLowerCase().replace(/\W+/g, '.')}@example.test`,
    },
  });
}
async function vehicle(customerId: string, vin = 'TESTVIN1234567890') {
  return app.inject({
    method: 'POST',
    url: '/api/vehicles',
    headers: auth(),
    payload: {
      customerId,
      vin,
      licensePlate: 'Dubai A 12345',
      make: 'Porsche',
      model: '911',
      modelYear: 2022,
    },
  });
}
async function intake(customerId: string, vehicleId: string) {
  return app.inject({
    method: 'POST',
    url: '/api/jobs/intake',
    headers: auth(),
    payload: {
      customerId,
      vehicleId,
      mileageKm: 24000,
      intakeCondition: 'Front left wheel has a visible scuff',
    },
  });
}

beforeAll(async () => {
  const dir = join(__dirname, '..', '..', 'migrations');
  const applied = await migrate(pool, dir, 'up');
  expect(applied).toContain('applied 0002_staff_intake_jobs.sql');
  expect((await migrate(pool, dir, 'validate')).every((line) => line.startsWith('applied '))).toBe(
    true,
  );
  await app.ready();
});
beforeEach(async () => {
  await pool.query(
    'TRUNCATE avc.outbox_events, avc.staff_members, avc.customers RESTART IDENTITY CASCADE',
  );
  const created = await pool.query<{ id: string }>(
    `INSERT INTO avc.staff_members(external_subject, display_name, role) VALUES
      ('test-manager','Test Manager','lounge_manager'), ('test-technician','Test Technician','technician')
      RETURNING id, external_subject`,
  );
  managerId = created.rows[0]!.id;
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe.sequential('staff intake and jobs with PostgreSQL', () => {
  it('rejects missing, invalid and unauthorized staff tokens', async () => {
    expect((await app.inject('/api/customers?query=Test')).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/api/jobs', headers: auth('bad-token') }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/customers',
          headers: auth('technician-token'),
          payload: { fullName: 'Test', mobileNumber: '123456789' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: 'GET', url: '/api/staff/me', headers: auth() })).json().staff
        .role,
    ).toBe('lounge_manager');
  });

  it('creates and finds customers and vehicles without accidental duplicates', async () => {
    const c = await customer();
    expect(c.statusCode).toBe(201);
    const customerId = c.json().customer.id;
    expect((await customer('test owner', '971501112222')).json().error.code).toBe(
      'POSSIBLE_DUPLICATE_CUSTOMER',
    );
    expect(
      (await app.inject({ url: '/api/customers?query=1112222', headers: auth() })).json().customers,
    ).toHaveLength(1);
    const v = await vehicle(customerId);
    expect(v.statusCode).toBe(201);
    expect(v.json().vehicle.customerId).toBe(customerId);
    expect((await vehicle(customerId)).json().error.code).toBe('POSSIBLE_DUPLICATE_VEHICLE');
    expect(
      (await app.inject({ url: '/api/vehicles?query=TESTVIN', headers: auth() })).json().vehicles,
    ).toHaveLength(1);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/customers',
          headers: auth(),
          payload: { fullName: '', mobileNumber: 'x' },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('creates a linked job and append-only audit event, then rejects mismatched links', async () => {
    const customerId = (await customer()).json().customer.id;
    const vehicleId = (await vehicle(customerId)).json().vehicle.id;
    const anotherCustomerId = (await customer('Other Owner', '971501113333')).json().customer.id;
    expect((await intake(anotherCustomerId, vehicleId)).json().error.code).toBe(
      'VEHICLE_CUSTOMER_MISMATCH',
    );
    const created = await intake(customerId, vehicleId);
    expect(created.statusCode).toBe(201);
    const job = created.json().job;
    expect(job).toMatchObject({
      customerId,
      vehicleId,
      mileageKm: 24000,
      status: 'intake_open',
      vehicleLocation: 'al_quoz',
      workStage: 'intake',
      version: 1,
      createdByStaffId: managerId,
    });
    const detail = (await app.inject({ url: `/api/jobs/${job.id}`, headers: auth() })).json();
    expect(detail.events).toHaveLength(1);
    expect(detail.events[0]).toMatchObject({
      eventType: 'job_created',
      jobVersion: 1,
      actorStaffId: managerId,
      actorStaffName: 'Test Manager',
    });
    expect((await app.inject({ url: '/api/jobs', headers: auth() })).json().jobs).toHaveLength(1);
    await expect(
      pool.query('UPDATE avc.job_events SET event_type = $1 WHERE job_card_id = $2', [
        'inspection_started',
        job.id,
      ]),
    ).rejects.toThrow('append only');
    await expect(
      pool.query('DELETE FROM avc.job_events WHERE job_card_id = $1', [job.id]),
    ).rejects.toThrow('append only');
    expect(
      (await pool.query('SELECT count(*)::int AS count FROM avc.job_events')).rows[0].count,
    ).toBe(1);
  });

  it('enforces transition version and status without producing extra events', async () => {
    const customerId = (await customer()).json().customer.id;
    const vehicleId = (await vehicle(customerId)).json().vehicle.id;
    const jobId = (await intake(customerId, vehicleId)).json().job.id;
    const path = `/api/jobs/${jobId}/commands/start-inspection`;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path,
          headers: auth(),
          payload: { expectedVersion: 99 },
        })
      ).json().error.code,
    ).toBe('STALE_VERSION');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path,
          headers: auth('technician-token'),
          payload: { expectedVersion: 1 },
        })
      ).statusCode,
    ).toBe(403);
    const changed = await app.inject({
      method: 'POST',
      url: path,
      headers: auth(),
      payload: { expectedVersion: 1 },
    });
    expect(changed.json().job).toMatchObject({ status: 'inspection_pending', version: 2 });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path,
          headers: auth(),
          payload: { expectedVersion: 1 },
        })
      ).json().error.code,
    ).toBe('STALE_VERSION');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path,
          headers: auth(),
          payload: { expectedVersion: 2 },
        })
      ).json().error.code,
    ).toBe('INVALID_TRANSITION');
    const events = (await app.inject({ url: `/api/jobs/${jobId}`, headers: auth() })).json().events;
    expect(events.map((event: { eventType: string }) => event.eventType)).toEqual([
      'job_created',
      'inspection_started',
    ]);
  });
});
