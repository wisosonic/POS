import { parseQtyMilli } from '@pos/shared';

// Quantities are strings with up to 3 decimals, exactly as the API takes them, and are added in thousandths so
// 0.1 + 0.2 is 0.3 and not 0.30000000000000004.

export const qtyToMilli = (q: string): number => parseQtyMilli(q);

export function milliToQty(milli: number): string {
  const whole = Math.floor(Math.abs(milli) / 1000);
  const frac = String(Math.abs(milli) % 1000)
    .padStart(3, '0')
    .replace(/0+$/, '');
  return `${milli < 0 ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

export const addQty = (a: string, b: string): string => milliToQty(qtyToMilli(a) + qtyToMilli(b));

const VALID = /^\d+(\.\d{1,3})?$/;

/** A quantity the till would accept: positive, at most 3 decimals, whole numbers only for items sold by the piece. */
export function isValidQty(q: string, fractional: boolean): boolean {
  if (!VALID.test(q) || Number(q) <= 0) return false;
  return fractional || !q.includes('.');
}
