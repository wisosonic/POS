import { parseLbpInput } from './money';
import type { Role } from './types';

/** What the cashier asked for: a percent off the whole cart, or a fixed number of lira off. */
export type Discount = { type: 'percent'; value: number } | { type: 'amount'; value: number };

/** A manager's go-ahead for a discount above the cashier's limit (from POST /auth/approve). */
export type Approval = { token: string; managerName: string; maxPct: number };

export type ParsedDiscount = { ok: true; discount: Discount } | { ok: false; error: string };

/** Read what was typed. A percent may have up to 2 decimals ("12.5" or "12,5"); lira are whole numbers. */
export function parseDiscountInput(kind: Discount['type'], text: string): ParsedDiscount {
  const t = text.trim();
  if (t === '') return { ok: false, error: 'Type the discount' };
  if (kind === 'percent') {
    const m = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(t.replace('%', '').trim());
    if (!m) return { ok: false, error: 'Type a percent such as 10 or 12.5' };
    const value = Number(`${m[1]}.${m[2] ?? '0'}`);
    if (value <= 0) return { ok: false, error: 'The discount must be more than zero' };
    if (value > 100) return { ok: false, error: 'A discount cannot be more than 100%' };
    return { ok: true, discount: { type: 'percent', value } };
  }
  const value = parseLbpInput(t);
  if (!Number.isFinite(value)) return { ok: false, error: 'Type the amount in whole lira, for example 5,000' };
  if (value <= 0) return { ok: false, error: 'The discount must be more than zero' };
  return { ok: true, discount: { type: 'amount', value } };
}

/** The discount as a percent of the cart before the discount. */
export const discountPct = (discountLbp: number, subtotalLbp: number): number => (subtotalLbp > 0 ? (discountLbp * 100) / subtotalLbp : 0);

/**
 * The percent to put on an approval request: rounded UP to a hundredth of a percent, so that rounding can never make an
 * honest sale a hair over what the manager approved.
 */
export const approvalPct = (pct: number): number => Math.max(0, Math.min(100, Math.ceil(pct * 100 - 1e-9) / 100));

/** Only a cashier is limited. Managers and admins give any discount. */
export const needsApproval = (role: Role, pct: number, limitPct: number): boolean => role === 'cashier' && pct > limitPct;

/** Is this approval still enough for a discount of `pct`? (The server has the final word.) */
export const approvalCovers = (approval: Approval, pct: number): boolean => pct <= approval.maxPct + 0.011;
