// Is this PC ready for opening day? Reads the real settings and the real database (read-only) and says what is missing.
//
//   npm run preflight -w @pos/api -- [--env C:\POS\service.env] [--url http://127.0.0.1:3000]
//
// --env   reads the service's settings file (the one install-service.ps1 wrote), so the check sees what the service sees
// --url   where the running server is (default: this PC, PORT). Not running is fine before the first start.
// FAIL = do not open the shop like this. WARN = works, but you should know. Exit code 1 only when something FAILED.
// See docs/10-cutover.md. It never prints a password, a secret or a passphrase.
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { listBackups } from '../backup/backup';
import { STALE_AFTER_MS } from '../backup/service';
import { loadConfig } from '../config';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

// The service's own settings file: KEY=VALUE lines.
const envFile = flag('env');
const env: NodeJS.ProcessEnv = { ...process.env };
if (envFile) {
  if (!existsSync(envFile)) {
    process.stderr.write(`There is no settings file at ${envFile}\n`);
    process.exit(2);
  }
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) env[m[1]!] = m[2]!.replace(/^"(.*)"$/, '$1');
  }
}

type Level = 'PASS' | 'WARN' | 'FAIL';
const results: { level: Level; what: string; detail: string }[] = [];
const say = (m = '') => process.stdout.write(`${m}\n`);
const report = (level: Level, what: string, detail = '') => {
  results.push({ level, what, detail });
  say(`  ${level}  ${what}${detail ? `: ${detail}` : ''}`);
};
const section = (title: string) => say(`\n${title}`);
const days = (iso: string) => (Date.now() - new Date(iso).getTime()) / 86_400_000;

async function main() {
  // ---- the PC
  section('This PC');
  const major = Number(/^v(\d+)\./.exec(process.version)?.[1]);
  report(major >= 22 ? 'PASS' : 'FAIL', 'Node.js is 22 or newer', process.version);

  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig({ ...env, NODE_ENV: 'production' });
    report('PASS', 'the service has a real JWT_SECRET (production settings load)');
  } catch (e) {
    report('FAIL', 'the service settings are not valid for production', (e as Error).message);
    config = loadConfig({ ...env, JWT_SECRET: 'x'.repeat(40) });
  }
  const dbPath = resolve(config.databasePath);
  const uploads = config.uploadsDir ?? join(dirname(dbPath), 'uploads');

  // ---- the database
  section('The database');
  if (!existsSync(dbPath)) {
    report('FAIL', 'the database file exists', `nothing at ${dbPath}. Import the old data (npm run etl) or create an admin first`);
    return;
  }
  report('PASS', 'the database file exists', `${dbPath}, ${(statSync(dbPath).size / 1_048_576).toFixed(1)} MB`);
  try {
    const free = statfsSync(dirname(dbPath));
    const gb = (free.bavail * free.bsize) / 1_073_741_824;
    report(gb >= 5 ? 'PASS' : gb >= 1 ? 'WARN' : 'FAIL', 'room on the disk that holds it', `${gb.toFixed(1)} GB free`);
  } catch {
    report('WARN', 'room on the disk that holds it', 'could not be read');
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    report(db.pragma('quick_check', { simple: true }) === 'ok' ? 'PASS' : 'FAIL', 'the database file is not damaged', 'PRAGMA quick_check');
    const files = readdirSync(join(import.meta.dirname, '..', 'db', 'migrations'))
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const last = (db.prepare('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1').get() as { name: string } | undefined)?.name;
    report(
      last === files.at(-1) ? 'PASS' : 'WARN',
      'the database is on the newest version',
      `${last ?? 'none'}${last === files.at(-1) ? '' : ` (newest is ${files.at(-1)}; it updates itself when the service starts)`}`,
    );

    // ---- people
    section('People');
    const users = db.prepare('SELECT username, role, active, must_reset_password AS reset FROM users').all() as {
      username: string;
      role: string;
      active: number;
      reset: number;
    }[];
    const active = users.filter((u) => u.active === 1);
    report(
      active.some((u) => u.role === 'admin') ? 'PASS' : 'FAIL',
      'there is an active admin',
      `${active.filter((u) => u.role === 'admin').length}`,
    );
    report(
      active.some((u) => u.role === 'manager' || u.role === 'admin') ? 'PASS' : 'FAIL',
      'someone can approve a discount or a return',
      'a manager or an admin',
    );
    report(
      active.some((u) => u.role === 'cashier') ? 'PASS' : 'WARN',
      'there is an active cashier',
      `${active.filter((u) => u.role === 'cashier').length}`,
    );
    const pending = active.filter((u) => u.reset === 1).map((u) => u.username);
    report(
      pending.length === 0 ? 'PASS' : 'WARN',
      'nobody is waiting to choose a password',
      pending.length ? `${pending.join(', ')} must change theirs at the next sign-in` : '',
    );
    say(`        users: ${users.map((u) => `${u.username} (${u.role}${u.active ? '' : ', inactive'})`).join(', ')}`);

    // ---- money settings
    section('Money and receipts');
    const rate = db
      .prepare(
        'SELECT rate_lbp_per_usd AS rate, effective_from AS since FROM exchange_rates WHERE effective_from <= ? ORDER BY effective_from DESC LIMIT 1',
      )
      .get(new Date().toISOString()) as { rate: number; since: string } | undefined;
    report(
      rate ? 'PASS' : 'FAIL',
      'an exchange rate is in force',
      rate ? `${rate.rate.toLocaleString('en-US')} LBP per USD since ${rate.since.slice(0, 10)}` : 'set one on the Exchange rate page',
    );
    if (rate)
      report(
        days(rate.since) <= 7 ? 'PASS' : 'WARN',
        'the rate was set in the last 7 days',
        `${Math.floor(days(rate.since))} days ago. Confirm today's rate before the first sale`,
      );
    const store = db.prepare('SELECT name, printer_name AS printer, lbp_rounding AS rounding FROM store_settings WHERE id = 1').get() as {
      name: string;
      printer: string | null;
      rounding: number;
    };
    report(store.name && store.name !== 'Store' ? 'PASS' : 'WARN', 'the shop name is set (it prints on every receipt)', store.name);
    report(store.rounding === 5000 ? 'PASS' : 'WARN', 'totals round to 5,000 LBP', `${store.rounding}`);
    if (!store.printer)
      report('WARN', 'a receipt printer is chosen', 'none yet: Settings → printer. Without one, receipts print from the browser');
    else if (process.platform !== 'win32') report('WARN', `the printer "${store.printer}" exists`, 'not checked (only on Windows)');
    else {
      const ps = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-Printer -Name $env:POS_PREFLIGHT_PRINTER -ErrorAction Stop).Name`],
        {
          encoding: 'utf8',
          env: { ...process.env, POS_PREFLIGHT_PRINTER: store.printer },
          timeout: 15_000,
        },
      );
      report(
        ps.status === 0 ? 'PASS' : 'FAIL',
        `Windows has a printer called "${store.printer}"`,
        ps.status === 0 ? '' : 'install it, or choose another in Settings',
      );
    }

    // ---- the till
    section('The till');
    const open = db.prepare(`SELECT id, opened_at AS at FROM register_sessions WHERE status = 'open'`).all() as {
      id: number;
      at: string;
    }[];
    for (const s of open)
      report(
        days(s.at) > 1 ? 'WARN' : 'PASS',
        `register ${s.id} is open`,
        days(s.at) > 1
          ? `since ${s.at.slice(0, 16)}: count and close it before opening day, so a fresh one can be opened`
          : `since ${s.at.slice(0, 16)}`,
      );
    if (open.length === 0) report('PASS', 'no register is left open', 'the first cashier opens one');
    const dup = (
      db
        .prepare(
          `SELECT count(*) AS c FROM (SELECT barcode FROM products WHERE active = 1 AND barcode <> '' GROUP BY barcode HAVING count(*) > 1)`,
        )
        .get() as { c: number }
    ).c;
    report(
      dup === 0 ? 'PASS' : 'WARN',
      'no barcode is shared by two products',
      dup ? `${dup} are (a scan finds both; cleaned up in the last milestone)` : '',
    );
    const noPrice = (db.prepare(`SELECT count(*) AS c FROM products WHERE active = 1 AND price_minor = 0`).get() as { c: number }).c;
    report(noPrice === 0 ? 'PASS' : 'WARN', 'every active product has a price', noPrice ? `${noPrice} sell for nothing` : '');
    const pics = db.prepare(`SELECT image_path AS p FROM products WHERE image_path IS NOT NULL`).all() as { p: string }[];
    const missing = pics.filter((r) => !existsSync(join(uploads, basename(r.p)))).length;
    report(
      missing === 0 ? 'PASS' : 'WARN',
      'every product picture is in the pictures folder',
      `${pics.length - missing} of ${pics.length}${missing ? `, ${missing} missing from ${uploads}` : ''}`,
    );
  } finally {
    db.close();
  }

  // ---- backups
  section('Backups');
  if (!config.backupDir) report('FAIL', 'a backup folder is set (BACKUP_DIR)', 'without it nothing is backed up');
  else {
    const dir = resolve(config.backupDir);
    let writable = false;
    try {
      const probe = join(dir, `.preflight-${process.pid}`);
      writeFileSync(probe, 'x');
      rmSync(probe);
      writable = true;
    } catch {
      /* reported below */
    }
    report(writable ? 'PASS' : 'FAIL', 'the backup folder can be written to', dir);
    const list = await listBackups(dir);
    if (list.length === 0) report('WARN', 'there is a backup in it', 'none yet: take one now (npm run backup)');
    else
      report(
        Date.now() - new Date(list[0]!.modifiedAt).getTime() < STALE_AFTER_MS ? 'PASS' : 'WARN',
        'the newest backup is recent',
        `${list[0]!.file}, ${list[0]!.modifiedAt.slice(0, 16)}`,
      );
  }
  report(
    config.backupPassphrase ? 'PASS' : 'WARN',
    'backups are encrypted (BACKUP_PASSPHRASE)',
    config.backupPassphrase ? '' : 'they are plain files: anyone who takes the disk can read every sale',
  );
  report(
    config.backupCopyDir ? 'PASS' : 'WARN',
    'a second copy of each backup goes somewhere else (BACKUP_COPY_DIR)',
    config.backupCopyDir ?? 'one disk failing would lose both the data and the backups',
  );

  // ---- the app itself
  section('The app');
  const web = config.webDist ? resolve(config.webDist) : undefined;
  report(
    web && existsSync(join(web, 'index.html')) ? 'PASS' : 'FAIL',
    'the built web app is there (WEB_DIST)',
    web ?? 'not set: run npm run build and set WEB_DIST',
  );
  if (web) report(existsSync(join(web, 'sw.js')) ? 'PASS' : 'WARN', 'the offline service worker was built', '');
  report(
    config.host === '127.0.0.1' || config.host === 'localhost' ? 'PASS' : 'WARN',
    'the server listens on this PC only',
    `${config.host}${config.allowedHosts.length ? ` (also answers to ${config.allowedHosts.join(', ')})` : ''}`,
  );
  const url = flag('url') ?? `http://127.0.0.1:${config.port}`;
  try {
    const res = await fetch(`${url}/api/v1/readyz`, { signal: AbortSignal.timeout(2000) });
    report(res.ok ? 'PASS' : 'FAIL', 'the server is running and ready', `${url} answered ${res.status}`);
  } catch {
    report('WARN', 'the server is running and ready', `nothing answered at ${url} (fine if you have not started it yet)`);
  }
}

await main();
const fails = results.filter((r) => r.level === 'FAIL');
const warns = results.filter((r) => r.level === 'WARN');
say(`\n${results.length - fails.length - warns.length} passed, ${warns.length} to look at, ${fails.length} failed.`);
if (fails.length) {
  say('Do not open the shop until the FAILs are fixed:');
  for (const f of fails) say(`  - ${f.what}${f.detail ? `: ${f.detail}` : ''}`);
}
process.exitCode = fails.length ? 1 : 0;
