// Runs the server and the screen together in ONE terminal: `npm run dev` (or runner.bat, which uses --open).
//
//   node scripts/dev.mjs [--open]
//
// Both write to this terminal, each line marked [api] or [web]. Ctrl+C stops both. If either stops by itself the other is
// stopped too, so nothing is left running in the background. --open opens the browser once both answer.
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const open = process.argv.includes('--open') && !process.env.RUNNER_NO_BROWSER;
const API = 'http://127.0.0.1:3000/api/v1/healthz';
const WEB = 'http://localhost:5173';

const color = process.stdout.isTTY;
const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
const parts = [
  // The server runs without the file watcher: a restore chosen on the Backups screen stops it on purpose (exit code 75) and this
  // script starts it again.
  { name: 'api', code: 36, args: ['run', 'start', '-w', '@pos/api'] },
  { name: 'web', code: 35, args: ['run', 'dev', '-w', '@pos/web'] },
];

let stopping = false;
const children = [];

// The server logs one JSON line per event. For a person: the time, the level and the message, one line per request, and none for
// the health check this script itself keeps asking.
const requests = new Map();
const LEVEL = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' };
function readable(line) {
  if (!line.startsWith('{')) return line;
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    return line;
  }
  if (typeof e.msg !== 'string') return line;
  const time = new Date(e.time).toTimeString().slice(0, 8);
  if (e.msg === 'incoming request' && e.req) {
    requests.set(e.reqId, e.req);
    if (requests.size > 500) requests.delete(requests.keys().next().value);
    return null;
  }
  if (e.msg === 'request completed') {
    const r = requests.get(e.reqId);
    requests.delete(e.reqId);
    if (!r || r.url.endsWith('/healthz')) return null;
    return `${time} ${r.method} ${r.url} ${e.res?.statusCode} ${Math.round(e.responseTime)} ms`;
  }
  const level = LEVEL[e.level] ?? e.level;
  return `${time} ${level === 'info' ? '' : `${level} `}${e.msg}${e.err?.message ? `: ${e.err.message}` : ''}`;
}

function say(name, code, chunk) {
  for (const raw of String(chunk).split(/\r?\n/)) {
    if (raw.trim() === '') continue;
    const line = name === 'api' ? readable(raw) : raw;
    if (line !== null) process.stdout.write(`${paint(code, `[${name}]`)} ${line}\n`);
  }
}

function stopAll(reason) {
  if (stopping) return;
  stopping = true;
  if (reason) process.stdout.write(`\n${reason}\n`);
  for (const c of children) {
    if (c.exitCode !== null) continue;
    // npm starts the real program as a child of its own: on Windows the whole tree has to be ended, or the port stays taken.
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 1500).unref();
}

// Something already on a port is the commonest reason for "it does not start": say so plainly, before starting anything.
const taken = (port, host) =>
  new Promise((done) => {
    const s = net.connect({ port, host });
    s.once('connect', () => (s.destroy(), done(true)));
    s.once('error', () => done(false));
    s.setTimeout(800, () => (s.destroy(), done(false)));
  });
for (const [port, what] of [
  [3000, 'the server'],
  [5173, 'the screen'],
]) {
  if ((await taken(port, '127.0.0.1')) || (await taken(port, '::1'))) {
    process.stdout.write(
      `\nCannot start: port ${port}, which ${what} needs, is already in use. Most likely another copy of the POS (or the browser tests) is\nstill running, in another window or in the background. Close it, or end the "node" programs in Task Manager, and try again.\n`,
    );
    process.exit(1);
  }
}

const RESTART_EXIT_CODE = 75;
function launch(p) {
  // One command string (not a list of arguments) so the shell can find npm on every system without a warning.
  const child = spawn(`npm ${p.args.join(' ')}`, {
    cwd: root,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  children.push(child);
  child.stdout.on('data', (d) => say(p.name, p.code, d));
  child.stderr.on('data', (d) => say(p.name, p.code, d));
  child.on('exit', (code) => {
    if (!stopping && p.name === 'api' && code === RESTART_EXIT_CODE) {
      children.splice(children.indexOf(child), 1);
      process.stdout.write('\nThe server stopped to put a restored backup in place. Starting it again…\n');
      launch(p);
    } else if (!stopping) {
      process.exitCode = code || 1;
      stopAll(
        `The ${p.name === 'api' ? 'server' : 'screen'} stopped (exit code ${code}). Read the [${p.name}] lines above for the reason. Stopping the other one too.`,
      );
    } else if (children.every((c) => c.exitCode !== null)) process.exit(process.exitCode ?? 0);
  });
}
for (const p of parts) launch(p);

process.on('SIGINT', () => stopAll('Stopping the server and the screen…'));
process.on('SIGTERM', () => stopAll('Stopping the server and the screen…'));

async function up(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

// Wait until both answer, then say where to go (and open it, when asked).
for (let i = 0; i < 90 && !stopping; i++) {
  if ((await up(API)) && (await up(WEB))) {
    process.stdout.write(
      `\n  The POS is at  ${paint(1, WEB)}\n  Sign in as  admin  with the password you chose. Press Ctrl+C here to stop everything.\n\n`,
    );
    if (open) {
      const cmd =
        process.platform === 'win32'
          ? ['cmd', ['/c', 'start', '', WEB]]
          : process.platform === 'darwin'
            ? ['open', [WEB]]
            : ['xdg-open', [WEB]];
      spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref();
    }
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
if (!stopping && !(await up(WEB))) stopAll('The screen did not answer within 90 seconds. Read the lines above for the reason.');
