-- Local staff sign-in (email + password) and a super_admin role that manages accounts.
-- external_subject stays so an OIDC provider can be added later; local accounts use 'local:<id>'.
ALTER TABLE avc.staff_members DROP CONSTRAINT staff_members_role_check;
ALTER TABLE avc.staff_members ADD CONSTRAINT staff_members_role_check
  CHECK (role IN ('lounge_manager', 'technician', 'driver', 'workshop_manager', 'finance', 'admin', 'super_admin'));

ALTER TABLE avc.staff_members
  ADD COLUMN email text,
  ADD COLUMN password_hash text,
  ADD COLUMN must_change_password boolean NOT NULL DEFAULT false,
  ADD COLUMN failed_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN locked_until timestamptz,
  ADD COLUMN last_login_at timestamptz;
CREATE UNIQUE INDEX staff_members_email_key ON avc.staff_members (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE avc.staff_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES avc.staff_members(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX staff_sessions_staff_idx ON avc.staff_sessions (staff_id);
