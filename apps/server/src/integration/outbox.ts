import type { Pool, PoolClient } from 'pg';
import { AppError } from '../errors.js';

export type OutboxEventInput = {
  branchId: string | null;
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
};

// Written inside the same transaction as the change it describes, so an event exists if and only if
// the change committed. Consumers (Zoho CRM sync, webhooks) read it later; nothing is sent inline.
export async function emit(client: PoolClient, event: OutboxEventInput): Promise<void> {
  await client.query(
    `INSERT INTO avc.outbox_events(branch_id, event_type, aggregate_type, aggregate_id, payload)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [
      event.branchId,
      event.type,
      event.aggregateType,
      event.aggregateId,
      JSON.stringify(event.payload),
    ],
  );
}

export type EventEnvelope = {
  id: string;
  cursor: string;
  type: string;
  occurredAt: string;
  branch: string | null;
  aggregate: { type: string; id: string };
  data: unknown;
};
export type EventPage = { events: EventEnvelope[]; nextCursor: string };

type Row = {
  seq: string;
  txid: string;
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: unknown;
  created_at: Date;
  branch_code: string | null;
};

export const START_CURSOR = '0.0';

export function parseCursor(cursor: string | undefined): { txid: string; seq: string } {
  const match = /^(\d{1,19})\.(\d{1,19})$/.exec(cursor ?? START_CURSOR);
  if (!match) throw new AppError(400, 'INVALID_CURSOR', 'Cursor is not valid');
  return { txid: match[1]!, seq: match[2]! };
}

// Cursor = "txid.seq". Only transactions older than every still-running transaction are visible, so a
// transaction that commits late can never appear behind a cursor a consumer already moved past.
export async function readEvents(
  db: Pool | PoolClient,
  options: { cursor?: string; limit: number; types?: string[] },
): Promise<EventPage> {
  const { txid, seq } = parseCursor(options.cursor);
  const result = await db.query<Row>(
    `SELECT e.seq::text, e.txid::text, e.id, e.event_type, e.aggregate_type, e.aggregate_id,
            e.payload, e.created_at, b.code AS branch_code
     FROM avc.outbox_events e LEFT JOIN avc.branches b ON b.id = e.branch_id
     WHERE e.txid < pg_snapshot_xmin(pg_current_snapshot())::text::bigint
       AND (e.txid, e.seq) > ($1::bigint, $2::bigint)
       AND (cardinality($3::text[]) = 0 OR e.event_type = ANY($3::text[]))
     ORDER BY e.txid, e.seq LIMIT $4`,
    [txid, seq, options.types ?? [], options.limit],
  );
  const last = result.rows.at(-1);
  return {
    events: result.rows.map((r) => ({
      id: r.id,
      cursor: `${r.txid}.${r.seq}`,
      type: r.event_type,
      occurredAt: r.created_at.toISOString(),
      branch: r.branch_code,
      aggregate: { type: r.aggregate_type, id: r.aggregate_id },
      data: r.payload,
    })),
    nextCursor: last ? `${last.txid}.${last.seq}` : (options.cursor ?? START_CURSOR),
  };
}
