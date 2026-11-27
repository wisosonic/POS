// The whole chain, each project in its OWN sandbox, talking only over HTTP (docs/11-multi-branch.md §8.1, §8.5).
//
//   node scripts/sandbox-chain.mjs [--keep] [--skip-till-build]
//
// What it does (nothing here touches the repo's own folders, data or node_modules):
//   1. Copies each project folder (without node_modules, tests, data, build output) into its own folder under the system temp
//      folder, as if it had been carried to its own machine: hq/, branch-a/, branch-b/, till/. Then runs `npm ci` in each, alone,
//      and builds the till. If a project needs anything from outside its folder, this is where it fails.
//   2. Starts five programs, each from its own sandbox with its own data folder: HQ, branch A, branch B, and the till's own
//      server (in front of branch A).
//   3. Drives the shop through the TILL'S address only, like a person would, and HQ and the branches through their own
//      addresses: set the till's branch server address, connect the branches to HQ, enrol the till, sign in, sell, check HQ holds
//      exactly what each branch holds, change the rate at HQ and watch it reach both branches, stop HQ and keep selling then
//      catch up, stop the branch and see the till say so.
// The sync loop runs at its real pace (10 s), so the whole run takes several minutes. --keep leaves the sandboxes and their logs in
// place (the path is printed) so a failure can be looked at.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, openSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = process.argv.includes('--keep');
const PORTS = { hq: 4101, a: 3101, b: 3102, till: 8101 };
const ADMIN_PW = 'sandbox-admin-pass-1';
const CASHIER_PW = 'sandbox-cashier-pass-1';
const HQ_PW = 'sandbox-hq-admin-pass-1';
// HQ has no break-glass token here: its staff sign in with their own account (P3d), and this is that person's session token once HQ is up.
let HQ_TOKEN = '';
const JWT = randomBytes(32).toString('hex');

const root = mkdtempSync(join(tmpdir(), 'pos-sandbox-'));
const box = (name) => join(root, name);
const results = [];
const children = [];
let current = '';

// ---------------------------------------------------------------- reporting
const t0 = Date.now();
const stamp = () => `${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s`;
const say = (m) => process.stdout.write(`${stamp()}  ${m}\n`);
async function step(name, fn) {
  current = name;
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    say(`ok      ${name}  (${Math.round((Date.now() - started) / 1000)}s)`);
  } catch (e) {
    results.push({ name, ok: false, why: e.message });
    say(`FAILED  ${name}\n          ${e.message}`);
    throw e;
  }
}
const check = (cond, message) => {
  if (!cond) throw new Error(message);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 45_000, every = 500) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(every);
  }
  throw new Error(`gave up waiting (${Math.round(ms / 1000)}s) for: ${what}${last instanceof Error ? ` (last error: ${last.message})` : ''}`);
}

// ---------------------------------------------------------------- the sandboxes
const SKIP_SEGMENTS = new Set(['node_modules', 'dist', 'test-results', 'playwright-report', 'coverage']);
const SKIP_TOP = new Set(['tests', 'data', 'backups', 'web/tests', 'agent/tests']);
function copyProject(project, dest) {
  const from = join(repo, project);
  cpSync(from, dest, {
    recursive: true,
    filter: (src) => {
      const rel = relative(from, src).split(sep).join('/');
      if (rel === '') return true;
      if (rel.split('/').some((s) => SKIP_SEGMENTS.has(s))) return false;
      return !SKIP_TOP.has(rel);
    },
  });
}
function run(cwd, cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed in ${cwd}\n${(r.stderr || r.stdout || '').split('\n').slice(-15).join('\n')}`);
  return r.stdout;
}
const npm = (cwd, args) => run(cwd, 'npm', args);
function runAsync(cwd, cmd, args) {
  return new Promise((resolveRun, reject) => {
    const c = spawn(cmd, args, { cwd, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('exit', (code) => (code === 0 ? resolveRun() : reject(new Error(`${cmd} ${args.join(' ')} failed in ${cwd}\n${out.split('\n').slice(-15).join('\n')}`))));
  });
}

// ---------------------------------------------------------------- the programs
const taken = (port) =>
  new Promise((done) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => (s.destroy(), done(true)));
    s.once('error', () => done(false));
    s.setTimeout(800, () => (s.destroy(), done(false)));
  });
const programs = {};
function start(name, cwd, args, env) {
  mkdirSync(join(box(cwd), 'logs'), { recursive: true });
  const log = openSync(join(box(cwd), 'logs', `${name}.log`), 'a');
  const child = spawn(process.execPath, ['--import', 'tsx', ...args], {
    cwd: box(cwd),
    env: { ...process.env, FORCE_COLOR: '0', HOST: '127.0.0.1', ...env },
    stdio: ['ignore', log, log],
  });
  programs[name] = { child, cwd, args, env };
  children.push(child);
}
function stop(name) {
  const p = programs[name];
  if (!p || p.child.exitCode !== null) return Promise.resolve();
  return new Promise((done) => {
    p.child.once('exit', () => done());
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(p.child.pid), '/T', '/F'], { stdio: 'ignore' });
    else p.child.kill('SIGTERM');
    setTimeout(done, 5000);
  });
}
function restart(name) {
  const p = programs[name];
  start(name, p.cwd, p.args, p.env);
}
const tail = (name, n = 14) => {
  try {
    return readFileSync(join(box(programs[name].cwd), 'logs', `${name}.log`), 'utf8').split('\n').slice(-n).join('\n');
  } catch {
    return '';
  }
};

// ---------------------------------------------------------------- talking HTTP
const url = { hq: `http://127.0.0.1:${PORTS.hq}`, a: `http://127.0.0.1:${PORTS.a}`, b: `http://127.0.0.1:${PORTS.b}`, till: `http://127.0.0.1:${PORTS.till}` };
async function http(method, base, path, { token, body, headers = {}, terminal } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(terminal ? { 'X-Terminal-Token': terminal } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, body: await res.json().catch(() => ({})), headers: res.headers };
}
const must = (r, status, what) => {
  check(r.status === status, `${what}: expected ${status}, got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body;
};
const login = async (base, username, password) => must(await http('POST', base, '/api/v1/auth/login', { body: { username, password } }), 200, `sign in ${username} at ${base}`).accessToken;
const healthy = async (base, path = '/api/v1/healthz') => {
  try {
    return (await fetch(`${base}${path}`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------- the run
async function main() {
  say(`sandboxes in ${root}`);
  for (const [name, port] of Object.entries(PORTS)) check(!(await taken(port)), `port ${port} (${name}) is already in use: close the other program first`);

  await step('each project is copied alone into its own sandbox and installed there with nothing else from the repo', async () => {
    copyProject('cloud-hq', box('hq'));
    copyProject('branch-server', box('branch-a'));
    copyProject('till', box('till'));
    await Promise.all([runAsync(box('hq'), 'npm', ['ci', '--no-audit', '--no-fund']), runAsync(box('branch-a'), 'npm', ['ci', '--no-audit', '--no-fund']), runAsync(box('till'), 'npm', ['ci', '--no-audit', '--no-fund'])]);
    // The second branch is a second machine: a copy of the first one's installed folder.
    cpSync(box('branch-a'), box('branch-b'), { recursive: true });
    for (const d of ['hq', 'branch-a', 'branch-b', 'till']) check(existsSync(join(box(d), 'node_modules')), `${d} has no node_modules`);
  });

  if (!process.argv.includes('--skip-till-build'))
    await step('the till builds its screens from its own folder', async () => {
      await runAsync(box('till'), 'npm', ['run', 'build']);
      check(existsSync(join(box('till'), 'web', 'dist', 'index.html')), 'till/web/dist/index.html was not made');
    });

  await step('HQ and the two branch servers get their own admin account in their own database', async () => {
    run(box('hq'), 'node', ['--import', 'tsx', 'src/cli/create-admin.ts', 'hqadmin', HQ_PW], { DATABASE_PATH: join(box('hq'), 'data', 'hq.db') });
    for (const d of ['branch-a', 'branch-b'])
      run(box(d), 'node', ['--import', 'tsx', 'src/cli/create-admin.ts', 'admin', ADMIN_PW], { DATABASE_PATH: join(box(d), 'data', 'pos.db') });
  });

  await step('HQ, branch A, branch B and the till start, each from its own sandbox, and answer', async () => {
    start('hq', 'hq', ['src/index.ts'], { PORT: String(PORTS.hq), DATABASE_PATH: join(box('hq'), 'data', 'hq.db') });
    for (const [n, d] of [['a', 'branch-a'], ['b', 'branch-b']])
      start(`branch-${n}`, d, ['src/index.ts'], {
        PORT: String(PORTS[n]),
        DATABASE_PATH: join(box(d), 'data', 'pos.db'),
        BACKUP_DIR: join(box(d), 'data', 'backups'),
        UPLOADS_DIR: join(box(d), 'data', 'uploads'),
        JWT_SECRET: JWT,
      });
    // The till knows no branch server yet: its address is set later, through its own settings.
    start('till', 'till', ['agent/src/cli.ts', 'serve'], { PORT: String(PORTS.till), TILL_DATA_DIR: join(box('till'), 'data'), WEB_DIST: join(box('till'), 'web', 'dist') });
    for (const [base, path] of [[url.hq, '/api/v1/healthz'], [url.a, '/api/v1/healthz'], [url.b, '/api/v1/healthz'], [url.till, '/till/health']])
      await until(`${base}${path} answers`, () => healthy(base, path), 60_000);
    // HQ staff sign in with a name and password (no token); a wrong password is refused, and an anonymous request too.
    check((await http('POST', url.hq, '/api/v1/auth/login', { body: { username: 'hqadmin', password: 'not-the-password-1' } })).status === 401, 'HQ accepted a wrong password');
    check((await http('GET', url.hq, '/api/v1/branches', {})).status === 401, 'HQ answered an anonymous request');
    HQ_TOKEN = must(await http('POST', url.hq, '/api/v1/auth/login', { body: { username: 'hqadmin', password: HQ_PW } }), 200, 'the HQ admin signs in').token;
  });

  let adminA, adminB;
  await step('the till is told where its branch server is, through its own settings, and tests the connection', async () => {
    const before = must(await http('GET', url.till, '/till/health'), 200, 'till health');
    check(before.configured === false, 'the till should not know a branch server yet');
    const refused = await http('GET', url.till, '/api/v1/products');
    check(refused.status === 503 && refused.headers.get('x-till-proxy-error') === 'BRANCH_NOT_CONFIGURED', `an unconfigured till should say so, got ${refused.status}`);
    must(await http('PUT', url.till, '/till/config', { body: { branchServer: `127.0.0.1:${PORTS.a}` } }), 200, 'save the address');
    const test = must(await http('POST', url.till, '/till/test', { body: {} }), 200, 'test the address');
    check(test.ok === true, `the till cannot reach branch A: ${JSON.stringify(test)}`);
  });

  await step('HQ adds the two branches and each branch connects to HQ with its one-time code', async () => {
    adminA = await login(url.a, 'admin', ADMIN_PW);
    adminB = await login(url.b, 'admin', ADMIN_PW);
    for (const [code, base, token] of [['A', url.a, adminA], ['B', url.b, adminB]]) {
      const made = must(await http('POST', url.hq, '/api/v1/branches', { token: HQ_TOKEN, body: { code, name: `Branch ${code}` } }), 201, `HQ adds branch ${code}`);
      must(await http('POST', base, '/api/v1/sync/connect', { token, body: { url: url.hq, code: made.enrolCode } }), 200, `branch ${code} connects`);
    }
    for (const [code, base, token] of [['A', url.a, adminA], ['B', url.b, adminB]])
      await until(`branch ${code} is connected`, async () => (await http('GET', base, '/api/v1/sync/status', { token })).body.state === 'online', 60_000);
  });

  await step('a rate set at HQ reaches both branches by itself (the branches ping HQ every 5 s) and the till shows it', async () => {
    must(await http('POST', url.hq, '/api/v1/exchange-rates', { token: HQ_TOKEN, body: { rateLbpPerUsd: 91000 } }), 201, 'HQ sets the rate');
    for (const [code, base, token] of [['A', url.a, adminA], ['B', url.b, adminB]])
      await until(`branch ${code} has the new rate`, async () => (await http('GET', base, '/api/v1/exchange-rates/current', { token })).body.rateLbpPerUsd === 91000, 45_000);
    const viaTill = await http('GET', url.till, '/api/v1/exchange-rates/current', { token: adminA });
    check(viaTill.body.rateLbpPerUsd === 91000, `the till shows ${JSON.stringify(viaTill.body)}`);
  });

  let terminalToken, cashierA, productA, terminal;
  await step('through the till: the admin signs in, adds a till and enrols this device, adds a cashier and a product', async () => {
    const admin = await login(url.till, 'admin', ADMIN_PW);
    const made = must(await http('POST', url.till, '/api/v1/terminals', { token: admin, body: { name: 'Till 1', code: 'A1' } }), 201, 'add the till');
    terminal = made.terminal;
    const enrol = must(await http('POST', url.till, '/api/v1/terminals/enrol', { token: admin, body: { code: made.enrolCode } }), 200, 'enrol the device');
    terminalToken = enrol.token;
    check(typeof terminalToken === 'string' && terminalToken.length > 20, 'no device token came back');
    must(await http('POST', url.till, '/api/v1/users', { token: admin, terminal: terminalToken, body: { username: 'sara', name: 'Sara', role: 'cashier', password: CASHIER_PW } }), 201, 'add the cashier');
    // Products are HQ's (docs/12 §17): added at HQ, they reach both branches with HQ's id.
    productA = must(
      await http('POST', url.hq, '/api/v1/products', { token: HQ_TOKEN, body: { name: 'Sandbox towel', barcode: '5287000107945', priceMinor: 75000, currency: 'LBP' } }),
      201,
      'HQ adds the product',
    );
    await until('the product reaches branch A, through the till', async () => (await http('GET', url.till, `/api/v1/products/${productA.id}`, { token: admin, terminal: terminalToken })).status === 200, 45_000);
    await until('the product reaches branch B', async () => (await http('GET', url.b, `/api/v1/products/${productA.id}`, { token: adminB })).status === 200, 45_000);
    const refused = await http('POST', url.till, '/api/v1/products', { token: admin, terminal: terminalToken, body: { name: 'Local towel', priceMinor: 1 } });
    check(refused.status === 409 && refused.body.code === 'HQ_OWNS_CATALOG', `a connected branch must not add its own product (answered ${refused.status})`);
    const me = must(await http('GET', url.till, '/api/v1/terminals/me', { token: admin, terminal: terminalToken }), 200, 'who is this till');
    check(me.code === 'A1', `the till says it is ${me.code}`);
  });

  let saleA1;
  // A till holds cash only: Whish and OMT are the branch's wallets (docs/13-branch-wallets.md).
  const openingBalances = ['LBP', 'USD'].map((currency) => ({ method: 'cash', currency, amount: currency === 'LBP' ? 3_000_000 : 7000 }));
  const saleBody = (productId) => ({ clientSaleId: randomUUID(), customerId: 1, items: [{ productId, qty: '1', unitPriceLbp: 75000 }], payments: [{ method: 'cash', currency: 'LBP', amount: 75000 }] });
  await step('through the till: the cashier opens the register and sells; the same sale sent twice is one sale', async () => {
    cashierA = await login(url.till, 'sara', CASHIER_PW);
    must(await http('POST', url.till, '/api/v1/registers/open', { token: cashierA, terminal: terminalToken, body: { terminalId: 'A1', openingBalances } }), 201, 'open the register');
    const key = randomUUID();
    const body = saleBody(productA.id);
    const first = await http('POST', url.till, '/api/v1/sales', { token: cashierA, terminal: terminalToken, body, headers: { 'Idempotency-Key': key } });
    saleA1 = must(first, 201, 'sell');
    const again = await http('POST', url.till, '/api/v1/sales', { token: cashierA, terminal: terminalToken, body, headers: { 'Idempotency-Key': key } });
    check(again.status === 200 || again.status === 201, `the replay answered ${again.status}`);
    check(again.body.id === saleA1.id || again.body.data?.id === saleA1.id, 'the replay made a second sale');
    const list = must(await http('GET', url.a, '/api/v1/sales?limit=50', { token: adminA }), 200, 'branch A lists its sales');
    check(list.data.length === 1, `branch A holds ${list.data.length} sales, expected exactly 1`);
  });

  const inSync = async (base, token) => (await http('GET', base, '/api/v1/sync/verify', { token })).body.inSync === true;
  await step('HQ ends up holding exactly what branch A holds (checked by fingerprint of every synced table)', async () => {
    await until('branch A and HQ agree', () => inSync(url.a, adminA), 60_000);
  });

  await step('through the till: a sale paid by Whish goes to the branch wallet, and the admin counts the wallets (the first count is a baseline, the next shows the difference)', async () => {
    const adminT = await login(url.till, 'admin', ADMIN_PW);
    const wallet = (list, method, currency) => list.data.find((w) => w.method === method && w.currency === currency);
    const sellByWhish = async () =>
      must(
        await http('POST', url.till, '/api/v1/sales', {
          token: cashierA,
          terminal: terminalToken,
          body: { ...saleBody(productA.id), payments: [{ method: 'whish', currency: 'LBP', amount: 75000 }] },
          headers: { 'Idempotency-Key': randomUUID() },
        }),
        201,
        'sell by Whish',
      );
    const countAll = async (whishLbp) =>
      must(
        await http('POST', url.till, '/api/v1/wallets/counts', {
          token: adminT,
          terminal: terminalToken,
          body: {
            balances: [
              { method: 'whish', currency: 'LBP', amount: whishLbp },
              { method: 'whish', currency: 'USD', amount: 0 },
              { method: 'omt', currency: 'LBP', amount: 0 },
              { method: 'omt', currency: 'USD', amount: 0 },
            ],
          },
        }),
        201,
        'count the wallets',
      );
    const before = must(await http('GET', url.till, '/api/v1/wallets', { token: adminT, terminal: terminalToken }), 200, 'read the wallets');
    const start = wallet(before, 'whish', 'LBP').expected;
    await sellByWhish();
    const after = must(await http('GET', url.till, '/api/v1/wallets', { token: adminT, terminal: terminalToken }), 200, 'read the wallets again');
    check(wallet(after, 'whish', 'LBP').expected === start + 75000, `the wallet should hold ${start + 75000}, it holds ${wallet(after, 'whish', 'LBP').expected}`);
    // The cashier may not read or count the branch wallets.
    check((await http('GET', url.till, '/api/v1/wallets', { token: cashierA, terminal: terminalToken })).status === 403, 'a cashier read the wallets');
    const baseline = await countAll(start + 75000);
    check(Object.keys(baseline.variances).length === 0, 'the first count should only set a baseline');
    await sellByWhish();
    const second = await countAll(start + 150000 - 5000);
    check(second.variances['whish/LBP'] === -5000, `expected a difference of -5000, got ${JSON.stringify(second.variances)}`);
    check(wallet(second, 'whish', 'LBP').expected === start + 150000 - 5000, 'the wallet should start again from what was counted');
    // Selling by wallet did not touch the till's own cash: the register closes on cash alone.
    await until('branch A and HQ agree after the wallet sales', () => inSync(url.a, adminA), 60_000);
  });

  let productB;
  await step('branch B sells too: both branches have a sale with the same id, and HQ keeps them apart and agrees with both', async () => {
    productB = productA; // the same product, under HQ's id, already at branch B
    must(await http('POST', url.b, '/api/v1/users', { token: adminB, body: { username: 'omar', name: 'Omar', role: 'cashier', password: CASHIER_PW } }), 201, 'B adds the cashier');
    const cashierB = await login(url.b, 'omar', CASHIER_PW);
    // Branch B has one till and none enrolled: the legacy single-till mode, so no device token is needed.
    must(await http('POST', url.b, '/api/v1/registers/open', { token: cashierB, body: { terminalId: 'T1', openingBalances } }), 201, 'B opens the register');
    const saleB = must(await http('POST', url.b, '/api/v1/sales', { token: cashierB, body: saleBody(productB.id), headers: { 'Idempotency-Key': randomUUID() } }), 201, 'B sells');
    check(saleB.id === saleA1.id, `expected the same sale id in both branches (A ${saleA1.id}, B ${saleB.id})`);
    await until('branch B and HQ agree', () => inSync(url.b, adminB), 60_000);
    check(await inSync(url.a, adminA), 'branch A and HQ stopped agreeing after branch B sent its sale');
  });

  await step('HQ goes away: the till keeps selling; when HQ is back both branches catch up with nothing lost or doubled', async () => {
    await stop('hq');
    check(!(await healthy(url.hq)), 'HQ should be stopped');
    const sold = [];
    for (let i = 0; i < 3; i++) sold.push(must(await http('POST', url.till, '/api/v1/sales', { token: cashierA, terminal: terminalToken, body: saleBody(productA.id), headers: { 'Idempotency-Key': randomUUID() } }), 201, 'sell while HQ is away'));
    check(new Set(sold.map((s) => s.id)).size === 3, 'the sales while HQ was away did not get their own ids');
    await sleep(12_000); // a full sync interval with HQ down: the branch must stay up and keep its backlog
    check((await http('GET', url.a, '/api/v1/sync/status', { token: adminA })).status === 200, 'branch A stopped answering while HQ was away');
    restart('hq');
    await until('HQ answers again', () => healthy(url.hq), 60_000);
    await until('branch A and HQ agree after the outage', () => inSync(url.a, adminA), 90_000);
    check(await inSync(url.b, adminB), 'branch B disagrees with HQ after the outage');
  });

  await step('the till copies the catalog onto its own disk by itself and follows a price changed at HQ (docs/14 step 3, docs/12 §17)', async () => {
    const catalogOf = async () => (await http('GET', url.till, '/till/catalog', {})).body;
    await until('the till reports a complete catalog copy', async () => (await catalogOf()).ready === true, 30_000);
    const feed = async () => (await http('GET', url.till, '/api/v1/products/sync?limit=500', { terminal: terminalToken })).body;
    const towel = async () => (await feed()).data.find((p) => p.id === productA.id);
    const first = await towel();
    check(first && first.priceMinor === 75000, `the till's copy should hold the towel at 75000, got ${JSON.stringify(first)}`);
    check(first.costMinor === 0 && first.qty === '0', 'the till copy must not carry the cost or the stock');
    must(await http('PATCH', url.hq, `/api/v1/products/${productA.id}`, { token: HQ_TOKEN, body: { priceMinor: 76000 } }), 200, 'HQ changes the price');
    await until('the till copy follows the price change', async () => (await towel())?.priceMinor === 76000, 30_000);
    must(await http('PATCH', url.hq, `/api/v1/products/${productA.id}`, { token: HQ_TOKEN, body: { priceMinor: 75000 } }), 200, 'HQ puts the price back');
    await until('the till copy follows the price back', async () => (await towel())?.priceMinor === 75000, 30_000);
  });

  await step('the branch server goes away: the till says so in a way the screens treat as offline; when it is back the till works again', async () => {
    // The till watches its branch server by itself (docs/14): with its device token it pings, and the answer is what stops selling.
    const linkOf = async () => (await http('GET', url.till, '/till/link', { terminal: terminalToken })).body;
    await until('the till reports the branch server as connected, by ping', async () => {
      const l = await linkOf();
      return l.state === 'connected' && l.watching === 'ping' && l.blocked === false;
    }, 20_000);
    await stop('branch-a');
    await until('the till reports selling blocked once the branch server stops answering', async () => (await linkOf()).blocked === true, 20_000);
    const r = await http('POST', url.till, '/api/v1/sales', { token: cashierA, terminal: terminalToken, body: saleBody(productA.id), headers: { 'Idempotency-Key': randomUUID() } });
    check(r.status === 502 && r.headers.get('x-till-proxy-error') === 'BRANCH_UNREACHABLE', `expected the till's own 502 mark, got ${r.status}`);
    // The catalog copy is on the till's own disk: scanning and searching still have their prices while the branch server is away.
    const copy = await http('GET', url.till, '/api/v1/products/sync?limit=500', { terminal: terminalToken });
    check(copy.status === 200 && copy.body.data.some((p) => p.id === productA.id), `the till should answer the catalog from its disk, got ${copy.status}`);
    const test = must(await http('POST', url.till, '/till/test', { body: {} }), 200, 'test the address');
    check(test.ok === false && test.reason === 'REFUSED', `the till should report a refused connection, got ${JSON.stringify(test)}`);
    restart('branch-a');
    await until('branch A answers again', () => healthy(url.a), 60_000);
    await until('the till reports selling allowed again, by itself', async () => (await linkOf()).blocked === false, 20_000);
    const sale = must(await http('POST', url.till, '/api/v1/sales', { token: cashierA, terminal: terminalToken, body: saleBody(productA.id), headers: { 'Idempotency-Key': randomUUID() } }), 201, 'sell after the branch server is back');
    check(!!sale.id, 'no sale after restart');
    await until('branch A and HQ agree at the end', () => inSync(url.a, adminA), 90_000);
  });

  await step('the till keeps the sale in doubt on its own disk (docs/14 step 4): written, read back, and empty again', async () => {
    const put = (items) => fetch(`${url.till}/till/journal`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) });
    const get = async () => (await (await fetch(`${url.till}/till/journal`)).json()).items;
    check((await get()).length === 0, 'the journal should start empty');
    check((await put([{ id: randomUUID(), body: { clientSaleId: 'x' }, createdAt: new Date().toISOString(), attempts: 0 }])).status === 200, 'the till did not keep the sale');
    check((await get()).length === 1, 'the journal should hold the sale');
    check((await put('not a list')).status === 400, 'a list that is not valid must be refused');
    check((await get()).length === 1, 'a refused write must keep what was there');
    check((await put([])).status === 200 && (await get()).length === 0, 'the journal should be empty again');
  });

  await step('the till still serves its screens, and a sale at the branch shows in the ping that reaches a screen through it', async () => {
    const page = await fetch(`${url.till}/`, { headers: { Accept: 'text/html' } });
    check(page.status === 200 && (await page.text()).includes('<div id="root">'), 'the till did not serve its screens');
    const ping = async () => {
      const res = await fetch(`${url.till}/api/v1/ping`, { headers: { 'X-Terminal-Token': terminalToken } });
      check(res.status === 200, `the ping answered ${res.status}`);
      return res.json();
    };
    const before = await ping();
    must(await http('POST', url.till, '/api/v1/sales', { token: cashierA, terminal: terminalToken, body: saleBody(productA.id), headers: { 'Idempotency-Key': randomUUID() } }), 201, 'sell');
    const after = await ping();
    check(after.epoch === before.epoch, 'the epoch must not change while the server runs');
    check(after.versions.stock > before.versions.stock, 'the stock number in the ping should have gone up after a sale');
    // The live-update stream is gone (docs/14 step 6): nothing answers at its old address.
    const gone = await fetch(`${url.till}/api/v1/events`, { headers: { Authorization: `Bearer ${cashierA}`, 'X-Terminal-Token': terminalToken } });
    check(gone.status === 404, `GET /events should not exist any more (answered ${gone.status})`);
  });
}

let failed = false;
try {
  await main();
} catch (e) {
  failed = true;
  say(`\nStopped at: ${current}`);
  for (const name of Object.keys(programs)) {
    const t = tail(name, 8);
    if (t.trim()) say(`--- the end of ${name}'s log ---\n${t}`);
  }
} finally {
  for (const name of Object.keys(programs)) await stop(name);
  if (KEEP) say(`kept: ${root}`);
  else {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 400 });
    } catch {
      say(`(could not remove ${root} yet: delete it by hand)`);
    }
  }
}
const okCount = results.filter((r) => r.ok).length;
say(`\n${failed ? 'FAILED' : 'PASSED'}: ${okCount} of ${results.length} steps ok${failed ? '' : ' (every project ran alone in its own sandbox and they worked together)'}`);
process.exit(failed ? 1 : 0);
