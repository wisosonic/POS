import { describe, expect, it } from 'vitest';
import {
  approvalCovers,
  approvalPct,
  discountPct,
  needsApproval,
  parseDiscountInput,
  type Approval,
} from '../../apps/web/src/lib/discount';
import { cartTotals } from '../../apps/web/src/store/cart';
import type { Product } from '../../apps/web/src/lib/types';

// US-09: discounts at the till. The server decides; these keep the screen from asking for what it will refuse.
const towel: Product = {
  id: 1,
  name: 'Towel',
  receiptName: null,
  barcode: '1',
  costMinor: 67000,
  priceMinor: 75000,
  currency: 'LBP',
  qty: '10',
  unitName: 'Piece',
  fractional: false,
  stockAlert: null,
  active: true,
  updatedAt: '2026-01-01T00:00:00Z',
};
const lines = (n = 1) => [{ key: 'l1', product: towel, qty: String(n) }];

describe('reading what was typed', () => {
  it('a percent: whole or with up to two decimals, comma or dot, with or without the % sign', () => {
    for (const [text, value] of [
      ['10', 10],
      ['12.5', 12.5],
      ['12,5', 12.5],
      ['7.25', 7.25],
      ['10%', 10],
      [' 100 ', 100],
    ] as const)
      expect(parseDiscountInput('percent', text), text).toEqual({ ok: true, discount: { type: 'percent', value } });
  });

  it('a percent that is empty, zero, over 100 or not a number is refused with a reason', () => {
    for (const text of ['', '   ', '0', '0.00', '101', '100.01', 'abc', '-5', '1.234', '12..5']) {
      const r = parseDiscountInput('percent', text);
      expect(r.ok, text).toBe(false);
      expect(r.ok === false && r.error.length > 0, text).toBe(true);
    }
  });

  it('an amount: whole lira, with thousands separators', () => {
    expect(parseDiscountInput('amount', '5,000')).toEqual({ ok: true, discount: { type: 'amount', value: 5000 } });
    expect(parseDiscountInput('amount', '12 500')).toEqual({ ok: true, discount: { type: 'amount', value: 12500 } });
  });

  it('an amount that is empty, zero, fractional or not a number is refused', () => {
    for (const text of ['', '0', '1.5', 'abc', '-100']) expect(parseDiscountInput('amount', text).ok, text).toBe(false);
  });
});

describe('percent and approval', () => {
  it('works out the percent of the cart', () => {
    expect(discountPct(7500, 75000)).toBe(10);
    expect(discountPct(30000, 75000)).toBe(40);
    expect(discountPct(100, 0)).toBe(0);
  });

  it('rounds the percent UP to a hundredth, so rounding can never make an honest sale exceed the approval', () => {
    expect(approvalPct(40)).toBe(40);
    expect(approvalPct(39.9981)).toBe(40);
    expect(approvalPct(13.3334)).toBe(13.34);
    expect(approvalPct(100.4)).toBe(100);
    expect(approvalPct(0)).toBe(0);
  });

  it('only a cashier over the limit needs a manager', () => {
    expect(needsApproval('cashier', 10, 10)).toBe(false); // at the limit is fine
    expect(needsApproval('cashier', 10.01, 10)).toBe(true);
    expect(needsApproval('manager', 90, 10)).toBe(false);
    expect(needsApproval('admin', 100, 10)).toBe(false);
  });

  it('an approval covers its percent and anything below, not above', () => {
    const a: Approval = { token: 't', managerName: 'Rami', maxPct: 15 };
    expect(approvalCovers(a, 15)).toBe(true);
    expect(approvalCovers(a, 12)).toBe(true);
    expect(approvalCovers(a, 15.005)).toBe(true); // rounding slack
    expect(approvalCovers(a, 16)).toBe(false);
  });
});

describe('the cart with a discount', () => {
  it('takes a percent off the subtotal and rounds the total like the server', () => {
    const t = cartTotals(lines(), 90000, 5000, { type: 'percent', value: 10 });
    expect(t.subtotalLbp).toBe(75000);
    expect(t.discountLbp).toBe(7500);
    expect(t.totalLbp).toBe(70000); // 67,500 is halfway between 65,000 and 70,000: the shared rule rounds up, as the server does
    expect(t.discountInvalid).toBe(false);
  });

  it('takes a fixed amount off', () => {
    const t = cartTotals(lines(2), 90000, 5000, { type: 'amount', value: 30000 });
    expect(t.subtotalLbp).toBe(150000);
    expect(t.discountLbp).toBe(30000);
    expect(t.totalLbp).toBe(120000);
  });

  it('no discount means no change', () => {
    const t = cartTotals(lines(), 90000, 5000);
    expect(t.discountLbp).toBe(0);
    expect(t.totalLbp).toBe(75000);
  });

  it('a discount bigger than the cart is dropped from the figures and flagged, never thrown at the screen', () => {
    const t = cartTotals(lines(), 90000, 5000, { type: 'amount', value: 80000 });
    expect(t.discountInvalid).toBe(true);
    expect(t.discountLbp).toBe(0);
    expect(t.totalLbp).toBe(75000);
  });

  it('an empty cart has nothing to discount', () => {
    const t = cartTotals([], 90000, 5000, { type: 'percent', value: 10 });
    expect(t.totalLbp).toBe(0);
    expect(t.discountLbp).toBe(0);
  });
});

describe('the cart with a changed price (US-09)', () => {
  const usd: Product = { ...towel, id: 2, name: 'Oil', priceMinor: 250, currency: 'USD' };

  it('prices the line at the new price in lira, and the others as before', () => {
    const l = [
      { key: 'a', product: towel, qty: '2', price: { lbp: 60000 } },
      { key: 'b', product: usd, qty: '1' },
    ];
    const t = cartTotals(l, 90000, 5000);
    expect(t.lines[0]).toMatchObject({ unitPriceLbp: 60000, lineTotalLbp: 120000 });
    expect(t.lines[1]).toMatchObject({ unitPriceLbp: 225000 }); // $2.50 at 90,000
    expect(t.subtotalLbp).toBe(345000);
  });

  it('a dollar product sold at a lira price is priced in lira, exactly as the server does', () => {
    const t = cartTotals([{ key: 'b', product: usd, qty: '3', price: { lbp: 200000 } }], 90000, 5000);
    expect(t.lines[0]).toMatchObject({ unitPriceLbp: 200000, lineTotalLbp: 600000 });
  });

  it('a discount applies on top of the changed price', () => {
    const t = cartTotals([{ key: 'a', product: towel, qty: '1', price: { lbp: 60000 } }], 90000, 5000, { type: 'percent', value: 10 });
    expect(t.subtotalLbp).toBe(60000);
    expect(t.discountLbp).toBe(6000);
    expect(t.totalLbp).toBe(55000); // 54,000 rounds to 55,000
  });
});
