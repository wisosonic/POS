import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Db } from '../../apps/api/src/db/open';
import { migrate } from '../../apps/api/src/db/migrate';
import { seedReference } from '../../apps/api/src/db/seed';

const MIGRATIONS = join(__dirname, '../../apps/api/src/db/migrations');

let dir: string;
let file: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pos-purch-'));
  file = join(dir, 'pos.db');
  migrate(file);
  db = openDatabase(file);
  seedReference(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('migration 0002 upgrades an existing database', () => {
  it('a database that only has 0001 gets exactly the migrations it is missing, and keeps its data', () => {
    const old = join(dir, 'old.db');
    const raw = openDatabase(old);
    raw.exec(readFileSync(join(MIGRATIONS, '0001_init.sql'), 'utf8'));
    raw.exec(
      `CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`,
    );
    raw.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run('0001_init.sql');
    raw.prepare(`INSERT INTO suppliers (name) VALUES ('Existing supplier')`).run();
    raw.close();

    // A database that only has 0001 gets every later migration, in order, and nothing else.
    const later = readdirSync(MIGRATIONS)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f) && f !== '0001_init.sql')
      .sort();
    expect(later[0]).toBe('0002_purchase_payments.sql');
    expect(migrate(old)).toEqual(later);
    expect(migrate(old)).toEqual([]); // and nothing the second time

    const after = openDatabase(old);
    expect((after.prepare('SELECT name FROM suppliers').get() as { name: string }).name).toBe('Existing supplier');
    expect((after.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE name = 'purchase_payments'`).get() as { n: number }).n).toBe(1);
    after.close();
  });
});

const supplier = () => Number(db.prepare(`INSERT INTO suppliers (name) VALUES ('S')`).run().lastInsertRowid);
const product = () => Number(db.prepare(`INSERT INTO products (name) VALUES ('P')`).run().lastInsertRowid);
function purchase(status: 'draft' | 'ordered' | 'received' = 'ordered', total = 100_000) {
  const ref = (db.prepare(`UPDATE counters SET value = value + 1 WHERE name = 'purchase_ref' RETURNING value`).get() as { value: number })
    .value;
  const id = Number(
    db
      .prepare(`INSERT INTO purchases (ref, supplier_id, warehouse_id, status, currency, total_minor) VALUES (?, ?, 1, ?, 'LBP', ?)`)
      .run(ref, supplier(), status, total).lastInsertRowid,
  );
  const item = Number(
    db
      .prepare(`INSERT INTO purchase_items (purchase_id, product_id, name_snap, qty_milli, cost_minor) VALUES (?, ?, 'P', 10000, 10000)`)
      .run(id, product()).lastInsertRowid,
  );
  return { id, item };
}

describe('supplier payments', () => {
  it('are append-only', () => {
    const { id } = purchase();
    db.prepare('INSERT INTO purchase_payments (purchase_id, amount_minor) VALUES (?, 5000)').run(id);
    expect(() => db.exec('UPDATE purchase_payments SET amount_minor = 1')).toThrow(/append-only/);
    expect(() => db.exec('DELETE FROM purchase_payments')).toThrow(/append-only/);
  });

  it('must be positive', () => {
    const { id } = purchase();
    expect(() => db.prepare('INSERT INTO purchase_payments (purchase_id, amount_minor) VALUES (?, 0)').run(id)).toThrow(/CHECK/);
  });

  it('a purchase cannot be paid beyond its total', () => {
    const { id } = purchase('ordered', 100_000);
    expect(() => db.prepare('UPDATE purchases SET paid_minor = 100001 WHERE id = ?').run(id)).toThrow(/beyond its total/);
    expect(() => db.prepare('UPDATE purchases SET paid_minor = 100000 WHERE id = ?').run(id)).not.toThrow();
  });
});

describe('purchases keep their shape once goods arrive', () => {
  it('a received purchase cannot change supplier, currency, warehouse or total', () => {
    const { id } = purchase('received');
    for (const sql of ['supplier_id = NULL', `currency = 'USD'`, 'total_minor = 1', 'warehouse_id = 1']) {
      expect(() => db.exec(`UPDATE purchases SET ${sql} WHERE id = ${id}`), sql).toThrow(/received purchase cannot be changed/);
    }
  });

  it('but how much of it has been paid can still change after receipt', () => {
    const { id } = purchase('received', 100_000);
    expect(() => db.prepare('UPDATE purchases SET paid_minor = 40000 WHERE id = ?').run(id)).not.toThrow();
  });

  it('an ordered purchase can still be edited', () => {
    const { id } = purchase('ordered');
    expect(() => db.prepare('UPDATE purchases SET total_minor = 5 WHERE id = ?').run(id)).not.toThrow();
  });

  it('only a draft can be deleted', () => {
    const draft = purchase('draft');
    const ordered = purchase('ordered');
    expect(() => db.prepare('DELETE FROM purchases WHERE id = ?').run(ordered.id)).toThrow(/only a draft/);
    db.prepare('DELETE FROM purchase_items WHERE purchase_id = ?').run(draft.id);
    expect(() => db.prepare('DELETE FROM purchases WHERE id = ?').run(draft.id)).not.toThrow();
  });

  it('a line that has been received keeps its product, quantity and cost', () => {
    const { item } = purchase();
    db.prepare('UPDATE purchase_items SET received_milli = 4000 WHERE id = ?').run(item);
    for (const sql of ['qty_milli = 99000', 'cost_minor = 1', 'product_id = NULL']) {
      expect(() => db.exec(`UPDATE purchase_items SET ${sql} WHERE id = ${item}`), sql).toThrow(/received cannot be changed/);
    }
  });

  it('a line with nothing received yet can still be edited', () => {
    const { item } = purchase();
    expect(() => db.prepare('UPDATE purchase_items SET qty_milli = 20000 WHERE id = ?').run(item)).not.toThrow();
  });

  it('cannot receive more than was ordered', () => {
    const { item } = purchase();
    expect(() => db.prepare('UPDATE purchase_items SET received_milli = 10001 WHERE id = ?').run(item)).toThrow(/more than was ordered/);
    expect(() => db.prepare('UPDATE purchase_items SET received_milli = 10000 WHERE id = ?').run(item)).not.toThrow();
  });
});
