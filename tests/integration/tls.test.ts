import { spawnSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/api/src/app';
import { loadConfig } from '../../apps/api/src/config';
import { migrate } from '../../apps/api/src/db/migrate';
import { seedTestData, type Seed } from '../../apps/api/src/db/seed-test';

// US-26 / US-10: the server can speak HTTPS (a tablet or second PC reaching the shop PC across the network). The certificate is the
// shop's own: here a throwaway one made with openssl. Skipped when openssl is not installed.
const probe = spawnSync('openssl', ['version'], { encoding: 'utf8' });
const maybe = probe.status === 0 ? describe : describe.skip;

type Answer = { status: number; headers: http.IncomingHttpHeaders; body: string };
const request = (lib: typeof http | typeof https, port: number, path: string, init: { method?: string; body?: unknown } = {}) =>
  new Promise<Answer>((resolve, reject) => {
    const data = init.body === undefined ? undefined : JSON.stringify(init.body);
    const req = lib.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: init.method ?? 'GET',
        headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
        ...(lib === https ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end(data);
  });

maybe('HTTPS', () => {
  let dir: string;
  let seed: Seed;
  let secure: Awaited<ReturnType<typeof buildApp>>;
  let plain: Awaited<ReturnType<typeof buildApp>>;
  let securePort: number;
  let plainPort: number;
  let cert: string;
  let key: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pos-tls-'));
    const made = spawnSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
        '-days',
        '2',
        '-subj',
        '/CN=till',
        '-addext',
        'subjectAltName=DNS:till,IP:127.0.0.1',
      ],
      { encoding: 'utf8' },
    );
    expect(made.status, made.stderr).toBe(0);
    cert = readFileSync(join(dir, 'cert.pem'), 'utf8');
    key = readFileSync(join(dir, 'key.pem'), 'utf8');

    const dbS = join(dir, 'secure.db');
    migrate(dbS);
    seed = await seedTestData(dbS);
    secure = await buildApp({ databasePath: dbS, tls: { cert, key } });
    await secure.listen({ host: '127.0.0.1', port: 0 });
    securePort = (secure.server.address() as AddressInfo).port;

    const dbP = join(dir, 'plain.db');
    migrate(dbP);
    await seedTestData(dbP);
    plain = await buildApp({ databasePath: dbP });
    await plain.listen({ host: '127.0.0.1', port: 0 });
    plainPort = (plain.server.address() as AddressInfo).port;
  }, 60_000);
  afterAll(async () => {
    await secure.close();
    await plain.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers over HTTPS, tells the browser to keep using it, and does not answer plain HTTP on that port', async () => {
    const res = await request(https, securePort, '/api/v1/healthz');
    expect(res.status).toBe(200);
    expect(res.headers['strict-transport-security']).toContain('max-age=');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'"); // the other headers are unchanged
    await expect(request(http, securePort, '/api/v1/healthz')).rejects.toBeDefined();
  });

  it('marks the sign-in cookie Secure over HTTPS (and not on a plain server), and the cookie is still HttpOnly and strict', async () => {
    const u = seed.users.cashier;
    const s = await request(https, securePort, '/api/v1/auth/login', {
      method: 'POST',
      body: { username: u.username, password: u.password },
    });
    expect(s.status).toBe(200);
    const cookie = String(s.headers['set-cookie']);
    expect(cookie).toMatch(/;\s*Secure/i);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);

    const p = await request(http, plainPort, '/api/v1/auth/login', {
      method: 'POST',
      body: { username: u.username, password: u.password },
    });
    expect(String(p.headers['set-cookie'])).not.toMatch(/;\s*Secure/i);
    expect(p.headers['strict-transport-security']).toBeUndefined();
  });

  it('the settings must name both files or neither', () => {
    expect(() => loadConfig({ TLS_CERT: join(dir, 'cert.pem') })).toThrow(/both TLS_CERT and TLS_KEY/);
    expect(() => loadConfig({ TLS_KEY: join(dir, 'key.pem') })).toThrow(/both TLS_CERT and TLS_KEY/);
    expect(loadConfig({}).tlsCert).toBeUndefined();
    expect(loadConfig({ TLS_CERT: 'a.pem', TLS_KEY: 'b.pem' })).toMatchObject({ tlsCert: 'a.pem', tlsKey: 'b.pem' });
  });

  it('starts from the files named in the settings', async () => {
    writeFileSync(join(dir, 'unused'), '');
    const db = join(dir, 'env.db');
    migrate(db);
    const before = { c: process.env.TLS_CERT, k: process.env.TLS_KEY };
    process.env.TLS_CERT = join(dir, 'cert.pem');
    process.env.TLS_KEY = join(dir, 'key.pem');
    try {
      const app = await buildApp({ databasePath: db });
      await app.listen({ host: '127.0.0.1', port: 0 });
      const port = (app.server.address() as AddressInfo).port;
      expect((await request(https, port, '/api/v1/healthz')).status).toBe(200);
      await app.close();
    } finally {
      process.env.TLS_CERT = before.c;
      process.env.TLS_KEY = before.k;
      if (before.c === undefined) delete process.env.TLS_CERT;
      if (before.k === undefined) delete process.env.TLS_KEY;
    }
  });
});
