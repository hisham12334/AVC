-- Branches, quotes with per-line customer decisions, evidence, customer tracking links,
-- and an integration layer (transactional outbox, API keys, webhook endpoints) for Zoho CRM.

-- ---------- branches (AVC currently has one outlet; more can be added as rows) ----------
CREATE TABLE avc.branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_]{2,32}$'),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  timezone text NOT NULL DEFAULT 'Asia/Dubai',
  bay_capacity integer NOT NULL DEFAULT 30 CHECK (bay_capacity > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO avc.branches(code, name, bay_capacity) VALUES ('al_quoz', 'Al Quoz 1', 30);

ALTER TABLE avc.staff_members DROP CONSTRAINT staff_members_role_check;
ALTER TABLE avc.staff_members ADD CONSTRAINT staff_members_role_check
  CHECK (role IN ('lounge_manager', 'technician', 'driver', 'workshop_manager', 'finance', 'admin'));
-- NULL branch_id means the staff member works across all branches.
ALTER TABLE avc.staff_members ADD COLUMN branch_id uuid REFERENCES avc.branches(id);

ALTER TABLE avc.job_cards ADD COLUMN branch_id uuid REFERENCES avc.branches(id);
UPDATE avc.job_cards SET branch_id = (SELECT id FROM avc.branches WHERE code = 'al_quoz');
ALTER TABLE avc.job_cards ALTER COLUMN branch_id SET NOT NULL;
CREATE INDEX job_cards_branch_stage_idx ON avc.job_cards (branch_id, work_stage);

-- The foundation hard-coded a Jumeirah location and two stages; the job now follows the full lifecycle.
ALTER TABLE avc.job_cards DROP CONSTRAINT job_cards_vehicle_location_check;
UPDATE avc.job_cards SET vehicle_location = 'al_quoz';
ALTER TABLE avc.job_cards ADD CONSTRAINT job_cards_vehicle_location_check
  CHECK (length(trim(vehicle_location)) > 0);
ALTER TABLE avc.job_cards DROP CONSTRAINT job_cards_status_check;
ALTER TABLE avc.job_cards ADD CONSTRAINT job_cards_status_check CHECK (status IN
  ('intake_open', 'inspection_pending', 'awaiting_approval', 'approved', 'in_progress',
   'quality_check', 'ready', 'delivered'));
ALTER TABLE avc.job_cards DROP CONSTRAINT job_cards_work_stage_check;
ALTER TABLE avc.job_cards ADD CONSTRAINT job_cards_work_stage_check CHECK (work_stage IN
  ('intake', 'inspection', 'quote', 'approved', 'in_bay', 'qc', 'ready', 'delivered'));

-- Events can now be caused by a customer or the system, not only staff.
ALTER TABLE avc.job_events DROP CONSTRAINT job_events_event_type_check;
ALTER TABLE avc.job_events ADD CONSTRAINT job_events_event_type_check CHECK (event_type IN
  ('job_created', 'inspection_started', 'quote_sent', 'finding_raised', 'quote_decided',
   'stage_advanced', 'customer_link_issued'));
ALTER TABLE avc.job_events ALTER COLUMN actor_staff_id DROP NOT NULL;
ALTER TABLE avc.job_events ADD COLUMN actor_type text NOT NULL DEFAULT 'staff'
  CHECK (actor_type IN ('staff', 'customer', 'system'));
ALTER TABLE avc.job_events ADD CONSTRAINT job_events_actor_consistent
  CHECK ((actor_type = 'staff') = (actor_staff_id IS NOT NULL));

CREATE FUNCTION avc.prevent_row_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are append only', TG_TABLE_NAME;
END;
$$;

-- ---------- quotes: the customer decides every line; a new finding is an addendum quote ----------
CREATE TABLE avc.quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_card_id uuid NOT NULL REFERENCES avc.job_cards(id),
  version integer NOT NULL CHECK (version >= 1),
  kind text NOT NULL CHECK (kind IN ('initial', 'addendum')),
  status text NOT NULL CHECK (status IN ('sent', 'decided')),
  sent_by_staff_id uuid NOT NULL REFERENCES avc.staff_members(id),
  sent_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  UNIQUE (job_card_id, version),
  CHECK ((status = 'decided') = (decided_at IS NOT NULL))
);
-- At most one quote per job can await the customer at a time.
CREATE UNIQUE INDEX quotes_one_open_per_job_idx ON avc.quotes (job_card_id) WHERE status = 'sent';

CREATE TABLE avc.quote_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL REFERENCES avc.quotes(id),
  position integer NOT NULL CHECK (position >= 1),
  title text NOT NULL CHECK (length(trim(title)) > 0),
  detail text NOT NULL DEFAULT '',
  severity text NOT NULL CHECK (severity IN ('critical', 'moderate', 'minor')),
  price_aed numeric(12, 2) NOT NULL CHECK (price_aed >= 0),
  decision text NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending', 'approved', 'rejected')),
  decided_at timestamptz,
  UNIQUE (quote_id, position),
  CHECK ((decision = 'pending') = (decided_at IS NULL))
);

-- Evidence metadata. File bytes live in object storage (not implemented yet); storage_key points there.
CREATE TABLE avc.evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_card_id uuid NOT NULL REFERENCES avc.job_cards(id),
  quote_item_id uuid REFERENCES avc.quote_items(id),
  kind text NOT NULL CHECK (kind IN ('photo', 'video', 'signature', 'document')),
  storage_key text NOT NULL CHECK (length(trim(storage_key)) > 0),
  content_sha256 text CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  caption text NOT NULL DEFAULT '',
  captured_by_staff_id uuid NOT NULL REFERENCES avc.staff_members(id),
  captured_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evidence_job_idx ON avc.evidence (job_card_id);
CREATE INDEX evidence_item_idx ON avc.evidence (quote_item_id);
-- Evidence is immutable except for being attached to a quote item once.
CREATE FUNCTION avc.guard_evidence_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'evidence rows cannot be deleted';
  END IF;
  IF (NEW.id, NEW.job_card_id, NEW.kind, NEW.storage_key, NEW.content_sha256, NEW.caption,
      NEW.captured_by_staff_id, NEW.captured_at)
     IS DISTINCT FROM
     (OLD.id, OLD.job_card_id, OLD.kind, OLD.storage_key, OLD.content_sha256, OLD.caption,
      OLD.captured_by_staff_id, OLD.captured_at)
     OR (OLD.quote_item_id IS NOT NULL AND NEW.quote_item_id IS DISTINCT FROM OLD.quote_item_id) THEN
    RAISE EXCEPTION 'evidence rows are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER evidence_guard BEFORE UPDATE OR DELETE ON avc.evidence
FOR EACH ROW EXECUTE FUNCTION avc.guard_evidence_change();

-- Customer tracking/approval links. Only a SHA-256 of the token is stored.
CREATE TABLE avc.customer_access_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_card_id uuid NOT NULL REFERENCES avc.job_cards(id),
  token_hash text NOT NULL UNIQUE,
  issued_by_staff_id uuid NOT NULL REFERENCES avc.staff_members(id),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX customer_links_job_idx ON avc.customer_access_links (job_card_id);

-- The customer's signed-off answer, kept as evidence. One decision per quote; never edited.
CREATE TABLE avc.quote_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL UNIQUE REFERENCES avc.quotes(id),
  link_id uuid NOT NULL REFERENCES avc.customer_access_links(id),
  quote_version integer NOT NULL,
  choices jsonb NOT NULL,
  user_agent text,
  decided_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER quote_decisions_append_only BEFORE UPDATE OR DELETE ON avc.quote_decisions
FOR EACH ROW EXECUTE FUNCTION avc.prevent_row_change();

-- ---------- integration: transactional outbox, API keys, webhook endpoints ----------
-- txid orders events so consumers never skip a late-committing transaction (see integration/outbox.ts).
CREATE TABLE avc.outbox_events (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  txid bigint NOT NULL DEFAULT (pg_current_xact_id()::text::bigint),
  id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  branch_id uuid REFERENCES avc.branches(id),
  event_type text NOT NULL CHECK (event_type ~ '^[a-z_]+\.[a-z_]+$'),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_events_order_idx ON avc.outbox_events (txid, seq);
CREATE TRIGGER outbox_events_append_only BEFORE UPDATE OR DELETE ON avc.outbox_events
FOR EACH ROW EXECUTE FUNCTION avc.prevent_row_change();

CREATE TABLE avc.api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  key_prefix text NOT NULL UNIQUE,
  key_hash text NOT NULL,
  scopes text[] NOT NULL CHECK (cardinality(scopes) > 0 AND scopes <@ ARRAY['events:read']::text[]),
  created_by_staff_id uuid NOT NULL REFERENCES avc.staff_members(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE avc.webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url text NOT NULL CHECK (url ~ '^https://'),
  signing_secret text NOT NULL,
  event_types text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  created_by_staff_id uuid NOT NULL REFERENCES avc.staff_members(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  cursor_txid bigint NOT NULL DEFAULT 0,
  cursor_seq bigint NOT NULL DEFAULT 0,
  failure_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text
);
