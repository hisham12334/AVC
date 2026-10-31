import { createHash, randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { AppError } from '../errors.js';

export const PROFILE_LINK_DAYS = 365;
export const SESSION_DAYS = 30;

export type CustomerPrincipal = {
  customerId: string;
  tokenId: string;
  kind: 'profile_link' | 'session';
};

export const hashCustomerToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

// Only a SHA-256 of the token is stored. The raw value is shown once (QR/link or login response).
export async function issueCustomerToken(
  client: PoolClient | Pool,
  customerId: string,
  kind: 'profile_link' | 'session',
  staffId: string | null,
): Promise<{ token: string; tokenId: string; expiresAt: string; path: string }> {
  const token = randomBytes(32).toString('base64url');
  const days = kind === 'profile_link' ? PROFILE_LINK_DAYS : SESSION_DAYS;
  const created = await client.query<{ id: string; expiresAt: Date }>(
    `INSERT INTO avc.customer_tokens(customer_id, kind, token_hash, issued_by_staff_id, expires_at)
     VALUES ($1,$2,$3,$4, now() + make_interval(days => $5))
     RETURNING id, expires_at AS "expiresAt"`,
    [customerId, kind, hashCustomerToken(token), staffId, days],
  );
  const row = created.rows[0]!;
  return { token, tokenId: row.id, expiresAt: row.expiresAt.toISOString(), path: `/p/${token}` };
}

// Replace the QR/link: the old one stops working.
export async function revokeProfileLinks(
  client: PoolClient | Pool,
  customerId: string,
): Promise<void> {
  await client.query(
    `UPDATE avc.customer_tokens SET revoked_at = now()
     WHERE customer_id = $1 AND kind = 'profile_link' AND revoked_at IS NULL`,
    [customerId],
  );
}

const invalid = () => new AppError(401, 'CUSTOMER_AUTH_REQUIRED', 'Please sign in to continue');

export async function authenticateCustomer(
  db: Pool | PoolClient,
  request: FastifyRequest,
): Promise<CustomerPrincipal> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ') || header.length <= 7) throw invalid();
  const result = await db.query<{
    id: string;
    customerId: string;
    kind: CustomerPrincipal['kind'];
  }>(
    `SELECT id, customer_id AS "customerId", kind FROM avc.customer_tokens
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [hashCustomerToken(header.slice(7))],
  );
  const row = result.rows[0];
  if (!row) throw invalid();
  return { customerId: row.customerId, tokenId: row.id, kind: row.kind };
}
