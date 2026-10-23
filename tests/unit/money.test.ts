import { describe, it, expect } from 'vitest';
import { usdToLbp, lbpToUsdCents, roundLbp, lineTotal } from '@pos/shared/money';

// Contract: USD minor unit = cent, LBP minor unit = 1 LBP. Rate = LBP per 1 USD.
describe('money · conversion (US-04, US-05)', () => {
  it('converts USD cents to LBP at the given rate', () => {
    expect(usdToLbp(250, 90000)).toBe(225000); // $2.50
    expect(usdToLbp(1, 90000)).toBe(900); // 1 cent
    expect(usdToLbp(0, 90000)).toBe(0);
  });

  it('converts LBP to USD cents, rounding to the nearest cent', () => {
    expect(lbpToUsdCents(335000, 90000)).toBe(372); // $3.72 (see receipt mockup)
    expect(lbpToUsdCents(0, 90000)).toBe(0);
  });

  it('never returns floating point fractions', () => {
    for (const cents of [1, 7, 199, 213, 99999]) {
      expect(Number.isInteger(usdToLbp(cents, 89500))).toBe(true);
    }
  });

  it('rejects a non-positive or non-finite rate', () => {
    expect(() => usdToLbp(100, 0)).toThrow();
    expect(() => usdToLbp(100, -1)).toThrow();
    expect(() => usdToLbp(100, NaN)).toThrow();
  });
});

describe('money · LBP rounding (legacy totals are multiples of 5,000)', () => {
  it.each([
    [233333, 235000],
    [232499, 230000],
    [232500, 235000], // half rounds up
    [235000, 235000],
    [0, 0],
    [1, 0],
    [2500, 5000],
  ])('roundLbp(%i, 5000) = %i', (input, expected) => {
    expect(roundLbp(input, 5000)).toBe(expected);
  });

  it('supports other increments (configurable)', () => {
    expect(roundLbp(233333, 1000)).toBe(233000);
    expect(roundLbp(233333, 1)).toBe(233333);
  });
});

describe('money · line totals (US-03)', () => {
  it('multiplies price by integer quantity', () => {
    expect(lineTotal(50000, '2')).toBe(100000);
  });

  it('supports 3-decimal weighed quantities', () => {
    expect(lineTotal(400000, '0.35')).toBe(140000); // 0.35 kg @ 400,000/kg
    expect(lineTotal(333333, '0.001')).toBe(333); // rounds to whole LBP
  });

  it('rejects negative or zero quantity', () => {
    expect(() => lineTotal(50000, '0')).toThrow();
    expect(() => lineTotal(50000, '-1')).toThrow();
  });

  it('rejects more than 3 decimals', () => {
    expect(() => lineTotal(50000, '0.3333')).toThrow();
  });
});
