import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCtx, type TestCtx } from '../helpers/app';

// US-25 / US-26: a person given a first password can do nothing but change it, on the server as well as on the screen.
let c: TestCtx;
let admin: string;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  c = await startCtx();
  admin = await c.login('admin');
});
afterAll(() => c.close());

describe('a first password must be replaced before anything else', () => {
  it('is refused everywhere except /me and change-password, then everything works', async () => {
    const made = await c.http
      .post(`${api}/users`)
      .set(auth(admin))
      .send({ username: 'first.timer', name: 'First', role: 'manager', password: 'first-password-1' });
    expect(made.status).toBe(201);
    expect((await c.http.patch(`${api}/users/${made.body.id}`).set(auth(admin)).send({ mustResetPassword: true })).status).toBe(200);

    const login = await c.http.post(`${api}/auth/login`).send({ username: 'first.timer', password: 'first-password-1' });
    expect(login.status).toBe(200);
    expect(login.body.user.mustResetPassword).toBe(true);
    const t = login.body.accessToken as string;

    for (const path of ['/products', '/sales', '/registers/current', '/reports/dashboard', '/exchange-rates/current']) {
      const res = await c.http.get(`${api}${path}`).set(auth(t));
      expect(res.status, path).toBe(403);
      expect(res.body.code, path).toBe('PASSWORD_RESET_REQUIRED');
    }
    expect((await c.http.post(`${api}/sales`).set(auth(t)).set('Idempotency-Key', 'k1').send({})).status).toBe(403);
    expect((await c.http.post(`${api}/auth/approve`).set(auth(t)).send({})).status).toBe(403);

    const me = await c.http.get(`${api}/me`).set(auth(t));
    expect(me.status).toBe(200);
    expect(me.body.user.mustResetPassword).toBe(true);

    expect(
      (
        await c.http
          .post(`${api}/auth/change-password`)
          .set(auth(t))
          .send({ currentPassword: 'wrong-wrong-1', newPassword: 'my-own-password-1' })
      ).status,
    ).toBe(401);
    const changed = await c.http
      .post(`${api}/auth/change-password`)
      .set(auth(t))
      .send({ currentPassword: 'first-password-1', newPassword: 'my-own-password-1' });
    expect(changed.status).toBe(200);
    expect(changed.body.user.mustResetPassword).toBe(false);

    const fresh = changed.body.accessToken as string;
    expect((await c.http.get(`${api}/products`).set(auth(fresh))).status).toBe(200);
    expect((await c.http.get(`${api}/me`).set(auth(fresh))).body.user.mustResetPassword).toBe(false);
  });

  it('an admin giving someone a new password can make them choose again, and the people already fine are not touched', async () => {
    const manager = await c.login('manager');
    expect((await c.http.get(`${api}/products`).set(auth(manager))).status).toBe(200);
    const list = await c.http.get(`${api}/users`).set(auth(admin));
    const m = list.body.data.find((u: { username: string }) => u.username === c.seed.users.manager.username);
    await c.http.patch(`${api}/users/${m.id}`).set(auth(admin)).send({ password: 'reset-by-admin-1', mustResetPassword: true });
    // their old session ended with the password change; the new first password is stopped the same way
    const again = await c.http.post(`${api}/auth/login`).send({ username: m.username, password: 'reset-by-admin-1' });
    expect((await c.http.get(`${api}/products`).set(auth(again.body.accessToken))).body.code).toBe('PASSWORD_RESET_REQUIRED');
  });
});
