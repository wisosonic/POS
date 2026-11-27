/** A quantity threshold in whole units (up to 3 decimals) to integer thousandths. Returns null if it has more than 3 decimals. */
export function qtyNumberToMilli(n: number): number | null {
  const milli = Math.round(n * 1000);
  return Math.abs(n * 1000 - milli) < 1e-6 ? milli : null;
}
