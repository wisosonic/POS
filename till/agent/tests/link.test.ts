import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLinkMonitor } from '../src/link';
import { createTillServer } from '../src/tillServer';

// The till's heartbeat (docs/14-connection-and-till-backend.md §2 to §4), against a made-up branch server whose behaviour the test
// controls: one missed answer is not an outage, two in a row stop selling, one good answer starts it again, and a token is only ever
// sent to the branch server, never shown on the screens.

type Mode = 'ok' | 'hang' | 'unknown-device' | 'broken' | 'host-refused';
let mode: Mode = 'ok';
let hits: { url: string; token: string | undefined }[] = [];
let branch: http.Server;
let port = 0;
const listen = (s: http.Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));
const closed = (s: http.Server) =>
  new Promise<void>((r) => {
    s.closeAllConnections();
    s.close(() => r());
  });

beforeEach(async () => {
  mode = 'ok';
  hits = [];
  branch = http.createServer((req, res) => {
    const token = req.headers['x-terminal-token'];
    hits.push({ url: req.url ?? '', token: typeof token === 'string' ? token : undefined });
    if (mode === 'hang') return; // never answers
    const send = (status: number, body: unknown) =>
      void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (mode === 'broken') return send(500, { code: 'INTERNAL' });
    if (mode === 'host-refused') return send(403, { code: 'HOST_NOT_ALLOWED' });
    if (req.url === '/api/v1/healthz') return send(200, { status: 'ok' });
    if (req.url === '/api/v1/ping') {
      if (mode === 'unknown-device') return send(401, { code: 'TERMINAL_UNKNOWN' });
      if (!token) return send(401, { code: 'TERMINAL_REQUIRED' });
      return send(200, { ok: true, serverTime: '2026-11-27T09:00:00.000Z', epoch: 'epoch-1', versions: { catalog: 4, rate: 1 } });
    }
    send(404, { code: 'NOT_FOUND' });
  });
  port = await listen(branch);
});
afterEach(async () => {
  await closed(branch);
});

const monitor = (over: { branchServer?: () => string | null; missesToFail?: number } = {}) =>
  createLinkMonitor({ branchServer: () => `http://127.0.0.1:${port}`, timeoutMs: 150, intervalMs: 40, ...over });

describe('the link monitor (US-10)', () => {
  it('starts as "starting" and does not stop selling before it knows anything', () => {
    const m = monitor();
    expect(m.snapshot()).toMatchObject({ state: 'starting', blocked: false, lastOkAt: null, misses: 0 });
  });

  it("with the till's token it pings, and reports the server time, the epoch and the version of each topic", async () => {
    const m = monitor();
    m.setToken('device-token-1');
    await m.check();
    expect(m.snapshot()).toMatchObject({
      state: 'connected',
      blocked: false,
      watching: 'ping',
      epoch: 'epoch-1',
      versions: { catalog: 4, rate: 1 },
      misses: 0,
      reason: null,
    });
    expect(hits.at(-1)).toEqual({ url: '/api/v1/ping', token: 'device-token-1' });
  });

  it('without a token (legacy single-till shop, or a till not enrolled yet) it uses the open health check and sends nothing secret', async () => {
    const m = monitor();
    await m.check();
    expect(m.snapshot()).toMatchObject({ state: 'connected', watching: 'healthz', epoch: null, versions: null });
    expect(hits.at(-1)).toEqual({ url: '/api/v1/healthz', token: undefined });
  });

  it('never shows the token in what the screens can read', async () => {
    const m = monitor();
    m.setToken('very-secret-device-token');
    await m.check();
    expect(JSON.stringify(m.snapshot())).not.toContain('very-secret-device-token');
  });

  it('one missed answer is not an outage; two in a row stop selling', async () => {
    const m = monitor();
    m.setToken('t');
    await m.check();
    await closed(branch); // the branch server goes away
    await m.check();
    expect(m.snapshot()).toMatchObject({ state: 'connected', blocked: false, misses: 1, reason: 'REFUSED' });
    await m.check();
    expect(m.snapshot()).toMatchObject({ state: 'down', blocked: true, misses: 2, reason: 'REFUSED' });
    expect(m.snapshot().detail).toMatch(/no branch server is running/i);
    branch = http.createServer(); // so afterEach has something to close
    await listen(branch);
  });

  it('one good answer after an outage starts selling again at once', async () => {
    const m = monitor();
    m.setToken('t');
    mode = 'broken';
    await m.check();
    await m.check();
    expect(m.snapshot().blocked).toBe(true);
    mode = 'ok';
    await m.check();
    expect(m.snapshot()).toMatchObject({ state: 'connected', blocked: false, misses: 0, reason: null });
    expect(m.snapshot().lastOkAt).not.toBeNull();
  });

  it('a server that never answers counts as a miss after the timeout', async () => {
    const m = monitor();
    m.setToken('t');
    mode = 'hang';
    const started = Date.now();
    await m.check();
    await m.check();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(m.snapshot()).toMatchObject({ state: 'down', blocked: true, reason: 'TIMEOUT' });
  });

  it('an error answer from the server is a miss too, and a refused address says so', async () => {
    const m = monitor();
    mode = 'host-refused';
    await m.check();
    await m.check();
    expect(m.snapshot()).toMatchObject({ state: 'down', reason: 'HOST_NOT_ALLOWED' });
    expect(m.snapshot().detail).toMatch(/ALLOWED_HOSTS/);
  });

  it('a server that does not know this device is reachable: the link does not stop selling (the screens offer to enrol)', async () => {
    const m = monitor();
    m.setToken('forgotten');
    mode = 'unknown-device';
    await m.check();
    expect(m.snapshot()).toMatchObject({ state: 'not_a_till', blocked: false, misses: 0 });
  });

  it('with no branch server address it says so and does not stop selling', async () => {
    const m = monitor({ branchServer: () => null });
    await m.check();
    expect(m.snapshot()).toMatchObject({ state: 'not_configured', blocked: false });
    expect(hits).toHaveLength(0);
  });

  it('keeps asking by itself, and stops asking when it is stopped', async () => {
    const m = monitor();
    m.start();
    // Wait for the condition, not a fixed time: a busy machine can be slow.
    for (let i = 0; i < 100 && hits.length < 3; i++) await new Promise((r) => setTimeout(r, 25));
    expect(hits.length).toBeGreaterThanOrEqual(3);
    m.stop();
    await new Promise((r) => setTimeout(r, 150)); // a question already on its way may still land
    const asked = hits.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(hits.length).toBe(asked);
  });

  it('never has two questions in flight at once', async () => {
    const m = monitor();
    mode = 'hang';
    await Promise.all([m.check(), m.check(), m.check()]);
    expect(hits).toHaveLength(1);
  });

  it('a different token asks again straight away, as that token', async () => {
    const m = monitor();
    m.start();
    await new Promise((r) => setTimeout(r, 30));
    m.setToken('device-2');
    await new Promise((r) => setTimeout(r, 120));
    m.stop();
    expect(hits.some((h) => h.url === '/api/v1/ping' && h.token === 'device-2')).toBe(true);
  });
});

describe('the till server reports it (GET /till/link)', () => {
  let dir = '';
  let tillPort = 0;
  let till: ReturnType<typeof createTillServer>;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'till-link-'));
    till = createTillServer({
      dataDir: join(dir, 'data'),
      port: 0,
      defaultBranchServer: `http://127.0.0.1:${port}`,
      link: { intervalMs: 40, timeoutMs: 150 },
    });
    tillPort = await till.listen('127.0.0.1');
  });
  afterEach(async () => {
    await till.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const link = async (token?: string) => {
    const res = await fetch(`http://127.0.0.1:${tillPort}/till/link`, { headers: token ? { 'X-Terminal-Token': token } : {} });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const until = async (fn: () => Promise<boolean>) => {
    for (let i = 0; i < 60; i++) {
      if (await fn()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  };

  it('answers with the state, and the heartbeat uses the token the screen sends', async () => {
    expect((await link('screen-token')).status).toBe(200);
    expect(await until(async () => (await link('screen-token')).body.watching === 'ping')).toBe(true);
    const body = (await link('screen-token')).body;
    expect(body).toMatchObject({ state: 'connected', blocked: false, epoch: 'epoch-1' });
    expect(hits.some((h) => h.url === '/api/v1/ping' && h.token === 'screen-token')).toBe(true);
    expect(JSON.stringify(body)).not.toContain('screen-token');
  });

  it('a screen with no token puts the heartbeat back on the open health check', async () => {
    await link('screen-token');
    await until(async () => (await link('screen-token')).body.watching === 'ping');
    expect(await until(async () => (await link()).body.watching === 'healthz')).toBe(true);
  });

  it('turns to "down" and "blocked" when the branch server stops answering, and back when it does', async () => {
    await link('t');
    expect(await until(async () => (await link('t')).body.state === 'connected')).toBe(true);
    mode = 'broken';
    expect(await until(async () => (await link('t')).body.blocked === true)).toBe(true);
    mode = 'ok';
    expect(await until(async () => (await link('t')).body.blocked === false)).toBe(true);
  });

  it('learns the device token from the calls it passes through, not only from the poll', async () => {
    await fetch(`http://127.0.0.1:${tillPort}/api/v1/anything`, { headers: { 'X-Terminal-Token': 'from-a-sale' } });
    expect(await until(async () => hits.some((h) => h.url === '/api/v1/ping' && h.token === 'from-a-sale'))).toBe(true);
  });
});
