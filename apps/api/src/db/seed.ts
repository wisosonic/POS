import { openDatabase, type Db } from './open';

export const WALK_IN_ID = 1;
export const DEFAULT_RATE_LBP_PER_USD = 90000;

/**
 * Reference data every installation needs: store settings, payment methods, the protected Walk-In customer
 * (id 1), a warehouse, units, the exchange rate and the number counters. Idempotent.
 * Legacy receipt numbers go up to ~25,000, so the ETL raises `sale_ref` above the highest imported reference.
 */
export function seedReference(target: string | Db, store: { name?: string; address?: string; phone?: string } = {}): void {
  const owned = typeof target === 'string';
  const db = owned ? openDatabase(target) : target;
  try {
    db.transaction(() => {
      db.prepare(`INSERT OR IGNORE INTO store_settings (id, name, address, phone) VALUES (1, ?, ?, ?)`).run(
        store.name ?? 'Darwish Market',
        store.address ?? 'lebanon , Beirut',
        store.phone ?? '71479893',
      );

      const method = db.prepare('INSERT OR IGNORE INTO payment_methods (code, name, sort) VALUES (?, ?, ?)');
      method.run('cash', 'Cash', 1);
      method.run('whish', 'Whish Money', 2);
      method.run('omt', 'OMT', 3);

      db.prepare(`INSERT OR IGNORE INTO customers (id, name, is_walk_in) VALUES (?, 'Walk-In', 1)`).run(WALK_IN_ID);

      if (!db.prepare('SELECT 1 FROM warehouses LIMIT 1').get()) db.prepare(`INSERT INTO warehouses (name) VALUES ('Main Stock')`).run();

      if (!db.prepare('SELECT 1 FROM units LIMIT 1').get()) {
        const unit = db.prepare('INSERT INTO units (name, fractional) VALUES (?, ?)');
        unit.run('Piece', 0);
        unit.run('KG', 1);
        unit.run('Box', 0);
      }

      if (!db.prepare('SELECT 1 FROM exchange_rates LIMIT 1').get()) {
        db.prepare(`INSERT INTO exchange_rates (rate_lbp_per_usd, effective_from) VALUES (?, '2000-01-01T00:00:00.000Z')`).run(
          DEFAULT_RATE_LBP_PER_USD,
        );
      }

      const counter = db.prepare('INSERT OR IGNORE INTO counters (name, value) VALUES (?, ?)');
      counter.run('sale_ref', 0);
      counter.run('return_ref', 0);
      counter.run('purchase_ref', 0);
    }).immediate();
  } finally {
    if (owned) db.close();
  }
}
