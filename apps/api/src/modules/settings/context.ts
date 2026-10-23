import type { Db } from '../../db/open';

/** The LBP-per-USD rate in force right now. Each sale snapshots it; changing the rate never touches old sales. */
export function currentRate(db: Db, at: Date = new Date()): number {
  const row = db
    .prepare('SELECT rate_lbp_per_usd AS rate FROM exchange_rates WHERE effective_from <= ? ORDER BY effective_from DESC, id DESC LIMIT 1')
    .get(at.toISOString()) as { rate: number } | undefined;
  if (!row) throw new Error('No exchange rate is configured. Was the reference data seeded?');
  return row.rate;
}

export type ShopSettings = { lbpRounding: number; cashierDiscountLimitPct: number };

export function shopSettings(db: Db): ShopSettings {
  const row = db.prepare('SELECT lbp_rounding, cashier_discount_limit_pct FROM store_settings WHERE id = 1').get() as {
    lbp_rounding: number;
    cashier_discount_limit_pct: number;
  };
  return { lbpRounding: row.lbp_rounding, cashierDiscountLimitPct: row.cashier_discount_limit_pct };
}

export function defaultWarehouseId(db: Db): number {
  const row = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get() as { id: number } | undefined;
  if (!row) throw new Error('No warehouse exists. Was the reference data seeded?');
  return row.id;
}

export function walkInCustomerId(db: Db): number {
  return (db.prepare('SELECT id FROM customers WHERE is_walk_in = 1').get() as { id: number }).id;
}
