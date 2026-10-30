/* eslint-disable @typescript-eslint/no-explicit-any -- test response bodies are untyped JSON */
import { join } from 'node:path';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createApp } from '../app.js';
import { loadLocalEnvFile, type Config } from '../config.js';
import { AppError } from '../errors.js';
import { dispatchWebhooks, signPayload, type Fetcher } from '../integration/webhooks.js';
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
const subjects: Record<string, string> = {
  'manager-token': 'test-manager',
  'tech-token': 'test-technician',
  'admin-token': 'test-admin',
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
  method: 'GET' | 'POST' | 'DELETE',
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

async function jobInInspection(vin = 'TESTVIN1234567890') {
  const c = await call('POST', '/api/customers', 'manager-token', {
    fullName: 'Test Owner',
    mobileNumber: '+971 50 111 2222',
  });
  const v = await call('POST', '/api/vehicles', 'manager-token', {
    customerId: c.body.customer.id,
    vin,
    licensePlate: 'Dubai A 12345',
    make: 'Porsche',
    model: 'Cayenne',
    modelYear: 2020,
  });
  const j = await call('POST', '/api/jobs/intake', 'manager-token', {
    customerId: c.body.customer.id,
    vehicleId: v.body.vehicle.id,
    mileageKm: 1000,
    intakeCondition: 'Clean, no visible damage',
  });
  const jobId: string = j.body.job.id;
  const started = await call(
    'POST',
    `/api/jobs/${jobId}/commands/start-inspection`,
    'manager-token',
    {
      expectedVersion: 1,
    },
  );
  return { jobId, version: started.body.job.version as number };
}
async function evidence(jobId: string, token = 'manager-token', kind = 'photo') {
  const res = await call('POST', `/api/jobs/${jobId}/evidence`, token, {
    kind,
    storageKey: `jobs/${jobId}/${Math.random().toString(36).slice(2)}.jpg`,
    caption: 'Close-up',
  });
  expect(res.status).toBe(201);
  return res.body.evidence.id as string;
}
async function publishQuote(jobId: string, version: number) {
  const proof = await evidence(jobId);
  return call('POST', `/api/jobs/${jobId}/quotes`, 'manager-token', {
    expectedVersion: version,
    items: [
      {
        title: 'Front brake pads',
        detail: 'Measured at 2.8 mm',
        severity: 'critical',
        priceAed: 780,
        evidenceIds: [proof],
      },
      { title: 'Engine oil & filter', severity: 'minor', priceAed: 420.5 },
    ],
  });
}
const track = (token: string) => call('GET', `/api/track/${token}`);
const tokenOf = (res: Res): string => res.body.customerLink.token;

beforeAll(async () => {
  const dir = join(__dirname, '..', '..', 'migrations');
  const applied = await migrate(pool, dir, 'up');
  expect(applied).toContain('applied 0003_branches_quotes_integration.sql');
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
      ('test-admin','Test Admin','admin')`,
  );
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('quote, approval and addendum lifecycle', () => {
  it('runs a car from inspection to delivery with customer approval as the start line', async () => {
    const { jobId, version } = await jobInInspection();
    const published = await publishQuote(jobId, version);
    expect(published.status).toBe(201);
    const token = tokenOf(published);
    expect(published.body.customerLink.path).toBe(`/track/${token}`);

    // Work cannot begin while the quote is unanswered.
    const early = await call('POST', `/api/jobs/${jobId}/commands/advance`, 'manager-token', {
      expectedVersion: published.body.jobVersion,
    });
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('INVALID_TRANSITION');

    // The customer sees the quote without staff-only fields.
    const view = await track(token);
    expect(view.status).toBe(200);
    expect(view.body.job.stage).toBe('quote');
    expect(view.body.workPaused).toBe(false);
    expect(view.body.openQuote.items).toHaveLength(2);
    expect(view.body.openQuote.totalAed).toBe(1200.5);
    expect(JSON.stringify(view.body)).not.toMatch(/storageKey|customerMobile|jobs\//);

    const quote = view.body.openQuote;
    const [pads, oil] = quote.items;
    const incomplete = await call('POST', `/api/track/${token}/decisions`, undefined, {
      quoteId: quote.id,
      quoteVersion: quote.version,
      decisions: [{ itemId: pads.id, decision: 'approved' }],
    });
    expect(incomplete.status).toBe(422);
    expect(incomplete.body.error.code).toBe('INCOMPLETE_DECISIONS');

    const decisions = [
      { itemId: pads.id, decision: 'approved' },
      { itemId: oil.id, decision: 'rejected' },
    ];
    const wrongVersion = await call('POST', `/api/track/${token}/decisions`, undefined, {
      quoteId: quote.id,
      quoteVersion: quote.version + 1,
      decisions,
    });
    expect(wrongVersion.body.error.code).toBe('QUOTE_VERSION_MISMATCH');

    const decided = await call('POST', `/api/track/${token}/decisions`, undefined, {
      quoteId: quote.id,
      quoteVersion: quote.version,
      decisions,
    });
    expect(decided.status).toBe(200);
    expect(decided.body.result).toMatchObject({
      stage: 'approved',
      approved: 1,
      rejected: 1,
      approvedTotalAed: 780,
    });

    // A replayed submission cannot change the answer.
    const replay = await call('POST', `/api/track/${token}/decisions`, undefined, {
      quoteId: quote.id,
      quoteVersion: quote.version,
      decisions: decisions.map((d) => ({ ...d, decision: 'approved' })),
    });
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe('QUOTE_ALREADY_DECIDED');

    let current = (await call('GET', `/api/jobs/${jobId}`, 'manager-token')).body.job;
    expect(current.workStage).toBe('approved');
    const start = await call('POST', `/api/jobs/${jobId}/commands/advance`, 'manager-token', {
      expectedVersion: current.version,
    });
    expect(start.body.job.workStage).toBe('in_bay');

    // A technician finds something new: work on it waits for the customer.
    const proof = await evidence(jobId, 'tech-token');
    const finding = await call('POST', `/api/jobs/${jobId}/findings`, 'tech-token', {
      expectedVersion: start.body.job.version,
      items: [
        {
          title: 'Cracked serpentine belt',
          severity: 'moderate',
          priceAed: 380,
          evidenceIds: [proof],
        },
      ],
    });
    expect(finding.status).toBe(201);
    current = (await call('GET', `/api/jobs/${jobId}`, 'manager-token')).body.job;
    const blocked = await call('POST', `/api/jobs/${jobId}/commands/advance`, 'manager-token', {
      expectedVersion: current.version,
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('AWAITING_CUSTOMER_DECISION');

    const paused = await track(token);
    expect(paused.body.workPaused).toBe(true);
    expect(paused.body.job.stage).toBe('in_bay');
    const addendum = paused.body.openQuote;
    expect(addendum.kind).toBe('addendum');
    const approved = await call('POST', `/api/track/${token}/decisions`, undefined, {
      quoteId: addendum.id,
      quoteVersion: addendum.version,
      decisions: [{ itemId: addendum.items[0].id, decision: 'approved' }],
    });
    expect(approved.body.result.stage).toBe('in_bay');

    for (const stage of ['qc', 'ready', 'delivered']) {
      current = (await call('GET', `/api/jobs/${jobId}`, 'manager-token')).body.job;
      const moved = await call('POST', `/api/jobs/${jobId}/commands/advance`, 'manager-token', {
        expectedVersion: current.version,
      });
      expect(moved.body.job.workStage).toBe(stage);
    }

    // The audit trail has no gaps and records the customer as the actor of their decisions.
    const { events } = (await call('GET', `/api/jobs/${jobId}`, 'manager-token')).body;
    expect(events.map((e: any) => e.jobVersion)).toEqual(
      events.map((_: unknown, i: number) => i + 1),
    );
    const customerEvents = events.filter((e: any) => e.actorType === 'customer');
    expect(customerEvents).toHaveLength(2);
    expect(customerEvents[0].actorStaffName).toBe('Customer');

    const summary = await call('GET', '/api/dashboard/summary', 'manager-token');
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({
      activeCars: 0,
      capacity: 30,
      deliveredMtd: 1,
      approvedValueMtdAed: 1160,
      awaitingApproval: 0,
      pausedForFinding: 0,
    });
    const history = await track(token);
    expect(history.body.decidedQuotes).toHaveLength(2);
    expect(history.body.timeline.at(-1).label).toBe('Delivered');
  });

  it('enforces evidence for yellow and red items and valid, current customer links', async () => {
    const { jobId, version } = await jobInInspection();
    const noProof = await call('POST', `/api/jobs/${jobId}/quotes`, 'manager-token', {
      expectedVersion: version,
      items: [{ title: 'Brake fluid', severity: 'moderate', priceAed: 310 }],
    });
    expect(noProof.status).toBe(422);
    expect(noProof.body.error.code).toBe('EVIDENCE_REQUIRED');

    const signature = await evidence(jobId, 'manager-token', 'signature');
    const wrongKind = await call('POST', `/api/jobs/${jobId}/quotes`, 'manager-token', {
      expectedVersion: version,
      items: [
        { title: 'Brake fluid', severity: 'moderate', priceAed: 310, evidenceIds: [signature] },
      ],
    });
    expect(wrongKind.body.error.code).toBe('EVIDENCE_INVALID');

    const stale = await publishQuote(jobId, version - 1);
    expect(stale.body.error.code).toBe('STALE_VERSION');

    const published = await publishQuote(jobId, version);
    expect(published.status).toBe(201);
    const first = tokenOf(published);
    const reissued = await call('POST', `/api/jobs/${jobId}/customer-links`, 'manager-token', {
      expectedVersion: published.body.jobVersion,
    });
    expect(reissued.status).toBe(201);
    expect((await track(first)).status).toBe(404);
    expect((await track(first)).body.error.code).toBe('LINK_INVALID');
    expect((await track(reissued.body.customerLink.token)).status).toBe(200);
    expect((await track('x'.repeat(43))).status).toBe(404);

    const again = await publishQuote(jobId, published.body.jobVersion + 1);
    expect(again.status).toBe(422); // the job is no longer in inspection

    const tech = await call('POST', `/api/jobs/${jobId}/quotes`, 'tech-token', {
      expectedVersion: 1,
      items: [{ title: 'x', severity: 'minor', priceAed: 1 }],
    });
    expect(tech.status).toBe(403);
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
    const list = await call('GET', '/api/jobs', 'branch-b-token');
    expect(list.body.jobs).toHaveLength(0);
    expect((await call('GET', `/api/jobs/${jobId}`, 'branch-b-token')).status).toBe(404);
    const summary = await call('GET', '/api/dashboard/summary', 'branch-b-token');
    expect(summary.body).toMatchObject({ capacity: 12, activeCars: 0 });

    // With several branches active, an unpinned manager must say which one an intake belongs to.
    const c = await call('POST', '/api/customers', 'manager-token', {
      fullName: 'Second Owner',
      mobileNumber: '+971 55 000 1111',
    });
    const v = await call('POST', '/api/vehicles', 'manager-token', {
      customerId: c.body.customer.id,
      vin: 'SECONDVIN12345678',
      make: 'BMW',
      model: 'X5',
    });
    const ambiguous = await call('POST', '/api/jobs/intake', 'manager-token', {
      customerId: c.body.customer.id,
      vehicleId: v.body.vehicle.id,
      mileageKm: 5,
      intakeCondition: 'ok',
    });
    expect(ambiguous.body.error.code).toBe('BRANCH_REQUIRED');
    const pinned = await call('POST', '/api/jobs/intake', 'branch-b-token', {
      customerId: c.body.customer.id,
      vehicleId: v.body.vehicle.id,
      mileageKm: 5,
      intakeCondition: 'ok',
    });
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
    const { jobId, version } = await jobInInspection();
    const published = await publishQuote(jobId, version);
    const token = tokenOf(published);
    const quote = (await track(token)).body.openQuote;
    await call('POST', `/api/track/${token}/decisions`, undefined, {
      quoteId: quote.id,
      quoteVersion: quote.version,
      decisions: quote.items.map((i: any) => ({ itemId: i.id, decision: 'approved' })),
    });

    expect((await call('GET', '/api/integration/events')).status).toBe(401);
    expect((await call('GET', '/api/integration/events', 'manager-token')).status).toBe(401);
    expect(
      (await call('POST', '/api/integration/api-keys', 'manager-token', { name: 'x' })).status,
    ).toBe(403);

    const key = await apiKey();
    const all = await call('GET', '/api/integration/events?limit=200', key);
    expect(all.status).toBe(200);
    const types = all.body.events.map((e: any) => e.type);
    expect(types).toEqual([
      'customer.created',
      'vehicle.created',
      'job.created',
      'job.stage_changed', // intake -> inspection
      'quote.sent',
      'job.stage_changed', // inspection -> quote
      'quote.decided',
      'job.stage_changed', // quote -> approved
    ]);
    expect(all.body.events[2]).toMatchObject({
      branch: 'al_quoz',
      aggregate: { type: 'job', id: jobId },
    });

    // Paging by cursor yields the same events once each.
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
    const id = list.body.apiKeys[0].id;
    expect((await call('DELETE', `/api/integration/api-keys/${id}`, 'admin-token')).status).toBe(
      204,
    );
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
      const res = await call('POST', '/api/integration/webhooks', 'admin-token', { url });
      expect(res.status).toBe(422);
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

    await jobInInspection(); // customer.created, vehicle.created, job.created, job.stage_changed
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

    const c = await call('POST', '/api/customers', 'manager-token', {
      fullName: 'Another Owner',
      mobileNumber: '+971 56 222 3333',
    });
    expect(c.status).toBe(201);
    const down: Fetcher = async () => ({ ok: false, status: 503 });
    expect(await dispatchWebhooks(pool, down)).toEqual({ delivered: 0, failed: 1 });
    const [endpoint] = (await call('GET', '/api/integration/webhooks', 'admin-token')).body
      .webhooks;
    expect(endpoint).toMatchObject({ failureCount: 1, lastError: 'HTTP 503' });
    // During backoff nothing is attempted; the event is not lost.
    expect(await dispatchWebhooks(pool, ok)).toEqual({ delivered: 0, failed: 0 });
    await pool.query('UPDATE avc.webhook_endpoints SET next_attempt_at = now()');
    expect(await dispatchWebhooks(pool, ok)).toEqual({ delivered: 1, failed: 0 });
    expect(seen.at(-1)!.type).toBe('customer.created');
  });
});
