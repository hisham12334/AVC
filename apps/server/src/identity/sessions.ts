import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { AppError } from '../errors.js';
import type { TokenVerifier } from './auth.js';

export const STAFF_SESSION_HOURS = 12;

export const hashStaffToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

// Only a SHA-256 of the session token is stored; the raw value is returned once at sign-in.
export async function issueStaffSession(
  db: Pool,
  staffId: string,
): Promise<{ token: string; expiresAt: string }> {
  const token = randomBytes(32).toString('base64url');
  const created = await db.query<{ expiresAt: Date }>(
    `INSERT INTO avc.staff_sessions(staff_id, token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(hours => $3)) RETURNING expires_at AS "expiresAt"`,
    [staffId, hashStaffToken(token), STAFF_SESSION_HOURS],
  );
  return { token, expiresAt: created.rows[0]!.expiresAt.toISOString() };
}

export async function revokeStaffSessions(db: Pool, staffId: string): Promise<void> {
  await db.query(
    'UPDATE avc.staff_sessions SET revoked_at = now() WHERE staff_id = $1 AND revoked_at IS NULL',
    [staffId],
  );
}

// Resolves a session token to the staff member's subject. Swap for an OIDC verifier later.
export function sessionVerifier(db: Pool): TokenVerifier {
  return {
    async verify(token) {
      const result = await db.query<{ subject: string }>(
        `SELECT m.external_subject AS subject
         FROM avc.staff_sessions s JOIN avc.staff_members m ON m.id = s.staff_id
         WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
        [hashStaffToken(token)],
      );
      const row = result.rows[0];
      if (!row)
        throw new AppError(401, 'INVALID_TOKEN', 'Your session has expired. Sign in again.');
      return row.subject;
    },
  };
}
