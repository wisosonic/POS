export type Role = 'cashier' | 'manager' | 'admin';

const RANK: Record<Role, number> = { cashier: 1, manager: 2, admin: 3 };

export const hasRole = (actual: Role, minimum: Role) => RANK[actual] >= RANK[minimum];

/** Capabilities shown to the UI (GET /me). The server enforces them per route with requireRole. Matrix: docs/06-api-spec.md. */
const CAPABILITIES: Record<string, Role> = {
  sell: 'cashier',
  'customers.read': 'cashier',
  'customers.payments': 'cashier',
  'register.use': 'cashier',
  'discount.within-limit': 'cashier',
  'discount.over-limit': 'manager',
  'price.override': 'manager',
  'returns.create': 'manager',
  'sales.void': 'manager',
  'products.write': 'manager',
  'inventory.write': 'manager',
  'purchases.write': 'manager',
  'customers.write': 'manager',
  'reports.read': 'manager',
  'cash-movements.write': 'manager',
  'users.manage': 'admin',
  'settings.manage': 'admin',
  'audit.read': 'admin',
  'exchange-rate.write': 'admin',
};

export function capabilitiesFor(role: Role): string[] {
  return Object.entries(CAPABILITIES)
    .filter(([, min]) => hasRole(role, min))
    .map(([name]) => name)
    .sort();
}
