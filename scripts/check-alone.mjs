// Proves that each server project runs ALONE (docs/11-multi-branch.md §8.1): it is started from its own folder, with an empty data
// folder and nothing else running, and must answer its health check. Run it after `npm run setup`:  node scripts/check-alone.mjs
// Nothing is touched outside a temporary folder. (The till is in the list too: its own server starts with no branch server around.)
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PROJECTS = [
  {
    name: 'branch-server',
    dir: 'branch-server',
    port: 3911,
    env: (data) => ({ DATABASE_PATH: join(data, 'pos.db'), JWT_SECRET: 'check-alone-secret-check-alone-secret-0123456789' }),
  },
  {
    name: 'cloud-hq',
    dir: 'cloud-hq',
    port: 3912,
    env: (data) => ({ DATABASE_PATH: join(data, 'hq.db'), HQ_ADMIN_TOKEN: 'check-alone-token-check-alone-token-0123456789' }),
  },
  {
    // The till's own server (step b). It needs no branch server to start: with no address saved it still answers, and says so.
    name: 'till',
    dir: 'till',
    port: 3913,
    entry: ['agent/src/cli.ts', 'serve'],
    health: '/till/health',
    env: (data) => ({ TILL_DATA_DIR: data }),
  },
];

async function answers(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

let failed = false;
for (const p of PROJECTS) {
  const data = mkdtempSync(join(tmpdir(), `pos-alone-${p.name}-`));
  const child = spawn(process.execPath, ['--import', 'tsx', ...(p.entry ?? ['src/index.ts'])], {
    cwd: join(root, p.dir),
    env: { ...process.env, PORT: String(p.port), HOST: '127.0.0.1', NODE_ENV: 'development', ...p.env(data) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const up = await answers(`http://127.0.0.1:${p.port}${p.health ?? '/api/v1/healthz'}`, 30_000);
  console.log(`${up ? 'ok    ' : 'FAILED'} ${p.name} started from ${p.dir}/ on its own and ${up ? 'answers' : 'did not answer'}`);
  if (!up) {
    failed = true;
    console.log(log.split('\n').slice(-12).join('\n'));
  }
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill();
  await new Promise((r) => (child.exitCode !== null ? r() : (child.once('exit', r), setTimeout(r, 5000))));
  try {
    rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    console.log('       (the temporary folder ' + data + ' could not be removed yet: delete it by hand)');
  }
}
process.exit(failed ? 1 : 0);
