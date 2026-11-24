// The cut-over rehearsal: import a legacy dump into a THROWAWAY database, check that the new system holds the same shop, sell
// something on it, and prove a backup of it restores. Run it as often as you like, and again on cut-over day with the fresh dump.
//
//   npm run rehearse -w @pos/api -- --dump ../../POSDB.sql [--uploads ../../Uploads] [--keep] [--report <file.json>]
//
// It never touches the real database: everything happens in a temporary folder that is deleted at the end (--keep leaves it).
// Exit code 0 when every check passed, 1 when any failed. See docs/10-cutover.md.
import Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { usdToLbp } from '@pos/shared';
import { buildApp } from '../app';
import { hashPassword } from '../auth/password';
import { createBackup, restoreBackup } from '../backup/backup';
import { migrate } from '../db/migrate';
import { openDatabase } from '../db/open';
import { runEtl } from '../etl/run';
import type { EtlReport } from '../etl/report';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dump = flag('dump');
if (!dump) {
  process.stderr.write('Usage: rehearse --dump <POSDB.sql> [--uploads <folder>] [--keep] [--report <file.json>]\n');
  process.exit(2);
}
const keep = args.includes('--keep');
const dumpPath = resolve(dump);
if (!existsSync(dumpPath)) {
  process.stderr.write(`There is no file at ${dumpPath}\n`);
  process.exit(2);
}

type Check = { step: string; name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const timings: Record<string, number> = {};
let step = '';
const say = (m = '') => process.stdout.write(`${m}\n`);
const check = (name: string, ok: boolean, detail = '') => {
  checks.push({ step, name, ok, detail });
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
};
const info = (m: string) => say(`  ....  ${m}`);
async function timed<T>(title: string, run: () => Promise<T> | T): Promise<T> {
  step = title;
  say(`\n${title}`);
  const t = Date.now();
  try {
    return await run();
  } finally {
    timings[title] = Math.round((Date.now() - t) / 100) / 10;
    say(`  (${timings[title]} s)`);
  }
}

const dir = mkdtempSync(join(tmpdir(), 'pos-rehearse-'));
const dbPath = join(dir, 'pos.db');
const imagesDir = join(dir, 'uploads');
const n = (v: unknown) => Number(v);
const lbp = (v: number) => `${v.toLocaleString('en-US')} LBP`;

// ------------------------------------------------------------------ the checks on a database

function invariants(label: string, path: string) {
  const db = new Database(path, { readonly: true });
  try {
    check(`${label}: database integrity`, db.pragma('integrity_check', { simple: true }) === 'ok', 'PRAGMA integrity_check');
    const fk = db.pragma('foreign_key_check') as unknown[];
    check(`${label}: no broken references`, fk.length === 0, `${fk.length} broken`);
    const dup = db.prepare('SELECT count(*) - count(DISTINCT ref) AS d FROM sales').get() as { d: number };
    check(`${label}: no two sales share a receipt number`, n(dup.d) === 0, `${dup.d} duplicates`);
    const badPaid = db.prepare(`SELECT count(*) AS c FROM sales WHERE status <> 'void' AND paid_lbp + rest_lbp <> total_lbp`).get() as {
      c: number;
    };
    check(`${label}: every sale: paid + still owed = total`, n(badPaid.c) === 0, `${badPaid.c} differ`);
    const owed = `COALESCE((SELECT SUM(s.rest_lbp) FROM sales s WHERE s.customer_id = c.id AND s.status <> 'void'), 0)`;
    const badBal = db.prepare(`SELECT count(*) AS c FROM customers c WHERE c.balance_lbp <> ${owed}`).get() as { c: number };
    check(`${label}: every customer's balance equals what their open sales add up to`, n(badBal.c) === 0, `${badBal.c} differ`);
    const badStock = db
      .prepare(
        `SELECT count(*) AS c FROM products p
         WHERE COALESCE((SELECT SUM(l.qty_milli) FROM stock_levels l WHERE l.product_id = p.id), 0)
            <> COALESCE((SELECT SUM(m.qty_milli_delta) FROM stock_movements m WHERE m.product_id = p.id), 0)`,
      )
      .get() as { c: number };
    check(`${label}: every product's stock equals the sum of its movements`, n(badStock.c) === 0, `${badStock.c} differ`);
    const badItems = db
      .prepare(`SELECT count(*) AS c FROM sale_items WHERE line_total_lbp < 0 OR qty_milli <= 0 OR unit_price_lbp < 0`)
      .get() as { c: number };
    check(`${label}: no sale line with a negative amount or nothing sold`, n(badItems.c) === 0, `${badItems.c} lines`);
    const badPay = db
      .prepare(
        `SELECT count(*) AS c FROM sales s WHERE s.status <> 'void' AND s.paid_lbp > 0 AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.sale_id = s.id)`,
      )
      .get() as { c: number };
    check(`${label}: every paid sale has its payment recorded`, n(badPay.c) === 0, `${badPay.c} sales without one`);
  } finally {
    db.close();
  }
}

/** A fingerprint of what matters, to prove a restored copy is the same shop. */
function fingerprint(path: string) {
  const db = new Database(path, { readonly: true });
  try {
    const tables = [
      'sales',
      'sale_items',
      'payments',
      'products',
      'customers',
      'stock_movements',
      'returns',
      'purchases',
      'users',
      'audit_log',
    ];
    const parts: Record<string, string> = {};
    for (const t of tables) {
      const r = db.prepare(`SELECT count(*) AS c, COALESCE(SUM(id), 0) AS s FROM ${t}`).get() as { c: number; s: number };
      parts[t] = `${r.c}:${r.s}`;
    }
    const money = db.prepare('SELECT COALESCE(SUM(total_lbp), 0) AS t, COALESCE(SUM(rest_lbp), 0) AS r FROM sales').get() as {
      t: number;
      r: number;
    };
    const bal = db.prepare('SELECT COALESCE(SUM(balance_lbp), 0) AS b FROM customers').get() as { b: number };
    parts.money = `${money.t}:${money.r}:${bal.b}`;
    return { parts, hash: createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16) };
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------------ the steps

async function importStep(): Promise<EtlReport> {
  info(`dump ${dumpPath} (${(statSync(dumpPath).size / 1_048_576).toFixed(0)} MB)`);
  migrate(dbPath);
  const report = await runEtl({
    dumpPath,
    databasePath: dbPath,
    uploadsDir: flag('uploads') ? resolve(flag('uploads')!) : undefined,
    imagesDir,
    log: () => undefined,
  });
  // runEtl refuses to save unless revenue less refunds equals the legacy total, so reaching here already means it matched.
  check(
    'revenue less refunds equals the old app’s total',
    report.imported.netRevenueMatchesLegacy,
    `${lbp(report.imported.revenueLbp)} − ${lbp(report.imported.refundsLbp)} refunds; the old app said ${lbp(report.legacyTotals.grandTotalLbp)} for ${report.legacyTotals.saleCount} sales`,
  );
  const sales = report.counts.sales;
  check(
    'every sale in the dump arrived',
    !!sales && sales.imported + sales.existing === sales.legacy,
    `${sales?.imported} of ${sales?.legacy}`,
  );
  info('rows per table (dump → imported):');
  for (const [table, v] of Object.entries(report.counts))
    info(`  ${table.padEnd(18)} ${String(v.legacy).padStart(7)} → ${String(v.imported + v.existing).padStart(7)}`);
  return report;
}

async function smokeStep() {
  // A user that exists only in this throwaway copy.
  const password = randomBytes(12).toString('hex');
  const hash = await hashPassword(password);
  const w = openDatabase(dbPath);
  w.prepare(`INSERT INTO users (username, name, role, password_hash) VALUES ('rehearsal-admin', 'Rehearsal', 'admin', ?)`).run(hash);
  const product = w
    .prepare(
      `SELECT p.id, p.name, p.price_minor AS price, p.currency FROM products p LEFT JOIN units u ON u.id = p.unit_id
       WHERE p.active = 1 AND p.price_minor > 0 AND COALESCE(u.fractional, 0) = 0
       ORDER BY (p.currency = 'USD') DESC, p.price_minor LIMIT 1 OFFSET 20`,
    )
    .get() as { id: number; name: string; price: number; currency: 'USD' | 'LBP' } | undefined;
  const arabic = (w.prepare(`SELECT id, name FROM products WHERE active = 1`).all() as { id: number; name: string }[])
    .map((r) => ({ ...r, part: /[؀-ۿ]{3}/.exec(r.name)?.[0] }))
    .find((r) => r.part);
  w.close();

  const app = await buildApp({ databasePath: dbPath, uploadsDir: imagesDir, printer: { async print() {} } });
  await app.ready();
  try {
    const call = async (method: 'GET' | 'POST', url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) => {
      const res = await app.inject({
        method,
        url,
        payload: payload as object | undefined,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      });
      let json: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any -- an answer is only read, field by field, below
      try {
        json = res.json();
      } catch {
        /* text answer */
      }
      return { status: res.statusCode, json, text: res.body };
    };

    check('the server says it is ready on this data', (await call('GET', '/api/v1/readyz')).status === 200);
    const login = await call('POST', '/api/v1/auth/login', undefined, { username: 'rehearsal-admin', password });
    check('sign-in works', login.status === 200, `status ${login.status}`);
    const token = login.json.accessToken as string;

    const rate = await call('GET', '/api/v1/exchange-rates/current', token);
    check('an exchange rate is in force', rate.status === 200 && n(rate.json.rateLbpPerUsd) > 0, `status ${rate.status}`);

    if (arabic) {
      const q = arabic.part!;
      const found = await call('GET', `/api/v1/products?q=${encodeURIComponent(q)}&limit=200`, token);
      check(
        'an Arabic product name is found by searching for part of it',
        (found.json.data as { id: number }[] | undefined)?.some((p) => p.id === arabic.id) === true,
        `searched "${q}"`,
      );
    } else info('no product with an Arabic name in this data');

    const dash = await call('GET', '/api/v1/reports/dashboard', token);
    check('the dashboard opens on this data', dash.status === 200, `status ${dash.status}`);
    const sales = await call('GET', '/api/v1/sales?limit=1', token);
    check('the sales list opens and starts with the newest sale', sales.status === 200 && (sales.json.data as unknown[]).length === 1);

    if (!product) return info('no suitable product for a test sale (an active product with a price that is not sold by weight)');
    // Every legacy product is priced in dollars: the till sends what it shows, the price converted at the rate in force.
    const unitPriceLbp = product.currency === 'USD' ? usdToLbp(product.price, n(rate.json.rateLbpPerUsd)) : product.price;
    const opening = ['cash', 'whish', 'omt'].flatMap((method) =>
      (['USD', 'LBP'] as const).map((currency) => ({ method, currency, amount: 0 })),
    );
    let reg = await call('POST', '/api/v1/registers/open', token, { terminalId: 'T1', openingBalances: opening });
    if (reg.status === 409) {
      // The old app's open register session comes across with the import. On cut-over day it is counted and closed first.
      info('the old app’s open register came across with the import: counting and closing it first, as the runbook says');
      const old = await call('GET', '/api/v1/registers/current', token);
      const counted = (old.json.balances as { method: string; currency: string; expected: number }[]).map((b) => ({
        method: b.method,
        currency: b.currency,
        amount: b.expected,
      }));
      const closedOld = await call('POST', `/api/v1/registers/${old.json.id}/close`, token, { countedBalances: counted });
      check('the old app’s open register can be counted and closed', closedOld.status === 200, `status ${closedOld.status}`);
      reg = await call('POST', '/api/v1/registers/open', token, { terminalId: 'T1', openingBalances: opening });
    }
    check('a new register can be opened', reg.status === 201, `status ${reg.status}`);
    const key = randomUUID();
    const body = {
      clientSaleId: randomUUID(),
      customerId: 1,
      items: [{ productId: product.id, qty: '1', unitPriceLbp }],
      payments: [{ method: 'cash', currency: 'LBP', amount: Math.ceil(unitPriceLbp / 5000) * 5000 + 5000 }],
    };
    const sale = await call('POST', '/api/v1/sales', token, body, { 'idempotency-key': key });
    check(
      `a sale of "${product.name}" goes through`,
      sale.status === 201,
      `status ${sale.status}${sale.status === 201 ? '' : ` ${JSON.stringify(sale.json).slice(0, 200)}`}`,
    );
    if (sale.status === 201) {
      const replay = await call('POST', '/api/v1/sales', token, body, { 'idempotency-key': key });
      check(
        'sending the same sale again answers with the first and records nothing more',
        replay.status === 200 && replay.json.id === sale.json.id,
      );
      const receipt = await call('GET', `/api/v1/sales/${sale.json.id}/receipt?format=text`, token);
      check(
        'its receipt prints as plain ASCII',
        receipt.status === 200 && [...receipt.text].every((ch) => ch.charCodeAt(0) < 128) && receipt.text.includes(`#${sale.json.ref}`),
        `receipt ${sale.json.ref}`,
      );
    }
    const cur = await call('GET', '/api/v1/registers/current', token);
    const counted = (cur.json.balances as { method: string; currency: string; expected: number }[]).map((b) => ({
      method: b.method,
      currency: b.currency,
      amount: b.expected,
    }));
    const closed = await call('POST', `/api/v1/registers/${cur.json.id}/close`, token, { countedBalances: counted });
    check('the register closes with no difference', closed.status === 200, `status ${closed.status}`);
  } finally {
    await app.close();
  }
}

async function restoreStep() {
  const backups = join(dir, 'backups');
  const passphrase = randomBytes(12).toString('hex');
  const db = new Database(dbPath, { readonly: true });
  let made;
  try {
    made = await createBackup(db, { dir: backups, passphrase, uploadsDir: imagesDir });
  } finally {
    db.close();
  }
  check('a backup is made, encrypted and verified', made.encrypted && made.bytes > 0, `${(made.bytes / 1_048_576).toFixed(1)} MB`);
  const target = join(dir, 'restored', 'pos.db');
  mkdirSync(dirname(target), { recursive: true });
  await restoreBackup({ from: made.path, to: target, passphrase });
  const a = fingerprint(dbPath);
  const b = fingerprint(target);
  check(
    'the restored copy is the same shop (row counts, ids, sales totals, balances)',
    a.hash === b.hash,
    a.hash === b.hash ? `fingerprint ${a.hash}` : `${JSON.stringify(a.parts)} vs ${JSON.stringify(b.parts)}`,
  );
  invariants('restored copy', target);
  let wrong = false;
  try {
    await restoreBackup({ from: made.path, to: join(dir, 'wrong', 'pos.db'), passphrase: 'not-the-right-passphrase' });
  } catch {
    wrong = true;
  }
  check('a wrong passphrase restores nothing', wrong && !existsSync(join(dir, 'wrong', 'pos.db')));
}

// ------------------------------------------------------------------ main

let exit = 0;
try {
  say(`Cut-over rehearsal. Working in ${dir} (deleted at the end${keep ? ', except that --keep was given' : ''}).`);
  const report = await timed('1. Import the dump into a new database', importStep);
  await timed('2. Does the imported shop add up?', () => invariants('imported', dbPath));
  await timed('3. Does the till work on it?', smokeStep);
  await timed('4. After selling: does it still add up?', () => invariants('after the test sale', dbPath));
  await timed('5. Can a backup of it be restored?', restoreStep);

  step = 'summary';
  say('\nFor a person to look at before the real cut-over (the full list is in the report):');
  const todo: [number, string][] = [
    [report.users.length, 'users need a new password (the old ones are never carried over)'],
    [report.walkInDebts.length, 'sales where Walk-In still owed money (moved to a placeholder customer)'],
    [report.duplicateBarcodes.length, 'barcodes shared by several products (cleaned up in the last milestone)'],
    [
      report.reconciliation.inconsistentSales.length,
      'sales whose total differs from their lines by 5,000 LBP or more (imported as they were)',
    ],
    [report.reconciliation.salesWithoutLines.length, 'sales with no lines in the dump'],
    [report.negativeStock.length, 'products with negative stock (allowed; stock never blocks a sale)'],
    [report.receiptNames.transliterated, 'Arabic product names got an automatic English receipt name to review'],
    [report.images.missing.length, 'product pictures are missing from the Uploads folder'],
    [report.images.notPictures.length, 'product "pictures" are saved web pages (those products have none)'],
    [report.unmatchedLines.sale.unmatched, 'sale lines matched no product (kept with their name and price)'],
  ];
  for (const [count, text] of todo) say(`  ${String(count).padStart(6)}  ${text}`);
  info(
    `legacy exchange rate: ${report.exchangeRate.legacy} (${report.exchangeRate.action}); registers: ${report.registers.note || report.registers.openSession}`,
  );

  const failed = checks.filter((c) => !c.ok);
  const out = flag('report');
  if (out)
    writeFileSync(resolve(out), JSON.stringify({ at: new Date().toISOString(), dump: dumpPath, timings, checks, etl: report }, null, 2));
  say(
    `\n${checks.length - failed.length} of ${checks.length} checks passed. Times: ${Object.entries(timings)
      .map(([k, v]) => `${k.split('.')[0]}: ${v}s`)
      .join(', ')}.`,
  );
  if (failed.length) {
    say('\nFAILED:');
    for (const f of failed) say(`  ${f.step} / ${f.name}: ${f.detail}`);
    say('\nDo not cut over until these are understood.');
    exit = 1;
  } else say('\nEverything checked passed. The cut-over steps are in docs/10-cutover.md.');
} catch (err) {
  say(`\nThe rehearsal stopped: ${(err as Error).message}`);
  exit = 1;
} finally {
  if (keep) say(`\nKept: ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
}
process.exit(exit);
