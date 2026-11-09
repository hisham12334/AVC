-- Customer communications, follow-up opportunities, and accountable next actions.
ALTER TABLE avc.customers ADD COLUMN service_reminders_opt_in boolean NOT NULL DEFAULT false;
CREATE TABLE avc.customer_message_settings (id boolean PRIMARY KEY DEFAULT true CHECK (id), started_at timestamptz NOT NULL DEFAULT now());
INSERT INTO avc.customer_message_settings(id) VALUES (true);

CREATE TABLE avc.customer_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES avc.customers(id),
  job_card_id uuid REFERENCES avc.job_cards(id),
  source_key text NOT NULL UNIQUE,
  kind text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_messages_pending_idx ON avc.customer_messages(next_attempt_at) WHERE status <> 'sent';
CREATE INDEX customer_messages_customer_idx ON avc.customer_messages(customer_id, created_at DESC);

CREATE TABLE avc.service_followups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES avc.customers(id),
  vehicle_id uuid NOT NULL REFERENCES avc.vehicles(id),
  source_job_id uuid NOT NULL REFERENCES avc.job_cards(id),
  quote_item_id uuid REFERENCES avc.quote_items(id),
  kind text NOT NULL CHECK (kind IN ('declined_work', 'service_reminder')),
  title text NOT NULL,
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'contacted', 'booked', 'dismissed')),
  contacted_at timestamptz,
  booked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_job_id, quote_item_id),
  CHECK ((kind = 'declined_work') = (quote_item_id IS NOT NULL))
);
CREATE INDEX service_followups_due_idx ON avc.service_followups(due_at) WHERE status = 'open';
CREATE UNIQUE INDEX service_followups_one_service_per_job_idx ON avc.service_followups(source_job_id)
  WHERE kind = 'service_reminder';

CREATE TABLE avc.job_action_plans (
  job_card_id uuid PRIMARY KEY REFERENCES avc.job_cards(id),
  next_action text NOT NULL DEFAULT '',
  owner_staff_id uuid REFERENCES avc.staff_members(id),
  promised_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_staff_id uuid REFERENCES avc.staff_members(id)
);
