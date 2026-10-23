import { PricingError, applyTender, type Tender } from '@pos/shared';
import { parseLbpInput, parseUsdInput } from './money';

// What the cashier typed in the pay dialog -> what it means. The same rules the server applies (packages/shared), so the
// till can say "change 25,000" or "select a registered customer" before anything is sent.

export type PayInputs = { cashLbp: string; cashUsd: string; whishLbp: string; whishUsd: string; omtLbp: string; omtUsd: string };
export const NO_PAYMENT: PayInputs = { cashLbp: '', cashUsd: '', whishLbp: '', whishUsd: '', omtLbp: '', omtUsd: '' };

export type PayAnalysis = {
  tenders: Tender[];
  receivedLbp: number;
  changeLbp: number;
  restLbp: number;
  status: 'paid' | 'partial' | 'unpaid' | null;
  /** Why the sale cannot be completed yet. Null when it can. */
  error: string | null;
};

const FIELDS: { key: keyof PayInputs; method: Tender['method']; currency: Tender['currency']; label: string }[] = [
  { key: 'cashLbp', method: 'cash', currency: 'LBP', label: 'Cash LBP' },
  { key: 'cashUsd', method: 'cash', currency: 'USD', label: 'Cash USD' },
  { key: 'whishLbp', method: 'whish', currency: 'LBP', label: 'Whish LBP' },
  { key: 'whishUsd', method: 'whish', currency: 'USD', label: 'Whish USD' },
  { key: 'omtLbp', method: 'omt', currency: 'LBP', label: 'OMT LBP' },
  { key: 'omtUsd', method: 'omt', currency: 'USD', label: 'OMT USD' },
];

export function analyzePayment(args: {
  inputs: PayInputs;
  totalLbp: number;
  rate: number;
  lbpRounding: number;
  registeredCustomer: boolean;
}): PayAnalysis {
  const none: Omit<PayAnalysis, 'error'> = { tenders: [], receivedLbp: 0, changeLbp: 0, restLbp: 0, status: null };
  const tenders: Tender[] = [];
  for (const f of FIELDS) {
    const amount = f.currency === 'LBP' ? parseLbpInput(args.inputs[f.key]) : parseUsdInput(args.inputs[f.key]);
    if (Number.isNaN(amount)) return { ...none, error: `Check the amount in ${f.label}` };
    if (amount > 0) tenders.push({ method: f.method, currency: f.currency, amount });
  }
  if (args.totalLbp <= 0) return { ...none, error: 'The cart is empty' };
  if (tenders.length === 0 && !args.registeredCustomer) return { ...none, error: 'Enter what the customer pays' };

  try {
    const r = applyTender({
      totalLbp: args.totalLbp,
      rate: args.rate,
      tenders,
      lbpRounding: args.lbpRounding,
      // Any registered customer may owe; Walk-In (no customer chosen) may not. -1 is never a real customer id.
      customerId: args.registeredCustomer ? 1_000_000_000 : undefined,
      walkInId: -1,
    });
    return { tenders, receivedLbp: r.paidLbp, changeLbp: r.changeLbp, restLbp: r.restLbp, status: r.status, error: null };
  } catch (e) {
    if (e instanceof PricingError) {
      if (e.code === 'CREDIT_REQUIRES_CUSTOMER')
        return { ...none, tenders, error: 'Select a registered customer to leave a balance on account' };
      if (e.code === 'WALLET_EXCEEDS_TOTAL')
        return {
          ...none,
          tenders,
          error: 'A Whish or OMT payment cannot be more than the total, because change can only be given in cash',
        };
    }
    return { ...none, tenders, error: e instanceof Error ? e.message : 'This payment cannot be used' };
  }
}
