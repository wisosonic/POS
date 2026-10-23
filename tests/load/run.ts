// The load test: `npm run test:load` (or `npm run test:load -- --quick`). See docs/09-load-test.md.
//
// It starts the real server in production mode on a COPY of the shop's real data (the ETL import of POSDB.sql, when that file
// is present), signs in, and runs a series of scenarios against it. Afterwards it checks that the money still adds up.
// It never touches your real database: everything lives in a temporary folder that is deleted at the end.
//
//   --quick        about a quarter of the time (for a fast check)
//   --only=a,b     run only these scenarios (steady, headroom, ramp, mixed, duplicates, hot, backup)
//   --keep         keep the temporary folder (database, server log) to look at afterwards
//
// Budgets can be changed for a slower PC: LOAD_SALES_P95_MS (default 150, from docs/04-architecture.md §7).
import Database from 'better-sqlite3';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os, { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { computeCart } from '../../packages/shared/src/pricing';
import { call, openLoop, rng, Series, sleep, timed, type Reply, type Target } from './lib';

const repo = resolve(import.meta.dirname, '..', '..');
const args = process.argv.slice(2);
const quick = args.includes('--quick');
const keep = args.includes('--keep');
const only = args
  .find((a) => a.startsWith('--only='))
  ?.slice(7)
  .split(',');
const wants = (name: string) => !only || only.includes(name);
const secs = (n: number) => Math.max(4, Math.round(n * (quick ? 0.25 : 1)));

const SALES_P95_MS = Number(process.env.LOAD_SALES_P95_MS ?? 150);

type Product = { id: number; name: string; barcode: string; priceMinor: number; currency: 'USD' | 'LBP'; fractional: boolean };
type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const report: Record<string, unknown> = {};
const check = (name: string, ok: boolean, detail: string) => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
};
const ms = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));
const line = (s: ReturnType<Series['summary']>) =>
  `${s.label.padEnd(26)} n=${String(s.count).padStart(5)}  p50 ${ms(s.p50).padStart(6)}  p95 ${ms(s.p95).padStart(6)}  p99 ${ms(s.p99).padStart(6)}  max ${ms(s.max).padStart(6)} ms  failures ${s.failures}`;

// ------------------------------------------------------------------ setup

const dir = mkdtempSync(join(tmpdir(), 'pos-load-'));
const dbPath = join(dir, 'pos.db');
const logPath = join(dir, 'server.log');
let server: ChildProcess | undefined;
let target: Target;
let password = '';
let token = '';
let tokenAt = 0;

const node = (script: string, scriptArgs: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, ['--import', 'tsx', join(repo, script), ...scriptArgs], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });

const freePort = () =>
  new Promise<number>((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => res(port));
    });
    s.on('error', rej);
  });

/** The access token lasts 15 minutes. Sign in again well before that so a long run never fails on an expired token. */
async function auth(): Promise<string> {
  if (token && performance.now() - tokenAt < 10 * 60_000) return token;
  const r = await call(target, 'POST', '/api/v1/auth/login', { body: { username: 'loadadmin', password } });
  if (r.status !== 200) throw new Error(`Could not sign in: ${r.status} ${r.text}`);
  token = r.json.accessToken as string;
  tokenAt = performance.now();
  return token;
}
const api = async (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
  call(target, method, `/api/v1${path}`, { token: await auth(), body, headers });

async function prepare() {
  const dump = process.env.POSDB_DUMP ?? join(repo, 'POSDB.sql');
  let dataset: string;
  if (existsSync(dump)) {
    console.log(`Importing the shop's data from ${dump} into a temporary copy…`);
    const t = performance.now();
    const etl = node('apps/api/src/etl/cli.ts', ['--dump', dump, '--db', dbPath, '--report', join(dir, 'etl-report.json')]);
    if (etl.status !== 0) throw new Error(`The import failed:\n${etl.stdout}\n${etl.stderr}`);
    dataset = 'the real shop data (ETL of POSDB.sql)';
    console.log(`  imported in ${((performance.now() - t) / 1000).toFixed(1)} s`);
  } else {
    const { migrate } = await import('../../apps/api/src/db/migrate');
    const { seedTestData } = await import('../../apps/api/src/db/seed-test');
    migrate(dbPath);
    await seedTestData(dbPath);
    dataset = 'a small synthetic database (POSDB.sql not found: results are less realistic)';
    console.log(`POSDB.sql not found: using ${dataset}`);
  }
  report.dataset = dataset;
  // Numbers mean nothing without the machine they came from.
  report.machine = {
    cpu: os.cpus()[0]?.model.trim(),
    cores: os.cpus().length,
    ramGB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
    os: `${os.type()} ${os.release()}`,
    node: process.version,
  };

  password = randomBytes(12).toString('base64url');
  const admin = node('apps/api/src/cli/create-admin.ts', ['loadadmin', password], { DATABASE_PATH: dbPath });
  if (admin.status !== 0) throw new Error(`Could not create the admin:\n${admin.stdout}\n${admin.stderr}`);

  const port = await freePort();
  target = { host: '127.0.0.1', port };
  const out = openSync(logPath, 'w');
  server = spawn(process.execPath, ['--import', 'tsx', join(repo, 'apps/api/src/index.ts')], {
    cwd: repo,
    stdio: ['ignore', out, out],
    env: {
      ...process.env,
      NODE_ENV: 'production', // as it will really run: request logging on, sign-in rate limit on
      JWT_SECRET: randomBytes(48).toString('hex'),
      DATABASE_PATH: dbPath,
      PORT: String(port),
      BACKUP_DIR: join(dir, 'backups'),
      BACKUP_PASSPHRASE: 'load-test-passphrase',
      BACKUP_AT: '23:59', // no automatic backup during the run; the "backup" scenario makes its own
    },
  });
  closeSync(out);
  // A cold start (compiling the server, opening a freshly imported database) can take a while: allow a minute.
  for (let i = 0; i < 300; i++) {
    await sleep(200);
    try {
      if ((await call(target, 'GET', '/api/v1/healthz')).status === 200) return;
    } catch {
      /* not up yet */
    }
  }
  throw new Error(`The server did not start. See ${logPath}`);
}

type Ctx = { products: Product[]; customers: number[]; rate: number; rounding: number };

async function loadContext(): Promise<Ctx> {
  // Open a fresh register: close the one the old system left open (counted = expected), then open with plenty in every balance.
  const current = await api('GET', '/registers/current');
  if (current.status === 200) {
    const counted = (current.json.balances as { method: string; currency: string; expected: number }[]).map((b) => ({
      method: b.method,
      currency: b.currency,
      amount: b.expected,
    }));
    const closed = await api('POST', `/registers/${current.json.id}/close`, { countedBalances: counted });
    if (closed.status !== 200) throw new Error(`Could not close the old register: ${closed.text}`);
  }
  const opening = ['cash', 'whish', 'omt'].flatMap((method) =>
    (['USD', 'LBP'] as const).map((currency) => ({ method, currency, amount: currency === 'USD' ? 100_000 : 50_000_000 })),
  );
  const opened = await api('POST', '/registers/open', { terminalId: 'LOAD', openingBalances: opening });
  if (opened.status !== 201) throw new Error(`Could not open the register: ${opened.status} ${opened.text}`);

  const products: Product[] = [];
  let cursor = 0;
  for (let page = 0; page < 20; page++) {
    const r = await api('GET', `/products?limit=200&active=true${cursor ? `&cursor=${cursor}` : ''}`);
    for (const p of r.json.data as Product[]) if (p.priceMinor > 0 && p.name.trim()) products.push(p);
    if (!r.json.nextCursor) break;
    cursor = r.json.nextCursor as number;
  }
  if (products.length === 0) throw new Error('There are no products to sell');

  const customers: number[] = [];
  for (let i = 1; i <= 20; i++) {
    const r = await api('POST', '/customers', { name: `Load customer ${i}`, phone: `7000${String(i).padStart(4, '0')}` });
    customers.push(r.json.id as number);
  }
  const rate = ((await api('GET', '/exchange-rates/current')).json.rateLbpPerUsd as number) ?? 90_000;
  const rounding = (await api('GET', '/settings/public')).json.lbpRounding as number;
  console.log(`  ${products.length} products to sell, rate ${rate}, totals round to ${rounding}`);
  report.products = products.length;
  return { products, customers, rate, rounding };
}

// ------------------------------------------------------------------ the sales

const created: { id: number; ref: number }[] = [];
const rand = rng(Number(process.env.LOAD_SEED ?? 20261020));

type Variant = 'cash-exact' | 'cash-change' | 'usd-change' | 'split-wallet' | 'omt-exact' | 'credit';
const VARIANTS: [Variant, number][] = [
  ['cash-exact', 40],
  ['cash-change', 20],
  ['usd-change', 10],
  ['split-wallet', 10],
  ['omt-exact', 5],
  ['credit', 15],
];
const pickVariant = (): Variant => {
  let n = rand.int(1, 100);
  for (const [v, w] of VARIANTS) if ((n -= w) <= 0) return v;
  return 'cash-exact';
};

/** A sale the way the till would send it: 1 to 6 different products, priced and totalled like the till does, paid in one of six ways. */
function makeSale(ctx: Ctx, forced?: { product?: Product }) {
  for (;;) {
    const wanted = forced?.product ? 1 : rand.int(1, 6);
    const chosen: Product[] = [];
    while (chosen.length < wanted) {
      const p = forced?.product ?? rand.pick(ctx.products);
      if (!chosen.includes(p)) chosen.push(p);
    }
    const lines = chosen.map((p) => ({ p, qty: p.fractional ? rand.pick(['0.5', '1', '1.25', '2']) : String(rand.int(1, 3)) }));
    const cart = computeCart({
      rate: ctx.rate,
      lbpRounding: ctx.rounding,
      lines: lines.map((l) => ({ unitPrice: { amount: l.p.priceMinor, currency: l.p.currency }, qty: l.qty })),
    });
    const total = cart.totalLbp;
    if (total < 1000) continue;

    let variant = pickVariant();
    const cash = (amount: number) => ({ method: 'cash', currency: 'LBP', amount });
    let payments: object[];
    let customerId: number | undefined;
    const wallet = Math.floor(total / 2 / 1000) * 1000;
    const onAccount = Math.floor((total * 0.4) / 1000) * 1000;
    if (variant === 'split-wallet' && wallet < 1000) variant = 'cash-exact';
    if (variant === 'credit' && (onAccount < 1000 || onAccount >= total)) variant = 'cash-exact';
    switch (variant) {
      case 'cash-change':
        payments = [cash(total + rand.pick([5000, 10_000, 50_000]))];
        break;
      case 'usd-change':
        payments = [{ method: 'cash', currency: 'USD', amount: Math.ceil((total * 100) / ctx.rate) + 100 }];
        break;
      case 'split-wallet':
        payments = [{ method: 'whish', currency: 'LBP', amount: wallet }, cash(total - wallet)];
        break;
      case 'omt-exact':
        payments = [{ method: 'omt', currency: 'LBP', amount: total }];
        break;
      case 'credit':
        customerId = rand.pick(ctx.customers);
        payments = [cash(onAccount)];
        break;
      default:
        payments = [cash(total)];
    }
    return {
      key: randomUUID(),
      body: {
        clientSaleId: randomUUID(),
        ...(customerId ? { customerId } : {}),
        items: lines.map((l, i) => ({ productId: l.p.id, qty: l.qty, unitPriceLbp: cart.lines[i]!.unitPriceLbp })),
        payments,
      },
    };
  }
}

async function postSale(ctx: Ctx, series: Series, at: number, forced?: { product?: Product }) {
  const sale = makeSale(ctx, forced);
  const rep = await timed(
    series,
    at,
    async () => call(target, 'POST', '/api/v1/sales', { token: await auth(), body: sale.body, headers: { 'Idempotency-Key': sale.key } }),
    (r) => r.status === 201,
  );
  if (rep?.status === 201) created.push({ id: rep.json.id as number, ref: rep.json.ref as number });
}

// ------------------------------------------------------------------ reading while selling

const DAYS_ALL = '2000-01-01T00:00:00.000Z';
function readers(
  ctx: Ctx,
  rates: { barcode: number; search: number; dashboard: number; reportSales: number; reportProducts: number; sync: number },
  seconds: number,
) {
  const s = {
    barcode: new Series('scan (by barcode)'),
    search: new Series('search by name'),
    dashboard: new Series('dashboard'),
    reportSales: new Series('report: sales, all history'),
    reportProducts: new Series('report: products, all hist.'),
    sync: new Series('catalog delta sync'),
  };
  const withBarcode = ctx.products.filter((p) => p.barcode);
  const get = (series: Series, at: number, path: string) =>
    timed(
      series,
      at,
      () => api('GET', path),
      (r) => r.status === 200,
    );
  const now = () => new Date().toISOString();
  const runs = [
    openLoop(rates.barcode, seconds, (_, at) =>
      get(s.barcode, at, `/products/by-barcode/${encodeURIComponent(rand.pick(withBarcode).barcode)}`).then(() => undefined),
    ),
    openLoop(rates.search, seconds, (_, at) => {
      const name = rand.pick(ctx.products).name.trim();
      const q = [...name].slice(0, Math.max(3, Math.min(5, [...name].length))).join('');
      return get(s.search, at, `/products?limit=20&q=${encodeURIComponent(q)}`).then(() => undefined);
    }),
    openLoop(rates.dashboard, seconds, (_, at) => get(s.dashboard, at, '/reports/dashboard').then(() => undefined)),
    openLoop(rates.reportSales, seconds, (_, at) =>
      get(s.reportSales, at, `/reports/sales?groupBy=day&from=${DAYS_ALL}&to=${encodeURIComponent(now())}`).then(() => undefined),
    ),
    openLoop(rates.reportProducts, seconds, (_, at) =>
      get(s.reportProducts, at, `/reports/products?sort=revenue&limit=50&from=${DAYS_ALL}&to=${encodeURIComponent(now())}`).then(
        () => undefined,
      ),
    ),
    openLoop(rates.sync, seconds, (_, at) =>
      get(s.sync, at, `/products/sync?since=${encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString())}`).then(() => undefined),
    ),
  ];
  return { series: s, done: Promise.all(runs) };
}

// ------------------------------------------------------------------ the checks after the run

type Row = Record<string, number | string | null>;

function invariants(
  registerId: number | null,
  expectedSales: number,
  zBuckets: { method: string; currency: string; expected: number }[] | null,
  runningBuckets: typeof zBuckets,
) {
  console.log('\nDid the money still add up?');
  const db = new Database(dbPath, { readonly: true });
  try {
    check('database integrity', db.pragma('integrity_check', { simple: true }) === 'ok', 'PRAGMA integrity_check');
    check('no broken references', (db.pragma('foreign_key_check') as unknown[]).length === 0, 'PRAGMA foreign_key_check');

    const ids = created.map((c) => c.id);
    const stored = db.prepare(`SELECT count(*) AS n FROM sales WHERE id IN (${ids.map(() => '?').join(',') || 'NULL'})`).get(...ids) as Row;
    check(
      'every sale the server confirmed is in the database',
      Number(stored.n) === expectedSales && ids.length === expectedSales,
      `${ids.length} confirmed, ${stored.n} stored`,
    );

    const dupRefs = db.prepare('SELECT count(*) - count(DISTINCT ref) AS d FROM sales').get() as Row;
    check('no two sales share a receipt number', Number(dupRefs.d) === 0, `${dupRefs.d} duplicates`);

    const badBalances = db
      .prepare(
        `SELECT c.id, c.balance_lbp AS balance, COALESCE((SELECT SUM(s.rest_lbp) FROM sales s WHERE s.customer_id = c.id AND s.status <> 'void'), 0) AS owed
         FROM customers c WHERE c.balance_lbp <> COALESCE((SELECT SUM(s.rest_lbp) FROM sales s WHERE s.customer_id = c.id AND s.status <> 'void'), 0)`,
      )
      .all() as Row[];
    check(
      'every customer’s balance equals what their open sales add up to',
      badBalances.length === 0,
      `${badBalances.length} customers differ`,
    );

    const badStock = db
      .prepare(
        `SELECT p.id FROM products p WHERE COALESCE((SELECT SUM(l.qty_milli) FROM stock_levels l WHERE l.product_id = p.id), 0)
                                        <> COALESCE((SELECT SUM(m.qty_milli_delta) FROM stock_movements m WHERE m.product_id = p.id), 0)`,
      )
      .all() as Row[];
    check('every product’s stock equals the sum of its movements', badStock.length === 0, `${badStock.length} products differ`);

    const badPaid = db.prepare(`SELECT count(*) AS n FROM sales WHERE status <> 'void' AND paid_lbp + rest_lbp <> total_lbp`).get() as Row;
    check('every sale: paid + still owed = total', Number(badPaid.n) === 0, `${badPaid.n} sales differ`);

    if (zBuckets && runningBuckets) {
      const diffs = runningBuckets.filter(
        (b) => zBuckets.find((z) => z.method === b.method && z.currency === b.currency)?.expected !== b.expected,
      );
      check(
        `register ${registerId}: the running balances equal the figures rebuilt from every sale, change, refund and movement`,
        diffs.length === 0,
        `${diffs.length} of ${runningBuckets.length} balances differ`,
      );
    }
    const wal = existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0;
    report.walMB = Number((wal / 1_048_576).toFixed(1));
    report.dbMB = Number((statSync(dbPath).size / 1_048_576).toFixed(1));
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------------ main

async function main() {
  await prepare();
  const ctx = await loadContext();
  const results: ReturnType<Series['summary']>[] = [];
  const show = (s: Series) => {
    const sum = s.summary();
    results.push(sum);
    console.log('  ' + line(sum));
    return sum;
  };

  if (wants('steady')) {
    console.log(`\n1. One till's busiest rate and beyond: 10 sales a second for ${secs(30)} s (target p95 < ${SALES_P95_MS} ms)`);
    const s = new Series('POST /sales @10/s');
    await openLoop(10, secs(30), (_, at) => postSale(ctx, s, at));
    const sum = show(s);
    check(
      'sales stay under the target',
      sum.p95 < SALES_P95_MS && sum.failures === 0,
      `p95 ${ms(sum.p95)} ms (limit ${SALES_P95_MS}), ${sum.failures} failures`,
    );
  }

  if (wants('headroom')) {
    console.log(`\n2. Five times that: 50 sales a second for ${secs(20)} s`);
    const s = new Series('POST /sales @50/s');
    await openLoop(50, secs(20), (_, at) => postSale(ctx, s, at));
    const sum = show(s);
    check('no sale fails at 5x the busiest rate', sum.failures === 0, `${sum.failures} failures, p95 ${ms(sum.p95)} ms`);
  }

  if (wants('ramp')) {
    console.log('\n3. Where does it give way? Faster and faster until p95 passes 1 second or sales start failing');
    let best = 0;
    for (const rate of [25, 50, 100, 150, 200, 300, 400]) {
      const s = new Series(`POST /sales @${rate}/s`);
      await openLoop(rate, secs(8), (_, at) => postSale(ctx, s, at));
      const sum = show(s);
      if (sum.p95 > 1000 || sum.failures / Math.max(1, sum.count) > 0.01) break;
      best = rate;
    }
    report.maxSalesPerSecond = best;
    console.log(`  → sales stayed healthy up to ${best} a second (a shop doing ~80 sales a day makes about 0.003 a second)`);
  }

  if (wants('mixed')) {
    const t = secs(30);
    console.log(
      `
4. A busy afternoon, with more going on than any shop has: 10 sales a second (a till's peak is far lower) while a scanner reads 10 codes a second, 2 searches a second, and a manager keeps the dashboard open and runs all-history reports every few seconds (${t} s)`,
    );
    const s = new Series('POST /sales (afternoon)');
    const r = readers(ctx, { barcode: 10, search: 2, dashboard: 0.2, reportSales: 0.2, reportProducts: 0.2, sync: 0.1 }, t);
    await Promise.all([openLoop(10, t, (_, at) => postSale(ctx, s, at)), r.done]);
    const sales = show(s);
    for (const x of Object.values(r.series)) show(x);
    const readFailures = Object.values(r.series).reduce((n, x) => n + x.failures, 0);
    // The architecture's 150 ms is for sales on their own (scenario 1). With reports running on the same thread the limit is
    // twice that: a sale still finishes far inside the 2 s "pay to receipt" target. See docs/09-load-test.md.
    check(
      `sales stay under ${SALES_P95_MS * 2} ms while others read`,
      sales.p95 < SALES_P95_MS * 2 && sales.failures === 0,
      `p95 ${ms(sales.p95)} ms (limit ${SALES_P95_MS * 2}), ${sales.failures} failures`,
    );
    check(
      'the dashboard answers within 2 s (docs/04-architecture.md §7)',
      r.series.dashboard.percentile(95) < 2000,
      `p95 ${ms(r.series.dashboard.percentile(95))} ms`,
    );
    check(
      'scans stay under 200 ms (docs/04-architecture.md §7)',
      r.series.barcode.percentile(95) < 200,
      `p95 ${ms(r.series.barcode.percentile(95))} ms`,
    );
    check('nothing that was read failed', readFailures === 0, `${readFailures} failures`);
  }

  if (wants('stall')) {
    const t = secs(20);
    console.log(`
5. How long does a heavy report hold up the till? 5 sales a second while the all-history product report runs every 3 s (${t} s)`);
    const s = new Series('POST /sales (during reports)');
    const rep = new Series('report: products, all hist.');
    const now = () => new Date().toISOString();
    await Promise.all([
      openLoop(5, t, (_, at) => postSale(ctx, s, at)),
      openLoop(1 / 3, t, (_, at) =>
        timed(
          rep,
          at,
          () => api('GET', `/reports/products?sort=revenue&limit=50&from=${DAYS_ALL}&to=${encodeURIComponent(now())}`),
          (r) => r.status === 200,
        ).then(() => undefined),
      ),
    ]);
    const sales = show(s);
    const report1 = show(rep);
    report.reportStall = { slowestSaleMs: Math.round(sales.max), slowestReportMs: Math.round(report1.max) };
    check(
      'no sale fails while a report runs',
      sales.failures === 0 && report1.failures === 0,
      `${sales.failures} sale and ${report1.failures} report failures`,
    );
    check(
      'no sale waits more than a second for a report',
      sales.max < 1000,
      `the slowest sale took ${ms(sales.max)} ms while reports of ${ms(report1.p50)} ms (median) ran`,
    );
  }

  if (wants('stress')) {
    const t = secs(30);
    console.log(
      `
6. Stress, far beyond any shop (reported, not a target): 10 sales, 30 scans, 10 searches, 1 dashboard and 1 all-history report every second (${t} s)`,
    );
    const s = new Series('POST /sales (stress)');
    const r = readers(ctx, { barcode: 30, search: 10, dashboard: 1, reportSales: 0.5, reportProducts: 0.5, sync: 0.2 }, t);
    await Promise.all([openLoop(10, t, (_, at) => postSale(ctx, s, at)), r.done]);
    const sales = show(s);
    for (const x of Object.values(r.series)) show(x);
    report.stress = { salesP95Ms: Math.round(sales.p95), scanP95Ms: Math.round(r.series.barcode.percentile(95)) };
    const failures = sales.failures + Object.values(r.series).reduce((n, x) => n + x.failures, 0);
    check(
      'under stress everything is slow but nothing fails or is lost',
      failures === 0,
      `${failures} failures (sales p95 ${ms(sales.p95)} ms)`,
    );
  }

  if (wants('duplicates')) {
    console.log('\n7. The same sale sent ten times at once (a double-click, a retry after a dropped connection), forty times over');
    const before = created.length;
    let bad = 0;
    let first = 0;
    for (let k = 0; k < 40; k++) {
      const sale = makeSale(ctx);
      const tk = await auth();
      const replies: Reply[] = await Promise.all(
        Array.from({ length: 10 }, () =>
          call(target, 'POST', '/api/v1/sales', { token: tk, body: sale.body, headers: { 'Idempotency-Key': sale.key } }),
        ),
      );
      const made = replies.filter((r) => r.status === 201);
      const replayed = replies.filter((r) => r.status === 200 && r.headers['idempotent-replay'] === 'true');
      if (made.length !== 1 || replayed.length !== 9 || new Set(replies.map((r) => r.json?.id)).size !== 1) bad++;
      if (made[0]) {
        created.push({ id: made[0].json.id as number, ref: made[0].json.ref as number });
        first++;
      }
    }
    check(
      'each sale is recorded exactly once, however many times it is sent',
      bad === 0 && created.length - before === 40 && first === 40,
      `${bad} of 40 went wrong; ${created.length - before} sales recorded for 400 requests`,
    );
  }

  if (wants('hot')) {
    const t = secs(10);
    console.log(
      `\n8. Everyone buys the same product (20 a second for ${t} s): stock goes negative, which is allowed, and must still add up`,
    );
    const s = new Series('POST /sales (one product)');
    const hot = ctx.products[0]!;
    await openLoop(20, t, (_, at) => postSale(ctx, s, at, { product: hot }));
    const sum = show(s);
    check('selling one product at 20 a second works', sum.failures === 0, `${sum.failures} failures, p95 ${ms(sum.p95)} ms`);
  }

  if (wants('backup')) {
    const t = secs(30);
    console.log(`\n9. Backups taken while the shop sells: 10 sales a second for ${t} s with an encrypted backup at 20% and 60% of the way`);
    const s = new Series('POST /sales (during backups)');
    const backups: { atS: number; ms: number; status: number }[] = [];
    const takeBackup = async (afterMs: number) => {
      await sleep(afterMs);
      const started = performance.now();
      const r = await api('POST', '/backups');
      backups.push({ atS: Math.round(afterMs / 1000), ms: Math.round(performance.now() - started), status: r.status });
    };
    await Promise.all([openLoop(10, t, (_, at) => postSale(ctx, s, at)), takeBackup(t * 200), takeBackup(t * 600)]);
    const sum = show(s);
    console.log('  backups: ' + backups.map((b) => `${b.status} in ${b.ms} ms`).join(', '));
    check('both backups succeeded', backups.length === 2 && backups.every((b) => b.status === 201), JSON.stringify(backups));
    check(
      'sales kept working during the backups',
      sum.failures === 0 && sum.p95 < SALES_P95_MS * 2,
      `p95 ${ms(sum.p95)} ms (limit ${SALES_P95_MS * 2}), ${sum.failures} failures`,
    );
    report.backups = backups;
  }

  // The money. Compare the register's running balances with the figures rebuilt from every row.
  const cur = await api('GET', '/registers/current');
  const z = cur.status === 200 ? await api('GET', `/reports/register/${cur.json.id}`) : null;
  const pick = (r: Reply | null) =>
    r && r.status === 200 ? (r.json.balances as { method: string; currency: string; expected: number }[]) : null;
  invariants(cur.status === 200 ? (cur.json.id as number) : null, created.length, pick(z), pick(cur));

  // The server's own log: nothing it logs at "error" level (a crash, an unhandled failure) is acceptable.
  const log = readFileSync(logPath, 'utf8');
  const errors = log.split('\n').filter((l) => l.includes('"level":50') || l.includes('"level":60'));
  check('the server logged no errors', errors.length === 0, errors.length ? errors[0]!.slice(0, 300) : '0 error lines');

  report.sales = created.length;
  report.results = results;
  report.checks = checks;
}

async function finish(code: number) {
  if (server && server.exitCode === null) {
    server.kill();
    await new Promise((r) => server!.once('exit', r));
  }
  // Keep the folder (database and server log) when asked to, and whenever the test itself could not run: the log says why.
  if (keep || code === 2) console.log(`\nKept for you to look at: ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
  process.exit(code);
}

main()
  .then(async () => {
    const dirOut = join(repo, 'tests', 'load', 'results');
    mkdirSync(dirOut, { recursive: true });
    const file = join(dirOut, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(file, JSON.stringify({ quick, when: new Date().toISOString(), ...report }, null, 2));
    const failed = checks.filter((c) => !c.ok);
    console.log(
      `\n${failed.length === 0 ? 'ALL CHECKS PASSED' : `${failed.length} CHECK(S) FAILED`} (${checks.length} checks). Details: ${file}`,
    );
    await finish(failed.length === 0 ? 0 : 1);
  })
  .catch(async (err) => {
    console.error('\nThe load test could not run:', err instanceof Error ? err.message : err);
    await finish(2);
  });
