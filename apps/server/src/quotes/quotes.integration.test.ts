/* eslint-disable @typescript-eslint/no-explicit-any -- test response bodies are untyped JSON */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createApp } from '../app.js';
import { loadLocalEnvFile, type Config } from '../config.js';
import { AppError } from '../errors.js';
import { dispatchWebhooks, signPayload, type Fetcher } from '../integration/webhooks.js';
import { prepareCustomerWork } from '../engagement/worker.js';
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
  UPLOAD_DIR: mkdtempSync(join(tmpdir(), 'avc-uploads-')),
};
const subjects: Record<string, string> = {
  'manager-token': 'test-manager',
  'tech-token': 'test-technician',
  'admin-token': 'test-admin',
  'driver-token': 'test-driver',
  'branch-b-token': 'test-branch-b',
};
const verifier: TokenVerifier = {
  async verify(token) {
    const subject = subjects[token];
    if (!subject) throw new AppError(401, 'INVALID_TOKEN', 'Staff token is invalid');
    return subject;
  },
};
const app = createApp(config, pool, verifier);

type Res = { status: number; body: any };
async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  token?: string,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<Res> {
  const res = await app.inject({
    method,
    url,
    payload: payload as object | undefined,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  });
  return { status: res.statusCode, body: res.body ? safeJson(res.body) : null };
}
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

let counter = 0;
const PHONE = '+971 50 111 2222';
const PHONE_DIGITS = '971501112222';

async function newCustomer(name = 'Test Owner', mobile = PHONE) {
  counter += 1;
  const email = `owner${counter}@example.test`;
  const c = await call('POST', '/api/customers', 'manager-token', {
    fullName: name,
    mobileNumber: mobile,
    email,
  });
  expect(c.status).toBe(201);
  return {
    id: c.body.customer.id as string,
    email,
    profileToken: c.body.profileLink.token as string,
  };
}
async function newVehicle(customerId: string) {
  counter += 1;
  const v = await call('POST', '/api/vehicles', 'manager-token', {
    customerId,
    vin: `TESTVIN${String(counter).padStart(10, '0')}`,
    licensePlate: 'Dubai A 12345',
    make: 'Porsche',
    model: 'Cayenne',
    modelYear: 2020,
  });
  expect(v.status).toBe(201);
  return v.body.vehicle.id as string;
}
const version = async (jobId: string): Promise<number> =>
  (await call('GET', `/api/jobs/${jobId}`, 'manager-token')).body.job.version;

async function jobInInspection(extra: Record<string, unknown> = {}) {
  const customer = await newCustomer();
  const vehicleId = await newVehicle(customer.id);
  const j = await call('POST', '/api/jobs/intake', 'manager-token', {
    customerId: customer.id,
    vehicleId,
    mileageKm: 1000,
    intakeCondition: 'Clean, no visible damage',
    ...extra,
  });
  expect(j.status).toBe(201);
  const jobId: string = j.body.job.id;
  return { jobId, customer, vehicleId, job: j.body.job };
}
async function startInspection(jobId: string) {
  const started = await call(
    'POST',
    `/api/jobs/${jobId}/commands/start-inspection`,
    'manager-token',
    {
      expectedVersion: await version(jobId),
    },
  );
  expect(started.status).toBe(200);
}
async function evidence(jobId: string, token = 'tech-token', kind = 'photo') {
  const res = await call('POST', `/api/jobs/${jobId}/evidence`, token, {
    kind,
    storageKey: `jobs/${jobId}/${Math.random().toString(36).slice(2)}.jpg`,
    caption: 'Close-up',
  });
  expect(res.status).toBe(201);
  return res.body.evidence.id as string;
}
async function submitInspection(jobId: string) {
  return call('POST', `/api/jobs/${jobId}/inspection/submit`, 'tech-token', {
    expectedVersion: await version(jobId),
    findings: [
      {
        title: 'Front brake pads',
        detail: 'Measured at 2.8 mm',
        severity: 'critical',
        evidenceIds: [await evidence(jobId)],
      },
      {
        title: 'Brake fluid',
        detail: 'Moisture above limit',
        severity: 'moderate',
        evidenceIds: [await evidence(jobId)],
      },
      { title: 'Cabin air filter', severity: 'minor' },
    ],
  });
}
async function openFindings(jobId: string) {
  const res = await call('GET', `/api/jobs/${jobId}/findings`, 'manager-token');
  expect(res.status).toBe(200);
  const open = res.body.batches.filter((b: any) => b.status === 'awaiting_pricing').at(-1);
  return open.findings as { id: string; title: string; detail: string; severity: string }[];
}
const PRICES: Record<string, number> = {
  'Front brake pads': 780,
  'Brake fluid': 310,
  'Cabin air filter': 140,
  'Cracked serpentine belt': 380,
};
async function priceQuote(jobId: string, extras: object[] = []) {
  const findings = await openFindings(jobId);
  return call('POST', `/api/jobs/${jobId}/quotes`, 'manager-token', {
    expectedVersion: await version(jobId),
    items: [
      ...findings.map((f) => ({
        findingId: f.id,
        title: f.title,
        detail: f.detail,
        priceAed: PRICES[f.title],
      })),
      ...extras,
    ],
  });
}
const portalJob = (token: string, jobId: string) => call('GET', `/api/portal/jobs/${jobId}`, token);
async function customerDecides(
  token: string,
  jobId: string,
  pick: (title: string) => 'approved' | 'rejected',
) {
  const view = await portalJob(token, jobId);
  const quote = view.body.openQuote;
  return call('POST', `/api/portal/jobs/${jobId}/decisions`, token, {
    quoteId: quote.id,
    quoteVersion: quote.version,
    decisions: quote.items.map((i: any) => ({ itemId: i.id, decision: pick(i.title) })),
  });
}
async function advance(jobId: string, token = 'manager-token') {
  return call('POST', `/api/jobs/${jobId}/commands/advance`, token, {
    expectedVersion: await version(jobId),
  });
}
// Inspection -> priced quote -> customer approves everything except the cabin filter.
async function approvedJob(extra: Record<string, unknown> = {}) {
  const ctx = await jobInInspection(extra);
  if (ctx.job.workStage === 'intake') await startInspection(ctx.jobId);
  expect((await submitInspection(ctx.jobId)).status).toBe(201);
  expect((await priceQuote(ctx.jobId)).status).toBe(201);
  const decided = await customerDecides(ctx.customer.profileToken, ctx.jobId, (t) =>
    t === 'Cabin air filter' ? 'rejected' : 'approved',
  );
  expect(decided.status).toBe(200);
  return { ...ctx, approvedAed: 1090 };
}

beforeAll(async () => {
  const dir = join(__dirname, '..', '..', 'migrations');
  const applied = await migrate(pool, dir, 'up');
  expect(applied).toContain('applied 0004_portal_findings_transfers_revenue.sql');
  await app.ready();
});
beforeEach(async () => {
  await pool.query(
    'TRUNCATE avc.outbox_events, avc.staff_members, avc.customers RESTART IDENTITY CASCADE',
  );
  await pool.query("DELETE FROM avc.branches WHERE code <> 'al_quoz'");
  await pool.query(
    `INSERT INTO avc.staff_members(external_subject, display_name, role) VALUES
      ('test-manager','Test Manager','lounge_manager'),
      ('test-technician','Test Technician','technician'),
      ('test-admin','Test Admin','admin'),
      ('test-driver','Test Driver','driver')`,
  );
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('inspection, pricing and approval', () => {
  it('tracks next actions and creates consent-gated follow-ups without duplicates', async () => {
    const { jobId, customer } = await approvedJob();
    const tower = await call('GET', '/api/control-tower', 'manager-token');
    expect(tower.status).toBe(200);
    expect(tower.body.jobs.some((job: { id: string }) => job.id === jobId)).toBe(true);
    const plan = await call('PATCH', `/api/control-tower/${jobId}`, 'manager-token', {
      nextAction: 'Confirm parts arrival',
      ownerStaffId: null,
      promisedAt: new Date(Date.now() + 86400000).toISOString(),
    });
    expect(plan.status).toBe(200);
    expect(
      (await call('GET', '/api/control-tower', 'manager-token')).body.jobs.find(
        (job: { id: string }) => job.id === jobId,
      ).nextAction,
    ).toBe('Confirm parts arrival');
    for (const stage of ['in_bay', 'qc', 'ready', 'delivered'])
      expect((await advance(jobId)).body.job.workStage).toBe(stage);

    await prepareCustomerWork(pool);
    await prepareCustomerWork(pool);
    expect(
      (await call('GET', '/api/portal/messages', customer.profileToken)).body.messages.length,
    ).toBeGreaterThan(0);
    const followups = await call('GET', '/api/engagement/followups', 'manager-token');
    expect(followups.body.followups.map((f: { kind: string }) => f.kind).sort()).toEqual([
      'declined_work',
      'service_reminder',
    ]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM avc.customer_messages WHERE kind IN ('declined_work', 'service_reminder')",
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (
        await call('POST', '/api/portal/reminder-preference', customer.profileToken, {
          enabled: true,
        })
      ).status,
    ).toBe(200);
    await pool.query("UPDATE avc.service_followups SET due_at = now() - interval '1 minute'");
    await prepareCustomerWork(pool);
    await prepareCustomerWork(pool);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM avc.customer_messages WHERE kind IN ('declined_work', 'service_reminder')",
        )
      ).rows[0].count,
    ).toBe(2);
    const first = followups.body.followups[0];
    expect(
      (
        await call('PATCH', `/api/engagement/followups/${first.id}`, 'manager-token', {
          status: 'booked',
        })
      ).status,
    ).toBe(200);
  });

  it('runs a car from inspection to delivery: technician describes, advisor prices, customer decides', async () => {
    const { jobId, customer } = await jobInInspection();
    await startInspection(jobId);
    const inspected = await submitInspection(jobId);
    expect(inspected.status).toBe(201);

    // The technician never sees prices or quotes.
    expect((await call('GET', `/api/jobs/${jobId}/quotes`, 'tech-token')).status).toBe(403);
    expect((await call('GET', `/api/jobs/${jobId}/bill`, 'tech-token')).status).toBe(403);
    const techView = await call('GET', `/api/jobs/${jobId}/findings`, 'tech-token');
    expect(techView.status).toBe(200);
    expect(JSON.stringify(techView.body)).not.toMatch(/priceAed|price_aed|amountAed|totalAed/);

    // The customer is told the inspection is done and the quote is coming, and nothing more.
    const waiting = await portalJob(customer.profileToken, jobId);
    expect(waiting.body.job.stage).toBe('pricing');
    expect(waiting.body.pricingPending).toBe(true);
    expect(waiting.body.openQuote).toBeNull();
    expect(JSON.stringify(waiting.body)).not.toContain('Front brake pads');
    expect(waiting.body.timeline.at(-1).label).toMatch(/Inspection completed/);

    // The advisor cannot drop a finding, cannot downgrade one, and extra lines are always minor.
    const findings = await openFindings(jobId);
    const partial = await call('POST', `/api/jobs/${jobId}/quotes`, 'manager-token', {
      expectedVersion: await version(jobId),
      items: [{ findingId: findings[0]!.id, title: 'Front brake pads', priceAed: 780 }],
    });
    expect(partial.status).toBe(422);
    expect(partial.body.error.code).toBe('FINDING_UNPRICED');
    const upsell = await call('POST', `/api/jobs/${jobId}/quotes`, 'manager-token', {
      expectedVersion: await version(jobId),
      items: [{ title: 'Detailing', severity: 'critical', priceAed: 99 }],
    });
    expect(upsell.status).toBe(400);
    expect((await call('POST', `/api/jobs/${jobId}/quotes`, 'tech-token', {})).status).toBe(403);

    const published = await priceQuote(jobId, [{ title: 'Engine oil & filter', priceAed: 250.5 }]);
    expect(published.status).toBe(201);

    const view = await portalJob(customer.profileToken, jobId);
    expect(view.body.job.stage).toBe('quote');
    const quote = view.body.openQuote;
    expect(quote.totalAed).toBe(1480.5);
    const pads = quote.items.find((i: any) => i.title === 'Front brake pads');
    expect(pads).toMatchObject({ severity: 'critical', priceAed: 780 });
    expect(pads.evidence).toHaveLength(1);
    expect(JSON.stringify(view.body)).not.toMatch(/storageKey|jobs\//);
    expect(quote.items.find((i: any) => i.title === 'Engine oil & filter').severity).toBe('minor');

    // Another customer cannot open this job.
    const other = await newCustomer('Someone Else', '+971 55 000 1111');
    expect((await portalJob(other.profileToken, jobId)).status).toBe(404);

    const incomplete = await call(
      'POST',
      `/api/portal/jobs/${jobId}/decisions`,
      customer.profileToken,
      {
        quoteId: quote.id,
        quoteVersion: quote.version,
        decisions: [{ itemId: pads.id, decision: 'approved' }],
      },
    );
    expect(incomplete.body.error.code).toBe('INCOMPLETE_DECISIONS');
    const decided = await customerDecides(customer.profileToken, jobId, (t) =>
      t === 'Cabin air filter' ? 'rejected' : 'approved',
    );
    expect(decided.body.result).toMatchObject({
      stage: 'approved',
      approved: 3,
      rejected: 1,
      approvedTotalAed: 1340.5,
    });
    const replay = await call(
      'POST',
      `/api/portal/jobs/${jobId}/decisions`,
      customer.profileToken,
      {
        quoteId: quote.id,
        quoteVersion: quote.version,
        decisions: quote.items.map((i: any) => ({ itemId: i.id, decision: 'approved' })),
      },
    );
    expect(replay.body.error.code).toBe('QUOTE_ALREADY_DECIDED');

    expect((await advance(jobId)).body.job.workStage).toBe('in_bay');

    // Mid-repair: the technician posts a finding with no price. The customer is told it is being priced.
    const belt = await call('POST', `/api/jobs/${jobId}/findings`, 'tech-token', {
      expectedVersion: await version(jobId),
      findings: [
        {
          title: 'Cracked serpentine belt',
          severity: 'moderate',
          evidenceIds: [await evidence(jobId)],
        },
      ],
    });
    expect(belt.status).toBe(201);
    const paused = await portalJob(customer.profileToken, jobId);
    expect(paused.body).toMatchObject({ workPaused: true, pendingFinding: true, openQuote: null });
    expect(JSON.stringify(paused.body)).not.toContain('Cracked serpentine belt');
    const blocked = await advance(jobId);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('AWAITING_CUSTOMER_DECISION');

    expect((await priceQuote(jobId)).body.customerLink).toBeNull();
    const addendum = await portalJob(customer.profileToken, jobId);
    expect(addendum.body.openQuote).toMatchObject({ kind: 'addendum' });
    expect(addendum.body.workPaused).toBe(true);
    const approved = await customerDecides(customer.profileToken, jobId, () => 'approved');
    expect(approved.body.result.stage).toBe('in_bay');

    for (const stage of ['qc', 'ready', 'delivered']) {
      expect((await advance(jobId)).body.job.workStage).toBe(stage);
    }

    // Delivered counts as received: 1340.5 + 380 on the day's revenue and on the invoice.
    const summary = await call('GET', '/api/dashboard/summary', 'manager-token');
    expect(summary.body).toMatchObject({
      activeCars: 0,
      deliveredMtd: 1,
      revenueTodayAed: 1720.5,
      revenueMtdAed: 1720.5,
      awaitingPricing: 0,
      pausedForFinding: 0,
    });
    const bill = (await call('GET', `/api/jobs/${jobId}/bill`, 'manager-token')).body.bill;
    expect(bill).toMatchObject({
      document: 'invoice',
      paymentStatus: 'received',
      totals: { approvedAed: 1720.5, declinedAed: 140 },
    });
    expect(bill.lines).toHaveLength(5);
    expect(bill.terms.join(' ')).toMatch(/12-month/);

    // The lounge can flag a payment that was not actually received; the amount leaves revenue.
    const reversed = await call('POST', `/api/jobs/${jobId}/revenue/reverse`, 'manager-token', {
      expectedVersion: await version(jobId),
      reason: 'Customer will pay by transfer next week',
    });
    expect(reversed.status).toBe(200);
    expect((await call('GET', '/api/dashboard/summary', 'manager-token')).body.revenueMtdAed).toBe(
      0,
    );
    expect(
      (await call('GET', `/api/jobs/${jobId}/bill`, 'manager-token')).body.bill.paymentStatus,
    ).toBe('reversed');
    const again = await call('POST', `/api/jobs/${jobId}/revenue/reverse`, 'manager-token', {
      expectedVersion: await version(jobId),
      reason: 'twice',
    });
    expect(again.status).toBe(409);

    // The audit trail has no gaps and records the customer as the actor of their decisions.
    const { events } = (await call('GET', `/api/jobs/${jobId}`, 'manager-token')).body;
    expect(events.map((e: any) => e.jobVersion)).toEqual(
      events.map((_: unknown, i: number) => i + 1),
    );
    expect(events.filter((e: any) => e.actorType === 'customer')).toHaveLength(2);
  });

  it('requires proof for yellow and red findings and keeps links current', async () => {
    const { jobId, customer } = await jobInInspection();
    await startInspection(jobId);
    const noProof = await call('POST', `/api/jobs/${jobId}/inspection/submit`, 'tech-token', {
      expectedVersion: await version(jobId),
      findings: [{ title: 'Brake fluid', severity: 'moderate' }],
    });
    expect(noProof.status).toBe(422);
    expect(noProof.body.error.code).toBe('EVIDENCE_REQUIRED');
    const signature = await evidence(jobId, 'tech-token', 'signature');
    const wrongKind = await call('POST', `/api/jobs/${jobId}/inspection/submit`, 'tech-token', {
      expectedVersion: await version(jobId),
      findings: [{ title: 'Brake fluid', severity: 'moderate', evidenceIds: [signature] }],
    });
    expect(wrongKind.body.error.code).toBe('EVIDENCE_INVALID');
    const stale = await call('POST', `/api/jobs/${jobId}/inspection/submit`, 'tech-token', {
      expectedVersion: 1,
      findings: [],
    });
    expect(stale.body.error.code).toBe('STALE_VERSION');
    // Nothing was half-saved: the inspection can still be submitted properly.
    expect((await call('GET', `/api/jobs/${jobId}`, 'manager-token')).body.job.workStage).toBe(
      'inspection',
    );

    // An inspection with no findings is valid; the advisor then adds service lines only.
    expect(
      (
        await call('POST', `/api/jobs/${jobId}/inspection/submit`, 'tech-token', {
          expectedVersion: await version(jobId),
          findings: [],
        })
      ).status,
    ).toBe(201);
    const published = await call('POST', `/api/jobs/${jobId}/quotes`, 'manager-token', {
      expectedVersion: await version(jobId),
      items: [{ title: 'Full Care service', priceAed: 1200 }],
    });
    expect(published.status).toBe(201);
    const first = published.body.customerLink.token;
    const reissued = await call('POST', `/api/jobs/${jobId}/customer-links`, 'manager-token', {
      expectedVersion: await version(jobId),
    });
    expect((await call('GET', `/api/track/${first}`)).body.error.code).toBe('LINK_INVALID');
    expect((await call('GET', `/api/track/${reissued.body.customerLink.token}`)).status).toBe(200);
    const bill = await call('GET', `/api/track/${reissued.body.customerLink.token}/bill`);
    expect(bill.body.bill).toMatchObject({ document: 'estimate', totals: { quotedAed: 1200 } });
    expect(bill.body.bill.instructions.join(' ')).toMatch(/Approve or reject/);
    expect((await call('GET', `/api/track/${'x'.repeat(43)}`)).status).toBe(404);
    // Old profile link and per-job link are different credentials for the same customer.
    expect((await portalJob(customer.profileToken, jobId)).status).toBe(200);
  });
});

describe('customer profile and portal login', () => {
  it('creates a profile with a QR link, logs in with email and phone, and lets the customer change the password', async () => {
    const noEmail = await call('POST', '/api/customers', 'manager-token', {
      fullName: 'No Email',
      mobileNumber: PHONE,
    });
    expect(noEmail.status).toBe(400);
    const customer = await newCustomer();
    const dup = await call('POST', '/api/customers', 'manager-token', {
      fullName: 'Someone New',
      mobileNumber: '+971 55 999 0000',
      email: customer.email.toUpperCase(),
    });
    expect(dup.status).toBe(409);

    // The QR/link opens the profile directly.
    const me = await call('GET', '/api/portal/me', customer.profileToken);
    expect(me.status).toBe(200);
    expect(me.body.customer).toMatchObject({ email: customer.email, passwordIsDefault: true });
    expect((await call('GET', '/api/portal/me')).status).toBe(401);
    expect((await call('GET', '/api/portal/me', 'nonsense-token-value')).status).toBe(401);

    // Email + mobile number works, however the number is typed.
    const wrong = await call('POST', '/api/portal/login', undefined, {
      email: customer.email,
      password: 'nope-nope',
    });
    expect(wrong.status).toBe(401);
    const unknown = await call('POST', '/api/portal/login', undefined, {
      email: 'nobody@example.test',
      password: PHONE_DIGITS,
    });
    expect(unknown.body.error.code).toBe('INVALID_LOGIN');
    const typed = await call('POST', '/api/portal/login', undefined, {
      email: customer.email.toUpperCase(),
      password: PHONE,
    });
    expect(typed.status).toBe(200);
    expect(typed.body.passwordIsDefault).toBe(true);
    const session = typed.body.token as string;
    const digits = await call('POST', '/api/portal/login', undefined, {
      email: customer.email,
      password: PHONE_DIGITS,
    });
    expect(digits.status).toBe(200);
    const otherSession = digits.body.token as string;

    // Change password under Users.
    const change = (current: string, next: string) =>
      call('POST', '/api/portal/password', session, {
        currentPassword: current,
        newPassword: next,
      });
    expect((await change(PHONE, 'short')).status).toBe(400);
    expect((await change(PHONE, PHONE_DIGITS)).body.error.code).toBe('PASSWORD_TOO_WEAK');
    expect((await change('wrong-password', 'a-better-password')).body.error.code).toBe(
      'WRONG_PASSWORD',
    );
    expect((await change(PHONE, 'a-better-password')).status).toBe(204);
    expect((await call('GET', '/api/portal/me', session)).body.customer.passwordIsDefault).toBe(
      false,
    );
    expect((await call('GET', '/api/portal/me', otherSession)).status).toBe(401);
    const oldLogin = await call('POST', '/api/portal/login', undefined, {
      email: customer.email,
      password: PHONE,
    });
    expect(oldLogin.status).toBe(401);
    const newLogin = await call('POST', '/api/portal/login', undefined, {
      email: customer.email,
      password: 'a-better-password',
    });
    expect(newLogin.status).toBe(200);
    expect(newLogin.body.passwordIsDefault).toBe(false);
    expect((await call('POST', '/api/portal/logout', newLogin.body.token)).status).toBe(204);
    expect((await call('GET', '/api/portal/me', newLogin.body.token)).status).toBe(401);

    // Staff can replace a lost QR; the old one stops working.
    const replaced = await call(
      'POST',
      `/api/customers/${customer.id}/profile-link`,
      'manager-token',
    );
    expect(replaced.status).toBe(201);
    expect((await call('GET', '/api/portal/me', customer.profileToken)).status).toBe(401);
    expect((await call('GET', '/api/portal/me', replaced.body.profileLink.token)).status).toBe(200);
  });

  it('locks the account after repeated wrong passwords', async () => {
    const customer = await newCustomer();
    const attempt = (password: string) =>
      call('POST', '/api/portal/login', undefined, { email: customer.email, password });
    for (let i = 0; i < 5; i += 1) expect((await attempt('guess-' + i)).status).toBe(401);
    // Even the right password is refused while locked, with the same message as a wrong one.
    const locked = await attempt(PHONE_DIGITS);
    expect(locked.status).toBe(401);
    expect(locked.body.error.code).toBe('INVALID_LOGIN');
    await pool.query('UPDATE avc.customer_accounts SET locked_until = NULL');
    expect((await attempt(PHONE_DIGITS)).status).toBe(200);
  });
});

describe('concierge pickup and delivery', () => {
  it('handles a pickup, a return by driver, and revenue on delivery', async () => {
    const driver = (
      await pool.query<{ id: string }>("SELECT id FROM avc.staff_members WHERE role = 'driver'")
    ).rows[0]!.id;
    const customer = await newCustomer();
    const vehicleId = await newVehicle(customer.id);
    const noDetails = await call('POST', '/api/jobs/intake', 'manager-token', {
      customerId: customer.id,
      vehicleId,
      mileageKm: 10,
      intakeCondition: 'ok',
      arrivalMethod: 'pickup',
    });
    expect(noDetails.status).toBe(400);
    const intake = await call('POST', '/api/jobs/intake', 'manager-token', {
      customerId: customer.id,
      vehicleId,
      mileageKm: 5000,
      intakeCondition: 'Owner reports a squeak from the front',
      arrivalMethod: 'pickup',
      returnMethod: 'delivery',
      leadSource: 'google',
      pickup: {
        address: 'Villa 12, Jumeirah 2',
        contactPhone: '+971 50 111 2222',
        driverStaffId: driver,
      },
    });
    expect(intake.status).toBe(201);
    const jobId: string = intake.body.job.id;
    expect(intake.body.job).toMatchObject({
      workStage: 'pickup',
      arrivalMethod: 'pickup',
      leadSource: 'google',
    });
    expect(
      (
        await call('POST', `/api/jobs/${jobId}/commands/start-inspection`, 'manager-token', {
          expectedVersion: 1,
        })
      ).status,
    ).toBe(422);

    // The driver sees only their own legs, with the address and the customer's number.
    expect((await call('GET', '/api/transfers/mine', 'tech-token')).status).toBe(403);
    const mine = await call('GET', '/api/transfers/mine', 'driver-token');
    expect(mine.body.transfers).toHaveLength(1);
    expect(mine.body.transfers[0]).toMatchObject({
      direction: 'pickup',
      address: 'Villa 12, Jumeirah 2',
      customerName: 'Test Owner',
    });
    const pickupId: string = mine.body.transfers[0].id;
    expect(
      (
        await call('POST', `/api/transfers/${pickupId}/complete`, 'driver-token', {
          photoEvidenceIds: [],
        })
      ).status,
    ).toBe(400);
    const early = await call('POST', `/api/transfers/${pickupId}/complete`, 'driver-token', {
      photoEvidenceIds: [await evidence(jobId, 'driver-token')],
    });
    expect(early.body.error.code).toBe('INVALID_TRANSITION');
    expect((await call('POST', `/api/transfers/${pickupId}/start`, 'driver-token')).status).toBe(
      200,
    );
    const onTheWay = await portalJob(customer.profileToken, jobId);
    expect(onTheWay.body.transfer).toMatchObject({
      direction: 'pickup',
      status: 'en_route',
      driverName: 'Test Driver',
    });
    expect(onTheWay.body.timeline.at(-1).label).toMatch(/on the way/);
    const signature = await evidence(jobId, 'driver-token', 'signature');
    const collected = await call('POST', `/api/transfers/${pickupId}/complete`, 'driver-token', {
      photoEvidenceIds: [
        await evidence(jobId, 'driver-token'),
        await evidence(jobId, 'driver-token'),
      ],
      signatureEvidenceId: signature,
    });
    expect(collected.body.result.stage).toBe('intake');

    // The usual inspection, pricing and approval.
    await startInspection(jobId);
    expect((await submitInspection(jobId)).status).toBe(201);
    expect((await priceQuote(jobId)).status).toBe(201);
    expect((await customerDecides(customer.profileToken, jobId, () => 'approved')).status).toBe(
      200,
    );
    for (const stage of ['in_bay', 'qc', 'ready']) {
      expect((await advance(jobId)).body.job.workStage).toBe(stage);
    }

    // A car going back by driver cannot be marked delivered by the lounge.
    const lounge = await advance(jobId);
    expect(lounge.status).toBe(422);
    expect(lounge.body.error.code).toBe('DELIVERY_BY_DRIVER');
    const returnLeg = await call('POST', `/api/jobs/${jobId}/transfers`, 'manager-token', {
      direction: 'return',
      address: 'Villa 12, Jumeirah 2',
      driverStaffId: driver,
    });
    expect(returnLeg.status).toBe(201);
    const returnId: string = returnLeg.body.transfer.id;
    await call('POST', `/api/transfers/${returnId}/start`, 'driver-token');
    const delivered = await call('POST', `/api/transfers/${returnId}/complete`, 'driver-token', {
      photoEvidenceIds: [await evidence(jobId, 'driver-token')],
    });
    expect(delivered.body.result).toMatchObject({ stage: 'delivered', amountAed: 1230 });
    const summary = await call('GET', '/api/dashboard/summary', 'manager-token');
    expect(summary.body).toMatchObject({ revenueTodayAed: 1230, deliveredMtd: 1 });
    expect((await portalJob(customer.profileToken, jobId)).body.job.stage).toBe('delivered');
  });

  it('delivers a walk-in car through the lounge', async () => {
    const ctx = await approvedJob();
    for (const stage of ['in_bay', 'qc', 'ready', 'delivered']) {
      expect((await advance(ctx.jobId)).body.job.workStage).toBe(stage);
    }
    expect((await call('GET', '/api/dashboard/summary', 'manager-token')).body.revenueMtdAed).toBe(
      ctx.approvedAed,
    );
  });
});

describe('branches', () => {
  it('scopes staff to their branch and lets only an admin add branches', async () => {
    const { jobId } = await jobInInspection();
    const denied = await call('POST', '/api/branches', 'manager-token', {
      code: 'jumeirah',
      name: 'Jumeirah',
      bayCapacity: 12,
    });
    expect(denied.status).toBe(403);
    const created = await call('POST', '/api/branches', 'admin-token', {
      code: 'jumeirah',
      name: 'Jumeirah',
      bayCapacity: 12,
    });
    expect(created.status).toBe(201);
    expect((await call('GET', '/api/branches', 'admin-token')).body.branches).toHaveLength(2);

    await pool.query(
      `INSERT INTO avc.staff_members(external_subject, display_name, role, branch_id)
       VALUES ('test-branch-b','Branch B Manager','lounge_manager',$1)`,
      [created.body.branch.id],
    );
    expect((await call('GET', '/api/jobs', 'branch-b-token')).body.jobs).toHaveLength(0);
    expect((await call('GET', `/api/jobs/${jobId}`, 'branch-b-token')).status).toBe(404);
    expect((await call('GET', '/api/dashboard/summary', 'branch-b-token')).body).toMatchObject({
      capacity: 12,
      activeCars: 0,
    });

    // With several branches active, an unpinned manager must say which one an intake belongs to.
    const c = await newCustomer('Second Owner', '+971 55 000 1111');
    const vehicleId = await newVehicle(c.id);
    const body = { customerId: c.id, vehicleId, mileageKm: 5, intakeCondition: 'ok' };
    expect((await call('POST', '/api/jobs/intake', 'manager-token', body)).body.error.code).toBe(
      'BRANCH_REQUIRED',
    );
    const pinned = await call('POST', '/api/jobs/intake', 'branch-b-token', body);
    expect(pinned.status).toBe(201);
    expect(pinned.body.job.vehicleLocation).toBe('jumeirah');
  });
});

describe('Zoho-ready integration layer', () => {
  async function apiKey(): Promise<string> {
    const res = await call('POST', '/api/integration/api-keys', 'admin-token', {
      name: 'Zoho sync',
    });
    expect(res.status).toBe(201);
    expect(res.body.apiKey).not.toHaveProperty('key_hash');
    return res.body.secret;
  }

  it('serves an ordered, resumable event feed only to valid API keys', async () => {
    const { jobId } = await approvedJob();
    expect((await call('GET', '/api/integration/events')).status).toBe(401);
    expect((await call('GET', '/api/integration/events', 'manager-token')).status).toBe(401);
    expect(
      (await call('POST', '/api/integration/api-keys', 'manager-token', { name: 'x' })).status,
    ).toBe(403);

    const key = await apiKey();
    const all = await call('GET', '/api/integration/events?limit=200', key);
    expect(all.status).toBe(200);
    expect(all.body.events.map((e: any) => e.type)).toEqual([
      'customer.created',
      'vehicle.created',
      'job.created',
      'job.stage_changed', // intake -> inspection
      'inspection.completed',
      'job.stage_changed', // inspection -> pricing
      'quote.sent',
      'job.stage_changed', // pricing -> quote
      'quote.decided',
      'job.stage_changed', // quote -> approved
    ]);
    expect(all.body.events[2]).toMatchObject({
      branch: 'al_quoz',
      aggregate: { type: 'job', id: jobId },
    });
    expect(all.body.events[0].data).toMatchObject({
      email: expect.stringContaining('@example.test'),
    });

    const collected: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i += 1) {
      const page: Res = await call(
        'GET',
        `/api/integration/events?limit=3${cursor ? `&cursor=${cursor}` : ''}`,
        key,
      );
      if (page.body.events.length === 0) break;
      collected.push(...page.body.events.map((e: any) => e.id));
      cursor = page.body.nextCursor;
    }
    expect(collected).toEqual(all.body.events.map((e: any) => e.id));
    const filtered = await call(
      'GET',
      '/api/integration/events?types=quote.sent,quote.decided',
      key,
    );
    expect(filtered.body.events.map((e: any) => e.type)).toEqual(['quote.sent', 'quote.decided']);
    expect((await call('GET', '/api/integration/events?types=bogus', key)).status).toBe(400);
    expect((await call('GET', '/api/integration/events?cursor=nope', key)).status).toBe(400);

    const list = await call('GET', '/api/integration/api-keys', 'admin-token');
    expect(
      (await call('DELETE', `/api/integration/api-keys/${list.body.apiKeys[0].id}`, 'admin-token'))
        .status,
    ).toBe(204);
    expect((await call('GET', '/api/integration/events', key)).status).toBe(401);
  });

  it('delivers signed webhooks in order, backs off on failure and rejects unsafe URLs', async () => {
    for (const url of [
      'http://example.com/hook',
      'https://localhost/hook',
      'https://10.0.0.5/hook',
      'https://user:pw@example.com/hook',
      'https://example.com:8443/hook',
    ]) {
      expect((await call('POST', '/api/integration/webhooks', 'admin-token', { url })).status).toBe(
        422,
      );
    }
    const created = await call('POST', '/api/integration/webhooks', 'admin-token', {
      url: 'https://hooks.example.com/avc',
      eventTypes: ['customer.created', 'job.created'],
    });
    expect(created.status).toBe(201);
    const secret: string = created.body.signingSecret;
    expect(
      JSON.stringify((await call('GET', '/api/integration/webhooks', 'admin-token')).body),
    ).not.toContain(secret);

    await jobInInspection();
    const seen: { type: string; body: string; headers: Record<string, string> }[] = [];
    const ok: Fetcher = async (_url, init) => {
      seen.push({ type: init.headers['avc-event-type']!, body: init.body, headers: init.headers });
      return { ok: true, status: 200 };
    };
    expect(await dispatchWebhooks(pool, ok)).toEqual({ delivered: 2, failed: 0 });
    expect(seen.map((s) => s.type)).toEqual(['customer.created', 'job.created']);
    const first = seen[0]!;
    const [t, v1] = first.headers['avc-signature']!.split(',').map((p) => p.split('=')[1]!);
    expect(v1).toBe(signPayload(secret, Number(t), first.body));
    expect(await dispatchWebhooks(pool, ok)).toEqual({ delivered: 0, failed: 0 });

    await newCustomer('Another Owner', '+971 56 222 3333');
    const down: Fetcher = async () => ({ ok: false, status: 503 });
    expect(await dispatchWebhooks(pool, down)).toEqual({ delivered: 0, failed: 1 });
    const [endpoint] = (await call('GET', '/api/integration/webhooks', 'admin-token')).body
      .webhooks;
    expect(endpoint).toMatchObject({ failureCount: 1, lastError: 'HTTP 503' });
    expect(await dispatchWebhooks(pool, ok)).toEqual({ delivered: 0, failed: 0 });
    await pool.query('UPDATE avc.webhook_endpoints SET next_attempt_at = now()');
    expect(await dispatchWebhooks(pool, ok)).toEqual({ delivered: 1, failed: 0 });
    expect(seen.at(-1)!.type).toBe('customer.created');
  });
});

describe('photo upload and release', () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
  const upload = (jobId: string, token: string, body: Buffer, type = 'image/jpeg') =>
    call('POST', `/api/jobs/${jobId}/evidence/upload?kind=photo&caption=Pads`, token, body, {
      'content-type': type,
    });

  it('stores photos, checks the bytes, and shows customers only what the advisor released', async () => {
    const { jobId, customer } = await jobInInspection();
    await startInspection(jobId);
    const bad = await upload(jobId, 'tech-token', Buffer.from('not an image at all'), 'image/png');
    expect(bad.status).toBe(415);
    expect((await upload(jobId, 'driver-token', jpeg)).status).toBe(201);
    expect(
      (
        await call('POST', `/api/jobs/${jobId}/evidence/upload`, undefined, jpeg, {
          'content-type': 'image/jpeg',
        })
      ).status,
    ).toBe(401);
    const stored = await upload(jobId, 'tech-token', jpeg);
    expect(stored.status).toBe(201);
    const photoId: string = stored.body.evidence.id;

    const file = await app.inject({
      method: 'GET',
      url: `/api/evidence/${photoId}/file`,
      headers: { authorization: 'Bearer tech-token' },
    });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/jpeg');
    expect(file.rawPayload.equals(jpeg)).toBe(true);
    expect((await call('GET', `/api/evidence/${photoId}/file`)).status).toBe(401);

    // Submit with the photo as proof. The customer still cannot open it.
    const submit = await call('POST', `/api/jobs/${jobId}/inspection/submit`, 'tech-token', {
      expectedVersion: await version(jobId),
      findings: [{ title: 'Front brake pads', severity: 'critical', evidenceIds: [photoId] }],
    });
    expect(submit.status).toBe(201);
    const asCustomer = () =>
      app.inject({
        method: 'GET',
        url: `/api/portal/evidence/${photoId}/file`,
        headers: { authorization: `Bearer ${customer.profileToken}` },
      });
    expect((await asCustomer()).statusCode).toBe(404);

    // Once the advisor posts the quote the owner can see it; another customer cannot.
    expect((await priceQuote(jobId)).status).toBe(201);
    const released = await asCustomer();
    expect(released.statusCode).toBe(200);
    expect(released.rawPayload.equals(jpeg)).toBe(true);
    const other = await newCustomer('Someone Else', '+971 55 000 1111');
    const denied = await app.inject({
      method: 'GET',
      url: `/api/portal/evidence/${photoId}/file`,
      headers: { authorization: `Bearer ${other.profileToken}` },
    });
    expect(denied.statusCode).toBe(404);
  });
});
