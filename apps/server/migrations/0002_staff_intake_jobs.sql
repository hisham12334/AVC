CREATE TABLE avc.staff_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_subject text NOT NULL UNIQUE,
  display_name text NOT NULL CHECK (length(trim(display_name)) > 0),
  role text NOT NULL CHECK (role IN ('lounge_manager', 'technician', 'driver', 'workshop_manager', 'finance')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE avc.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name text NOT NULL CHECK (length(trim(full_name)) > 0),
  mobile_number text NOT NULL CHECK (length(trim(mobile_number)) > 0),
  mobile_search text NOT NULL,
  created_by_staff_id uuid NOT NULL REFERENCES avc.staff_members(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customers_mobile_search_idx ON avc.customers (mobile_search);
CREATE INDEX customers_name_search_idx ON avc.customers (lower(full_name));

CREATE TABLE avc.vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES avc.customers(id),
  vin text,
  license_plate text,
  plate_search text,
  make text NOT NULL CHECK (length(trim(make)) > 0),
  model text NOT NULL CHECK (length(trim(model)) > 0),
  model_year integer CHECK (model_year BETWEEN 1900 AND 2200),
  color text,
  created_by_staff_id uuid NOT NULL REFERENCES avc.staff_members(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (vin IS NOT NULL OR license_plate IS NOT NULL),
  UNIQUE (id, customer_id)
);
CREATE UNIQUE INDEX vehicles_vin_unique_idx ON avc.vehicles (vin) WHERE vin IS NOT NULL;
CREATE INDEX vehicles_plate_search_idx ON avc.vehicles (plate_search);
CREATE INDEX vehicles_customer_idx ON avc.vehicles (customer_id);

CREATE SEQUENCE avc.job_card_number_seq;
CREATE TABLE avc.job_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_number bigint NOT NULL UNIQUE DEFAULT nextval('avc.job_card_number_seq'),
  customer_id uuid NOT NULL REFERENCES avc.customers(id),
  vehicle_id uuid NOT NULL,
  mileage_km integer NOT NULL CHECK (mileage_km >= 0),
  intake_condition text NOT NULL CHECK (length(trim(intake_condition)) > 0),
  status text NOT NULL CHECK (status IN ('intake_open', 'inspection_pending')),
  vehicle_location text NOT NULL CHECK (vehicle_location = 'jumeirah'),
  work_stage text NOT NULL CHECK (work_stage IN ('intake', 'inspection')),
  responsible_staff_id uuid NOT NULL REFERENCES avc.staff_members(id),
  created_by_staff_id uuid NOT NULL REFERENCES avc.staff_members(id),
  version integer NOT NULL CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (vehicle_id, customer_id) REFERENCES avc.vehicles(id, customer_id)
);
CREATE INDEX job_cards_created_at_idx ON avc.job_cards (created_at DESC);
CREATE INDEX job_cards_status_idx ON avc.job_cards (status);

CREATE TABLE avc.job_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_card_id uuid NOT NULL REFERENCES avc.job_cards(id),
  job_version integer NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('job_created', 'inspection_started')),
  from_status text,
  to_status text NOT NULL,
  actor_staff_id uuid NOT NULL REFERENCES avc.staff_members(id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (job_card_id, job_version)
);
CREATE INDEX job_events_history_idx ON avc.job_events (job_card_id, job_version);

CREATE FUNCTION avc.prevent_job_event_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'job events are append only';
END;
$$;
CREATE TRIGGER job_events_append_only BEFORE UPDATE OR DELETE ON avc.job_events
FOR EACH ROW EXECUTE FUNCTION avc.prevent_job_event_change();
