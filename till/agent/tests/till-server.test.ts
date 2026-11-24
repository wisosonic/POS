import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTillServer, isLoopbackAddress, normalizeBranchUrl, type TillServer } from '../src/tillServer';

// The till's own server (docs/11-multi-branch.md §8.4), against a made-up branch server: it serves the screens, passes the calls
// through unchanged, keeps the branch server's address, and refuses what it should. No database, no real branch server.

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };

let branch: http.Server;
let branchPort = 0;
let seen: Seen[] = [];
let streamClosed = false;
let till: TillServer;
let tillPort = 0;
let dir = '';
let webDist = '';

const listen = (s: http.Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'till-server-'));
  webDist = join(dir, 'dist');
  mkdirSync(join(webDist, 'assets'), { recursive: true });
  writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>till</title>');
  writeFileSync(join(webDist, 'assets', 'app-abc123.js'), 'console.log(1)');
  writeFileSync(join(dir, 'secret.txt'), 'outside the screens');

  branch = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      if (req.url === '/api/v1/healthz') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
      if (req.url?.split('?')[0] === '/api/v1/auth/login') {
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'pos_refresh=abc; HttpOnly; Path=/api/v1/auth' });
        return void res.end('{"accessToken":"t"}');
      }
      if (req.url === '/api/v1/teapot')
        return void res.writeHead(418, { 'content-type': 'application/problem+json' }).end('{"code":"TEAPOT"}');
      if (req.url === '/api/v1/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: hello\ndata: {}\n\n');
        res.on('close', () => (streamClosed = true));
        return; // stays open, like the real live-update stream
      }
      res.writeHead(404, { 'content-type': 'application/problem+json' }).end('{"code":"NOT_FOUND"}');
    });
  });
  branchPort = await listen(branch);

  till = createTillServer({
    dataDir: join(dir, 'data'),
    webDist,
    port: 0,
    defaultBranchServer: `http://127.0.0.1:${branchPort}`,
    connectTimeoutMs: 800,
  });
  tillPort = await till.listen('127.0.0.1');
});

afterAll(async () => {
  await till.close();
  await new Promise<void>((r) => {
    branch.closeAllConnections();
    branch.close(() => r());
  });
  rmSync(dir, { recursive: true, force: true });
});

/** fetch will not let a script set Host or Origin, so the tests that need to lie about them speak plain HTTP. */
const raw = (port: number, path: string, headers: Record<string, string>, method = 'GET') =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers: method === 'GET' ? headers : { ...headers, 'content-length': '2' } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end(method === 'GET' ? undefined : '{}');
  });

const t = (path: string, init?: RequestInit & { headers?: Record<string, string> }) => fetch(`http://127.0.0.1:${tillPort}${path}`, init);

describe('Till server: the address it is given', () => {
  it('accepts a bare host and port, adds http, and keeps only the server', () => {
    expect(normalizeBranchUrl('192.168.1.10:3000')).toBe('http://192.168.1.10:3000');
    expect(normalizeBranchUrl('  https://branch-server:3443/ ')).toBe('https://branch-server:3443');
    expect(normalizeBranchUrl('HTTP://Shop-PC')).toBe('http://shop-pc');
  });
  it('refuses what is not a server address', () => {
    for (const bad of ['', '   ', 'ftp://x', 'http://user:pw@host', 'http://host/api', 'http://host?x=1', 'http://host#a', 'http://']) {
      expect(() => normalizeBranchUrl(bad), bad).toThrow();
    }
  });
  it('refuses the till pointing at itself (that would loop for ever)', () => {
    expect(() => normalizeBranchUrl('localhost:8080', 8080)).toThrow(/this till itself/);
    expect(() => normalizeBranchUrl('127.0.0.1:8080', 8080)).toThrow(/this till itself/);
    expect(normalizeBranchUrl('127.0.0.1:3000', 8080)).toBe('http://127.0.0.1:3000');
  });
  it('knows this PC from another one', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.20')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe('Till server: its settings routes', () => {
  it('starts from the first address it was given, then keeps a saved one over restarts', async () => {
    const first = await (await t('/till/config')).json();
    expect(first).toEqual({ branchServer: `http://127.0.0.1:${branchPort}`, source: 'environment' });

    const res = await t('/till/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branchServer: `127.0.0.1:${branchPort}` }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ branchServer: `http://127.0.0.1:${branchPort}`, source: 'saved' });
    expect(JSON.parse(readFileSync(join(dir, 'data', 'till.json'), 'utf8'))).toEqual({ branchServer: `http://127.0.0.1:${branchPort}` });

    // a new server on the same folder (a restart) still has it, with no environment value
    const again = createTillServer({ dataDir: join(dir, 'data'), port: 0 });
    expect(again.branchServer()).toBe(`http://127.0.0.1:${branchPort}`);
  });

  it('refuses a bad address with a reason, and saves nothing', async () => {
    const res = await t('/till/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branchServer: 'http://a/b' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION');
    const notText = await t('/till/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branchServer: 5 }),
    });
    expect(notText.status).toBe(400);
    const notJson = await t('/till/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{nope' });
    expect(notJson.status).toBe(400);
    expect((await (await t('/till/config')).json()).branchServer).toBe(`http://127.0.0.1:${branchPort}`);
  });

  it('tests an address: a real branch server answers, a dead port and a bad address say why', async () => {
    const post = async (body: unknown) =>
      (await (
        await t('/till/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      ).json()) as Record<string, unknown>;
    const ok = await post({});
    expect(ok.ok).toBe(true);
    expect(typeof ok.ms).toBe('number');
    // a port nothing listens on
    const probe = http.createServer();
    const dead = await listen(probe);
    await new Promise((r) => probe.close(r));
    expect(await post({ branchServer: `127.0.0.1:${dead}` })).toMatchObject({ ok: false, reason: 'REFUSED' });
    expect(await post({ branchServer: 'http://a/b' })).toMatchObject({ ok: false, reason: 'BAD_ADDRESS' });
  });

  it("says so when the server is there but refuses this address (the branch server's ALLOWED_HOSTS)", async () => {
    const strict = http.createServer(
      (_req, res) => void res.writeHead(403, { 'content-type': 'application/problem+json' }).end('{"code":"HOST_NOT_ALLOWED"}'),
    );
    const port = await listen(strict);
    const r = await (
      await t('/till/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ branchServer: `127.0.0.1:${port}` }),
      })
    ).json();
    await new Promise((res) => strict.close(res));
    expect(r).toMatchObject({ ok: false, reason: 'HOST_NOT_ALLOWED' });
  });

  it('answers /till/health to anyone who may reach the till, but its settings only to this PC (guard checked above)', async () => {
    const res = await t('/till/health');
    expect(await res.json()).toEqual({ status: 'ok', configured: true });
    expect((await t('/till/nothing')).status).toBe(404);
  });
});

describe("Till server: it passes the branch server's answers through unchanged", () => {
  it('forwards method, path, query, body, sign-in and till tokens, and gives back status, body and cookie', async () => {
    seen = [];
    const res = await t('/api/v1/auth/login?x=1', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer abc', 'x-terminal-token': 'dev-1', 'idempotency-key': 'k-1' },
      body: JSON.stringify({ username: 'a', password: 'b' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accessToken: 't' });
    expect(res.headers.get('set-cookie')).toContain('pos_refresh=abc');
    const call = seen.at(-1)!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('/api/v1/auth/login?x=1');
    expect(JSON.parse(call.body)).toEqual({ username: 'a', password: 'b' });
    expect(call.headers.authorization).toBe('Bearer abc');
    expect(call.headers['x-terminal-token']).toBe('dev-1');
    expect(call.headers['idempotency-key']).toBe('k-1');
    // the branch server sees its own address in Host, and no Origin naming the till
    expect(call.headers.host).toBe(`127.0.0.1:${branchPort}`);
    expect(call.headers.origin).toBeUndefined();
  });

  it('drops the Origin the browser sent on the way (it names the till, and this server already checked it)', async () => {
    seen = [];
    await raw(tillPort, '/api/v1/teapot', {
      host: `127.0.0.1:${tillPort}`,
      origin: `http://127.0.0.1:${tillPort}`,
      referer: `http://127.0.0.1:${tillPort}/x`,
    });
    expect(seen.at(-1)!.headers.origin).toBeUndefined();
    expect(seen.at(-1)!.headers.referer).toBeUndefined();
  });

  it('keeps an error answer as it is (a 418 stays a 418, with its code)', async () => {
    const res = await t('/api/v1/teapot');
    expect(res.status).toBe(418);
    expect((await res.json()).code).toBe('TEAPOT');
    expect(res.headers.get('x-till-proxy-error')).toBeNull(); // only the till's own failures carry the mark
  });

  it('streams the live-update stream and lets go of the branch server when the screen hangs up', async () => {
    streamClosed = false;
    const ctl = new AbortController();
    const res = await t('/api/v1/events', { signal: ctl.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const first = await reader.read(); // arrives while the branch server's answer is still open
    expect(new TextDecoder().decode(first.value)).toContain('event: hello');
    ctl.abort();
    for (let i = 0; i < 50 && !streamClosed; i++) await new Promise((r) => setTimeout(r, 40));
    expect(streamClosed).toBe(true);
  });

  it('marks its own failures, so the screens treat them as "offline" and the sale queue keeps working', async () => {
    const probe = http.createServer();
    const dead = await listen(probe);
    await new Promise((r) => probe.close(r));
    const lost = createTillServer({
      dataDir: join(dir, 'lost'),
      port: 0,
      defaultBranchServer: `http://127.0.0.1:${dead}`,
      connectTimeoutMs: 500,
    });
    const port = await lost.listen('127.0.0.1');
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/sales`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(502);
    expect(res.headers.get('x-till-proxy-error')).toBe('BRANCH_UNREACHABLE');
    expect((await res.json()).code).toBe('BRANCH_UNREACHABLE');
    await lost.close();

    const none = createTillServer({ dataDir: join(dir, 'none'), port: 0 });
    const port2 = await none.listen('127.0.0.1');
    const res2 = await fetch(`http://127.0.0.1:${port2}/api/v1/products`);
    expect(res2.status).toBe(503);
    expect(res2.headers.get('x-till-proxy-error')).toBe('BRANCH_NOT_CONFIGURED');
    await none.close();
  });

  it('gives up quickly on a branch server that never answers the connection', async () => {
    // 10.255.255.1 is not routable here: the connection hangs until our own limit (0.5 s), not the operating system's
    const slow = createTillServer({
      dataDir: join(dir, 'slow'),
      port: 0,
      defaultBranchServer: 'http://10.255.255.1:3000',
      connectTimeoutMs: 500,
    });
    const port = await slow.listen('127.0.0.1');
    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/products`);
    expect(res.status).toBe(502);
    expect(Date.now() - started).toBeLessThan(5_000);
    await slow.close();
  });
});

describe('Till server: who may talk to it', () => {
  it('refuses another name in Host (DNS rebinding) and another website in Origin', async () => {
    const rebinding = await raw(tillPort, '/', { host: 'evil.example.com' });
    expect(rebinding.status).toBe(403);
    expect(JSON.parse(rebinding.body).code).toBe('HOST_NOT_ALLOWED');
    const other = await raw(tillPort, '/api/v1/sales', { host: `127.0.0.1:${tillPort}`, origin: 'https://evil.example.com' }, 'POST');
    expect(other.status).toBe(403);
    expect(JSON.parse(other.body).code).toBe('ORIGIN_NOT_ALLOWED');
    expect(seen.some((s) => s.headers.origin === 'https://evil.example.com')).toBe(false); // it never reached the branch server
  });

  it('answers to extra names only when they are listed', async () => {
    const named = createTillServer({ dataDir: join(dir, 'named'), webDist, port: 0, allowedHosts: ['till-3.shop.lan'] });
    const port = await named.listen('127.0.0.1');
    expect((await raw(port, '/', { host: 'till-3.shop.lan:8080', accept: 'text/html' })).status).toBe(200);
    expect((await raw(port, '/', { host: 'till-4.shop.lan', accept: 'text/html' })).status).toBe(403);
    await named.close();
  });
});

describe('Till server: the screens', () => {
  it('serves the app, with the security headers and its page never cached', async () => {
    const res = await t('/', { headers: { accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>till</title>');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('keeps hashed files for good, with the right type', async () => {
    const res = await t('/assets/app-abc123.js');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(res.headers.get('content-type')).toContain('text/javascript');
  });

  it('answers a page address with the app (its router), but a missing file stays a 404', async () => {
    expect((await t('/products', { headers: { accept: 'text/html' } })).status).toBe(200);
    expect((await t('/assets/missing.js', { headers: { accept: '*/*' } })).status).toBe(404);
  });

  it('never leaves the built folder, however the address is written', async () => {
    for (const p of ['/..%2fsecret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt', '/..\\secret.txt']) {
      const res = await t(p, { headers: { accept: '*/*' } });
      expect(await res.text(), p).not.toContain('outside the screens');
    }
  });

  it('says clearly when the screens are not built, and refuses writes to anything else', async () => {
    const bare = createTillServer({ dataDir: join(dir, 'bare'), port: 0 });
    const port = await bare.listen('127.0.0.1');
    const res = await fetch(`http://127.0.0.1:${port}/`, { headers: { accept: 'text/html' } });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NO_SCREENS');
    expect((await fetch(`http://127.0.0.1:${port}/x`, { method: 'POST' })).status).toBe(405);
    await bare.close();
  });
});
