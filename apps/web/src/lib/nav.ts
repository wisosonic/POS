import type { IconName } from '../components/Icon';
import type { Role } from './types';

export type NavItem = { to: string; label: string; icon: IconName; min: Role };
export type NavSection = { title: string; items: NavItem[] };

const rank: Record<Role, number> = { cashier: 0, manager: 1, admin: 2 };
export const atLeast = (role: Role, min: Role) => rank[role] >= rank[min];

/** The places the menu leads to, in the order people need them: the till first, then the shop, then the money. */
export const NAV: NavSection[] = [
  {
    title: 'Till',
    items: [
      { to: '/', label: 'Checkout', icon: 'till', min: 'cashier' },
      { to: '/sales', label: 'Sales', icon: 'sales', min: 'cashier' },
      { to: '/returns', label: 'Returns', icon: 'returns', min: 'cashier' },
      { to: '/customers', label: 'Customer accounts', icon: 'customers', min: 'cashier' },
      { to: '/low-stock', label: 'Low stock', icon: 'lowstock', min: 'cashier' },
      { to: '/register/close', label: 'Close register', icon: 'register', min: 'cashier' },
    ],
  },
  {
    title: 'Shop',
    items: [
      { to: '/dashboard', label: 'Dashboard', icon: 'dashboard', min: 'manager' },
      { to: '/products', label: 'Products', icon: 'products', min: 'manager' },
      { to: '/products/lists', label: 'Lists', icon: 'lists', min: 'manager' },
      { to: '/barcodes', label: 'Duplicate barcodes', icon: 'barcode', min: 'manager' },
      { to: '/purchases', label: 'Purchases', icon: 'purchases', min: 'manager' },
      { to: '/stocktake', label: 'Stocktake', icon: 'stocktake', min: 'manager' },
    ],
  },
  {
    title: 'Money',
    items: [
      { to: '/reports', label: 'Reports', icon: 'reports', min: 'manager' },
      { to: '/expenses', label: 'Expenses', icon: 'expenses', min: 'manager' },
      { to: '/services', label: 'Services', icon: 'services', min: 'manager' },
      { to: '/cash', label: 'Cash in and out', icon: 'cash', min: 'manager' },
    ],
  },
];

/** Administration: behind the gear in the header, for the admin only. */
export const ADMIN_NAV: NavItem[] = [
  { to: '/settings', label: 'Settings', icon: 'settings', min: 'admin' },
  { to: '/rate', label: 'Exchange rate', icon: 'rate', min: 'admin' },
  { to: '/users', label: 'Users', icon: 'users', min: 'admin' },
  { to: '/backups', label: 'Backups', icon: 'backups', min: 'admin' },
];
