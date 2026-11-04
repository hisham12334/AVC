export const STAFF_ROLES = [
  'lounge_manager',
  'technician',
  'driver',
  'workshop_manager',
  'finance',
  'admin',
  'super_admin',
] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

// The advisor / lounge-manager split and site-level rules are still open client decisions
// (see docs/OPEN_QUESTIONS.md). Grants below are the current working assumption.
export const PERMISSIONS = {
  'staff:self': STAFF_ROLES,
  'customers:read': ['lounge_manager', 'admin'],
  'customers:create': ['lounge_manager', 'workshop_manager'],
  'vehicles:read': ['lounge_manager', 'admin'],
  'vehicles:create': ['lounge_manager', 'workshop_manager'],
  'jobs:read': ['lounge_manager', 'workshop_manager', 'admin'],
  'jobs:create_intake': ['lounge_manager', 'workshop_manager'],
  'jobs:start_inspection': ['lounge_manager'],
  'jobs:advance': ['lounge_manager', 'workshop_manager'],
  'quotes:read': ['lounge_manager', 'workshop_manager', 'finance', 'admin'],
  'quotes:publish': ['lounge_manager'],
  'findings:raise': ['lounge_manager', 'technician', 'workshop_manager'],
  'evidence:create': ['lounge_manager', 'technician', 'workshop_manager', 'driver'],
  'evidence:read': [
    'lounge_manager',
    'technician',
    'workshop_manager',
    'driver',
    'admin',
    'finance',
  ],
  'customer_links:issue': ['lounge_manager', 'workshop_manager'],
  'inspection:submit': ['technician', 'workshop_manager', 'lounge_manager'],
  // Technicians read findings without prices; only the advisor side reads quotes.
  'findings:read': ['technician', 'workshop_manager', 'lounge_manager', 'admin'],
  'transfers:manage': ['lounge_manager', 'workshop_manager'],
  'transfers:work': ['driver'],
  'revenue:reverse': ['lounge_manager', 'admin'],
  'dashboard:read': ['lounge_manager', 'workshop_manager', 'finance', 'admin'],
  'branches:read': STAFF_ROLES,
  'branches:manage': ['admin'],
  'integrations:manage': ['admin'],
  // Only the super admin (who holds every grant) creates staff accounts and assigns roles.
  'staff:manage': [],
} as const satisfies Record<string, readonly StaffRole[]>;
export type Permission = keyof typeof PERMISSIONS;

export function can(role: StaffRole, permission: Permission): boolean {
  // The super admin holds every grant, including staff:manage which no other role has.
  if (role === 'super_admin') return true;
  return (PERMISSIONS[permission] as readonly StaffRole[]).includes(role);
}
