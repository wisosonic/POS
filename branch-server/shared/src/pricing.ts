// Cart totals and tender handling. Pure functions: the server recomputes everything with these (CLAUDE.md rule 2).
// Prices are tax-inclusive (no tax). Totals are whole LBP rounded to `lbpRounding`. Change is always cash.
import { parseQtyMilli, roundDiv, roundLbp, assertRate, usdToLbp, type Money, type Currency } from './money';

/** A RangeError with a stable `code`, so the API can answer with the right problem type. */
export class PricingError extends RangeError {
  constructor(
    readonly code:
      | 'CART_EMPTY'
      | 'DISCOUNT_INVALID'
      | 'DISCOUNT_EXCEEDS_SUBTOTAL'
      | 'TENDER_INVALID'
      | 'WALLET_EXCEEDS_TOTAL'
      | 'CREDIT_REQUIRES_CUSTOMER'
      | 'INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'PricingError';
  }
}

export const PAYMENT_METHODS = ['cash', 'whish', 'omt'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const WALLET_METHODS: readonly PaymentMethod[] = ['whish', 'omt'];

export const DEFAULT_LBP_ROUNDING = 5000;
export const WALK_IN_CUSTOMER_ID = 1;

// ---------------------------------------------------------------- cart

export type CartLine = { unitPrice: Money; qty: string };
export type Discount = { type: 'percent'; value: number } | { type: 'amount'; value: number };

export type CartInput = {
  lines: CartLine[];
  /** LBP per 1 USD, snapshotted on the sale. */
  rate: number;
  discount?: Discount;
  lbpRounding?: number;
};

export type CartResult = {
  lines: { unitPriceLbp: number; lineTotalLbp: number }[];
  subtotalLbp: number;
  discountLbp: number;
  roundingLbp: number;
  totalLbp: number;
};

/** price × qty in whole LBP. USD prices are multiplied before converting, so a line is rounded once. */
function lineTotalLbp(price: Money, qtyMilli: number, rate: number): number {
  if (price.currency === 'LBP') return roundDiv(price.amount * qtyMilli, 1000);
  if (!Number.isInteger(rate)) return Math.round((price.amount * qtyMilli * rate) / 100_000);
  // cents × thousandths × rate can exceed 2^53 for very large lines, so do this one in BigInt.
  const numerator = BigInt(price.amount) * BigInt(qtyMilli) * BigInt(rate);
  const denominator = 100_000n; // 100 cents per dollar × 1000 thousandths
  const q = numerator / denominator;
  const r = numerator - q * denominator;
  return Number(r * 2n >= denominator ? q + 1n : q); // amounts are validated non-negative
}

export function computeCart(input: CartInput): CartResult {
  const { lines, rate, discount, lbpRounding = DEFAULT_LBP_ROUNDING } = input;
  assertRate(rate);
  if (lines.length === 0) throw new PricingError('CART_EMPTY', 'Cart is empty');

  const priced = lines.map((l) => {
    if (!Number.isSafeInteger(l.unitPrice.amount) || l.unitPrice.amount < 0)
      throw new RangeError('Unit price must be a non-negative integer');
    return {
      unitPriceLbp: l.unitPrice.currency === 'LBP' ? l.unitPrice.amount : usdToLbp(l.unitPrice.amount, rate),
      lineTotalLbp: lineTotalLbp(l.unitPrice, parseQtyMilli(l.qty), rate),
    };
  });
  const subtotalLbp = priced.reduce((sum, l) => sum + l.lineTotalLbp, 0);

  let discountLbp = 0;
  if (discount) {
    if (discount.type === 'percent') {
      if (!(discount.value >= 0 && discount.value <= 100))
        throw new PricingError('DISCOUNT_INVALID', 'Discount percent must be between 0 and 100');
      discountLbp = roundDiv(subtotalLbp * Math.round(discount.value * 100), 10_000);
    } else {
      if (!Number.isSafeInteger(discount.value) || discount.value < 0)
        throw new PricingError('DISCOUNT_INVALID', 'Discount amount must be a non-negative integer');
      if (discount.value > subtotalLbp) throw new PricingError('DISCOUNT_EXCEEDS_SUBTOTAL', 'Discount cannot exceed the subtotal');
      discountLbp = discount.value;
    }
  }

  const afterDiscount = subtotalLbp - discountLbp;
  const totalLbp = roundLbp(afterDiscount, lbpRounding);
  return { lines: priced, subtotalLbp, discountLbp, roundingLbp: totalLbp - afterDiscount, totalLbp };
}

// ---------------------------------------------------------------- tender

export type Tender = { amount: number; currency: Currency; method?: PaymentMethod };
export type SaleStatus = 'paid' | 'partial' | 'unpaid';

export type TenderInput = {
  totalLbp: number;
  rate: number;
  tenders: Tender[];
  /** Registered customer id. Walk-In (1) or undefined cannot buy on credit. */
  customerId?: number;
  lbpRounding?: number;
  walkInId?: number;
};

export type TenderResult = {
  status: SaleStatus;
  /** Everything received, in LBP (may exceed the total when change is due). */
  paidLbp: number;
  changeLbp: number;
  restLbp: number;
  byMethod: { method: PaymentMethod; currency: Currency; amount: number }[];
};

export function applyTender(input: TenderInput): TenderResult {
  const { totalLbp, rate, tenders, customerId, lbpRounding = DEFAULT_LBP_ROUNDING, walkInId = WALK_IN_CUSTOMER_ID } = input;
  assertRate(rate);
  if (!Number.isSafeInteger(totalLbp) || totalLbp <= 0) throw new PricingError('INVALID', 'Total must be a positive integer');

  let paidLbp = 0;
  let walletLbp = 0;
  const byMethod: TenderResult['byMethod'] = [];

  for (const t of tenders) {
    const method = t.method ?? 'cash';
    if (!PAYMENT_METHODS.includes(method)) throw new RangeError(`Unknown payment method "${String(method)}"`);
    if (t.currency !== 'USD' && t.currency !== 'LBP') throw new RangeError(`Unknown currency "${String(t.currency)}"`);
    if (!Number.isSafeInteger(t.amount) || t.amount <= 0)
      throw new PricingError('TENDER_INVALID', 'Tender amounts must be positive integers');

    const lbp = t.currency === 'LBP' ? t.amount : usdToLbp(t.amount, rate);
    paidLbp += lbp;
    if (WALLET_METHODS.includes(method)) walletLbp += lbp;

    const existing = byMethod.find((b) => b.method === method && b.currency === t.currency);
    if (existing) existing.amount += t.amount;
    else byMethod.push({ method, currency: t.currency, amount: t.amount });
  }

  // Change is always paid out in cash, so a wallet payment may never exceed what is due.
  if (walletLbp > totalLbp)
    throw new PricingError('WALLET_EXCEEDS_TOTAL', 'A wallet payment cannot exceed the total: change can only be given in cash');

  if (paidLbp >= totalLbp) {
    return { status: 'paid', paidLbp, changeLbp: roundLbp(paidLbp - totalLbp, lbpRounding), restLbp: 0, byMethod };
  }

  if (customerId === undefined || customerId === walkInId) {
    throw new PricingError(
      'CREDIT_REQUIRES_CUSTOMER',
      'A registered customer is required to leave a balance (partial payment or pay later)',
    );
  }
  return {
    status: paidLbp === 0 ? 'unpaid' : 'partial',
    paidLbp,
    changeLbp: 0,
    restLbp: totalLbp - paidLbp,
    byMethod,
  };
}
