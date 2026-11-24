import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openDatabase, type Db } from '../../apps/api/src/db/open';
import { salesReport, productsReport } from '../../apps/api/src/modules/reports/compute';
import { ReportRunner } from '../../apps/api/src/modules/reports/runner';
import { startCtx, type TestCtx } from '../helpers/app';

// The heavy reports run in a worker thread with its own read-only connection, so a report over years of sales cannot hold up a sale.
// (The same figures, inline, are tested in reports.test.ts.) Vitest cannot load TypeScript inside a worker by itself, so the worker is
// given the same loader the server runs under.
const TSX = ['--import', 'tsx'];
const SALES = 150_000;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const ALL = { from: '2000-01-01T00:00:00.000Z', to: '2100-01-01T00:00:00.000Z' };

let c: TestCtx;
let manager: string;
let ro: Db;

/** Years of sales, written straight into the database file (this test is the only writer of it). */
function bulkSales(path: string) {
  const db = openDatabase(path);
  db.exec('BEGIN');
  const sale = db.prepare(
    `INSERT INTO sales (ref, user_id, customer_id, warehouse_id, rate_lbp_per_usd, subtotal_lbp, total_lbp, paid_lbp, profit_lbp, status, created_at)
     VALUES (?, 2, 1, 1, 90000, ?, ?, ?, ?, 'paid', ?)`,
  );
  const item = db.prepare(
    `INSERT INTO sale_items (sale_id, product_id, name_snap, barcode_snap, qty_milli, unit_price_lbp, unit_cost_lbp, line_total_lbp) VALUES (?, ?, ?, '', 1000, ?, ?, ?)`,
  );
  const first = (db.prepare('SELECT MIN(id) AS m FROM products').get() as { m: number }).m;
  const end = Date.now();
  const span = 5 * 365 * 86_400_000;
  for (let i = 1; i <= SALES; i++) {
    const at = new Date(end - span + Math.floor((i / SALES) * span)).toISOString();
    const price = 20000 + (i % 40) * 2500;
    const id = Number(sale.run(900_000 + i, price, price, price, Math.round(price * 0.2), at).lastInsertRowid);
    for (let l = 0; l < 3; l++) item.run(id, first + ((i + l) % 5), `Item ${(i + l) % 5}`, price / 3, price / 4, price / 3);
  }
  db.exec('COMMIT');
  db.exec('ANALYZE');
  db.close();
}

beforeAll(async () => {
  c = await startCtx({ reports: { worker: true, execArgv: TSX } });
  manager = await c.login('manager');
  bulkSales(c.databasePath);
  ro = openDatabase(c.databasePath, { readonly: true });
}, 300_000); // starting the worker (it loads TypeScript) takes about 2 minutes on this PC: leave room for a busy machine
afterAll(async () => {
  ro.close();
  await c.close(); // also ends the worker
});

describe('reports in a worker (US-28)', () => {
  it('gives exactly the figures the server would work out on its own thread', async () => {
    const q = `from=${ALL.from}&to=${ALL.to}`;
    for (const groupBy of ['day', 'cashier', 'category'] as const) {
      const viaWorker = (await c.http.get(`${api}/reports/sales?${q}&groupBy=${groupBy}`).set(auth(manager))).body;
      expect(JSON.parse(JSON.stringify(salesReport(ro, { ...ALL, groupBy }))), groupBy).toEqual(viaWorker);
    }
    const products = (await c.http.get(`${api}/reports/products?${q}&sort=revenue&limit=3`).set(auth(manager))).body;
    expect(JSON.parse(JSON.stringify(productsReport(ro, { ...ALL, sort: 'revenue', order: 'desc', limit: 3 })))).toEqual(products);
    expect(products.data.length).toBe(3);
  }, 60_000);

  it('a long report does not hold up the server: its thread keeps running while the worker reads', async () => {
    // How long the same report takes on the server's own thread: that is how long every till would wait without the worker.
    const t0 = performance.now();
    salesReport(ro, { ...ALL, groupBy: 'day' });
    const inlineMs = performance.now() - t0;
    expect(inlineMs).toBeGreaterThan(150); // a heavy report, or this test proves nothing

    // Now ask for it through the server and watch how long its own thread is unresponsive meanwhile.
    let last = performance.now();
    let longest = 0;
    const tick = setInterval(() => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
    }, 5);
    const res = await c.http.get(`${api}/reports/sales?from=${ALL.from}&to=${ALL.to}&groupBy=day`).set(auth(manager));
    clearInterval(tick);
    expect(res.status).toBe(200);
    expect(longest, `longest stall ${longest.toFixed(0)} ms against ${inlineMs.toFixed(0)} ms inline`).toBeLessThan(inlineMs / 2);
  }, 60_000);

  it('the worker reads only: its connection is read-only, so even a bug there cannot change a figure', () => {
    expect(() => ro.prepare(`UPDATE sales SET total_lbp = 1 WHERE id = 1`).run()).toThrow(/readonly/i);
    expect(() => ro.prepare(`INSERT INTO audit_log (action, entity) VALUES ('x', 'y')`).run()).toThrow(/readonly/i);
  });

  it('a report that overruns its time is given up on, with a clear answer, and the next one works', async () => {
    const impatient = new ReportRunner({ databasePath: c.databasePath, db: ro, worker: true, execArgv: TSX, timeoutMs: 1 });
    await expect(impatient.run({ kind: 'sales', params: { ...ALL, groupBy: 'day' } })).rejects.toMatchObject({
      code: 'REPORT_TIMEOUT',
      status: 503,
    });
    await impatient.close();

    const patient = new ReportRunner({ databasePath: c.databasePath, db: ro, worker: true, execArgv: TSX });
    const ok = await patient.run<{ totals: { count: number } }>({ kind: 'sales', params: { ...ALL, groupBy: 'day' } });
    expect(ok.totals.count).toBeGreaterThanOrEqual(SALES);
    await patient.close();
  }, 60_000);

  it('if the worker dies with a report waiting, that report is told at once, and the next report starts a fresh worker', async () => {
    const runner = new ReportRunner({ databasePath: c.databasePath, db: ro, worker: true, execArgv: TSX });
    const first = runner.run({ kind: 'sales', params: { ...ALL, groupBy: 'day' } });
    await new Promise((r) => setTimeout(r, 50));
    (runner as unknown as { worker: { terminate: () => Promise<number> } }).worker.terminate(); // killed from outside
    await expect(first).rejects.toMatchObject({ code: 'REPORT_FAILED' });

    const again = await runner.run<{ totals: { count: number } }>({ kind: 'sales', params: { ...ALL, groupBy: 'day' } });
    expect(again.totals.count).toBeGreaterThanOrEqual(SALES);
    await runner.close();
  }, 60_000);

  it('a closed runner refuses new reports instead of starting a worker that nobody will stop', async () => {
    const runner = new ReportRunner({ databasePath: c.databasePath, db: ro, worker: true, execArgv: TSX });
    await runner.close();
    await expect(runner.run({ kind: 'sales', params: { ...ALL, groupBy: 'day' } })).rejects.toMatchObject({ code: 'REPORTS_UNAVAILABLE' });
  });
});

describe('inline mode', () => {
  it('runs the same code on the server’s own connection when the worker is switched off', async () => {
    const inline = new ReportRunner({ databasePath: c.databasePath, db: ro, worker: false });
    expect(inline.usesWorker).toBe(false);
    const a = await inline.run({ kind: 'sales', params: { ...ALL, groupBy: 'category' } });
    expect(JSON.parse(JSON.stringify(a))).toEqual(JSON.parse(JSON.stringify(salesReport(ro, { ...ALL, groupBy: 'category' }))));
    await inline.close();
  }, 60_000);
});
