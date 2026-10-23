import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../../apps/api/src/db/migrate';
import { openDatabase, type Db } from '../../apps/api/src/db/open';
import { seedTestData } from '../../apps/api/src/db/seed-test';

// The load test (docs/09-load-test.md) found listings that read the whole table. These tests keep the busy queries on their
// indexes, so a change that quietly turns one back into a scan fails here instead of showing up as a slow till in a year.
let root: string;
let db: Db;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pos-plans-'));
  const path = join(root, 'pos.db');
  migrate(path);
  await seedTestData(path);
  db = openDatabase(path);
  // The planner only prefers an index when the table is big enough to matter, so give it something to chew on.
  db.exec('BEGIN');
  const sale = db.prepare(
    `INSERT INTO sales (ref, customer_id, warehouse_id, rate_lbp_per_usd, subtotal_lbp, total_lbp, paid_lbp, status, user_id, created_at)
     VALUES (?, ?, 1, 90000, 50000, 50000, 50000, 'paid', ?, ?)`,
  );
  for (let i = 1; i <= 5000; i++)
    sale.run(100_000 + i, 1 + (i % 2), 1 + (i % 3), `2026-01-${String(1 + (i % 28)).padStart(2, '0')}T10:00:00.000Z`);
  db.exec('COMMIT');
  db.exec('ANALYZE');
});
afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const plan = (sql: string, ...params: unknown[]) =>
  (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((r) => r.detail).join(' | ');

describe('the busy queries use their indexes (US-27, US-28, US-32)', () => {
  it('a customer’s purchase history', () => {
    expect(plan('SELECT * FROM sales WHERE customer_id = ? ORDER BY id DESC LIMIT 51', 2)).toMatch(
      /USING (COVERING )?INDEX ix_sales_customer/,
    );
  });

  it('a cashier’s own sales', () => {
    expect(plan('SELECT * FROM sales WHERE user_id = ? ORDER BY id DESC LIMIT 51', 2)).toMatch(/USING (COVERING )?INDEX ix_sales_user/);
  });

  it('returns inside a date range', () => {
    expect(plan('SELECT * FROM returns WHERE created_at >= ? AND created_at <= ?', 'a', 'b')).toMatch(/INDEX ix_returns_created/);
  });

  it('sales inside a date range (the dashboard and every report start here)', () => {
    expect(plan(`SELECT * FROM sales WHERE created_at >= ? AND created_at <= ? AND status <> 'void'`, 'a', 'b')).toMatch(
      /INDEX ix_sales_created/,
    );
  });

  it('a sale looked up by its receipt number', () => {
    expect(plan('SELECT * FROM sales WHERE ref = ?', 1)).toMatch(/SEARCH sales USING (COVERING )?INDEX/);
  });

  it('the lines of a sale, and the sales of a register session', () => {
    expect(plan('SELECT * FROM sale_items WHERE sale_id = ?', 1)).toMatch(/INDEX ix_sale_items_sale/);
    expect(plan(`SELECT count(*) FROM sales WHERE session_id = ? AND status <> 'void'`, 1)).toMatch(/INDEX ix_sales_session/);
  });

  it('a product’s sales history, and a product by barcode', () => {
    expect(plan('SELECT * FROM sale_items WHERE product_id = ?', 1)).toMatch(/INDEX ix_sale_items_product/);
    expect(plan('SELECT * FROM products WHERE barcode = ? AND active = 1', 'x')).toMatch(/INDEX ix_products_barcode/);
  });

  it('no busy listing above reads a whole table', () => {
    for (const [sql, params] of [
      ['SELECT * FROM sales WHERE customer_id = ? ORDER BY id DESC LIMIT 51', [2]],
      ['SELECT * FROM sales WHERE user_id = ? ORDER BY id DESC LIMIT 51', [2]],
      ['SELECT * FROM returns WHERE created_at >= ? AND created_at <= ?', ['a', 'b']],
    ] as const) {
      expect(plan(sql, ...params), sql).not.toMatch(/\bSCAN (sales|returns)\b/);
    }
  });
});
