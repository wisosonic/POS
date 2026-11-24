// Runs the HQ server and two branch servers together on this machine, in ONE terminal: `npm run dev:chain`.
//
//   node scripts/dev-chain.mjs
//   CHAIN_ADMIN_PASSWORD=<a password> node scripts/dev-chain.mjs     (also sets everything up, see below)
//
//   HQ        http://127.0.0.1:4000      .dev-data/chain/hq/
//   Branch A  http://127.0.0.1:3000      .dev-data/chain/a/
//   Branch B  http://127.0.0.1:3001      .dev-data/chain/b/
//
// Each has its OWN database folder, so this is the real thing (three separate servers talking over HTTP), only on one machine. Move them
// to their real machines later by giving each its own PC and address (docs/12-sync-and-hq.md).
//
// With CHAIN_ADMIN_PASSWORD set (use any password for this throw-away dev data) it also: creates an `admin` account in each branch if
// there is none, adds the branches A and B at HQ if they are not there, and connects each branch to HQ. Without it, create the admins
// yourself (npm run create-admin --prefix branch-server) and connect the branches with Settings > HQ (or POST /api/v1/sync/connect).
//
// The HQ admin token is made once and kept in .dev-data/chain/hq-admin-token.txt (it is a secret: it is never printed here).
// To look at a branch's screen: `API_URL=http://127.0.0.1:3000 npm run dev --prefix till`
// (branch B: `API_URL=http://127.0.0.1:3001 WEB_PORT=5174 npm run dev --prefix till`). Ctrl+C stops everything.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = join(root, '.dev-data', 'chain');
const HQ_PORT = 4000;
const parts = [
  { name: 'hq', code: 33, port: HQ_PORT, dir: join(base, 'hq'), cwd: 'cloud-hq', entry: 'src/index.ts', db: 'hq.db' },
  { name: 'a', code: 36, port: 3000, dir: join(base, 'a'), cwd: 'branch-server', entry: 'src/index.ts', db: 'pos.db' },
  { name: 'b', code: 35, port: 3001, dir: join(base, 'b'), cwd: 'branch-server', entry: 'src/index.ts', db: 'pos.db' },
];
const adminPassword = process.env.CHAIN_ADMIN_PASSWORD;

const color = process.stdout.isTTY;
const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
const say = (name, code, chunk) => {
  for (const raw of String(chunk).split(/\r?\n/)) {
    if (raw.trim() === '') continue;
    const line = readable(raw);
    if (line !== '') process.stdout.write(`${paint(code, `[${name}]`.padEnd(5))} ${line}\n`);
  }
};
// The servers log one JSON line per event; show the time, the level and the message, and skip the health checks and the sync pings.
function readable(line) {
  if (!line.startsWith('{')) return line;
  try {
    const e = JSON.parse(line);
    if (typeof e.msg !== 'string') return line;
    if (e.msg === 'incoming request') return '';
    if (e.msg === 'request completed') return '';
    return `${new Date(e.time).toTimeString().slice(0, 8)} ${e.level >= 40 ? 'WARN ' : ''}${e.msg}${e.err?.message ? `: ${e.err.message}` : ''}`;
  } catch {
    return line;
  }
}

let stopping = false;
const children = [];
function stopAll(reason) {
  if (stopping) return;
  stopping = true;
  if (reason) process.stdout.write(`\n${reason}\n`);
  for (const c of children) {
    if (c.exitCode !== null) continue;
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 1500).unref();
}
process.on('SIGINT', () => stopAll('Stopping the three servers...'));
process.on('SIGTERM', () => stopAll('Stopping the three servers...'));

const taken = (port) =>
  new Promise((done) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => (s.destroy(), done(true)));
    s.once('error', () => done(false));
    s.setTimeout(800, () => (s.destroy(), done(false)));
  });
for (const p of parts) {
  if (await taken(p.port)) {
    process.stdout.write(
      `\nCannot start: port ${p.port}, which ${p.name === 'hq' ? 'HQ' : `branch ${p.name.toUpperCase()}`} needs, is already in use. Close the other copy (or end the "node" programs in Task Manager) and try again.\n`,
    );
    process.exit(1);
  }
  mkdirSync(p.dir, { recursive: true });
}

// The HQ admin token: made once, kept in a file, never printed.
const tokenFile = join(base, 'hq-admin-token.txt');
if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(32).toString('base64url'), { mode: 0o600 });
const hqToken = readFileSync(tokenFile, 'utf8').trim();

// Before the branches start: give each an admin account if asked (the command creates the database and its tables too).
if (adminPassword) {
  for (const p of parts.filter((x) => x.name !== 'hq')) {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/create-admin.ts', 'admin', adminPassword], {
      cwd: join(root, 'branch-server'),
      env: { ...process.env, DATABASE_PATH: join(p.dir, p.db) },
      encoding: 'utf8',
    });
    if (r.status !== 0) {
      process.stdout.write(`Could not create the admin for branch ${p.name.toUpperCase()}: ${r.stderr || r.stdout}\n`);
      process.exit(1);
    }
  }
}

function launch(p) {
  const env = {
    ...process.env,
    FORCE_COLOR: '0',
    PORT: String(p.port),
    DATABASE_PATH: join(p.dir, p.db),
    ...(p.name === 'hq' ? { HQ_ADMIN_TOKEN: hqToken } : { BACKUP_DIR: join(p.dir, 'backups'), UPLOADS_DIR: join(p.dir, 'uploads') }),
  };
  const child = spawn(process.execPath, ['--import', 'tsx', p.entry], { cwd: join(root, p.cwd), env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stdout.on('data', (d) => say(p.name, p.code, d));
  child.stderr.on('data', (d) => say(p.name, p.code, d));
  child.on('exit', (code) => {
    if (!stopping) {
      process.exitCode = code || 1;
      stopAll(
        `${p.name === 'hq' ? 'HQ' : `Branch ${p.name.toUpperCase()}`} stopped (exit code ${code}). Read its lines above for the reason. Stopping the others too.`,
      );
    } else if (children.every((c) => c.exitCode !== null)) process.exit(process.exitCode ?? 0);
  });
}
for (const p of parts) launch(p);

const json = async (url, init = {}) => {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(8000),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const up = async (port) => {
  try {
    return (await fetch(`http://127.0.0.1:${port}/api/v1/healthz`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
};
for (let i = 0; i < 90 && !stopping; i++) {
  if ((await Promise.all(parts.map((p) => up(p.port)))).every(Boolean)) break;
  await new Promise((r) => setTimeout(r, 1000));
}
if (stopping) await new Promise(() => undefined);
if (!(await Promise.all(parts.map((p) => up(p.port)))).every(Boolean))
  stopAll('The servers did not all answer within 90 seconds. Read the lines above for the reason.');

// Set the chain up when asked: the branches at HQ, and each branch connected to HQ.
const hq = `http://127.0.0.1:${HQ_PORT}`;
const hqAuth = { Authorization: `Bearer ${hqToken}` };
if (adminPassword && !stopping) {
  try {
    const known = (await json(`${hq}/api/v1/branches`, { headers: hqAuth })).body.data ?? [];
    for (const p of parts.filter((x) => x.name !== 'hq')) {
      const url = `http://127.0.0.1:${p.port}`;
      const login = await json(`${url}/api/v1/auth/login`, {
        method: 'POST',
        body: JSON.stringify({ username: 'admin', password: adminPassword }),
      });
      if (!login.body.accessToken)
        throw new Error(`Branch ${p.name.toUpperCase()} refused the admin sign-in (is the password the one it was first created with?)`);
      const auth = { Authorization: `Bearer ${login.body.accessToken}` };
      const status = (await json(`${url}/api/v1/sync/status`, { headers: auth })).body;
      if (status.linked) continue;
      const code = p.name.toUpperCase();
      let branch = known.find((b) => b.code === code);
      let enrolCode;
      if (branch)
        enrolCode = (await json(`${hq}/api/v1/branches/${branch.id}/enrol-code`, { method: 'POST', headers: hqAuth, body: '{}' })).body
          .enrolCode;
      else
        enrolCode = (
          await json(`${hq}/api/v1/branches`, { method: 'POST', headers: hqAuth, body: JSON.stringify({ code, name: `Branch ${code}` }) })
        ).body.enrolCode;
      const done = await json(`${url}/api/v1/sync/connect`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ url: hq, code: enrolCode }),
      });
      if (done.status !== 200) throw new Error(`Branch ${code} could not connect: ${done.body.detail ?? done.status}`);
    }
  } catch (e) {
    process.stdout.write(`\nSetting up the chain failed: ${e.message}\n`);
  }
}

process.stdout.write(
  `\n  HQ        ${paint(1, hq)}\n  Branch A  ${paint(1, 'http://127.0.0.1:3000')}\n  Branch B  ${paint(1, 'http://127.0.0.1:3001')}\n` +
    (adminPassword
      ? `  The branches are connected to HQ (see "Settings > HQ" status: GET /api/v1/sync/status as admin).\n`
      : `  To connect a branch: add it at HQ (POST ${hq}/api/v1/branches with the token in ${tokenFile}), then POST /api/v1/sync/connect at the branch.\n`) +
    `  Press Ctrl+C here to stop all three.\n\n`,
);
