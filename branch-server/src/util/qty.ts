/** Quantities are stored as integer thousandths. These convert at the API boundary. */

/** 10_000 → "10", 350 → "0.35", -3000 → "-3", 1500 → "1.5" */
export function milliToQty(milli: number): string {
  const sign = milli < 0 ? '-' : '';
  const abs = Math.abs(milli);
  const whole = Math.floor(abs / 1000);
  const frac = String(abs % 1000)
    .padStart(3, '0')
    .replace(/0+$/, '');
  return `${sign}${whole}${frac ? `.${frac}` : ''}`;
}

/** 90 → 90_000, 0.5 → 500. Returns null if the number has more than 3 decimals. */
export function qtyNumberToMilli(n: number): number | null {
  const milli = Math.round(n * 1000);
  return Math.abs(n * 1000 - milli) < 1e-6 ? milli : null;
}
