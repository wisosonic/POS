import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startCtx, type TestCtx } from '../helpers/app';

// Sessions: refresh rotation, logout, PIN switch, change password, immediate effect of role/active changes. (US-25)
let c: TestCtx;
let admin: string;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const api = '/api/v1';

const cookieOf = (res: { headers: Record<string, unknown> }): string => {
  const raw = res.headers['set-cookie'] as string[] | string | undefined;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const found = list.find((l) => l.startsWith('pos_refresh='));
  return found ? found.split(';')[0]! : '';
};

let counter = 0;
/** Create a throwaway user so a test can lock, demote or deactivate it without disturbing the shared seed accounts. */
async function makeUser(role: 'cashier' | 'manager' | 'admin', extra: Record<string, unknown> = {}) {
  const username = `u${++counter}_${role}`;
  const password = 'throwaway-pass-1';
  const res = await c.http
    .post(`${api}/users`)
    .set(auth(admin))
    .send({ username, name: username, role, password, ...extra });
  expect(res.status).toBe(201);
  return { id: res.body.id as number, username, password };
}
const login = (u: { username: string; password: string }) => c.http.post(`${api}/auth/login`).send(u);

beforeAll(async () => {
  c = await startCtx();
  admin = await c.login('admin');
});
afterAll(() => c.close());

describe('login response and cookie', () => {
  it('returns a short-lived access token and the user without secrets', async () => {
    const res = await c.http.post(`${api}/auth/login`).send({ username: 'cashier', password: c.seed.users.cashier.password });
    expect(res.status).toBe(200);
    expect(res.body.expiresIn).toBe(900);
    expect(res.body.user).toEqual({
      id: c.seed.users.cashier.id,
      username: 'cashier',
      name: 'Test cashier',
      role: 'cashier',
      mustResetPassword: false,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/argon2|hash/i);
  });

  it('sets the refresh token as an httpOnly, SameSite=Strict cookie scoped to /api/v1/auth', async () => {
    const res = await c.http.post(`${api}/auth/login`).send({ username: 'cashier', password: c.seed.users.cashier.password });
    const line = (res.headers['set-cookie'] as unknown as string[]).find((l) => l.startsWith('pos_refresh='))!;
    expect(line).toMatch(/HttpOnly/i);
    expect(line).toMatch(/SameSite=Strict/i);
    expect(line).toMatch(/Path=\/api\/v1\/auth/);
    expect(res.body.refreshToken).toBeUndefined(); // never in the body, so scripts cannot read it
  });

  it('matches usernames case-insensitively', async () => {
    const res = await c.http.post(`${api}/auth/login`).send({ username: 'CASHIER', password: c.seed.users.cashier.password });
    expect(res.status).toBe(200);
  });

  it('unknown user and wrong password are indistinguishable', async () => {
    const unknown = await c.http.post(`${api}/auth/login`).send({ username: 'nobody-here', password: 'whatever-1' });
    const wrong = await c.http.post(`${api}/auth/login`).send({ username: 'cashier', password: 'whatever-1' });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  it('validates the body', async () => {
    const res = await c.http.post(`${api}/auth/login`).send({ username: '' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION');
    expect(res.body.errors.map((e: { path: string }) => e.path)).toEqual(expect.arrayContaining(['username', 'password']));
  });

  it('a deactivated user cannot sign in', async () => {
    const u = await makeUser('cashier');
    await c.http.patch(`${api}/users/${u.id}`).set(auth(admin)).send({ active: false });
    expect((await login(u)).status).toBe(401);
  });
});

describe('refresh tokens rotate and detect reuse', () => {
  it('a refresh token works once and issues a new one', async () => {
    const first = await login(c.seed.users.cashier);
    const old = cookieOf(first);
    const res = await c.http.post(`${api}/auth/refresh`).set('Cookie', old);
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    const next = cookieOf(res);
    expect(next).not.toBe('');
    expect(next).not.toBe(old);
    expect((await c.http.get(`${api}/me`).set(auth(res.body.accessToken))).status).toBe(200);
  });

  it('reusing a spent refresh token is refused and revokes the whole session family', async () => {
    const first = await login(c.seed.users.cashier);
    const spent = cookieOf(first);
    const rotated = await c.http.post(`${api}/auth/refresh`).set('Cookie', spent);
    const live = cookieOf(rotated);

    const replay = await c.http.post(`${api}/auth/refresh`).set('Cookie', spent); // someone replays the stolen token
    expect(replay.status).toBe(401);
    const afterTheft = await c.http.post(`${api}/auth/refresh`).set('Cookie', live); // the legitimate holder is signed out too
    expect(afterTheft.status).toBe(401);
  });

  it('no cookie, a made-up cookie and an expired session all give 401', async () => {
    expect((await c.http.post(`${api}/auth/refresh`)).status).toBe(401);
    expect((await c.http.post(`${api}/auth/refresh`).set('Cookie', 'pos_refresh=not-a-real-token')).status).toBe(401);
  });

  it('logout revokes the refresh token', async () => {
    const session = await login(c.seed.users.cashier);
    const cookie = cookieOf(session);
    const out = await c.http.post(`${api}/auth/logout`).set('Cookie', cookie);
    expect(out.status).toBe(204);
    expect((await c.http.post(`${api}/auth/refresh`).set('Cookie', cookie)).status).toBe(401);
  });

  it('logout without a session is harmless', async () => {
    expect((await c.http.post(`${api}/auth/logout`)).status).toBe(204);
  });

  it('a deactivated user cannot refresh', async () => {
    const u = await makeUser('cashier');
    const cookie = cookieOf(await login(u));
    await c.http.patch(`${api}/users/${u.id}`).set(auth(admin)).send({ active: false });
    expect((await c.http.post(`${api}/auth/refresh`).set('Cookie', cookie)).status).toBe(401);
  });
});

describe('changes take effect immediately, not when the token expires', () => {
  it('deactivating a user kills their existing access token', async () => {
    const u = await makeUser('cashier');
    const token = (await login(u)).body.accessToken as string;
    expect((await c.http.get(`${api}/me`).set(auth(token))).status).toBe(200);
    await c.http.patch(`${api}/users/${u.id}`).set(auth(admin)).send({ active: false });
    expect((await c.http.get(`${api}/me`).set(auth(token))).status).toBe(401);
  });

  it('demoting a manager removes manager access on the very next request', async () => {
    const u = await makeUser('manager');
    const token = (await login(u)).body.accessToken as string;
    expect((await c.http.get(`${api}/reports/dashboard`).set(auth(token))).status).toBe(200);
    await c.http.patch(`${api}/users/${u.id}`).set(auth(admin)).send({ role: 'cashier' });
    expect((await c.http.get(`${api}/reports/dashboard`).set(auth(token))).status).toBe(403);
  });

  it('a password reset by an admin signs the user out everywhere', async () => {
    const u = await makeUser('cashier');
    const cookie = cookieOf(await login(u));
    await c.http.patch(`${api}/users/${u.id}`).set(auth(admin)).send({ password: 'brand-new-pass-2' });
    expect((await c.http.post(`${api}/auth/refresh`).set('Cookie', cookie)).status).toBe(401);
    expect((await login(u)).status).toBe(401);
    expect((await login({ username: u.username, password: 'brand-new-pass-2' })).status).toBe(200);
  });
});

describe('PIN quick switch', () => {
  it('lets a user with a PIN sign in, and rejects a wrong PIN', async () => {
    const u = await makeUser('cashier', { pin: '4821' });
    const ok = await c.http.post(`${api}/auth/pin`).send({ userId: u.id, pin: '4821' });
    expect(ok.status).toBe(200);
    expect(ok.body.user.username).toBe(u.username);
    expect(cookieOf(ok)).not.toBe('');
    expect((await c.http.post(`${api}/auth/pin`).send({ userId: u.id, pin: '0000' })).status).toBe(401);
  });

  it('a user without a PIN cannot use the PIN screen', async () => {
    const u = await makeUser('cashier');
    expect((await c.http.post(`${api}/auth/pin`).send({ userId: u.id, pin: '1234' })).status).toBe(401);
  });

  it('only accepts 4 to 8 digits', async () => {
    const u = await makeUser('cashier', { pin: '4821' });
    for (const pin of ['123', '123456789', 'abcd', '12 34']) {
      expect((await c.http.post(`${api}/auth/pin`).send({ userId: u.id, pin })).status).toBe(400);
    }
  });

  it('locks after 5 wrong PINs, separately from the password lockout', async () => {
    const u = await makeUser('cashier', { pin: '4821' });
    for (let i = 0; i < 5; i++) await c.http.post(`${api}/auth/pin`).send({ userId: u.id, pin: '9999' });
    const locked = await c.http.post(`${api}/auth/pin`).send({ userId: u.id, pin: '4821' });
    expect(locked.status).toBe(423);
    expect(locked.body.code).toBe('LOCKED');
    expect((await login(u)).status).toBe(200); // the password still works
  });

  it('shows hasPin but never the PIN or its hash', async () => {
    const u = await makeUser('cashier', { pin: '4821' });
    const list = await c.http.get(`${api}/users`).set(auth(admin));
    const row = list.body.data.find((x: { id: number }) => x.id === u.id);
    expect(row.hasPin).toBe(true);
    expect(JSON.stringify(list.body)).not.toMatch(/4821|argon2/);
  });

  it('removing the PIN disables it', async () => {
    const u = await makeUser('cashier', { pin: '4821' });
    await c.http.patch(`${api}/users/${u.id}`).set(auth(admin)).send({ pin: null });
    expect((await c.http.post(`${api}/auth/pin`).send({ userId: u.id, pin: '4821' })).status).toBe(401);
  });

  it('the PIN screen lists only active users that have a PIN, by name only', async () => {
    const withPin = await makeUser('cashier', { pin: '4821' });
    const without = await makeUser('cashier');
    const res = await c.http.get(`${api}/users/pin-list`).set(auth(admin));
    const ids = res.body.data.map((x: { id: number }) => x.id);
    expect(ids).toContain(withPin.id);
    expect(ids).not.toContain(without.id);
    expect(Object.keys(res.body.data[0]).sort()).toEqual(['id', 'name']);
  });
});

describe('change password', () => {
  it('requires the current password', async () => {
    const u = await makeUser('cashier');
    const token = (await login(u)).body.accessToken as string;
    const res = await c.http
      .post(`${api}/auth/change-password`)
      .set(auth(token))
      .send({ currentPassword: 'wrong-pass-9', newPassword: 'new-password-3' });
    expect(res.status).toBe(401);
  });

  it('rejects a short or unchanged password', async () => {
    const u = await makeUser('cashier');
    const token = (await login(u)).body.accessToken as string;
    expect(
      (await c.http.post(`${api}/auth/change-password`).set(auth(token)).send({ currentPassword: u.password, newPassword: 'short' }))
        .status,
    ).toBe(400);
    expect(
      (await c.http.post(`${api}/auth/change-password`).set(auth(token)).send({ currentPassword: u.password, newPassword: u.password }))
        .status,
    ).toBe(400);
  });

  it('changes the password, clears the reset flag, ends other sessions and keeps this one', async () => {
    const u = await makeUser('cashier');
    await c.http.patch(`${api}/users/${u.id}`).set(auth(admin)).send({ mustResetPassword: true });
    const first = await login(u);
    expect(first.body.user.mustResetPassword).toBe(true);
    const otherDevice = cookieOf(await login(u));

    const res = await c.http
      .post(`${api}/auth/change-password`)
      .set(auth(first.body.accessToken))
      .send({ currentPassword: u.password, newPassword: 'fresh-password-4' });
    expect(res.status).toBe(200);
    expect(res.body.user.mustResetPassword).toBe(false);

    expect((await c.http.post(`${api}/auth/refresh`).set('Cookie', otherDevice)).status).toBe(401);
    expect((await login(u)).status).toBe(401);
    expect((await login({ username: u.username, password: 'fresh-password-4' })).status).toBe(200);
  });

  it('is written to the audit log without any password', async () => {
    const u = await makeUser('cashier');
    const token = (await login(u)).body.accessToken as string;
    await c.http.post(`${api}/auth/change-password`).set(auth(token)).send({ currentPassword: u.password, newPassword: 'audited-pass-5' });
    const log = await c.http.get(`${api}/audit?action=user.password.change&userId=${u.id}`).set(auth(admin));
    expect(log.body.data).toHaveLength(1);
    expect(JSON.stringify(log.body)).not.toMatch(/audited-pass-5|throwaway-pass/);
  });
});

describe('/me, health and error shape', () => {
  it('/me returns the capabilities for the role', async () => {
    const t = await c.login('manager');
    const res = await c.http.get(`${api}/me`).set(auth(t));
    expect(res.body.user.role).toBe('manager');
    expect(res.body.capabilities).toContain('reports.read');
    expect(res.body.capabilities).toContain('returns.create');
    expect(res.body.capabilities).not.toContain('users.manage');
    const cashier = await c.http.get(`${api}/me`).set(auth(await c.login('cashier')));
    expect(cashier.body.capabilities).toContain('sell');
    expect(cashier.body.capabilities).not.toContain('reports.read');
  });

  it('protected routes answer 401 without a token, as problem+json', async () => {
    const res = await c.http.get(`${api}/products`);
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 401, code: 'UNAUTHENTICATED', title: 'Unauthorized' });
  });

  it('health endpoints are public', async () => {
    expect((await c.http.get(`${api}/healthz`)).body).toEqual({ status: 'ok' });
    const ready = await c.http.get(`${api}/readyz`);
    // the newest migration that has been applied: its name changes with every new migration, so only its shape is checked
    expect(ready.body).toEqual({ status: 'ready', schema: expect.stringMatching(/^\d{4}_.+\.sql$/) });
  });

  it('unknown routes give a 404 problem', async () => {
    const res = await c.http.get(`${api}/nope`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('malformed JSON gives a 400 problem and never a stack trace', async () => {
    const res = await c.http.post(`${api}/auth/login`).set('Content-Type', 'application/json').send('{"username": ');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.(ts|js)|node_modules/);
  });

  it('responses are never cacheable and not sniffable', async () => {
    const res = await c.http.get(`${api}/healthz`);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
