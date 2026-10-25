import {
  PricingError,
  applyTender,
  computeCart,
  lineTotal,
  parseQtyMilli,
  toReceiptName,
  usdToLbp,
  type CartLine,
  type Money,
  type Receipt,
} from '@pos/shared';
import { z } from 'zod';
import { consumeApproval, consumePriceApproval } from '../../auth/approvals';
import { hasRole, type Role } from '../../auth/permissions';
import { nextRef } from '../../db/counters';
import { inWriteTransaction, type Db } from '../../db/open';
import { AppError, E } from '../../errors';
import { findReplay, rememberResponse } from '../../util/idempotency';
import { milliToQty } from '../../util/qty';
import { activeMethods, bumpExpected, requireOpenSession } from '../registers/service';
import { currentRate, defaultWarehouseId, shopSettings, walkInCustomerId } from '../settings/context';

export const SALE_SCOPE = 'POST /sales';

// ------------------------------------------------------------------ input

const qty = z
  .string()
  .regex(/^\d+(\.\d{1,3})?$/, 'Quantity must be a positive number with at most 3 decimals')
  .refine((v) => Number(v) > 0, 'Quantity must be greater than zero');

export const saleBody = z.object({
  clientSaleId: z.string().min(1).max(64).optional(),
  customerId: z.number().int().positive().optional(),
  items: z
    .array(
      z.object({
        productId: z.number().int().positive(),
        qty,
        /** What the till displayed. The server re-prices from the catalog and compares. */
        unitPriceLbp: z.number().int().min(0),
        /** A cashier selling at a price other than the catalogue's needs a manager's approval for this product and this price. */
        approvalToken: z.string().max(100).optional(),
      }),
    )
    .min(1, 'A sale needs at least one item')
    .max(200),
  discount: z
    .union([
      z.object({ type: z.literal('percent'), value: z.number().min(0).max(100) }),
      z.object({ type: z.literal('amount'), value: z.number().int().min(0) }),
    ])
    .optional(),
  payments: z
    .array(
      z.object({
        method: z.enum(['cash', 'whish', 'omt']),
        currency: z.enum(['USD', 'LBP']),
        amount: z.number().int().positive(),
      }),
    )
    .max(12),
  notes: z.string().max(500).optional(),
  /** A manager's approval (from POST /auth/approve) for a discount above this cashier's limit. Used once. */
  approvalToken: z.string().max(100).optional(),
});
export type SaleBody = z.infer<typeof saleBody>;

export type Actor = { id: number; role: Role };

/** Pricing errors keep their code; the API answers 422 (a valid request that the shop's rules refuse). */
export function pricingToAppError(e: unknown): never {
  if (e instanceof PricingError) {
    if (e.code === 'CART_EMPTY') throw E.validation(e.message);
    throw E.unprocessable(e.code, e.message);
  }
  if (e instanceof RangeError) throw E.unprocessable('INVALID_SALE', e.message);
  throw e;
}

// ------------------------------------------------------------------ output

type SaleRow = {
  id: number;
  ref: number;
  session_id: number | null;
  user_id: number | null;
  customer_id: number;
  rate_lbp_per_usd: number;
  subtotal_lbp: number;
  discount_lbp: number;
  shipping_lbp: number;
  rounding_lbp: number;
  total_lbp: number;
  paid_lbp: number;
  change_lbp: number;
  rest_lbp: number;
  profit_lbp: number;
  status: string;
  notes: string;
  client_sale_id: string | null;
  created_at: string;
};

export const saleSummaryJson = (s: SaleRow) => ({
  id: s.id,
  ref: s.ref,
  status: s.status,
  userId: s.user_id,
  sessionId: s.session_id,
  customerId: s.customer_id,
  totalLbp: s.total_lbp,
  paidLbp: s.paid_lbp,
  restLbp: s.rest_lbp,
  changeLbp: s.change_lbp,
  clientSaleId: s.client_sale_id,
  createdAt: s.created_at,
});

export function getSale(db: Db, id: number): SaleRow | undefined {
  return db.prepare('SELECT * FROM sales WHERE id = ?').get(id) as SaleRow | undefined;
}

export function saleJson(db: Db, s: SaleRow) {
  const items = db
    .prepare(
      'SELECT id, product_id, name_snap, receipt_name_snap, barcode_snap, qty_milli, unit_price_lbp, line_total_lbp FROM sale_items WHERE sale_id = ? ORDER BY id',
    )
    .all(s.id) as {
    id: number;
    product_id: number | null;
    name_snap: string;
    receipt_name_snap: string | null;
    barcode_snap: string;
    qty_milli: number;
    unit_price_lbp: number;
    line_total_lbp: number;
  }[];
  // How much of each line has already come back, so a return screen can say what is left without reading the returns list.
  const returned = new Map(
    (
      db
        .prepare(
          `SELECT sale_item_id AS item_id, SUM(qty_milli) AS back_milli FROM return_items
           WHERE sale_item_id IN (SELECT id FROM sale_items WHERE sale_id = ?) GROUP BY sale_item_id`,
        )
        .all(s.id) as { item_id: number; back_milli: number }[]
    ).map((r) => [r.item_id, r.back_milli]),
  );
  const payments = db.prepare('SELECT method, currency, amount FROM payments WHERE sale_id = ? ORDER BY id').all(s.id) as {
    method: string;
    currency: 'USD' | 'LBP';
    amount: number;
  }[];
  const receivedLbp = payments.reduce((sum, p) => sum + (p.currency === 'LBP' ? p.amount : usdToLbp(p.amount, s.rate_lbp_per_usd)), 0);

  return {
    ...saleSummaryJson(s),
    rateLbpPerUsd: s.rate_lbp_per_usd,
    subtotalLbp: s.subtotal_lbp,
    discountLbp: s.discount_lbp,
    shippingLbp: s.shipping_lbp,
    roundingLbp: s.rounding_lbp,
    receivedLbp,
    profitLbp: s.profit_lbp,
    notes: s.notes,
    items: items.map((i) => ({
      id: i.id,
      productId: i.product_id,
      name: i.name_snap,
      receiptName: i.receipt_name_snap,
      barcode: i.barcode_snap,
      qty: milliToQty(i.qty_milli),
      returnedQty: milliToQty(returned.get(i.id) ?? 0),
      unitPriceLbp: i.unit_price_lbp,
      lineTotalLbp: i.line_total_lbp,
    })),
    payments,
  };
}

/** The receipt model for the printer and the browser (English/ASCII rendering is done by @pos/shared). */
export function receiptFor(db: Db, s: SaleRow): Receipt {
  const store = db.prepare('SELECT name, address, phone, receipt_footer FROM store_settings WHERE id = 1').get() as {
    name: string;
    address: string | null;
    phone: string | null;
    receipt_footer: string;
  };
  const cashier = s.user_id
    ? (db.prepare('SELECT name FROM users WHERE id = ?').get(s.user_id) as { name: string } | undefined)?.name
    : undefined;
  const customer = db.prepare('SELECT name, balance_lbp, is_walk_in FROM customers WHERE id = ?').get(s.customer_id) as {
    name: string;
    balance_lbp: number;
    is_walk_in: number;
  };
  const labels: Record<string, string> = { cash: 'Cash', whish: 'Whish', omt: 'OMT' };
  const json = saleJson(db, s);

  return {
    storeName: store.name,
    voided: s.status === 'void' ? true : undefined,
    address: store.address ?? undefined,
    phone: store.phone ?? undefined,
    ref: s.ref,
    createdAt: s.created_at,
    cashier: cashier ?? '-',
    register: s.session_id ?? undefined,
    customer: customer.is_walk_in ? undefined : { name: customer.name, balanceLbp: customer.balance_lbp },
    items: json.items.map((i) => ({
      name: i.name,
      receiptName: i.receiptName,
      qty: i.qty,
      unitPriceLbp: i.unitPriceLbp,
      totalLbp: i.lineTotalLbp,
    })),
    subtotalLbp: s.subtotal_lbp,
    discountLbp: s.discount_lbp,
    totalLbp: s.total_lbp,
    rateLbpPerUsd: s.rate_lbp_per_usd,
    payments: json.payments.map((p) => ({
      label: `${labels[p.method] ?? p.method} ${p.currency}`,
      amountLbp: p.currency === 'LBP' ? p.amount : usdToLbp(p.amount, s.rate_lbp_per_usd),
    })),
    paidLbp: s.paid_lbp,
    changeLbp: s.change_lbp,
    restLbp: s.rest_lbp,
    footer: store.receipt_footer,
  };
}

// ------------------------------------------------------------------ the sale

type ProductRow = {
  id: number;
  name: string;
  receipt_name: string | null;
  barcode: string;
  cost_minor: number;
  price_minor: number;
  currency: 'USD' | 'LBP';
  active: number;
  brand_name: string | null;
  unit_name: string | null;
  fractional: number | null;
};

export type CreateSaleResult = { statusCode: number; body: unknown; replay: boolean };

/**
 * Complete a sale. Everything below happens in ONE write transaction (CLAUDE.md rule 3): the sale, its lines, the
 * payments, the stock ledger and cache, the customer's balance, the register buckets and the idempotency record all
 * commit together, or none of them does. The server prices the cart itself and never trusts the client's totals.
 * There is deliberately no `await` inside, so two identical requests cannot interleave.
 */
export function createSale(db: Db, actor: Actor, body: SaleBody, idem: { key: string; hash: string }): CreateSaleResult {
  return inWriteTransaction(db, (): CreateSaleResult => {
    const replay = findReplay(db, SALE_SCOPE, idem.key, idem.hash);
    if (replay) return { ...replay, replay: true };

    const session = requireOpenSession(db);
    const rate = currentRate(db);
    const settings = shopSettings(db);
    const warehouseId = defaultWarehouseId(db);
    const walkInId = walkInCustomerId(db);

    const customerId = body.customerId ?? walkInId;
    const customer = db.prepare('SELECT id, name FROM customers WHERE id = ? AND deleted_at IS NULL').get(customerId) as
      { id: number; name: string } | undefined;
    if (!customer) throw E.unprocessable('INVALID_REFERENCE', 'That customer does not exist');

    const methods = activeMethods(db);
    for (const p of body.payments) {
      if (!methods.includes(p.method)) throw E.unprocessable('PAYMENT_METHOD_DISABLED', `Payment method "${p.method}" is not accepted`);
    }

    // ---- price every line from the catalog
    const lines: CartLine[] = [];
    const prepared: { p: ProductRow; qtyMilli: number; unitCostLbp: number; qty: string }[] = [];
    const overrides: { productId: number; catalogUnitPriceLbp: number; usedUnitPriceLbp: number; approvedBy?: number }[] = [];

    for (const item of body.items) {
      const p = db
        .prepare(
          `SELECT p.id, p.name, p.receipt_name, p.barcode, p.cost_minor, p.price_minor, p.currency, p.active,
                  b.name AS brand_name, u.name AS unit_name, u.fractional
           FROM products p LEFT JOIN brands b ON b.id = p.brand_id LEFT JOIN units u ON u.id = p.unit_id WHERE p.id = ?`,
        )
        .get(item.productId) as ProductRow | undefined;
      if (!p) throw E.unprocessable('INVALID_REFERENCE', `Product ${item.productId} does not exist`);
      if (!p.active) throw E.unprocessable('PRODUCT_INACTIVE', `"${p.name}" is inactive`);

      const qtyMilli = parseQtyMilli(item.qty);
      if (p.unit_name !== null && p.fractional === 0 && qtyMilli % 1000 !== 0) {
        throw E.unprocessable('FRACTIONAL_NOT_ALLOWED', `"${p.name}" is sold by the ${p.unit_name} and cannot be split`);
      }

      const catalogUnitPriceLbp = p.currency === 'LBP' ? p.price_minor : usdToLbp(p.price_minor, rate);
      let unitPrice: Money = { amount: p.price_minor, currency: p.currency };
      if (item.unitPriceLbp !== catalogUnitPriceLbp) {
        let priceApprovedBy: number | undefined;
        if (!hasRole(actor.role, 'manager') && item.approvalToken) {
          // A manager has said yes to this product at this price. Used inside this transaction, so a sale that fails afterwards
          // rolls it back and the approval can be used again.
          priceApprovedBy = consumePriceApproval(db, item.approvalToken, actor.id, p.id, item.unitPriceLbp)?.approvedBy;
        }
        if (!hasRole(actor.role, 'manager') && priceApprovedBy === undefined) {
          throw new AppError(422, 'PRICE_MISMATCH', `The price of "${p.name}" changed. Refresh the catalog and try again.`, {
            productId: p.id,
            expectedUnitPriceLbp: catalogUnitPriceLbp,
            sentUnitPriceLbp: item.unitPriceLbp,
          });
        }
        unitPrice = { amount: item.unitPriceLbp, currency: 'LBP' }; // a manager may sell at a price they set
        overrides.push({ productId: p.id, catalogUnitPriceLbp, usedUnitPriceLbp: item.unitPriceLbp, approvedBy: priceApprovedBy });
      }

      lines.push({ unitPrice, qty: item.qty });
      prepared.push({ p, qtyMilli, qty: item.qty, unitCostLbp: p.currency === 'LBP' ? p.cost_minor : usdToLbp(p.cost_minor, rate) });
    }

    // ---- totals and payment, using the shared rules the till also uses
    let cart: ReturnType<typeof computeCart>;
    let tender: ReturnType<typeof applyTender>;
    let discountApproval: { approvedBy: number; pct: number } | null = null;
    try {
      cart = computeCart({ lines, rate, discount: body.discount, lbpRounding: settings.lbpRounding });
      if (body.discount && actor.role === 'cashier' && cart.subtotalLbp > 0) {
        const pct = (cart.discountLbp * 100) / cart.subtotalLbp;
        if (pct > settings.cashierDiscountLimitPct) {
          // Over the cashier's limit: only with a manager's approval. Using it is part of this transaction, so a sale
          // that fails afterwards (say, the payment is short) rolls it back and the approval can be used again.
          const approval = body.approvalToken ? consumeApproval(db, body.approvalToken, actor.id, pct) : null;
          if (!approval) {
            throw new AppError(
              403,
              'DISCOUNT_OVER_LIMIT',
              `Discounts above ${settings.cashierDiscountLimitPct}% need a manager's approval`,
              { limitPct: settings.cashierDiscountLimitPct, requestedPct: Math.round(pct * 100) / 100 },
            );
          }
          discountApproval = { approvedBy: approval.approvedBy, pct };
        }
      }
      tender = applyTender({
        totalLbp: cart.totalLbp,
        rate,
        tenders: body.payments,
        customerId: customer.id,
        walkInId,
        lbpRounding: settings.lbpRounding,
      });
    } catch (e) {
      if (e instanceof AppError) throw e;
      return pricingToAppError(e);
    }

    const appliedLbp = cart.totalLbp - tender.restLbp;
    const costLbp = prepared.reduce((sum, l) => sum + lineTotal(l.unitCostLbp, l.qty), 0);
    const profitLbp = cart.totalLbp - costLbp;

    // ---- write
    const ref = nextRef(db, 'sale_ref');
    const saleId = Number(
      db
        .prepare(
          `INSERT INTO sales (ref, session_id, user_id, customer_id, warehouse_id, rate_lbp_per_usd, subtotal_lbp, discount_lbp, rounding_lbp,
                              total_lbp, paid_lbp, change_lbp, rest_lbp, profit_lbp, status, notes, client_sale_id, idempotency_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ref,
          session.id,
          actor.id,
          customer.id,
          warehouseId,
          rate,
          cart.subtotalLbp,
          cart.discountLbp,
          cart.roundingLbp,
          cart.totalLbp,
          appliedLbp,
          tender.changeLbp,
          tender.restLbp,
          profitLbp,
          tender.status,
          body.notes ?? '',
          body.clientSaleId ?? null,
          idem.key,
        ).lastInsertRowid,
    );

    const insertItem = db.prepare(
      `INSERT INTO sale_items (sale_id, product_id, name_snap, receipt_name_snap, barcode_snap, brand_snap, unit_snap, qty_milli, unit_price_lbp, unit_cost_lbp, line_total_lbp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertMovement = db.prepare(
      `INSERT INTO stock_movements (product_id, warehouse_id, qty_milli_delta, reason, ref_type, ref_id, user_id) VALUES (?, ?, ?, 'sale', 'sale', ?, ?)`,
    );
    const upsertLevel = db.prepare(
      `INSERT INTO stock_levels (product_id, warehouse_id, qty_milli) VALUES (?, ?, ?)
       ON CONFLICT (product_id, warehouse_id) DO UPDATE SET qty_milli = qty_milli + excluded.qty_milli`,
    );

    prepared.forEach((l, i) => {
      const priced = cart.lines[i]!;
      insertItem.run(
        saleId,
        l.p.id,
        l.p.name,
        toReceiptName({ name: l.p.name, receiptName: l.p.receipt_name }),
        l.p.barcode,
        l.p.brand_name ?? '',
        l.p.unit_name ?? '',
        l.qtyMilli,
        priced.unitPriceLbp,
        l.unitCostLbp,
        priced.lineTotalLbp,
      );
      // Stock is informational (R2): it may go to zero or below, and it never blocks the sale.
      insertMovement.run(l.p.id, warehouseId, -l.qtyMilli, saleId, actor.id);
      upsertLevel.run(l.p.id, warehouseId, -l.qtyMilli);
    });

    const insertPayment = db.prepare('INSERT INTO payments (sale_id, method, currency, amount, rate_snap) VALUES (?, ?, ?, ?, ?)');
    for (const p of tender.byMethod) {
      insertPayment.run(saleId, p.method, p.currency, p.amount, rate);
      bumpExpected(db, session.id, p, p.amount);
    }
    // Change is handed back in cash LBP.
    bumpExpected(db, session.id, { method: 'cash', currency: 'LBP' }, -tender.changeLbp);

    if (tender.restLbp > 0) db.prepare('UPDATE customers SET balance_lbp = balance_lbp + ? WHERE id = ?').run(tender.restLbp, customer.id);

    for (const o of overrides) {
      db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?)').run(
        actor.id,
        'sale.price.override',
        'sale',
        String(saleId),
        JSON.stringify({ productId: o.productId, unitPriceLbp: o.catalogUnitPriceLbp }),
        JSON.stringify({ unitPriceLbp: o.usedUnitPriceLbp, ...(o.approvedBy !== undefined && { approvedBy: o.approvedBy }) }),
      );
    }

    if (discountApproval) {
      db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?)').run(
        actor.id,
        'sale.discount.override',
        'sale',
        String(saleId),
        JSON.stringify({ limitPct: settings.cashierDiscountLimitPct }),
        JSON.stringify({
          discountLbp: cart.discountLbp,
          pct: Math.round(discountApproval.pct * 100) / 100,
          approvedBy: discountApproval.approvedBy,
        }),
      );
    }

    // Items now at or below their own low-stock threshold, so the till can show a notice.
    const ids = [...new Set(prepared.map((l) => l.p.id))];
    const low = db
      .prepare(
        `SELECT p.id, p.name, p.stock_alert_milli AS threshold_milli, COALESCE(SUM(l.qty_milli), 0) AS total_milli
         FROM products p LEFT JOIN stock_levels l ON l.product_id = p.id
         WHERE p.id IN (${ids.map(() => '?').join(',')}) AND p.stock_alert_milli IS NOT NULL
         GROUP BY p.id HAVING total_milli <= p.stock_alert_milli ORDER BY p.id`,
      )
      .all(...ids) as { id: number; name: string; threshold_milli: number; total_milli: number }[];

    const response = {
      ...saleJson(db, getSale(db, saleId)!),
      lowStock: low.map((r) => ({ productId: r.id, name: r.name, qty: milliToQty(r.total_milli), threshold: r.threshold_milli / 1000 })),
    };
    rememberResponse(db, SALE_SCOPE, idem.key, idem.hash, 201, response);
    return { statusCode: 201, body: response, replay: false };
  });
}
