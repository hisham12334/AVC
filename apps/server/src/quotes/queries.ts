import type { Pool, PoolClient } from 'pg';

export type QuoteEvidence = {
  id: string;
  kind: string;
  caption: string;
  capturedAt: string;
  storageKey?: string;
};
export type QuoteItemView = {
  id: string;
  position: number;
  title: string;
  detail: string;
  severity: 'critical' | 'moderate' | 'minor';
  priceAed: number;
  decision: 'pending' | 'approved' | 'rejected';
  decidedAt: string | null;
  evidence: QuoteEvidence[];
};
export type QuoteView = {
  id: string;
  version: number;
  kind: 'initial' | 'addendum';
  status: 'sent' | 'decided';
  sentAt: string;
  decidedAt: string | null;
  totalAed: number;
  approvedTotalAed: number;
  items: QuoteItemView[];
};

type QuoteRow = {
  id: string;
  version: number;
  kind: 'initial' | 'addendum';
  status: 'sent' | 'decided';
  sentAt: Date;
  decidedAt: Date | null;
};
type ItemRow = {
  id: string;
  quoteId: string;
  position: number;
  title: string;
  detail: string;
  severity: QuoteItemView['severity'];
  price: string;
  decision: QuoteItemView['decision'];
  decidedAt: Date | null;
};
type EvidenceRow = {
  id: string;
  itemId: string;
  kind: string;
  caption: string;
  capturedAt: Date;
  storageKey: string;
};

// `forCustomer` hides internal storage keys; the customer app gets signed URLs once storage exists.
export async function loadQuotes(
  db: Pool | PoolClient,
  jobId: string,
  options: { forCustomer: boolean },
): Promise<QuoteView[]> {
  const quotes = await db.query<QuoteRow>(
    `SELECT id, version, kind, status, sent_at AS "sentAt", decided_at AS "decidedAt"
     FROM avc.quotes WHERE job_card_id = $1 ORDER BY version`,
    [jobId],
  );
  if (quotes.rows.length === 0) return [];
  const ids = quotes.rows.map((q) => q.id);
  const items = await db.query<ItemRow>(
    `SELECT id, quote_id AS "quoteId", position, title, detail, severity, price_aed::text AS price,
            decision, decided_at AS "decidedAt"
     FROM avc.quote_items WHERE quote_id = ANY($1::uuid[]) ORDER BY quote_id, position`,
    [ids],
  );
  const evidence = await db.query<EvidenceRow>(
    `SELECT id, quote_item_id AS "itemId", kind, caption, captured_at AS "capturedAt",
            storage_key AS "storageKey"
     FROM avc.evidence WHERE quote_item_id = ANY($1::uuid[]) ORDER BY captured_at`,
    [items.rows.map((i) => i.id)],
  );
  return quotes.rows.map((q) => {
    const views: QuoteItemView[] = items.rows
      .filter((i) => i.quoteId === q.id)
      .map((i) => ({
        id: i.id,
        position: i.position,
        title: i.title,
        detail: i.detail,
        severity: i.severity,
        priceAed: Number(i.price),
        decision: i.decision,
        decidedAt: i.decidedAt?.toISOString() ?? null,
        evidence: evidence.rows
          .filter((e) => e.itemId === i.id)
          .map((e) => ({
            id: e.id,
            kind: e.kind,
            caption: e.caption,
            capturedAt: e.capturedAt.toISOString(),
            ...(options.forCustomer ? {} : { storageKey: e.storageKey }),
          })),
      }));
    const cents = (n: number) => Math.round(n * 100);
    return {
      id: q.id,
      version: q.version,
      kind: q.kind,
      status: q.status,
      sentAt: q.sentAt.toISOString(),
      decidedAt: q.decidedAt?.toISOString() ?? null,
      totalAed: views.reduce((a, i) => a + cents(i.priceAed), 0) / 100,
      approvedTotalAed:
        views.filter((i) => i.decision === 'approved').reduce((a, i) => a + cents(i.priceAed), 0) /
        100,
      items: views,
    };
  });
}
