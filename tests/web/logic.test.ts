import { describe, it, expect, beforeEach } from 'vitest';
import {
  fmtLbp,
  fmtUsd,
  groupThousands,
  lbpAsUsd,
  parseLbpInput,
  parseUsdInput,
  trimQty,
  unitPriceLbp,
} from '../../apps/web/src/lib/money';
import { addQty, isValidQty, milliToQty, qtyToMilli } from '../../apps/web/src/lib/qty';
import { analyzePayment, NO_PAYMENT, type PayInputs } from '../../apps/web/src/lib/payment';
import { cartTotals, useCart } from '../../apps/web/src/store/cart';
import type { Product } from '../../apps/web/src/lib/types';

const RATE = 90000;
const product = (over: Partial<Product> & { id: number }): Product => ({
  name: `Product ${over.id}`,
  receiptName: null,
  barcode: String(1000 + over.id),
  costMinor: 0,
  priceMinor: 75000,
  currency: 'LBP',
  qty: '0',
  unitName: 'Piece',
  fractional: false,
  stockAlert: null,
  active: true,
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});
const towel = product({ id: 1, name: 'Cedars silver towel', priceMinor: 75000 });
const choc = product({ id: 2, name: 'Crispy chocolate', priceMinor: 50000 });
const latte = product({ id: 3, name: 'Latte', priceMinor: 250, currency: 'USD' });
const cheese = product({ id: 4, name: 'Loose cheese', priceMinor: 400000, fractional: true, unitName: 'KG' });

describe('money formatting and parsing', () => {
  it('formats lira with separators and dollars with cents', () => {
    expect(fmtLbp(335000)).toBe('335,000 LL');
    expect(fmtLbp(0)).toBe('0 LL');
    expect(fmtLbp(-25000)).toBe('-25,000 LL');
    expect(groupThousands(12340000)).toBe('12,340,000');
    expect(fmtUsd(372)).toBe('$3.72');
    expect(fmtUsd(5)).toBe('$0.05');
    expect(fmtUsd(-250)).toBe('-$2.50');
  });

  it('shows the dollar value beside a lira total', () => {
    expect(lbpAsUsd(335000, RATE)).toBe('$3.72');
    expect(lbpAsUsd(0, RATE)).toBe('$0.00');
  });

  it.each([
    ['200000', 200000],
    ['200,000', 200000],
    [' 200 000 ', 200000],
    ['', 0],
    ['0', 0],
  ])('reads lira "%s" as %i', (text, n) => {
    expect(parseLbpInput(text)).toBe(n);
  });

  it.each(['12.5', '-5', 'abc', '1e3', '2,5.5', '١٢٣'])('refuses lira "%s" instead of guessing', (text) => {
    expect(parseLbpInput(text)).toBeNaN();
  });

  it.each([
    ['70', 7000],
    ['2.5', 250],
    ['2.50', 250],
    ['0.05', 5],
    ['$3.72', 372],
    ['1,000.5', 100050],
    ['', 0],
  ])('reads dollars "%s" as %i cents', (text, cents) => {
    expect(parseUsdInput(text)).toBe(cents);
  });

  it.each(['2.555', '-1', 'x', '1.', '.5'])('refuses dollars "%s"', (text) => {
    expect(parseUsdInput(text)).toBeNaN();
  });

  it('prices a product in lira, whatever currency it is priced in', () => {
    expect(unitPriceLbp(towel, RATE)).toBe(75000);
    expect(unitPriceLbp(latte, RATE)).toBe(225000);
    expect(unitPriceLbp(latte, 100000)).toBe(250000);
  });

  it('trims quantities for display', () => {
    expect([trimQty('1.250'), trimQty('2.000'), trimQty('3'), trimQty('0.5')]).toEqual(['1.25', '2', '3', '0.5']);
  });
});

describe('quantities', () => {
  it('add exactly, without floating point drift', () => {
    expect(addQty('0.1', '0.2')).toBe('0.3');
    expect(addQty('1', '2')).toBe('3');
    expect(addQty('0.350', '0.650')).toBe('1');
    expect(milliToQty(qtyToMilli('12.345'))).toBe('12.345');
  });

  it('accept only what the till would send', () => {
    expect(isValidQty('2', false)).toBe(true);
    expect(isValidQty('2.5', false)).toBe(false); // pieces cannot be split
    expect(isValidQty('2.5', true)).toBe(true);
    expect(isValidQty('2.5555', true)).toBe(false);
    expect(isValidQty('0', true)).toBe(false);
    expect(isValidQty('-1', true)).toBe(false);
    expect(isValidQty('', true)).toBe(false);
    expect(isValidQty('1e3', true)).toBe(false);
  });
});

describe('cart', () => {
  beforeEach(() => useCart.getState().clear());
  const cart = () => useCart.getState();

  it('scanning the same product again adds to its line', () => {
    cart().add(towel);
    cart().add(towel);
    cart().add(choc);
    expect(cart().lines.map((l) => [l.product.id, l.qty])).toEqual([
      [1, '2'],
      [2, '1'],
    ]);
  });

  it('+ and - move by one unit, and going to zero removes the line', () => {
    const line = cart().add(towel, '2');
    cart().step(line.key, -1);
    expect(cart().lines[0]!.qty).toBe('1');
    cart().step(line.key, -1);
    expect(cart().lines).toHaveLength(0);
  });

  it('a weighed item steps by one kilo and can be typed to 3 decimals', () => {
    const line = cart().add(cheese);
    cart().step(line.key, 1);
    expect(cart().lines[0]!.qty).toBe('2');
    expect(cart().setQty(line.key, '0.350')).toBe(true);
    expect(cart().lines[0]!.qty).toBe('0.350');
  });

  it('refuses a quantity the product cannot be sold in', () => {
    const line = cart().add(towel);
    expect(cart().setQty(line.key, '1.5')).toBe(false);
    expect(cart().setQty(line.key, '0')).toBe(false);
    expect(cart().setQty(line.key, 'abc')).toBe(false);
    expect(cart().lines[0]!.qty).toBe('1');
  });

  it('remembers the last line touched, and forgets it when removed', () => {
    const a = cart().add(towel);
    const b = cart().add(choc);
    expect(cart().lastKey).toBe(b.key);
    cart().remove(b.key);
    expect(cart().lastKey).toBeNull();
    expect(cart().lines.map((l) => l.key)).toEqual([a.key]);
  });

  it('clear empties everything, including the customer', () => {
    cart().add(towel);
    cart().setCustomer({ id: 2, name: 'Ahmad', phone: null, balanceLbp: 0, isWalkIn: false });
    cart().clear();
    expect(cart().lines).toEqual([]);
    expect(cart().customer).toBeNull();
  });

  it('restore replaces the cart (recalling a held cart)', () => {
    cart().add(choc);
    cart().restore([{ product: towel, qty: '3' }], null);
    expect(cart().lines.map((l) => [l.product.id, l.qty])).toEqual([[1, '3']]);
  });
});

describe('cart totals: the same numbers the server will compute', () => {
  const lines = (...entries: [Product, string][]) => entries.map(([product, qty], i) => ({ key: `k${i}`, product, qty }));

  it('adds up lira prices', () => {
    expect(cartTotals(lines([towel, '1'], [choc, '2']), RATE, 5000).totalLbp).toBe(175000);
  });

  it('prices a dollar product at the rate, and a mixed cart together', () => {
    const t = cartTotals(lines([latte, '1'], [towel, '1']), RATE, 5000);
    expect(t.subtotalLbp).toBe(300000);
    expect(t.lines.map((l) => l.lineTotalLbp)).toEqual([225000, 75000]);
  });

  it('rounds the total to the nearest 5,000 and shows the adjustment', () => {
    const t = cartTotals(lines([cheese, '0.123']), RATE, 5000); // 49,200
    expect(t).toMatchObject({ subtotalLbp: 49200, roundingLbp: 800, totalLbp: 50000 });
  });

  it('an empty cart is zero, and a missing rate does not crash', () => {
    expect(cartTotals([], RATE, 5000).totalLbp).toBe(0);
    expect(cartTotals(lines([towel, '1']), 0, 5000).totalLbp).toBe(0);
  });

  it('follows a change of rate', () => {
    expect(cartTotals(lines([latte, '1']), 100000, 5000).totalLbp).toBe(250000);
  });
});

describe('the pay dialog arithmetic (docs/02 decision table, rows 7 to 13)', () => {
  const pay = (inputs: Partial<PayInputs>, over: { total?: number; registered?: boolean } = {}) =>
    analyzePayment({
      inputs: { ...NO_PAYMENT, ...inputs },
      totalLbp: over.total ?? 175000,
      rate: RATE,
      lbpRounding: 5000,
      registeredCustomer: over.registered ?? false,
    });

  it('exact payment: paid, no change', () => {
    expect(pay({ cashLbp: '175000' })).toMatchObject({ status: 'paid', changeLbp: 0, restLbp: 0, error: null });
  });

  it('over-payment gives cash change (the screen test: 200,000 for 175,000)', () => {
    expect(pay({ cashLbp: '200,000' })).toMatchObject({ status: 'paid', changeLbp: 25000, error: null });
  });

  it('dollars are converted at the rate, and change comes back in lira', () => {
    expect(pay({ cashUsd: '2' })).toMatchObject({ receivedLbp: 180000, changeLbp: 5000, status: 'paid' });
  });

  it('split between OMT and cash, exactly (the screen test)', () => {
    expect(pay({ omtLbp: '60000', cashLbp: '40000' }, { total: 100000 })).toMatchObject({ status: 'paid', changeLbp: 0, error: null });
  });

  it('a wallet payment alone, exactly', () => {
    expect(pay({ whishLbp: '75000' }, { total: 75000 })).toMatchObject({ status: 'paid', error: null });
  });

  it('a wallet payment cannot exceed the total, because change is cash only', () => {
    const r = pay({ whishLbp: '200000' }, { total: 175000 });
    expect(r.error).toMatch(/cannot be more than the total/);
    expect(r.status).toBeNull();
  });

  it('short payment for Walk-In is refused with the words the screen shows', () => {
    const r = pay({ cashLbp: '25000' }, { total: 75000 });
    expect(r.error).toMatch(/Select a registered customer/);
  });

  it('short payment for a registered customer leaves the rest on account (the screen test: 25,000 of 75,000)', () => {
    expect(pay({ cashLbp: '25000' }, { total: 75000, registered: true })).toMatchObject({ status: 'partial', restLbp: 50000, error: null });
  });

  it('nothing paid: refused for Walk-In, "pay later" for a registered customer', () => {
    expect(pay({}).error).toMatch(/Enter what the customer pays/);
    expect(pay({}, { registered: true })).toMatchObject({ status: 'unpaid', restLbp: 175000, error: null });
  });

  it('an unreadable amount names the box, rather than being taken as zero', () => {
    expect(pay({ omtLbp: '12.5' }).error).toBe('Check the amount in OMT LBP');
    expect(pay({ cashUsd: 'abc' }).error).toBe('Check the amount in Cash USD');
  });

  it('lists exactly the money that was typed, by method and currency', () => {
    const r = pay({ cashLbp: '40000', whishUsd: '1.50', omtLbp: '60000' }, { total: 100000 });
    expect(r.tenders).toEqual([
      { method: 'cash', currency: 'LBP', amount: 40000 },
      { method: 'whish', currency: 'USD', amount: 150 },
      { method: 'omt', currency: 'LBP', amount: 60000 },
    ]);
  });

  it('an empty cart cannot be paid', () => {
    expect(pay({ cashLbp: '1000' }, { total: 0 }).error).toBe('The cart is empty');
  });
});
