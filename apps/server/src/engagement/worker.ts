import type { Pool } from 'pg';

const LOCK = 2468003;

// Rebuild the queue from committed facts. Unique source keys make every tick safe to retry.
export async function prepareCustomerWork(db: Pool): Promise<void> {
  await db.query(`INSERT INTO avc.customer_messages(customer_id, job_card_id, source_key, kind, subject, body)
    SELECT j.customer_id, j.id, 'event:' || e.id::text,
      CASE WHEN e.event_type = 'quote.sent' THEN 'quote_ready' ELSE 'stage_update' END,
      CASE WHEN e.event_type = 'quote.sent' THEN 'Your AVC quote is ready'
        WHEN e.payload->>'to' = 'ready' THEN 'Your car is ready'
        WHEN e.payload->>'to' = 'delivered' THEN 'Your AVC visit is complete'
        ELSE 'An update on your AVC visit' END,
      CASE WHEN e.event_type = 'quote.sent'
        THEN 'Please sign in to My AVC to review and decide on your quote for job AVC-' || j.job_number::text || '.'
        WHEN e.payload->>'to' = 'ready' THEN 'Your car is ready. Please sign in to My AVC for the latest details on job AVC-' || j.job_number::text || '.'
        WHEN e.payload->>'to' = 'delivered' THEN 'Thank you for visiting AVC. Your visit AVC-' || j.job_number::text || ' is complete.'
        ELSE 'There is an update on job AVC-' || j.job_number::text || '. Please sign in to My AVC for details.' END
    FROM avc.outbox_events e JOIN avc.job_cards j ON j.id = (e.payload->>'jobId')::uuid
    WHERE e.event_type IN ('quote.sent', 'job.stage_changed')
      AND e.created_at >= (SELECT started_at FROM avc.customer_message_settings)
      AND (e.event_type = 'quote.sent' OR e.payload->>'to' IN ('inspection', 'pricing', 'in_bay', 'qc', 'ready', 'delivered'))
    ON CONFLICT (source_key) DO NOTHING`);

  await db.query(`INSERT INTO avc.customer_messages(customer_id, job_card_id, source_key, kind, subject, body)
    SELECT j.customer_id, j.id, 'quote-reminder:' || q.id::text, 'quote_reminder',
      'Your AVC quote is waiting',
      'Your quote for job AVC-' || j.job_number::text || ' is still waiting for your decision. Please sign in to My AVC.'
    FROM avc.quotes q JOIN avc.job_cards j ON j.id = q.job_card_id
    WHERE q.status = 'sent' AND q.sent_at <= now() - interval '24 hours'
      AND q.sent_at >= (SELECT started_at FROM avc.customer_message_settings)
    ON CONFLICT (source_key) DO NOTHING`);

  await db.query(`INSERT INTO avc.service_followups(customer_id, vehicle_id, source_job_id, quote_item_id, kind, title, due_at)
    SELECT j.customer_id, j.vehicle_id, j.id, i.id, 'declined_work', i.title,
      d.occurred_at + interval '30 days'
    FROM avc.job_cards j JOIN avc.job_events d ON d.job_card_id = j.id AND d.to_status = 'delivered' AND d.from_status <> 'delivered'
    JOIN avc.quotes q ON q.job_card_id = j.id JOIN avc.quote_items i ON i.quote_id = q.id
    WHERE i.decision = 'rejected' AND d.occurred_at >= now() - interval '1 year'
    ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO avc.service_followups(customer_id, vehicle_id, source_job_id, quote_item_id, kind, title, due_at)
    SELECT j.customer_id, j.vehicle_id, j.id, NULL, 'service_reminder', 'Time to plan your next service',
      d.occurred_at + interval '180 days'
    FROM avc.job_cards j JOIN avc.job_events d ON d.job_card_id = j.id AND d.to_status = 'delivered' AND d.from_status <> 'delivered'
    WHERE d.occurred_at >= now() - interval '180 days'
    ON CONFLICT DO NOTHING`);

  await db.query(`INSERT INTO avc.customer_messages(customer_id, job_card_id, source_key, kind, subject, body)
    SELECT f.customer_id, f.source_job_id, 'followup:' || f.id::text, f.kind,
      CASE WHEN f.kind = 'declined_work' THEN 'A follow-up on your AVC inspection' ELSE 'Time for your next service' END,
      CASE WHEN f.kind = 'declined_work' THEN 'Your previous AVC inspection included ' || f.title ||
        '. Please contact AVC if you would like to discuss or book this work.'
        ELSE 'It may be time to plan your next service. Please contact AVC to arrange a visit.' END
    FROM avc.service_followups f JOIN avc.customers c ON c.id = f.customer_id
    WHERE f.status = 'open' AND f.due_at <= now() AND c.service_reminders_opt_in
    ON CONFLICT (source_key) DO NOTHING`);
}

export async function runCustomerMessages(
  db: Pool,
  endpoint?: string,
  apiKey?: string,
  portalUrl?: string,
): Promise<void> {
  const lock = await db.connect();
  try {
    const acquired = await lock.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [
      LOCK,
    ]);
    if (!acquired.rows[0]?.ok) return;
    await prepareCustomerWork(db);
    if (!endpoint || !apiKey || !portalUrl) return;
    const queued = await db.query<{
      id: string;
      email: string;
      subject: string;
      body: string;
      attempts: number;
    }>(
      `SELECT m.id, c.email, m.subject, m.body, m.attempts FROM avc.customer_messages m
       JOIN avc.customers c ON c.id = m.customer_id
       WHERE m.status <> 'sent' AND m.next_attempt_at <= now() AND c.email IS NOT NULL
         AND (m.kind NOT IN ('declined_work', 'service_reminder') OR c.service_reminders_opt_in)
         AND (m.kind <> 'quote_reminder' OR EXISTS (
           SELECT 1 FROM avc.quotes q WHERE m.source_key = 'quote-reminder:' || q.id::text AND q.status = 'sent'))
         AND (m.kind NOT IN ('declined_work', 'service_reminder') OR EXISTS (
           SELECT 1 FROM avc.service_followups f WHERE m.source_key = 'followup:' || f.id::text AND f.status = 'open'))
       ORDER BY m.created_at LIMIT 25`,
    );
    for (const message of queued.rows) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
            'idempotency-key': message.id,
          },
          body: JSON.stringify({
            to: message.email,
            subject: message.subject,
            text: `${message.body}\n\n${portalUrl}`,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        await db.query(
          "UPDATE avc.customer_messages SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = $1",
          [message.id],
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message.slice(0, 200) : 'delivery failed';
        await db.query(
          `UPDATE avc.customer_messages SET status = 'failed', attempts = attempts + 1,
          last_error = $2, next_attempt_at = now() + make_interval(mins => LEAST(60, power(2, LEAST(attempts, 6))::integer))
          WHERE id = $1`,
          [message.id, reason],
        );
      }
    }
  } finally {
    await lock.query('SELECT pg_advisory_unlock($1)', [LOCK]).catch(() => undefined);
    lock.release();
  }
}
