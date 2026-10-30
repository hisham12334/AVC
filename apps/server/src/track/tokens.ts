import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';

export const LINK_LIFETIME_DAYS = 30;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Replaces any earlier link for the job, so a forwarded or leaked old link stops working.
export async function issueCustomerLink(
  client: PoolClient,
  jobId: string,
  staffId: string,
): Promise<{ token: string; linkId: string; expiresAt: string; path: string }> {
  await client.query(
    'UPDATE avc.customer_access_links SET revoked_at = now() WHERE job_card_id = $1 AND revoked_at IS NULL',
    [jobId],
  );
  const token = randomBytes(32).toString('base64url');
  const created = await client.query<{ id: string; expiresAt: Date }>(
    `INSERT INTO avc.customer_access_links(job_card_id, token_hash, issued_by_staff_id, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(days => $4))
     RETURNING id, expires_at AS "expiresAt"`,
    [jobId, hashToken(token), staffId, LINK_LIFETIME_DAYS],
  );
  const row = created.rows[0]!;
  return {
    token,
    linkId: row.id,
    expiresAt: row.expiresAt.toISOString(),
    path: `/track/${token}`,
  };
}
