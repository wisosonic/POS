import type { Queryable } from '../../db/adapter';
import type { Db } from '../../db/open';

/** `currentRate` for code that uses the database adapter. Same rule, same answer. */
export async function currentRateQ(q: Queryable, at: Date = new Date()): Promise<number> {
  const row = await q.one<{ rate: number }>(
    'SELECT rate_lbp_per_usd AS rate FROM exchange_rates WHERE effective_from <= ? ORDER BY effective_from DESC, id DESC LIMIT 1',
    [at.toISOString()],
  );
  if (!row) throw new Error('No exchange rate is configured. Was the reference data seeded?');
  return row.rate;
}

/** The LBP-per-USD rate in force right now. Each sale snapshots it; changing the rate never touches old sales. */
export function currentRate(db: Db, at: Date = new Date()): number {
  const row = db
    .prepare('SELECT rate_lbp_per_usd AS rate FROM exchange_rates WHERE effective_from <= ? ORDER BY effective_from DESC, id DESC LIMIT 1')
    .get(at.toISOString()) as { rate: number } | undefined;
  if (!row) throw new Error('No exchange rate is configured. Was the reference data seeded?');
  return row.rate;
}

export type ShopSettings = { lbpRounding: number; cashierDiscountLimitPct: number };

export async function shopSettingsQ(q: Queryable): Promise<ShopSettings> {
  const row = await q.one<{ lbp_rounding: number; cashier_discount_limit_pct: number }>(
    'SELECT lbp_rounding, cashier_discount_limit_pct FROM store_settings WHERE id = 1',
  );
  return { lbpRounding: row!.lbp_rounding, cashierDiscountLimitPct: row!.cashier_discount_limit_pct };
}

export async function defaultWarehouseIdQ(q: Queryable): Promise<number> {
  const row = await q.one<{ id: number }>('SELECT id FROM warehouses ORDER BY id LIMIT 1');
  if (!row) throw new Error('No warehouse exists. Was the reference data seeded?');
  return row.id;
}

export async function walkInCustomerIdQ(q: Queryable): Promise<number> {
  return (await q.one<{ id: number }>('SELECT id FROM customers WHERE is_walk_in = 1'))!.id;
}
