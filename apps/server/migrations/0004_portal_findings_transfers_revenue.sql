-- Customer portal accounts, technician findings (no prices) feeding the advisor's pricing step,
-- concierge pickup/return legs, and revenue recognised when the car is delivered.

-- ---------- customer profile and portal ----------
ALTER TABLE avc.customers ADD COLUMN email text;
CREATE UNIQUE INDEX customers_email_unique_idx ON avc.customers (lower(email)) WHERE email IS NOT NULL;

-- The username is the customer's email. The starting password is their mobile number (client decision);
-- only a scrypt hash is stored, and wrong guesses lock the account for a while.
CREATE TABLE avc.customer_accounts (
  customer_id uuid PRIMARY KEY REFERENCES avc.customers(id),
  password_hash text NOT NULL,
  password_is_default boolean NOT NULL DEFAULT true,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  password_changed_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 'profile_link' backs the QR/link given at intake; 'session' is issued after a password login.
CREATE TABLE avc.customer_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES avc.customers(id),
  kind text NOT NULL CHECK (kind IN ('profile_link', 'session')),
  token_hash text NOT NULL UNIQUE,
  issued_by_staff_id uuid REFERENCES avc.staff_members(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX customer_tokens_customer_idx ON avc.customer_tokens (customer_id);

ALTER TABLE avc.quote_decisions ALTER COLUMN link_id DROP NOT NULL;
ALTER TABLE avc.quote_decisions ADD COLUMN customer_token_id uuid REFERENCES avc.customer_tokens(id);
ALTER TABLE avc.quote_decisions ADD CONSTRAINT quote_decisions_one_credential
  CHECK (num_nonnulls(link_id, customer_token_id) = 1);

-- ---------- how the car arrives and returns ----------
ALTER TABLE avc.job_cards ADD COLUMN arrival_method text NOT NULL DEFAULT 'walk_in'
  CHECK (arrival_method IN ('pickup', 'walk_in'));
ALTER TABLE avc.job_cards ADD COLUMN return_method text NOT NULL DEFAULT 'collect'
  CHECK (return_method IN ('delivery', 'collect'));
ALTER TABLE avc.job_cards ADD COLUMN lead_source text
  CHECK (lead_source IN ('google', 'meta', 'referral', 'partner', 'walk_in', 'repeat', 'other'));

ALTER TABLE avc.job_cards DROP CONSTRAINT job_cards_status_check;
ALTER TABLE avc.job_cards ADD CONSTRAINT job_cards_status_check CHECK (status IN
  ('pickup_scheduled', 'intake_open', 'inspection_pending', 'pricing_pending', 'awaiting_approval',
   'approved', 'in_progress', 'quality_check', 'ready', 'delivered'));
ALTER TABLE avc.job_cards DROP CONSTRAINT job_cards_work_stage_check;
ALTER TABLE avc.job_cards ADD CONSTRAINT job_cards_work_stage_check CHECK (work_stage IN
  ('pickup', 'intake', 'inspection', 'pricing', 'quote', 'approved', 'in_bay', 'qc', 'ready',
   'delivered'));
ALTER TABLE avc.job_events DROP CONSTRAINT job_events_event_type_check;
ALTER TABLE avc.job_events ADD CONSTRAINT job_events_event_type_check CHECK (event_type IN
  ('job_created', 'inspection_started', 'inspection_submitted', 'quote_sent', 'finding_raised',
   'quote_decided', 'stage_advanced', 'customer_link_issued', 'transfer_started',
   'transfer_completed', 'revenue_reversed'));

-- ---------- findings: the technician describes, the advisor prices ----------
CREATE TABLE avc.finding_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_card_id uuid NOT NULL REFERENCES avc.job_cards(id),
  kind text NOT NULL CHECK (kind IN ('initial', 'addendum')),
  status text NOT NULL DEFAULT 'awaiting_pricing' CHECK (status IN ('awaiting_pricing', 'priced')),
  submitted_by_staff_id uuid NOT NULL REFERENCES avc.staff_members(id),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  priced_at timestamptz,
  CHECK ((status = 'priced') = (priced_at IS NOT NULL))
);
CREATE UNIQUE INDEX finding_batches_one_open_idx ON avc.finding_batches (job_card_id)
  WHERE status = 'awaiting_pricing';
CREATE UNIQUE INDEX finding_batches_one_initial_idx ON avc.finding_batches (job_card_id)
  WHERE kind = 'initial';

CREATE TABLE avc.findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES avc.finding_batches(id),
  position integer NOT NULL CHECK (position >= 1),
  title text NOT NULL CHECK (length(trim(title)) > 0),
  detail text NOT NULL DEFAULT '',
  severity text NOT NULL CHECK (severity IN ('critical', 'moderate', 'minor')),
  UNIQUE (batch_id, position)
);

ALTER TABLE avc.quotes ADD COLUMN batch_id uuid UNIQUE REFERENCES avc.finding_batches(id);
ALTER TABLE avc.quote_items ADD COLUMN finding_id uuid REFERENCES avc.findings(id);
ALTER TABLE avc.evidence ADD COLUMN finding_id uuid REFERENCES avc.findings(id);

-- ---------- concierge pickup / return legs ----------
CREATE TABLE avc.transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_card_id uuid NOT NULL REFERENCES avc.job_cards(id),
  direction text NOT NULL CHECK (direction IN ('pickup', 'return')),
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'en_route', 'completed', 'cancelled')),
  driver_staff_id uuid REFERENCES avc.staff_members(id),
  address text NOT NULL CHECK (length(trim(address)) > 0),
  contact_phone text,
  window_start timestamptz,
  window_end timestamptz,
  notes text NOT NULL DEFAULT '',
  scheduled_by_staff_id uuid NOT NULL REFERENCES avc.staff_members(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX transfers_one_open_idx ON avc.transfers (job_card_id, direction)
  WHERE status IN ('scheduled', 'en_route');
CREATE INDEX transfers_driver_idx ON avc.transfers (driver_staff_id) WHERE status IN ('scheduled', 'en_route');
ALTER TABLE avc.evidence ADD COLUMN transfer_id uuid REFERENCES avc.transfers(id);

-- Evidence is immutable except that each link (quote item, finding, transfer) can be set once.
CREATE OR REPLACE FUNCTION avc.guard_evidence_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'evidence rows cannot be deleted';
  END IF;
  IF (NEW.id, NEW.job_card_id, NEW.kind, NEW.storage_key, NEW.content_sha256, NEW.caption,
      NEW.captured_by_staff_id, NEW.captured_at)
     IS DISTINCT FROM
     (OLD.id, OLD.job_card_id, OLD.kind, OLD.storage_key, OLD.content_sha256, OLD.caption,
      OLD.captured_by_staff_id, OLD.captured_at)
     OR (OLD.quote_item_id IS NOT NULL AND NEW.quote_item_id IS DISTINCT FROM OLD.quote_item_id)
     OR (OLD.finding_id IS NOT NULL AND NEW.finding_id IS DISTINCT FROM OLD.finding_id)
     OR (OLD.transfer_id IS NOT NULL AND NEW.transfer_id IS DISTINCT FROM OLD.transfer_id) THEN
    RAISE EXCEPTION 'evidence rows are immutable';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------- revenue: a delivered car counts as received (client decision) ----------
CREATE TABLE avc.revenue_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_card_id uuid NOT NULL UNIQUE REFERENCES avc.job_cards(id),
  branch_id uuid NOT NULL REFERENCES avc.branches(id),
  amount_aed numeric(12, 2) NOT NULL CHECK (amount_aed >= 0),
  recognised_at timestamptz NOT NULL DEFAULT now(),
  recognised_by_staff_id uuid REFERENCES avc.staff_members(id),
  reversed_at timestamptz,
  reversed_by_staff_id uuid REFERENCES avc.staff_members(id),
  reversal_reason text CHECK (reversal_reason IS NULL OR length(trim(reversal_reason)) > 0),
  CHECK ((reversed_at IS NULL) = (reversal_reason IS NULL))
);
CREATE INDEX revenue_entries_branch_time_idx ON avc.revenue_entries (branch_id, recognised_at);
