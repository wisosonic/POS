import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from '../../src/db/adapter';
import { createSqliteDatabase } from '../../src/db/drivers/sqlite';
import { migrate } from '../../src/db/migrate';
import { openDatabase, type Db } from '../../src/db/open';
import { seedTestData, type Seed } from '../../src/db/seed-test';
import { createSale } from '../../src/modules/sales/service';
import { clearLink, saveLink, syncProgress } from '../../src/modules/sync/service';

// Change capture (migration 0018, docs/12-sync-and-hq.md §3): the database itself writes "this row changed" to the outbox, in the same
// statement, but ONLY while the branch is connected to HQ.
let dir: string;
let raw: Db;
let db: Database;
let seed: Seed;

type Out = { seq: number; tbl: string; pk: number; op: string };
const outbox = () => raw.prepare('SELECT seq, tbl, pk, op FROM sync_outbox ORDER BY seq').all() as Out[];
const control = () => raw.prepare('SELECT capture FROM sync_control WHERE id = 1').get() as { capture: number };
const connect = () => saveLink(db, seed.users.admin.id, 'http://hq.test', 'a-token', { id: 1, code: 'B2', name: 'Hamra', kind: 'sale' });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pos-capture-'));
  const file = join(dir, 'pos.db');
  migrate(file);
  seed = await seedTestData(file);
  raw = openDatabase(file);
  db = createSqliteDatabase(raw);
});
afterEach(() => {
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

const addSale = (ref: number) =>
  Number(
    raw
      .prepare(
        `INSERT INTO sales (ref, customer_id, warehouse_id, rate_lbp_per_usd, subtotal_lbp, total_lbp, paid_lbp, status, created_at)
         VALUES (?, 1, 1, 90000, 1000, 1000, 1000, 'paid', '2026-11-23T10:00:00.000Z')`,
      )
      .run(ref).lastInsertRowid,
  );
const addItem = (saleId: number) =>
  Number(
    raw
      .prepare(`INSERT INTO sale_items (sale_id, name_snap, qty_milli, unit_price_lbp, line_total_lbp) VALUES (?, 'x', 1000, 1000, 1000)`)
      .run(saleId).lastInsertRowid,
  );

describe('a shop that is not connected records nothing', () => {
  it('has capture off, and an empty outbox however many rows are written (an import, a day of sales)', () => {
    expect(control().capture).toBe(0);
    for (let i = 1; i <= 200; i++) addItem(addSale(i));
    expect(outbox()).toEqual([]);
  });
});

describe('a connected branch records every change', () => {
  beforeEach(async () => {
    await connect();
  });

  it('turns capture on when it connects', () => {
    expect(control().capture).toBe(1);
  });

  it('an insert is recorded as an update ("this is the row now")', () => {
    const sale = addSale(1);
    const item = addItem(sale);
    expect(outbox().map((o) => [o.tbl, o.pk, o.op])).toEqual([
      ['sales', sale, 'u'],
      ['sale_items', item, 'u'],
    ]);
  });

  it('a change is recorded, and a delete is recorded as a deletion (a tombstone)', () => {
    const sale = addSale(1);
    raw.prepare(`UPDATE sales SET status = 'void', rest_lbp = 0 WHERE id = ?`).run(sale);
    raw.prepare(`INSERT INTO sale_delete_unlock (sale_id) VALUES (?)`).run(sale); // what the permanent-delete routine does
    raw.prepare('DELETE FROM sales WHERE id = ?').run(sale);
    raw.prepare('DELETE FROM sale_delete_unlock WHERE sale_id = ?').run(sale);
    expect(outbox().map((o) => [o.tbl, o.pk, o.op])).toEqual([
      ['sales', sale, 'u'], // created
      ['sales', sale, 'u'], // voided
      ['sales', sale, 'd'], // deleted
    ]);
  });

  it('records payments and stock movements too, and numbers the lines in the order they happened', () => {
    const sale = addSale(1);
    raw.prepare(`INSERT INTO payments (sale_id, method, currency, amount, rate_snap) VALUES (?, 'cash', 'LBP', 1000, 90000)`).run(sale);
    raw
      .prepare(
        `INSERT INTO stock_movements (product_id, warehouse_id, qty_milli_delta, reason, ref_type, ref_id) VALUES (?, 1, -1000, 'sale', 'sale', ?)`,
      )
      .run(seed.products.towel.id, sale);
    const rows = outbox();
    expect(rows.map((o) => o.tbl)).toEqual(['sales', 'payments', 'stock_movements']);
    expect(rows.map((o) => o.seq)).toEqual([...rows.map((o) => o.seq)].sort((a, b) => a - b)); // oldest first
    expect(new Set(rows.map((o) => o.seq)).size).toBe(3);
  });

  it('is part of the same transaction: a sale that is rolled back leaves nothing in the outbox', async () => {
    await expect(
      db.tx(async (tx) => {
        await tx.run(
          `INSERT INTO sales (ref, customer_id, warehouse_id, rate_lbp_per_usd, subtotal_lbp, total_lbp, paid_lbp, status) VALUES (9, 1, 1, 90000, 1, 1, 1, 'paid')`,
        );
        throw new Error('the sale failed');
      }),
    ).rejects.toThrow('the sale failed');
    expect(outbox()).toEqual([]);
  });

  it('a real sale through the real sale code records the whole cluster: sale, lines, payment, stock', async () => {
    const sessionId = Number(
      raw.prepare(`INSERT INTO register_sessions (terminal_id, opened_by) VALUES ('T1', ?)`).run(seed.users.manager.id).lastInsertRowid,
    );
    for (const m of ['cash', 'whish', 'omt'])
      for (const c of ['USD', 'LBP'])
        raw
          .prepare('INSERT INTO register_balances (session_id, method, currency, opening, expected) VALUES (?, ?, ?, 0, 0)')
          .run(sessionId, m, c);
    raw.prepare('DELETE FROM sync_outbox').run();
    const res = await createSale(
      db,
      { id: seed.users.cashier.id, role: 'cashier' },
      { id: 1, code: 'T1', name: 'Till 1', branchId: 1, warehouseId: null, printMode: 'server' },
      {
        items: [{ productId: seed.products.towel.id, qty: '2', unitPriceLbp: 75000 }],
        payments: [{ method: 'cash', currency: 'LBP', amount: 150000 }],
      },
      { key: 'k1', hash: 'h1' },
    );
    expect(res.statusCode).toBe(201);
    const tables = outbox().map((o) => o.tbl);
    expect(tables.filter((t) => t === 'sales').length).toBeGreaterThanOrEqual(1);
    expect(tables).toEqual(expect.arrayContaining(['sales', 'sale_items', 'payments', 'stock_movements']));
  });
});

describe('connecting starts the snapshot and disconnecting stops everything', () => {
  it('connecting covers what already exists with a snapshot (up to the highest id) and leaves the outbox empty', async () => {
    for (let i = 1; i <= 7; i++) addItem(addSale(i));
    await connect();
    const p = await syncProgress(db);
    expect(p).toMatchObject({ capturing: true, pending: 0 });
    const byTable = Object.fromEntries(p.snapshot.tables.map((t) => [t.table, t]));
    expect(byTable.sales).toMatchObject({ total: 7, sent: 0, done: false });
    expect(byTable.sale_items).toMatchObject({ total: 7, sent: 0, done: false });
    expect(byTable.payments).toMatchObject({ total: 0 });
    expect(p.snapshot.done).toBe(false);
    expect(raw.prepare(`SELECT upto FROM sync_snapshot WHERE tbl = 'sales'`).get()).toEqual({ upto: 7 });
  });

  it('rows written after connecting are the triggers’ job, not the snapshot’s', async () => {
    addSale(1);
    await connect();
    addSale(2); // after: id 2 is above the snapshot's limit
    expect(raw.prepare(`SELECT upto FROM sync_snapshot WHERE tbl = 'sales'`).get()).toEqual({ upto: 1 });
    expect(outbox().map((o) => [o.tbl, o.pk])).toEqual([['sales', 2]]);
  });

  it('connecting again (or to another HQ) starts clean: the old outbox and snapshot are dropped', async () => {
    addSale(1);
    await connect();
    addSale(2);
    raw.prepare(`UPDATE sync_snapshot SET next_pk = 1, done = 1 WHERE tbl = 'sales'`).run();
    await connect();
    expect(outbox()).toEqual([]);
    expect(raw.prepare(`SELECT upto, next_pk, done FROM sync_snapshot WHERE tbl = 'sales'`).get()).toEqual({
      upto: 2,
      next_pk: 0,
      done: 0,
    });
  });

  it('disconnecting switches capture off and throws away everything waiting, so an unconnected shop never piles up', async () => {
    await connect();
    addItem(addSale(1));
    expect(outbox().length).toBeGreaterThan(0);
    await clearLink(db, seed.users.admin.id);
    expect(control().capture).toBe(0);
    expect(outbox()).toEqual([]);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM sync_snapshot').get()).toEqual({ n: 0 });
    addSale(2);
    expect(outbox()).toEqual([]); // nothing recorded any more
  });

  it('sequence numbers are never reused, even after the outbox is cleared', async () => {
    await connect();
    addSale(1);
    const first = outbox()[0]!.seq;
    raw.prepare('DELETE FROM sync_outbox').run();
    addSale(2);
    expect(outbox()[0]!.seq).toBeGreaterThan(first);
  });
});
