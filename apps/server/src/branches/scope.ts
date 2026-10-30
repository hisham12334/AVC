import type { PoolClient } from 'pg';
import { AppError } from '../errors.js';
import type { StaffPrincipal } from '../identity/auth.js';

export type BranchRef = { id: string; code: string };

// A job belongs to one branch. Branch-pinned staff always use theirs; others name one, or may omit it
// while only a single branch is active (today's situation).
export async function resolveBranch(
  client: PoolClient,
  staff: StaffPrincipal,
  requestedId?: string,
): Promise<BranchRef> {
  if (staff.branchId && requestedId && requestedId !== staff.branchId)
    throw new AppError(403, 'BRANCH_FORBIDDEN', 'This staff member works at a different branch');
  const wanted = staff.branchId ?? requestedId ?? null;
  const result = await client.query<BranchRef>(
    `SELECT id, code FROM avc.branches WHERE active AND ($1::uuid IS NULL OR id = $1)
     ORDER BY created_at LIMIT 2`,
    [wanted],
  );
  if (result.rows.length === 0)
    throw new AppError(422, 'BRANCH_NOT_FOUND', 'Branch does not exist');
  if (result.rows.length > 1)
    throw new AppError(422, 'BRANCH_REQUIRED', 'Several branches are active; specify branchId');
  return result.rows[0]!;
}
