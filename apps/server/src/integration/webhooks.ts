import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import type { Pool } from 'pg';
import { AppError } from '../errors.js';
import { readEvents, type EventEnvelope } from './outbox.js';

export const EVENT_TYPES = [
  'customer.created',
  'vehicle.created',
  'job.created',
  'job.stage_changed',
  'job.delivered',
  'inspection.completed',
  'finding.raised',
  'transfer.completed',
  'revenue.reversed',
  'quote.sent',
  'quote.decided',
] as const;

export function signPayload(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

// Lexical SSRF guard. It does not stop a public DNS name that resolves to a private address; production
// should also send webhook traffic through an egress proxy that blocks internal ranges.
export function assertPublicHttpsUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError(422, 'WEBHOOK_URL_INVALID', 'Webhook URL is not valid');
  }
  const host = url.hostname.toLowerCase();
  const private4 =
    /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
  const bad =
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    (url.port !== '' && url.port !== '443') ||
    host === 'localhost' ||
    /\.(local|localhost|internal|lan)$/.test(host) ||
    (isIP(host) === 4 && private4.test(host)) ||
    host.startsWith('[');
  if (bad)
    throw new AppError(
      422,
      'WEBHOOK_URL_INVALID',
      'Webhook URL must be a public https:// address on port 443 without credentials',
    );
}

export type Fetcher = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

type Endpoint = {
  id: string;
  url: string;
  signingSecret: string;
  eventTypes: string[];
  cursorTxid: string;
  cursorSeq: string;
  failureCount: number;
};

const BATCH = 50;
const DISPATCH_LOCK = 2468002;

async function deliver(
  fetcher: Fetcher,
  endpoint: Endpoint,
  event: EventEnvelope,
): Promise<string | null> {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    assertPublicHttpsUrl(endpoint.url);
    const response = await fetcher(endpoint.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'avc-event-id': event.id,
        'avc-event-type': event.type,
        'avc-signature': `t=${timestamp},v1=${signPayload(endpoint.signingSecret, timestamp, body)}`,
      },
      body,
      signal: controller.signal,
    });
    return response.ok ? null : `HTTP ${response.status}`;
  } catch (error) {
    return error instanceof Error ? error.message.slice(0, 200) : 'delivery failed';
  } finally {
    clearTimeout(timer);
  }
}

// At-least-once, in order, per endpoint. Each endpoint keeps its own cursor into the outbox and stops
// at the first failure, retrying with exponential backoff. Receivers should dedupe on the event id.
export async function dispatchWebhooks(
  db: Pool,
  fetcher: Fetcher = fetch as unknown as Fetcher,
): Promise<{ delivered: number; failed: number }> {
  const lock = await db.connect();
  const totals = { delivered: 0, failed: 0 };
  try {
    const got = await lock.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [
      DISPATCH_LOCK,
    ]);
    if (!got.rows[0]!.ok) return totals;
    const endpoints = await db.query<Endpoint>(
      `SELECT id, url, signing_secret AS "signingSecret", event_types AS "eventTypes",
              cursor_txid::text AS "cursorTxid", cursor_seq::text AS "cursorSeq",
              failure_count AS "failureCount"
       FROM avc.webhook_endpoints WHERE active AND next_attempt_at <= now() ORDER BY created_at`,
    );
    for (const endpoint of endpoints.rows) {
      const page = await readEvents(db, {
        cursor: `${endpoint.cursorTxid}.${endpoint.cursorSeq}`,
        limit: BATCH,
        types: endpoint.eventTypes,
      });
      let failure: string | null = null;
      for (const event of page.events) {
        failure = await deliver(fetcher, endpoint, event);
        if (failure) break;
        const [txid, seq] = event.cursor.split('.');
        await db.query(
          'UPDATE avc.webhook_endpoints SET cursor_txid = $2, cursor_seq = $3 WHERE id = $1',
          [endpoint.id, txid, seq],
        );
        totals.delivered += 1;
      }
      if (failure) {
        totals.failed += 1;
        const delayMinutes = Math.min(60, 2 ** Math.min(endpoint.failureCount, 6));
        await db.query(
          `UPDATE avc.webhook_endpoints SET failure_count = failure_count + 1, last_error = $2,
             next_attempt_at = now() + make_interval(mins => $3) WHERE id = $1`,
          [endpoint.id, failure, delayMinutes],
        );
      } else if (endpoint.failureCount > 0 || page.events.length > 0) {
        await db.query(
          'UPDATE avc.webhook_endpoints SET failure_count = 0, last_error = NULL WHERE id = $1',
          [endpoint.id],
        );
      }
    }
    return totals;
  } finally {
    await lock.query('SELECT pg_advisory_unlock($1)', [DISPATCH_LOCK]).catch(() => undefined);
    lock.release();
  }
}
