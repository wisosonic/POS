import { PricingError, computeCart } from '@pos/shared';
import { create } from 'zustand';
import type { Approval, Discount } from '../lib/discount';
import { unitPriceLbp } from '../lib/money';
import { addQty, isValidQty, milliToQty, qtyToMilli } from '../lib/qty';
import type { Customer, Product } from '../lib/types';

/** A unit price other than the catalogue's, in whole lira. A cashier's needs a manager's approval token for this product at this price. */
export type PriceOverride = { lbp: number; token?: string; approvedBy?: string };

export type CartLine = { key: string; product: Product; qty: string; price?: PriceOverride };

export type CartTotals = {
  subtotalLbp: number;
  /** What the discount takes off, in lira. 0 when there is none, or when it no longer fits the cart. */
  discountLbp: number;
  /** A discount was asked for but is more than the cart is worth (items were removed). The figures leave it out. */
  discountInvalid: boolean;
  roundingLbp: number;
  totalLbp: number;
  lines: { key: string; unitPriceLbp: number; lineTotalLbp: number }[];
};

const EMPTY: CartTotals = { subtotalLbp: 0, discountLbp: 0, discountInvalid: false, roundingLbp: 0, totalLbp: 0, lines: [] };

/** Price the cart with the same rules the server uses (packages/shared), so the till and the receipt agree to the lira. */
export function cartTotals(lines: CartLine[], rate: number, lbpRounding: number, discount: Discount | null = null): CartTotals {
  if (lines.length === 0 || !(rate > 0)) return EMPTY;
  const price = (d: Discount | null) =>
    computeCart({
      rate,
      lbpRounding,
      ...(d ? { discount: d } : {}),
      lines: lines.map((l) => ({
        unitPrice: l.price
          ? { amount: l.price.lbp, currency: 'LBP' as const }
          : { amount: l.product.priceMinor, currency: l.product.currency },
        qty: l.qty,
      })),
    });
  let priced: ReturnType<typeof price>;
  let discountInvalid = false;
  try {
    priced = price(discount);
  } catch (e) {
    // Items were taken out and a fixed discount is now more than what is left. Show the cart without it, and say so.
    if (discount && e instanceof PricingError) {
      priced = price(null);
      discountInvalid = true;
    } else throw e;
  }
  return {
    subtotalLbp: priced.subtotalLbp,
    discountLbp: priced.discountLbp,
    discountInvalid,
    roundingLbp: priced.roundingLbp,
    totalLbp: priced.totalLbp,
    lines: priced.lines.map((p, i) => ({ key: lines[i]!.key, unitPriceLbp: p.unitPriceLbp, lineTotalLbp: p.lineTotalLbp })),
  };
}

type CartState = {
  lines: CartLine[];
  customer: Customer | null;
  /** The line touched last, shown big at the top so the cashier can see what the scan did. */
  lastKey: string | null;
  /** A discount on the whole cart, and the manager's approval when it is above the cashier's limit. */
  discount: Discount | null;
  approval: Approval | null;
  add: (product: Product, qty?: string) => CartLine;
  setQty: (key: string, qty: string) => boolean;
  /** Sell this line at another price (null goes back to the catalogue price). */
  setPrice: (key: string, price: PriceOverride | null) => void;
  step: (key: string, direction: 1 | -1) => void;
  remove: (key: string) => void;
  clear: () => void;
  setCustomer: (customer: Customer | null) => void;
  setDiscount: (discount: Discount | null, approval?: Approval | null) => void;
  setApproval: (approval: Approval | null) => void;
  restore: (lines: { product: Product; qty: string }[], customer: Customer | null) => void;
};

let counter = 0;
const newKey = () => `l${++counter}`;

export const useCart = create<CartState>((set, get) => ({
  lines: [],
  customer: null,
  lastKey: null,
  discount: null,
  approval: null,

  // Scanning the same product again adds to its line instead of making a second one.
  add(product, qty = '1') {
    const existing = get().lines.find((l) => l.product.id === product.id);
    if (existing) {
      const next = { ...existing, qty: addQty(existing.qty, qty) };
      set((s) => ({ lines: s.lines.map((l) => (l.key === existing.key ? next : l)), lastKey: existing.key }));
      return next;
    }
    const line: CartLine = { key: newKey(), product, qty };
    set((s) => ({ lines: [...s.lines, line], lastKey: line.key }));
    return line;
  },

  setQty(key, qty) {
    const line = get().lines.find((l) => l.key === key);
    if (!line || !isValidQty(qty, line.product.fractional)) return false;
    set((s) => ({ lines: s.lines.map((l) => (l.key === key ? { ...l, qty } : l)), lastKey: key }));
    return true;
  },

  setPrice: (key, price) =>
    set((s) => ({ lines: s.lines.map((l) => (l.key === key ? { ...l, price: price ?? undefined } : l)), lastKey: key })),

  // + and - move by one unit (one kilo for items sold by weight). Going to zero removes the line.
  step(key, direction) {
    const line = get().lines.find((l) => l.key === key);
    if (!line) return;
    const next = qtyToMilli(line.qty) + direction * 1000;
    if (next <= 0) return get().remove(key);
    set((s) => ({ lines: s.lines.map((l) => (l.key === key ? { ...l, qty: milliToQty(next) } : l)), lastKey: key }));
  },

  remove: (key) => set((s) => ({ lines: s.lines.filter((l) => l.key !== key), lastKey: s.lastKey === key ? null : s.lastKey })),
  clear: () => set({ lines: [], customer: null, lastKey: null, discount: null, approval: null }),
  setCustomer: (customer) => set({ customer }),
  // A new discount invalidates any earlier approval unless one is given with it: an approval is for what the manager saw.
  setDiscount: (discount, approval = null) => set({ discount, approval: discount ? approval : null }),
  setApproval: (approval) => set({ approval }),
  restore: (lines, customer) =>
    set({
      lines: lines.map((l) => ({ key: newKey(), product: l.product, qty: l.qty })),
      customer,
      lastKey: null,
      discount: null,
      approval: null,
    }),
}));

export const lineUnitPrice = (l: CartLine, rate: number) => unitPriceLbp(l.product, rate);
