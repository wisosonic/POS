import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, inWriteTransaction, type Db } from '../../apps/api/src/db/open';
import { migrate } from '../../apps/api/src/db/migrate';
import { seedReference } from '../../apps/api/src/db/seed';
import { seedTestData, type Seed } from '../../apps/api/src/db/seed-test';
import { nextRef } from '../../apps/api/src/db/counters';

let dir: string;
let file: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pos-db-'));
  file = join(dir, 'pos.db');
  migrate(file);
  db = openDatabase(file);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const one = <T = Record<string, unknown>>(sql: string, ...params: unknown[]) => db.prepare(sql).get(...params) as T | undefined;
const all = <T = Record<string, unknown>>(sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as T[];

/** Insert a minimal open session + sale scaffolding and return ids. */
function scaffold() {
  seedReference(db);
  const user = Number(
    db.prepare(`INSERT INTO users (username, name, role, password_hash) VALUES ('u', 'U', 'cashier', 'x')`).run().lastInsertRowid,
  );
  const session = Number(db.prepare(`INSERT INTO register_sessions (terminal_id, opened_by) VALUES ('T1', ?)`).run(user).lastInsertRowid);
  const insertSale = (over: Record<string, unknown> = {}) => {
    const row = {
      ref: nextRef(db, 'sale_ref'),
      session_id: session,
      user_id: user,
      customer_id: 1,
      warehouse_id: 1,
      rate: 90000,
      subtotal: 75000,
      total: 75000,
      paid: 75000,
      rest: 0,
      status: 'paid',
      ...over,
    };
    return Number(
      db
        .prepare(
          `INSERT INTO sales (ref, session_id, user_id, customer_id, warehouse_id, rate_lbp_per_usd, subtotal_lbp, total_lbp, paid_lbp, rest_lbp, status)
           VALUES (@ref, @session_id, @user_id, @customer_id, @warehouse_id, @rate, @subtotal, @total, @paid, @rest, @status)`,
        )
        .run(row).lastInsertRowid,
    );
  };
  return { user, session, insertSale };
}

describe('migrations', () => {
  it('create every table the design needs', () => {
    const tables = all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).map(
      (t) => t.name,
    );
    for (const t of [
      'store_settings',
      'payment_methods',
      'users',
      'exchange_rates',
      'products',
      'stock_levels',
      'stock_movements',
      'customers',
      'register_sessions',
      'register_balances',
      'register_movements',
      'sales',
      'sale_items',
      'payments',
      'customer_payments',
      'payment_allocations',
      'returns',
      'return_items',
      'holds',
      'hold_items',
      'purchases',
      'purchase_items',
      'expenses',
      'service_sales',
      'audit_log',
      'idempotency_keys',
      'refresh_tokens',
      'login_attempts',
      'counters',
      'schema_migrations',
    ]) {
      expect(tables, t).toContain(t);
    }
  });

  it('are idempotent: running again applies nothing', () => {
    expect(migrate(file)).toEqual([]);
  });

  it('record what was applied', () => {
    // Every numbered file in the migrations folder, in order: a new migration needs no edit here.
    const onDisk = readdirSync(join(__dirname, '../../apps/api/src/db/migrations'))
      .filter((f) => /^\d{4}_.+\.sql$/.test(f))
      .sort();
    expect(onDisk.length).toBeGreaterThanOrEqual(4);
    expect(all<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name').map((m) => m.name)).toEqual(onDisk);
  });

  it('roll back completely if a migration fails (nothing half-applied)', () => {
    const bad = openDatabase(join(dir, 'bad.db'));
    expect(() =>
      bad
        .transaction(() => {
          bad.exec('CREATE TABLE t (a); CREATE TABLE t (a);');
        })
        .immediate(),
    ).toThrow();
    expect(bad.prepare(`SELECT 1 FROM sqlite_master WHERE name = 't'`).get()).toBeUndefined();
    bad.close();
  });
});

describe('connection settings', () => {
  it('uses WAL, full sync and enforces foreign keys', () => {
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('synchronous', { simple: true })).toBe(2); // FULL
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('rejects rows that point at nothing', () => {
    expect(() =>
      db
        .prepare(`INSERT INTO sale_items (sale_id, name_snap, qty_milli, unit_price_lbp, line_total_lbp) VALUES (999, 'x', 1000, 1, 1)`)
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it('a write transaction is atomic: an error undoes everything in it', () => {
    seedReference(db);
    expect(() =>
      inWriteTransaction(db, () => {
        db.prepare(`INSERT INTO suppliers (name) VALUES ('a')`).run();
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(one('SELECT 1 FROM suppliers')).toBeUndefined();
  });
});

describe('reference data', () => {
  beforeEach(() => seedReference(db));

  it('seeds the three payment methods and nothing else', () => {
    expect(all<{ code: string }>('SELECT code FROM payment_methods ORDER BY sort').map((m) => m.code)).toEqual(['cash', 'whish', 'omt']);
    expect(() => db.prepare(`INSERT INTO payment_methods (code, name) VALUES ('paypal', 'PayPal')`).run()).toThrow(/CHECK/);
  });

  it('is idempotent', () => {
    seedReference(db);
    expect(one<{ n: number }>('SELECT count(*) n FROM payment_methods')?.n).toBe(3);
    expect(one<{ n: number }>('SELECT count(*) n FROM customers')?.n).toBe(1);
    expect(one<{ n: number }>('SELECT count(*) n FROM units')?.n).toBe(3);
  });

  it('creates Walk-In as customer 1, and it can never hold a balance', () => {
    expect(one<{ id: number; is_walk_in: number }>(`SELECT id, is_walk_in FROM customers WHERE name = 'Walk-In'`)).toEqual({
      id: 1,
      is_walk_in: 1,
    });
    expect(() => db.prepare('UPDATE customers SET balance_lbp = 1000 WHERE id = 1').run()).toThrow(/CHECK/);
  });

  it('allows only one Walk-In', () => {
    expect(() => db.prepare(`INSERT INTO customers (name, is_walk_in) VALUES ('Another', 1)`).run()).toThrow(/UNIQUE/);
  });

  it('a registered customer cannot have a negative balance', () => {
    expect(() => db.prepare(`INSERT INTO customers (name, balance_lbp) VALUES ('x', -1)`).run()).toThrow(/CHECK/);
  });

  it('starts the exchange rate at 90,000, the document counters at zero and the service numbers after the last one of the old app (5002)', () => {
    expect(one<{ r: number }>('SELECT rate_lbp_per_usd r FROM exchange_rates')?.r).toBe(90000);
    expect(all('SELECT name, value FROM counters ORDER BY name')).toEqual([
      { name: 'purchase_ref', value: 0 },
      { name: 'return_ref', value: 0 },
      { name: 'sale_ref', value: 0 },
      { name: 'service_ref', value: 5002 },
    ]);
  });

  it('numbers are sequential and a rolled-back document gives its number back', () => {
    expect(nextRef(db, 'sale_ref')).toBe(1);
    expect(nextRef(db, 'sale_ref')).toBe(2);
    expect(() =>
      inWriteTransaction(db, () => {
        nextRef(db, 'sale_ref');
        throw new Error('rollback');
      }),
    ).toThrow();
    expect(nextRef(db, 'sale_ref')).toBe(3);
  });

  it('refuses an unknown counter', () => {
    expect(() => nextRef(db, 'nope' as never)).toThrow(/Unknown counter/);
  });
});

describe('check constraints', () => {
  beforeEach(() => seedReference(db));
  const product = (over: string) =>
    db.prepare(`INSERT INTO products (name, ${over.split('=')[0]}) VALUES ('p', ${over.split('=')[1]})`).run();

  it('rejects an unknown product currency', () => {
    expect(() => product(`currency='EUR'`)).toThrow(/CHECK/);
  });

  it('rejects negative prices', () => {
    expect(() => product('price_minor=-1')).toThrow(/CHECK/);
  });

  it('low-stock threshold may be NULL or >= 0 but never negative (R2)', () => {
    expect(() => db.prepare(`INSERT INTO products (name, stock_alert_milli) VALUES ('a', NULL)`).run()).not.toThrow();
    expect(() => db.prepare(`INSERT INTO products (name, stock_alert_milli) VALUES ('b', 0)`).run()).not.toThrow();
    expect(() => product('stock_alert_milli=-1')).toThrow(/CHECK/);
  });

  it('barcodes are NOT unique yet (legacy duplicates are imported as-is, decision Q7)', () => {
    db.prepare(`INSERT INTO products (name, barcode) VALUES ('a', '123')`).run();
    expect(() => db.prepare(`INSERT INTO products (name, barcode) VALUES ('b', '123')`).run()).not.toThrow();
    const unique = all<{ unique: number; name: string }>(`PRAGMA index_list('products')`).filter((i) => i.unique === 1);
    for (const idx of unique) {
      const cols = all<{ name: string }>(`PRAGMA index_info('${idx.name}')`).map((c) => c.name);
      expect(cols).not.toContain('barcode');
    }
  });

  it('stock may go negative: there is no stock CHECK (R2)', () => {
    const id = Number(db.prepare(`INSERT INTO products (name) VALUES ('p')`).run().lastInsertRowid);
    expect(() => db.prepare('INSERT INTO stock_levels (product_id, warehouse_id, qty_milli) VALUES (?, 1, -3000)').run(id)).not.toThrow();
  });

  it('sale line quantity must be positive', () => {
    const { insertSale } = scaffold2();
    const sale = insertSale();
    expect(() =>
      db
        .prepare(`INSERT INTO sale_items (sale_id, name_snap, qty_milli, unit_price_lbp, line_total_lbp) VALUES (?, 'x', 0, 1, 1)`)
        .run(sale),
    ).toThrow(/CHECK/);
  });

  it('a sale must satisfy paid + rest = total', () => {
    const { insertSale } = scaffold2();
    expect(() => insertSale({ paid: 1000, rest: 1000 })).toThrow(/CHECK/);
    expect(() => insertSale({ paid: 0, rest: 75000, status: 'unpaid' })).not.toThrow();
  });

  it('payments belong to exactly one of a sale or a customer payment', () => {
    const { insertSale } = scaffold2();
    const sale = insertSale();
    const ins = (s: number | null, cp: number | null) =>
      db
        .prepare(
          `INSERT INTO payments (sale_id, customer_payment_id, method, currency, amount, rate_snap) VALUES (?, ?, 'cash', 'LBP', 1000, 90000)`,
        )
        .run(s, cp);
    expect(() => ins(null, null)).toThrow(/CHECK/);
    expect(() => ins(sale, null)).not.toThrow();
  });

  it('a register movement needs a reason and matching source/destination for its type', () => {
    const { session, user } = scaffold2();
    const mv = (type: string, reason: string, from: string | null, to: string | null) =>
      db
        .prepare(
          `INSERT INTO register_movements (session_id, type, from_method, from_currency, to_method, to_currency, amount, reason, user_id)
                  VALUES (?, ?, ?, ?, ?, ?, 100, ?, ?)`,
        )
        .run(session, type, from, from && 'LBP', to, to && 'LBP', reason, user);
    expect(() => mv('transfer', 'OMT float', 'cash', 'omt')).not.toThrow();
    expect(() => mv('transfer', '  ', 'cash', 'omt')).toThrow(/CHECK/);
    expect(() => mv('transfer', 'x', 'cash', null)).toThrow(/CHECK/);
    expect(() => mv('out', 'x', null, null)).toThrow(/CHECK/);
  });

  function scaffold2() {
    return scaffold();
  }
});

describe('register sessions', () => {
  it('allows only one open session per terminal, whoever opens it', () => {
    const { user } = scaffold();
    expect(() => db.prepare(`INSERT INTO register_sessions (terminal_id, opened_by) VALUES ('T1', ?)`).run(user)).toThrow(/UNIQUE/);
    expect(() => db.prepare(`INSERT INTO register_sessions (terminal_id, opened_by) VALUES ('T2', ?)`).run(user)).not.toThrow();
  });

  it('after closing, the terminal can open a new session', () => {
    const { user, session } = scaffold();
    db.prepare(`UPDATE register_sessions SET status = 'closed', closed_at = '2026-10-19T20:00:00Z', closed_by = ? WHERE id = ?`).run(
      user,
      session,
    );
    expect(() => db.prepare(`INSERT INTO register_sessions (terminal_id, opened_by) VALUES ('T1', ?)`).run(user)).not.toThrow();
  });

  it('closed_at is set exactly when the session is closed', () => {
    const { session } = scaffold();
    expect(() => db.prepare(`UPDATE register_sessions SET status = 'closed' WHERE id = ?`).run(session)).toThrow(/CHECK/);
  });

  it('has one balance row per method × currency', () => {
    const { session } = scaffold();
    const ins = db.prepare(`INSERT INTO register_balances (session_id, method, currency, opening, expected) VALUES (?, ?, ?, 0, 0)`);
    for (const m of ['cash', 'whish', 'omt']) for (const c of ['USD', 'LBP']) ins.run(session, m, c);
    expect(() => ins.run(session, 'cash', 'USD')).toThrow(/UNIQUE|PRIMARY/);
    expect(one<{ n: number }>('SELECT count(*) n FROM register_balances WHERE session_id = ?', session)?.n).toBe(6);
  });

  it('a sale cannot be recorded against a closed session', () => {
    const { user, session, insertSale } = scaffold();
    db.prepare(`UPDATE register_sessions SET status = 'closed', closed_at = '2026-10-19T20:00:00Z', closed_by = ? WHERE id = ?`).run(
      user,
      session,
    );
    expect(() => insertSale()).toThrow(/REGISTER_CLOSED/);
  });

  it('a closed session and its balances are immutable (Z-report)', () => {
    const { user, session } = scaffold();
    db.prepare(`INSERT INTO register_balances (session_id, method, currency, opening, expected) VALUES (?, 'cash', 'LBP', 1000, 1000)`).run(
      session,
    );
    db.prepare(`UPDATE register_balances SET counted = 1000, variance = 0 WHERE session_id = ?`).run(session); // allowed while open
    db.prepare(`UPDATE register_sessions SET status = 'closed', closed_at = '2026-10-19T20:00:00Z', closed_by = ? WHERE id = ?`).run(
      user,
      session,
    );
    expect(() => db.prepare(`UPDATE register_balances SET counted = 5 WHERE session_id = ?`).run(session)).toThrow(
      /closed register session/,
    );
    expect(() => db.prepare(`UPDATE register_sessions SET closed_at = '2027-01-01T00:00:00Z' WHERE id = ?`).run(session)).toThrow(
      /closed register session/,
    );
  });
});

describe('append-only history (CLAUDE.md rule 4)', () => {
  it.each([
    ['audit_log', `INSERT INTO audit_log (action, entity) VALUES ('x', 'y')`, 'action'],
    [
      'stock_movements',
      `INSERT INTO stock_movements (product_id, warehouse_id, qty_milli_delta, reason) VALUES (1, 1, 1000, 'adjustment')`,
      'note',
    ],
  ])('%s cannot be updated or deleted', (table, insert, column) => {
    seedReference(db);
    db.prepare(`INSERT INTO products (name) VALUES ('p')`).run();
    db.exec(insert);
    expect(() => db.exec(`UPDATE ${table} SET ${column} = 'changed'`)).toThrow(/append-only/);
    expect(() => db.exec(`DELETE FROM ${table}`)).toThrow(/append-only/);
  });

  it('payments, sale items and returns cannot be changed or removed', () => {
    const { insertSale } = scaffold();
    const sale = insertSale();
    db.prepare(`INSERT INTO payments (sale_id, method, currency, amount, rate_snap) VALUES (?, 'cash', 'LBP', 75000, 90000)`).run(sale);
    db.prepare(
      `INSERT INTO sale_items (sale_id, name_snap, qty_milli, unit_price_lbp, line_total_lbp) VALUES (?, 'x', 1000, 75000, 75000)`,
    ).run(sale);
    for (const [table, col] of [
      ['payments', 'amount'],
      ['sale_items', 'qty_milli'],
    ]) {
      expect(() => db.exec(`UPDATE ${table} SET ${col} = ${col} + 1`)).toThrow(/append-only/);
      expect(() => db.exec(`DELETE FROM ${table}`)).toThrow(/append-only/);
    }
  });

  it('a sale total can never change, and a sale can never be deleted', () => {
    const { insertSale } = scaffold();
    const sale = insertSale();
    expect(() => db.prepare('UPDATE sales SET total_lbp = 1, paid_lbp = 1 WHERE id = ?').run(sale)).toThrow(/immutable/);
    expect(() => db.prepare('UPDATE sales SET rate_lbp_per_usd = 1 WHERE id = ?').run(sale)).toThrow(/immutable/);
    expect(() => db.prepare('UPDATE sales SET profit_lbp = 1 WHERE id = ?').run(sale)).toThrow(/immutable/);
    expect(() => db.prepare('DELETE FROM sales WHERE id = ?').run(sale)).toThrow(/append-only/);
  });

  it('but how much of a credit sale has been paid can change (customer pays later)', () => {
    const { insertSale } = scaffold();
    const sale = insertSale({ paid: 0, rest: 75000, status: 'unpaid', customer_id: 1 });
    expect(() =>
      db.prepare(`UPDATE sales SET paid_lbp = 25000, rest_lbp = 50000, status = 'partial' WHERE id = ?`).run(sale),
    ).not.toThrow();
    expect(one<{ status: string }>('SELECT status FROM sales WHERE id = ?', sale)?.status).toBe('partial');
  });
});

describe('product search (full text)', () => {
  beforeEach(() => {
    seedReference(db);
    const ins = db.prepare('INSERT INTO products (name, receipt_name, barcode) VALUES (?, ?, ?)');
    ins.run('Cedars silver towel', 'Cedars silver towel', '5287000107945');
    ins.run('Crispy chocolate', 'Crispy chocolate', '9342390005250');
    ins.run('خبز كبير', 'khbz kbyr', '5287001240016');
  });
  const search = (q: string) =>
    all<{ name: string }>(
      `SELECT p.name FROM products_fts f JOIN products p ON p.id = f.rowid WHERE products_fts MATCH ? ORDER BY p.id`,
      `"${q}"`,
    ).map((r) => r.name);

  it('finds products by a part of a Latin name', () => {
    expect(search('ilver tow')).toEqual(['Cedars silver towel']);
  });

  it('finds Arabic names by a part of the name', () => {
    expect(search('خبز')).toEqual(['خبز كبير']);
  });

  it('finds by the transliterated receipt name', () => {
    expect(search('khbz')).toEqual(['خبز كبير']);
  });

  it('finds by part of a barcode', () => {
    expect(search('9342390')).toEqual(['Crispy chocolate']);
  });

  it('stays in sync when a product is renamed or deleted', () => {
    db.prepare(`UPDATE products SET name = 'Master chips', receipt_name = 'Master chips' WHERE name = 'Crispy chocolate'`).run();
    expect(search('Crispy')).toEqual([]);
    expect(search('Master')).toEqual(['Master chips']);
    db.prepare(`DELETE FROM products WHERE name = 'Master chips'`).run();
    expect(search('Master')).toEqual([]);
  });
});

describe('test seed (contract in tests/helpers/app.ts)', () => {
  let seed: Seed;
  beforeEach(async () => {
    seed = await seedTestData(db);
  });

  it('creates one user per role with working argon2id hashes', async () => {
    const { verifyPassword } = await import('../../apps/api/src/auth/password');
    for (const role of ['cashier', 'manager', 'admin'] as const) {
      const row = one<{ password_hash: string; role: string }>('SELECT password_hash, role FROM users WHERE username = ?', role)!;
      expect(row.role).toBe(role);
      expect(row.password_hash).toMatch(/^\$argon2id\$/);
      expect(await verifyPassword(row.password_hash, seed.users[role].password)).toBe(true);
      expect(await verifyPassword(row.password_hash, 'wrong')).toBe(false);
    }
  });

  it('seeds Walk-In (1) and a registered customer with no balance', () => {
    expect(seed.customers.walkIn.id).toBe(1);
    expect(one<{ balance_lbp: number }>('SELECT balance_lbp FROM customers WHERE id = ?', seed.customers.registered.id)?.balance_lbp).toBe(
      0,
    );
  });

  it('seeds the five products with the documented prices, currencies and stock', () => {
    const p = (id: number) =>
      one<{ price_minor: number; currency: string; barcode: string; qty_milli: number }>(
        'SELECT p.price_minor, p.currency, p.barcode, l.qty_milli FROM products p JOIN stock_levels l ON l.product_id = p.id WHERE p.id = ?',
        id,
      )!;
    expect(p(seed.products.towel.id)).toMatchObject({ price_minor: 75000, currency: 'LBP', barcode: '5287000107945', qty_milli: 10_000 });
    expect(p(seed.products.choc.id)).toMatchObject({ price_minor: 50000, qty_milli: 100_000 });
    expect(p(seed.products.usd.id)).toMatchObject({ price_minor: 250, currency: 'USD', qty_milli: 10_000 });
    expect(p(seed.products.rare.id)).toMatchObject({ qty_milli: 1_000 });
    expect(p(seed.products.kg.id)).toMatchObject({ price_minor: 400000, qty_milli: 5_000 });
    expect(seed.products.towel.costLbp).toBe(67000);
  });

  it('the stock ledger equals the stock cache for every seeded product', () => {
    const rows = all<{ id: number; cache: number; ledger: number }>(
      `SELECT l.product_id id, l.qty_milli cache, (SELECT sum(qty_milli_delta) FROM stock_movements m WHERE m.product_id = l.product_id) ledger FROM stock_levels l`,
    );
    expect(rows.length).toBe(5);
    for (const r of rows) expect(r.ledger).toBe(r.cache);
  });

  it('gives every product a receipt name and only the KG product a fractional unit', () => {
    expect(one<{ n: number }>(`SELECT count(*) n FROM products WHERE receipt_name IS NULL OR receipt_name = ''`)?.n).toBe(0);
    expect(one<{ fractional: number }>('SELECT fractional FROM units WHERE id = ?', seed.units.kg.id)?.fractional).toBe(1);
    expect(one<{ fractional: number }>('SELECT fractional FROM units WHERE id = ?', seed.units.piece.id)?.fractional).toBe(0);
  });

  it('no seeded product has a low-stock threshold, so none alert by default', () => {
    expect(one<{ n: number }>('SELECT count(*) n FROM products WHERE stock_alert_milli IS NOT NULL')?.n).toBe(0);
  });
});
