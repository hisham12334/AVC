export const STAFF_ROLES = [
  'lounge_manager',
  'technician',
  'driver',
  'workshop_manager',
  'finance',
  'admin',
] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

// The advisor / lounge-manager split and site-level rules are still open client decisions
// (see docs/OPEN_QUESTIONS.md). Grants below are the current working assumption.
export const PERMISSIONS = {
  'staff:self': STAFF_ROLES,
  'customers:read': ['lounge_manager', 'admin'],
  'customers:create': ['lounge_manager'],
  'vehicles:read': ['lounge_manager', 'admin'],
  'vehicles:create': ['lounge_manager'],
  'jobs:read': ['lounge_manager', 'workshop_manager', 'admin'],
  'jobs:create_intake': ['lounge_manager'],
  'jobs:start_inspection': ['lounge_manager'],
  'jobs:advance': ['lounge_manager', 'workshop_manager'],
  'quotes:read': ['lounge_manager', 'workshop_manager', 'finance', 'admin'],
  'quotes:publish': ['lounge_manager'],
  'findings:raise': ['lounge_manager', 'technician', 'workshop_manager'],
  'evidence:create': ['lounge_manager', 'technician', 'workshop_manager'],
  'customer_links:issue': ['lounge_manager'],
  'dashboard:read': ['lounge_manager', 'workshop_manager', 'finance', 'admin'],
  'branches:read': STAFF_ROLES,
  'branches:manage': ['admin'],
  'integrations:manage': ['admin'],
} as const satisfies Record<string, readonly StaffRole[]>;
export type Permission = keyof typeof PERMISSIONS;

export function can(role: StaffRole, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly StaffRole[]).includes(role);
}
