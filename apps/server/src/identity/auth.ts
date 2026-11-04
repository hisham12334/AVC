import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { AppError } from '../errors.js';
import { can, type Permission, type StaffRole } from './permissions.js';
export type StaffPrincipal = {
  id: string;
  subject: string;
  displayName: string;
  role: StaffRole;
  branchId: string | null;
  email: string | null;
  mustChangePassword: boolean;
};
export interface TokenVerifier {
  verify(token: string): Promise<string>;
}

// An OIDC adapter will implement this interface after AVC chooses a provider.
// This deployed default never trusts a bearer token without verification.
export const unconfiguredVerifier: TokenVerifier = {
  async verify() {
    throw new AppError(503, 'AUTH_NOT_CONFIGURED', 'Staff sign-in is not configured');
  },
};

declare module 'fastify' {
  interface FastifyRequest {
    staff: StaffPrincipal | null;
  }
}

export function registerIdentity(app: FastifyInstance, db: Pool, verifier: TokenVerifier): void {
  app.decorateRequest('staff', null);
  app.get('/api/auth/status', async () => ({ configured: verifier !== unconfiguredVerifier }));

  async function authenticate(request: FastifyRequest): Promise<void> {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ') || header.length <= 7) {
      throw new AppError(401, 'AUTH_REQUIRED', 'Staff authentication is required');
    }
    const subject = await verifier.verify(header.slice(7));
    const result = await db.query<{
      id: string;
      external_subject: string;
      display_name: string;
      role: StaffRole;
      active: boolean;
      branch_id: string | null;
      email: string | null;
      must_change_password: boolean;
    }>(
      'SELECT id, external_subject, display_name, role, active, branch_id, email, must_change_password FROM avc.staff_members WHERE external_subject = $1',
      [subject],
    );
    const row = result.rows[0];
    if (!row || !row.active)
      throw new AppError(403, 'STAFF_NOT_ACTIVE', 'Staff access is not enabled');
    request.staff = {
      id: row.id,
      subject: row.external_subject,
      displayName: row.display_name,
      role: row.role,
      branchId: row.branch_id,
      email: row.email,
      mustChangePassword: row.must_change_password,
    };
  }

  function requirePermission(permission: Permission) {
    return async (request: FastifyRequest): Promise<void> => {
      await authenticate(request);
      if (!request.staff || !can(request.staff.role, permission)) {
        throw new AppError(403, 'FORBIDDEN', 'This staff role cannot perform this action');
      }
    };
  }

  app.decorate('requirePermission', requirePermission);
  app.get('/api/staff/me', { preHandler: requirePermission('staff:self') }, async (request) => ({
    staff: request.staff,
  }));
}

declare module 'fastify' {
  interface FastifyInstance {
    requirePermission: (permission: Permission) => (request: FastifyRequest) => Promise<void>;
  }
}
