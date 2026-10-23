import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Db } from '../../apps/api/src/db/open';
import { migrate } from '../../apps/api/src/db/migrate';
import { seedReference } from '../../apps/api/src/db/seed';
import { lowStock } from '../../apps/api/src/modules/inventory/routes';

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pos-alerts-'));
  const file = join(dir, 'pos.db');
  migrate(file);
  db = openDatabase(file);
  seedReference(db);
  db.prepare(`INSERT INTO warehouses (name) VALUES ('Second')`).run(); // id 2
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const product = (name: string, thresholdMilli: number | null, ...levels: [warehouse: number, qtyMilli: number][]) => {
  const id = Number(db.prepare('INSERT INTO products (name, stock_alert_milli) VALUES (?, ?)').run(name, thresholdMilli).lastInsertRowid);
  for (const [w, q] of levels) db.prepare('INSERT INTO stock_levels (product_id, warehouse_id, qty_milli) VALUES (?, ?, ?)').run(id, w, q);
  return id;
};
const alerting = () => lowStock(db).map((a) => a.name);

describe('low-stock alerts use the TOTAL across warehouses', () => {
  it('REGRESSION: a product is not low when its warehouses add up above the threshold', () => {
    // Threshold 5. Warehouse 1 holds 3 and warehouse 2 holds 4: 7 in total, so no alert.
    // A query that compared a single stock row (instead of the sum) wrongly alerted here.
    product('Spread over two', 5_000, [1, 3_000], [2, 4_000]);
    expect(alerting()).toEqual([]);
  });

  it('is low when the total is at or below the threshold', () => {
    product('Total 5', 5_000, [1, 3_000], [2, 2_000]); // 5 <= 5
    product('Total 4', 5_000, [1, 1_000], [2, 3_000]); // 4 <= 5
    expect(alerting().sort()).toEqual(['Total 4', 'Total 5']);
  });

  it('a product with no stock rows at all counts as zero', () => {
    product('Never stocked', 1_000);
    expect(alerting()).toEqual(['Never stocked']);
  });

  it('negative stock is low', () => {
    product('Oversold', 0, [1, -2_000]);
    expect(alerting()).toEqual(['Oversold']);
  });

  it('threshold zero alerts only at zero or below', () => {
    product('Has one', 0, [1, 1_000]);
    product('Empty', 0, [1, 0]);
    expect(alerting()).toEqual(['Empty']);
  });

  it('no threshold means never an alert, whatever the stock', () => {
    product('Untracked', null, [1, -9_000]);
    expect(alerting()).toEqual([]);
  });

  it('ignores inactive products', () => {
    const id = product('Retired', 5_000, [1, 0]);
    db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(id);
    expect(alerting()).toEqual([]);
  });

  it('orders the most urgent first: lowest quantity relative to its threshold', () => {
    product('Half empty', 10_000, [1, 5_000]); // 0.5 of its threshold
    product('Empty', 10_000, [1, 0]); // 0
    product('Almost full', 10_000, [1, 9_000]); // 0.9
    product('Oversold', 10_000, [1, -3_000]); // negative
    expect(alerting()).toEqual(['Oversold', 'Empty', 'Half empty', 'Almost full']);
  });

  it('reports quantity and threshold in whole units', () => {
    product('Cheese', 2_500, [1, 1_350]);
    expect(lowStock(db)).toEqual([expect.objectContaining({ name: 'Cheese', qty: '1.35', threshold: 2.5 })]);
  });
});
