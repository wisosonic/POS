import { describe, it, expect } from 'vitest';
import { milliToQty, qtyNumberToMilli } from '../../apps/api/src/util/qty';
import { shopDayStart } from '../../apps/api/src/util/time';

describe('qty · thousandths at the API boundary', () => {
  it.each([
    [10_000, '10'],
    [350, '0.35'],
    [1_500, '1.5'],
    [1, '0.001'],
    [0, '0'],
    [-3_000, '-3'],
    [-350, '-0.35'],
    [123_456, '123.456'],
  ])('milliToQty(%i) = %s', (milli, text) => {
    expect(milliToQty(milli)).toBe(text);
  });

  it.each([
    [90, 90_000],
    [0.5, 500],
    [2.5, 2_500],
    [0.001, 1],
    [0, 0],
  ])('qtyNumberToMilli(%d) = %i', (n, milli) => {
    expect(qtyNumberToMilli(n)).toBe(milli);
  });

  it('refuses more than 3 decimals instead of rounding silently', () => {
    expect(qtyNumberToMilli(1.2345)).toBeNull();
    expect(qtyNumberToMilli(0.0001)).toBeNull();
  });

  it('round-trips', () => {
    for (const milli of [1, 10, 100, 999, 1_000, 1_001, 12_345, 5_000_000]) {
      expect(qtyNumberToMilli(Number(milliToQty(milli)))).toBe(milli);
    }
  });
});

describe('time · the shop day starts at local midnight (Asia/Beirut)', () => {
  it('summer (UTC+3): midday on 19 Oct 2026', () => {
    expect(shopDayStart(new Date('2026-10-19T10:42:00Z')).toISOString()).toBe('2026-10-18T21:00:00.000Z');
  });

  it('winter (UTC+2): midday on 15 Jan 2026', () => {
    expect(shopDayStart(new Date('2026-01-15T10:00:00Z')).toISOString()).toBe('2026-01-14T22:00:00.000Z');
  });

  it('half a minute after local midnight belongs to the new day', () => {
    expect(shopDayStart(new Date('2026-10-18T21:00:30Z')).toISOString()).toBe('2026-10-18T21:00:00.000Z');
  });

  it('one second before local midnight still belongs to the old day', () => {
    expect(shopDayStart(new Date('2026-10-18T20:59:59Z')).toISOString()).toBe('2026-10-17T21:00:00.000Z');
  });

  it('is never in the future and never more than a day old', () => {
    const now = new Date();
    const start = shopDayStart(now).getTime();
    expect(start).toBeLessThanOrEqual(now.getTime());
    expect(now.getTime() - start).toBeLessThan(25 * 3600_000);
  });
});
