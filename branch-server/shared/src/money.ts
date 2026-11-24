// Money primitives. Contract (docs/04-architecture.md §5):
//   USD minor unit = cent, LBP minor unit = 1 LBP. Rate = LBP per 1 USD. Everything is an integer.

export type Currency = 'USD' | 'LBP';
export type Money = { amount: number; currency: Currency };

/** Divide two integers and round half away from zero, without floating point error. */
export function roundDiv(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new RangeError('roundDiv expects safe integers and a positive denominator');
  }
  const sign = numerator < 0 ? -1 : 1;
  const n = Math.abs(numerator);
  const q = Math.floor(n / denominator);
  const r = n - q * denominator;
  return sign * (r * 2 >= denominator ? q + 1 : q);
}

export function assertRate(rate: number): void {
  if (!Number.isFinite(rate) || rate <= 0) throw new RangeError(`Invalid exchange rate: ${rate}`);
}

function assertInt(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${what} must be a safe integer, got ${value}`);
}

/** USD cents → whole LBP at `rate` LBP per USD. */
export function usdToLbp(cents: number, rate: number): number {
  assertRate(rate);
  assertInt(cents, 'cents');
  // rate may be fractional in theory; keep exact arithmetic for integer rates (the normal case).
  if (Number.isInteger(rate)) return roundDiv(cents * rate, 100);
  return Math.round((cents * rate) / 100);
}

/** Whole LBP → USD cents, rounded to the nearest cent. */
export function lbpToUsdCents(lbp: number, rate: number): number {
  assertRate(rate);
  assertInt(lbp, 'lbp');
  if (Number.isInteger(rate)) return roundDiv(lbp * 100, rate);
  return Math.round((lbp * 100) / rate);
}

/** Convert any Money to whole LBP. */
export function toLbp(money: Money, rate: number): number {
  return money.currency === 'LBP' ? money.amount : usdToLbp(money.amount, rate);
}

/** Round an LBP amount to the nearest `increment` (half rounds up). Increment 1 = no rounding. */
export function roundLbp(lbp: number, increment: number): number {
  assertInt(lbp, 'lbp');
  if (!Number.isSafeInteger(increment) || increment < 1) throw new RangeError('increment must be a positive integer');
  return roundDiv(lbp, increment) * increment;
}

const QTY_RE = /^\d+(\.\d{1,3})?$/;

/** Parse a quantity (up to 3 decimals, > 0) into thousandths. */
export function parseQtyMilli(qty: string | number): number {
  const text = typeof qty === 'number' ? String(qty) : qty;
  if (!QTY_RE.test(text)) throw new RangeError(`Invalid quantity "${text}": must be positive with at most 3 decimals`);
  const [whole = '0', frac = ''] = text.split('.');
  const milli = Number(whole) * 1000 + Number(frac.padEnd(3, '0'));
  if (!Number.isSafeInteger(milli) || milli <= 0) throw new RangeError(`Invalid quantity "${text}": must be greater than zero`);
  return milli;
}

/** unit price (whole LBP) × quantity → whole LBP, rounded. */
export function lineTotal(unitPriceLbp: number, qty: string | number): number {
  assertInt(unitPriceLbp, 'unitPriceLbp');
  return roundDiv(unitPriceLbp * parseQtyMilli(qty), 1000);
}
