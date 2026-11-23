import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteDatabase } from '../../apps/api/src/db/drivers/sqlite';
import type { Database } from '../../apps/api/src/db/adapter';
import { migrate } from '../../apps/api/src/db/migrate';
import { openDatabase, type Db } from '../../apps/api/src/db/open';
import { seedTestData, type Seed } from '../../apps/api/src/db/seed-test';
import { createReturn } from '../../apps/api/src/modules/returns/service';
import { createSale } from '../../apps/api/src/modules/sales/service';
import { resolveTerminal, warehouseOf, type Terminal } from '../../apps/api/src/modules/terminals/service';

// A terminal may sell from its own warehouse (docs/11-multi-branch.md §3.4). The sale and the return move THAT warehouse's stock.
let dir: string;
let raw: Db;
let db: Database;
let seed: Seed;
let t1: Terminal;
let t2: Terminal;

const level = (productId: number, warehouseId: number) =>
  (
    raw.prepare('SELECT qty_milli AS n FROM stock_levels WHERE product_id = ? AND warehouse_id = ?').get(productId, warehouseId) as
      { n: number } | undefined
  )?.n ?? 0;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pos-terminal-'));
  const file = join(dir, 'pos.db');
  migrate(file);
  seed = await seedTestData(file);
  raw = openDatabase(file);
  db = createSqliteDatabase(raw);

  raw.prepare(`INSERT INTO warehouses (name) VALUES ('Back store')`).run(); // id 2
  raw
    .prepare(
      `INSERT INTO terminals (branch_id, warehouse_id, code, name, created_at) VALUES (1, 2, 'T2', 'Till 2', '2026-11-23T00:00:00.000Z')`,
    )
    .run();
  for (const code of ['T1', 'T2']) {
    const id = Number(
      raw.prepare('INSERT INTO register_sessions (terminal_id, opened_by) VALUES (?, ?)').run(code, seed.users.manager.id).lastInsertRowid,
    );
    for (const method of ['cash', 'whish', 'omt'])
      for (const currency of ['USD', 'LBP'])
        raw
          .prepare('INSERT INTO register_balances (session_id, method, currency, opening, expected) VALUES (?, ?, ?, 0, 0)')
          .run(id, method, currency);
  }
  // Both tills are known, so a terminal is chosen by its code here (the HTTP layer does this with the device token).
  t1 = { id: 1, code: 'T1', name: 'Till 1', branchId: 1, warehouseId: null, printMode: 'server' };
  t2 = { id: 2, code: 'T2', name: 'Till 2', branchId: 1, warehouseId: 2, printMode: 'server' };
});
afterEach(() => {
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

const actor = () => ({ id: seed.users.cashier.id, role: 'cashier' as const });
const saleBody = () => ({
  items: [{ productId: seed.products.towel.id, qty: '2', unitPriceLbp: 75000 }],
  payments: [{ method: 'cash' as const, currency: 'LBP' as const, amount: 150000 }],
});

describe('a terminal sells from its own warehouse', () => {
  it('a terminal without a warehouse uses the shop’s first one; one with its own uses that', async () => {
    expect(await warehouseOf(db, t1)).toBe(1);
    expect(await warehouseOf(db, t2)).toBe(2);
  });

  it('a sale at the till with its own warehouse moves that warehouse, not the first one', async () => {
    const before1 = level(seed.products.towel.id, 1);
    const res = await createSale(db, actor(), t2, saleBody(), { key: 'k-t2', hash: 'h-t2' });
    expect(res.statusCode).toBe(201);
    expect(level(seed.products.towel.id, 1)).toBe(before1); // untouched
    expect(level(seed.products.towel.id, 2)).toBe(-2000); // 2 sold from the back store, which held none
    const sale = raw.prepare('SELECT warehouse_id AS w, session_id AS s FROM sales').get() as { w: number; s: number };
    expect(sale.w).toBe(2);
    expect(raw.prepare('SELECT terminal_id AS t FROM register_sessions WHERE id = ?').get(sale.s)).toEqual({ t: 'T2' });
  });

  it('the till without its own warehouse still sells from the first', async () => {
    const before = level(seed.products.towel.id, 1);
    await createSale(db, actor(), t1, saleBody(), { key: 'k-t1', hash: 'h-t1' });
    expect(level(seed.products.towel.id, 1)).toBe(before - 2000);
    expect(level(seed.products.towel.id, 2)).toBe(0);
  });

  it('a return taken at a till goes back into that till’s warehouse', async () => {
    const sale = await createSale(db, actor(), t2, saleBody(), { key: 'k-sale', hash: 'h-sale' });
    const itemId = (sale.body as { items: { id: number }[] }).items[0]!.id;
    const res = await createReturn(
      db,
      { id: seed.users.manager.id, role: 'manager' },
      t2,
      {
        saleId: (sale.body as { id: number }).id,
        items: [{ saleItemId: itemId, qty: '1' }],
        reason: '',
        refund: { method: 'cash', currency: 'LBP', amount: 75000 },
      },
      { key: 'k-ret', hash: 'h-ret' },
    );
    expect(res.statusCode).toBe(201);
    expect(level(seed.products.towel.id, 2)).toBe(-1000); // 2 out, 1 back
  });

  it('each till sells only into its own register: a till with no open register is refused', async () => {
    raw
      .prepare(
        `UPDATE register_sessions SET status = 'closed', closed_at = '2026-11-23T01:00:00.000Z', closed_by = ? WHERE terminal_id = 'T2'`,
      )
      .run(seed.users.manager.id);
    await expect(createSale(db, actor(), t2, saleBody(), { key: 'k-closed', hash: 'h-closed' })).rejects.toMatchObject({
      code: 'REGISTER_CLOSED',
    });
    expect((await createSale(db, actor(), t1, saleBody(), { key: 'k-open', hash: 'h-open' })).statusCode).toBe(201);
  });
});

describe('which terminal a request came from', () => {
  it('two active terminals and no token: refused', async () => {
    await expect(resolveTerminal(db, undefined)).rejects.toMatchObject({ code: 'TERMINAL_REQUIRED' });
  });

  it('an unknown token: refused', async () => {
    await expect(resolveTerminal(db, 'nope')).rejects.toMatchObject({ code: 'TERMINAL_UNKNOWN' });
  });

  it('exactly one active terminal and none enrolled: that one (the shop as it is today)', async () => {
    raw.prepare(`UPDATE terminals SET active = 0 WHERE code = 'T2'`).run();
    expect(await resolveTerminal(db, undefined)).toMatchObject({ code: 'T1' });
  });

  it('one active terminal, but an enrolled one exists: a token is required', async () => {
    raw.prepare(`UPDATE terminals SET active = 0 WHERE code = 'T2'`).run();
    raw.prepare(`UPDATE terminals SET token_hash = 'x' WHERE code = 'T2'`).run(); // the switched-off till was enrolled once
    await expect(resolveTerminal(db, undefined)).rejects.toMatchObject({ code: 'TERMINAL_REQUIRED' });
  });
});
