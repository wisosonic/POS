import { describe, expect, it } from 'vitest';
import { ADMIN_NAV, atLeast, NAV } from '../../apps/web/src/lib/nav';

// The menu a person sees depends only on their role, and the server enforces the same roles: this keeps the screen honest.
const visible = (role: 'cashier' | 'manager' | 'admin') => NAV.flatMap((s) => s.items).filter((i) => atLeast(role, i.min));

describe('the menu', () => {
  it('a cashier sees the till pages and nothing from the back office', () => {
    expect(visible('cashier').map((i) => i.label)).toEqual([
      'Checkout',
      'Sales',
      'Returns',
      'Customer accounts',
      'Low stock',
      'Close register',
    ]);
  });

  it('a manager also sees the shop and the money pages; the admin has the same menu plus the gear', () => {
    const manager = visible('manager').map((i) => i.label);
    for (const label of [
      'Dashboard',
      'Products',
      'Lists',
      'Duplicate barcodes',
      'Purchases',
      'Stocktake',
      'Reports',
      'Expenses',
      'Services',
      'Cash in and out',
    ])
      expect(manager).toContain(label);
    expect(visible('admin')).toHaveLength(visible('manager').length);
  });

  it('administration (settings, exchange rate, users, backups) is behind the gear and for the admin only', () => {
    expect(ADMIN_NAV.map((i) => i.label)).toEqual(['Settings', 'Exchange rate', 'Users', 'Backups']);
    for (const i of ADMIN_NAV) {
      expect(atLeast('admin', i.min)).toBe(true);
      expect(atLeast('manager', i.min)).toBe(false);
    }
    expect(NAV.flatMap((s) => s.items).some((i) => ADMIN_NAV.some((a) => a.to === i.to))).toBe(false); // listed once
  });

  it('every place has its own address and its own label', () => {
    const all = [...NAV.flatMap((s) => s.items), ...ADMIN_NAV];
    expect(new Set(all.map((i) => i.to)).size).toBe(all.length);
    expect(new Set(all.map((i) => i.label)).size).toBe(all.length);
  });

  it('roles are ordered: cashier below manager below admin', () => {
    expect(atLeast('cashier', 'manager')).toBe(false);
    expect(atLeast('manager', 'cashier')).toBe(true);
    expect(atLeast('admin', 'manager')).toBe(true);
  });
});
