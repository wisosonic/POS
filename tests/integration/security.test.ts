import Database from 'better-sqlite3';
import { createHmac, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../apps/api/src/auth/password';
import { startCtx, type TestCtx } from '../helpers/app';

// The security review (US-25, US-26), kept as tests so it cannot quietly stop being true.
let c: TestCtx;
let admin: string;
let manager: string;
let cashier: string;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const b64 = (o: object | Buffer) => Buffer.from(o instanceof Buffer ? o : JSON.stringify(o)).toString('base64url');
const forge = (alg: 'none' | 'HS256', secret = '') => {
  const body = `${b64({ alg, typ: 'JWT' })}.${b64({ sub: '1', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 })}`;
  return alg === 'none' ? `${body}.` : `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
};

beforeAll(async () => {
  c = await startCtx();
  admin = await c.login('admin');
  manager = await c.login('manager');
  cashier = await c.login('cashier');
});
afterAll(() => c.close());

describe('every route asks for a sign-in', () => {
  // The only doors that open without one. Adding a route here must be a deliberate decision.
  const PUBLIC = new Set([
    'GET /api/v1/healthz',
    'GET /api/v1/readyz',
    'POST /api/v1/auth/login',
    'POST /api/v1/auth/pin',
    'POST /api/v1/auth/refresh',
    'POST /api/v1/auth/logout',
  ]);
  const real = () => c.routes.filter((r) => r.url.startsWith(api) && !['HEAD', 'OPTIONS'].includes(r.method));
  const concrete = (url: string) => url.replace(/:\w+/g, '1');

  it('the list of routes is really there (so this check cannot pass by checking nothing)', () => {
    expect(real().length).toBeGreaterThan(60);
    for (const open of PUBLIC) expect(real().map((r) => `${r.method} ${r.url}`)).toContain(open);
  });

  it('refuses every other route without a token: not a single one answers anonymously', async () => {
    const open: string[] = [];
    for (const r of real()) {
      if (PUBLIC.has(`${r.method} ${r.url}`)) continue;
      const method = r.method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete';
      const res = await c.http[method](concrete(r.url)).send({});
      if (res.status !== 401) open.push(`${r.method} ${r.url} → ${res.status}`);
    }
    expect(open).toEqual([]);
  });

  it('refuses every other route with a garbage token too', async () => {
    const open: string[] = [];
    for (const r of real()) {
      if (PUBLIC.has(`${r.method} ${r.url}`)) continue;
      const method = r.method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete';
      const res = await c.http[method](concrete(r.url)).set(auth('not-a-token')).send({});
      if (res.status !== 401) open.push(`${r.method} ${r.url} → ${res.status}`);
    }
    expect(open).toEqual([]);
  });
});

describe('tokens', () => {
  it('a token with no signature ("alg": "none") is refused', async () => {
    expect((await c.http.get(`${api}/me`).set(auth(forge('none')))).status).toBe(401);
  });

  it('a token signed with some other secret is refused', async () => {
    expect((await c.http.get(`${api}/me`).set(auth(forge('HS256', 'guessed-secret')))).status).toBe(401);
  });

  it('a real token stops working at once when its user is deactivated', async () => {
    const made = await c.http
      .post(`${api}/users`)
      .set(auth(admin))
      .send({ username: `temp-${randomUUID().slice(0, 8)}`, name: 'Temp', role: 'cashier', password: 'a-long-enough-password' });
    const login = await c.http.post(`${api}/auth/login`).send({ username: made.body.username, password: 'a-long-enough-password' });
    expect((await c.http.get(`${api}/me`).set(auth(login.body.accessToken))).status).toBe(200);
    await c.http.patch(`${api}/users/${made.body.id}`).set(auth(admin)).send({ active: false });
    expect((await c.http.get(`${api}/me`).set(auth(login.body.accessToken))).status).toBe(401);
  });
});

describe('a PIN only opens a cashier (US-25)', () => {
  const makeUser = async (role: 'cashier' | 'manager' | 'admin', pin?: string) => {
    const res = await c.http
      .post(`${api}/users`)
      .set(auth(admin))
      .send({
        username: `u-${randomUUID().slice(0, 8)}`,
        name: `User ${role}`,
        role,
        password: 'a-long-enough-password',
        ...(pin ? { pin } : {}),
      });
    return res;
  };

  it('a manager or admin cannot be given a PIN', async () => {
    for (const role of ['manager', 'admin'] as const) {
      const res = await makeUser(role, '4821');
      expect(res.status, role).toBe(422);
      expect(res.body.code).toBe('PIN_CASHIER_ONLY');
    }
    const m = await makeUser('manager');
    const set = await c.http.patch(`${api}/users/${m.body.id}`).set(auth(admin)).send({ pin: '4821' });
    expect(set.status).toBe(422);
    expect(set.body.code).toBe('PIN_CASHIER_ONLY');
  });

  it('promoting a cashier takes the PIN away, and the PIN stops working', async () => {
    const u = await makeUser('cashier', '4821');
    expect((await c.http.post(`${api}/auth/pin`).send({ userId: u.body.id, pin: '4821' })).status).toBe(200);
    const promoted = await c.http.patch(`${api}/users/${u.body.id}`).set(auth(admin)).send({ role: 'manager' });
    expect(promoted.body.hasPin).toBe(false);
    expect((await c.http.post(`${api}/auth/pin`).send({ userId: u.body.id, pin: '4821' })).status).toBe(401);
  });

  it('even a PIN already stored on a manager (an old account) does not sign in', async () => {
    const m = await makeUser('manager');
    const db = new Database(c.databasePath);
    try {
      db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(await hashPassword('4821'), m.body.id);
    } finally {
      db.close();
    }
    expect((await c.http.post(`${api}/auth/pin`).send({ userId: m.body.id, pin: '4821' })).status).toBe(401);
    const list = await c.http.get(`${api}/users/pin-list`).set(auth(cashier));
    expect(list.body.data.map((u: { id: number }) => u.id)).not.toContain(m.body.id);
  });
});

describe('lockout cannot be dodged by changing the capital letters', () => {
  it('five wrong passwords as "NAME" lock "name" as well', async () => {
    const username = `lock-${randomUUID().slice(0, 8)}`;
    await c.http
      .post(`${api}/users`)
      .set(auth(admin))
      .send({ username, name: 'Lock', role: 'cashier', password: 'a-long-enough-password' });
    for (let i = 0; i < 5; i++)
      await c.http.post(`${api}/auth/login`).send({ username: username.toUpperCase(), password: 'wrong-password' });
    const res = await c.http.post(`${api}/auth/login`).send({ username, password: 'a-long-enough-password' });
    expect(res.status).toBe(423);
  });
});

describe('only this PC’s own addresses are answered (DNS rebinding and cross-site requests)', () => {
  it('refuses a request addressed to some other name', async () => {
    const res = await c.http.get(`${api}/healthz`).set('Host', 'evil.example.com');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('HOST_NOT_ALLOWED');
  });

  it('answers to localhost, 127.0.0.1 and [::1], with or without a port', async () => {
    for (const host of ['localhost', 'localhost:3000', '127.0.0.1', '127.0.0.1:3000', '[::1]', '[::1]:3000', 'LOCALHOST']) {
      expect((await c.http.get(`${api}/healthz`).set('Host', host)).status, host).toBe(200);
    }
  });

  it('refuses a request that comes from another website, and one with an origin it cannot read', async () => {
    for (const origin of ['https://evil.example.com', 'http://localhost.evil.example.com', 'null', 'not a url']) {
      const res = await c.http.post(`${api}/auth/login`).set('Origin', origin).send({ username: 'admin', password: 'whatever' });
      expect(res.status, origin).toBe(403);
      expect(res.body.code, origin).toBe('ORIGIN_NOT_ALLOWED');
    }
  });

  it('accepts the web app’s own origin, and never adds CORS headers (no other site may read the answers)', async () => {
    const res = await c.http.get(`${api}/healthz`).set('Origin', 'http://localhost:5173');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('another name (a tablet) is allowed only when the owner lists it', async () => {
    process.env.ALLOWED_HOSTS = 'till.shop.lan, 192.168.1.20';
    const other = await startCtx();
    delete process.env.ALLOWED_HOSTS;
    try {
      expect((await other.http.get(`${api}/healthz`).set('Host', 'till.shop.lan:3000')).status).toBe(200);
      expect((await other.http.get(`${api}/healthz`).set('Host', '192.168.1.20')).status).toBe(200);
      expect((await other.http.get(`${api}/healthz`).set('Host', 'evil.example.com')).status).toBe(403);
    } finally {
      await other.close();
    }
  });
});

describe('headers', () => {
  it('every answer forbids framing, sniffing and leaking the address, and only allows this server’s own scripts', async () => {
    for (const res of [await c.http.get(`${api}/healthz`), await c.http.get(`${api}/no-such-route`)]) {
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
      const csp = String(res.headers['content-security-policy']);
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toMatch(/script-src[^;]*unsafe/); // no inline or eval scripts, ever
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
    }
  });

  it('the API answers are never cached', async () => {
    expect((await c.http.get(`${api}/me`).set(auth(cashier))).headers['cache-control']).toBe('no-store');
  });
});

describe('hostile input', () => {
  const count = (table: string) => {
    const db = new Database(c.databasePath, { readonly: true });
    try {
      return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    } finally {
      db.close();
    }
  };

  it('SQL in a search box, a barcode, a name or a query is only ever text', async () => {
    const users = count('users');
    const products = count('products');
    const attacks = ["'; DROP TABLE users;--", "' OR '1'='1", '" OR 1=1 --', '%', '_', '\\', 'a" AND "b', '*', 'NEAR(a b)', '\u0000'];
    for (const a of attacks) {
      const q = encodeURIComponent(a);
      for (const path of [`/products?q=${q}`, `/customers?q=${q}`, `/products/by-barcode/${q}`, `/sales?ref=${q}`, `/expenses?from=${q}`]) {
        const token = path.startsWith('/expenses') ? manager : cashier;
        const res = await c.http.get(`${api}${path}`).set(auth(token));
        expect(res.status, `${path}`).toBeLessThan(500);
        expect(JSON.stringify(res.body), path).not.toMatch(/SQLITE|syntax error|near "/i);
      }
    }
    expect(count('users')).toBe(users);
    expect(count('products')).toBe(products);
  });

  it('a broken JSON body is a plain 400 with no stack trace', async () => {
    const res = await c.http.post(`${api}/auth/login`).set('Content-Type', 'application/json').send('{"username": "a",');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/at \w+|node_modules|SyntaxError|\.ts:\d/);
  });

  it('a huge body is refused before it is read in full', async () => {
    const res = await c.http.post(`${api}/auth/login`).send({ username: 'a', password: 'x'.repeat(2_000_000) });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('an id that is not a number never reaches the database as anything else', async () => {
    for (const path of ['/products/abc', '/customers/1%20OR%201=1', '/purchases/-1', '/sales/by-ref/x']) {
      const res = await c.http.get(`${api}${path}`).set(auth(admin));
      expect(res.status, path).toBeLessThan(500);
    }
  });
});

describe('what the server writes to its log', () => {
  it('records the requests but never a password, a PIN, a token, a cookie or the backup passphrase', async () => {
    const lines: string[] = [];
    const secrets = {
      wrongPassword: 'Wrong-Password-XYZ-123',
      newPassword: 'Brand-New-Password-987',
      changedPassword: 'Changed-Password-654',
      pin: '73915028',
      wrongPin: '11223344',
      passphrase: 'logging-test-passphrase',
    };
    const dir = (await import('node:fs')).mkdtempSync(join(tmpdir(), 'pos-log-'));
    const logged = await startCtx({
      logStream: { write: (l) => void lines.push(l) },
      backup: { dir, passphrase: secrets.passphrase, keep: 3 },
    });
    try {
      const login = await logged.http.post(`${api}/auth/login`).send({ username: 'admin', password: 'test-admin-pass' });
      const token = login.body.accessToken as string;
      const cookie = /pos_refresh=([^;]+)/.exec(String(login.headers['set-cookie']))![1]!;

      await logged.http.post(`${api}/auth/login`).send({ username: 'admin', password: secrets.wrongPassword });
      const made = await logged.http
        .post(`${api}/users`)
        .set(auth(token))
        .send({ username: 'logtest', name: 'Log Test', role: 'cashier', password: secrets.newPassword, pin: secrets.pin });
      await logged.http.post(`${api}/auth/pin`).send({ userId: made.body.id, pin: secrets.wrongPin });
      await logged.http.post(`${api}/auth/pin`).send({ userId: made.body.id, pin: secrets.pin });
      await logged.http.post(`${api}/auth/refresh`).set('Cookie', `pos_refresh=${cookie}`);
      const approval = await logged.http
        .post(`${api}/auth/approve`)
        .set(auth(token))
        .send({ username: 'manager', password: 'test-manager-pass', scope: 'discount', pct: 25 });
      expect(approval.status).toBe(200);
      await logged.http
        .post(`${api}/auth/approve`)
        .set(auth(token))
        .send({ username: 'manager', password: secrets.wrongPassword, scope: 'discount', pct: 25 });
      await logged.http.get(`${api}/me`).set(auth(token));
      await logged.http.post(`${api}/backups`).set(auth(token));
      await logged.http
        .post(`${api}/auth/change-password`)
        .set(auth(token))
        .send({ currentPassword: 'test-admin-pass', newPassword: secrets.changedPassword });

      const text = lines.join('');
      expect(text).toContain('/api/v1/auth/login'); // it does log what happened, so this check is not empty
      expect(text).toContain('incoming request');
      for (const [what, secret] of Object.entries({
        ...secrets,
        managerPassword: 'test-manager-pass',
        approvalToken: approval.body.approvalToken as string,
        adminPassword: 'test-admin-pass',
        accessToken: token,
        refreshCookie: cookie,
      })) {
        expect(text.includes(secret), `the log contains the ${what}`).toBe(false);
      }
      expect(text).not.toMatch(/authorization|set-cookie|"cookie"/i);
    } finally {
      await logged.close();
      (await import('node:fs')).rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('what the answers never contain', () => {
  it('no password, PIN, hash, token secret or backup passphrase appears in the users, session or settings answers', async () => {
    const texts = [
      JSON.stringify((await c.http.get(`${api}/users`).set(auth(admin))).body),
      JSON.stringify((await c.http.get(`${api}/me`).set(auth(admin))).body),
      JSON.stringify((await c.http.get(`${api}/settings`).set(auth(admin))).body),
      JSON.stringify((await c.http.get(`${api}/audit?limit=200`).set(auth(admin))).body),
    ];
    for (const t of texts) expect(t).not.toMatch(/argon2|\$argon|password_?hash|pin_?hash|jwt_?secret|passphrase|refresh_?token/i);
  });

  it('a cashier cannot read other people’s accounts, the audit log or the settings', async () => {
    for (const path of ['/users', '/audit', '/settings', '/backups', '/exchange-rates']) {
      expect((await c.http.get(`${api}${path}`).set(auth(cashier))).status, path).toBe(403);
    }
  });
});
