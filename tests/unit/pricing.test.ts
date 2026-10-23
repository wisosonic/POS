import { describe, it, expect } from 'vitest';
import { computeCart, applyTender } from '@pos/shared/pricing';

const RATE = 90000;
const lbp = (amount: number) => ({ amount, currency: 'LBP' as const });
const usd = (cents: number) => ({ amount: cents, currency: 'USD' as const });

describe('pricing · computeCart (US-04)', () => {
  it('sums mixed-currency catalog prices into LBP', () => {
    const r = computeCart({
      rate: RATE,
      lines: [
        { unitPrice: lbp(75000), qty: '1' },
        { unitPrice: lbp(50000), qty: '2' },
        { unitPrice: usd(250), qty: '1' }, // 225,000
      ],
    });
    expect(r.subtotalLbp).toBe(400000);
    expect(r.roundingLbp).toBe(0);
    expect(r.totalLbp).toBe(400000);
  });

  it('rounds the total to the configured increment and exposes the adjustment', () => {
    const r = computeCart({ rate: RATE, lines: [{ unitPrice: usd(199), qty: '1' }] }); // 179,100
    expect(r.subtotalLbp).toBe(179100);
    expect(r.totalLbp).toBe(180000);
    expect(r.roundingLbp).toBe(900);
  });

  it('applies a percentage discount before rounding', () => {
    const r = computeCart({
      rate: RATE,
      lines: [{ unitPrice: lbp(100000), qty: '4' }],
      discount: { type: 'percent', value: 10 },
    });
    expect(r.discountLbp).toBe(40000);
    expect(r.totalLbp).toBe(360000);
  });

  it('applies a fixed discount', () => {
    const r = computeCart({
      rate: RATE,
      lines: [{ unitPrice: lbp(100000), qty: '2' }],
      discount: { type: 'amount', value: 25000 },
    });
    expect(r.totalLbp).toBe(175000);
  });

  it('treats catalog prices as tax-inclusive: no tax is ever added', () => {
    const r = computeCart({ rate: RATE, lines: [{ unitPrice: lbp(100000), qty: '1' }] });
    expect(r).not.toHaveProperty('taxLbp');
    expect(r.totalLbp).toBe(100000);
  });

  it('rejects a discount larger than the subtotal (decision table #15)', () => {
    expect(() =>
      computeCart({
        rate: RATE,
        lines: [{ unitPrice: lbp(10000), qty: '1' }],
        discount: { type: 'amount', value: 10001 },
      }),
    ).toThrow(/discount/i);
  });

  it('rejects an empty cart', () => {
    expect(() => computeCart({ rate: RATE, lines: [] })).toThrow();
  });

  it('is deterministic and does not mutate input', () => {
    const input = { rate: RATE, lines: [{ unitPrice: lbp(75000), qty: '1' }] };
    const snapshot = JSON.stringify(input);
    expect(computeCart(input)).toEqual(computeCart(input));
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('pricing · applyTender (US-05, decision table #8–#12)', () => {
  const total = 235000;

  it('exact LBP tender → paid, no change', () => {
    const r = applyTender({ totalLbp: total, rate: RATE, tenders: [lbp(235000)] });
    expect(r).toMatchObject({ status: 'paid', paidLbp: 235000, changeLbp: 0, restLbp: 0 });
  });

  it('over-tender in LBP → change', () => {
    const r = applyTender({ totalLbp: total, rate: RATE, tenders: [lbp(240000)] });
    expect(r).toMatchObject({ status: 'paid', changeLbp: 5000 });
  });

  it('USD tender is converted at the sale rate; change is given in LBP', () => {
    const r = applyTender({ totalLbp: total, rate: RATE, tenders: [usd(300)] }); // 270,000
    expect(r).toMatchObject({ status: 'paid', paidLbp: 270000, changeLbp: 35000 });
  });

  it('mixed USD + LBP tender', () => {
    const r = applyTender({ totalLbp: total, rate: RATE, tenders: [usd(100), lbp(150000)] }); // 90,000 + 150,000
    expect(r).toMatchObject({ status: 'paid', paidLbp: 240000, changeLbp: 5000 });
  });

  it('rounds change to the LBP increment', () => {
    const r = applyTender({ totalLbp: total, rate: RATE, tenders: [usd(101), lbp(150000)], lbpRounding: 5000 }); // 240,900 → 5,900 → 5,000
    expect(r.changeLbp).toBe(5000);
  });

  it('short tender with a registered customer → partial with rest (US-31)', () => {
    const r = applyTender({ totalLbp: total, rate: RATE, tenders: [lbp(100000)], customerId: 7 });
    expect(r).toMatchObject({ status: 'partial', paidLbp: 100000, restLbp: 135000, changeLbp: 0 });
  });

  it('no tender at all with a registered customer → unpaid, full amount owed (pay later)', () => {
    const r = applyTender({ totalLbp: total, rate: RATE, tenders: [], customerId: 7 });
    expect(r).toMatchObject({ status: 'unpaid', paidLbp: 0, restLbp: 235000, changeLbp: 0 });
  });

  it('short or empty tender for Walk-In (customerId 1) is rejected', () => {
    expect(() => applyTender({ totalLbp: total, rate: RATE, tenders: [lbp(100000)], customerId: 1 })).toThrow(/registered customer/i);
    expect(() => applyTender({ totalLbp: total, rate: RATE, tenders: [], customerId: 1 })).toThrow(/registered customer/i);
  });

  it('rejects zero or negative tender amounts', () => {
    expect(() => applyTender({ totalLbp: total, rate: RATE, tenders: [lbp(0)] })).toThrow();
    expect(() => applyTender({ totalLbp: total, rate: RATE, tenders: [lbp(-5)] })).toThrow();
  });

  it('there is no credit limit check in the pure function (enforced by the API if configured)', () => {
    expect(() => applyTender({ totalLbp: 99_000_000, rate: RATE, tenders: [], customerId: 7 })).not.toThrow();
  });
});

describe('pricing · payment methods (US-05, Q6)', () => {
  const total = 235000;

  it('aggregates what was received per method and currency', () => {
    const r = applyTender({
      totalLbp: total,
      rate: RATE,
      tenders: [
        { ...lbp(100000), method: 'whish' },
        { ...usd(100), method: 'cash' }, // 90,000
        { ...lbp(50000), method: 'omt' },
      ],
    });
    expect(r.paidLbp).toBe(240000);
    expect(r.byMethod).toEqual([
      { method: 'whish', currency: 'LBP', amount: 100000 },
      { method: 'cash', currency: 'USD', amount: 100 },
      { method: 'omt', currency: 'LBP', amount: 50000 },
    ]);
  });

  it('defaults the method to cash', () => {
    const r = applyTender({ totalLbp: total, rate: RATE, tenders: [lbp(235000)] });
    expect(r.byMethod).toEqual([{ method: 'cash', currency: 'LBP', amount: 235000 }]);
  });

  it('change is only ever given as cash: wallet over-payment is rejected', () => {
    expect(() => applyTender({ totalLbp: total, rate: RATE, tenders: [{ ...lbp(300000), method: 'whish' }] })).toThrow(/change/i);
  });

  it('wallet payment may exceed the total only when cash covers the difference', () => {
    // 200,000 by OMT + 50,000 cash = 250,000 → 15,000 change from cash is fine, wallet part did not exceed the total
    const r = applyTender({
      totalLbp: total,
      rate: RATE,
      tenders: [
        { ...lbp(200000), method: 'omt' },
        { ...lbp(50000), method: 'cash' },
      ],
    });
    expect(r).toMatchObject({ status: 'paid', changeLbp: 15000 });
  });

  it('rejects an unknown method', () => {
    expect(() => applyTender({ totalLbp: total, rate: RATE, tenders: [{ ...lbp(235000), method: 'paypal' as never }] })).toThrow();
  });
});
