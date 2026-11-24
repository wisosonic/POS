import { roundDiv, usdToLbp } from '@pos/shared';
import type { Currency, Product } from './types';

export const groupThousands = (n: number): string => {
  const sign = n < 0 ? '-' : '';
  return sign + String(Math.abs(Math.trunc(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};

/** 335000 → "335,000 LL" */
export const fmtLbp = (n: number): string => `${groupThousands(n)} LL`;
/** 372 cents → "$3.72" */
export const fmtUsd = (cents: number): string => `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;
export const fmtMoney = (amount: number, currency: Currency): string => (currency === 'USD' ? fmtUsd(amount) : fmtLbp(amount));

/** The dollar value of a lira amount, for the "about $3.72" shown beside totals. */
export const lbpAsUsd = (lbp: number, rate: number): string => fmtUsd(roundDiv(lbp * 100, rate));

/**
 * Read what a person typed into an amount box. Lira: whole numbers, commas and spaces ignored. Dollars: up to 2 decimals,
 * returned as cents. Empty is 0. Anything else is NaN so the screen can say so instead of guessing.
 */
export function parseLbpInput(text: string): number {
  const t = text.replace(/[,\s]/g, '');
  if (t === '') return 0;
  return /^\d+$/.test(t) ? Number(t) : NaN;
}
export function parseUsdInput(text: string): number {
  const t = text.replace(/[,\s$]/g, '');
  if (t === '') return 0;
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(t);
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : NaN;
}

/** The price of one unit in lira at the given rate, in the product's own currency. */
export const unitPriceLbp = (p: Pick<Product, 'priceMinor' | 'currency'>, rate: number): number =>
  p.currency === 'LBP' ? p.priceMinor : usdToLbp(p.priceMinor, rate);

/** "1.250" → "1.25", "2.000" → "2" */
export const trimQty = (q: string): string => (q.includes('.') ? q.replace(/0+$/, '').replace(/\.$/, '') : q);
