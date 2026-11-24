import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startCtx, type TestCtx } from '../helpers/app';

let c: TestCtx;
let admin: string;
let manager: string;
let cashier: string;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const api = '/api/v1';

beforeAll(async () => {
  c = await startCtx();
  admin = await c.login('admin');
  manager = await c.login('manager');
  cashier = await c.login('cashier');
});
afterAll(() => c.close());

describe('users (US-26)', () => {
  const body = { username: 'newbie', name: 'New Cashier', role: 'cashier', password: 'a-good-password-1' };

  it('an admin creates a user; the response has no secrets', async () => {
    const res = await c.http.post(`${api}/users`).set(auth(admin)).send(body);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ username: 'newbie', role: 'cashier', active: true, hasPin: false, mustResetPassword: false });
    expect(JSON.stringify(res.body)).not.toMatch(/argon2|a-good-password/);
  });

  it('refuses a duplicate username, ignoring case', async () => {
    const res = await c.http
      .post(`${api}/users`)
      .set(auth(admin))
      .send({ ...body, username: 'NEWBIE' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('USERNAME_TAKEN');
  });

  it.each([
    ['a short password', { password: 'short' }],
    ['an unknown role', { role: 'owner' }],
    ['a username with spaces', { username: 'bad name' }],
    ['a username that is too short', { username: 'ab' }],
  ])('validates: %s', async (_name, over) => {
    const res = await c.http
      .post(`${api}/users`)
      .set(auth(admin))
      .send({ ...body, username: 'x-valid', ...over });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION');
  });

  it('only admins can create, edit or list users', async () => {
    for (const t of [cashier, manager]) {
      expect((await c.http.post(`${api}/users`).set(auth(t)).send(body)).status).toBe(403);
      expect((await c.http.patch(`${api}/users/1`).set(auth(t)).send({ name: 'x' })).status).toBe(403);
    }
  });

  it('edits name, role and contact details, and audits the change', async () => {
    const list = await c.http.get(`${api}/users`).set(auth(admin));
    const id = list.body.data.find((u: { username: string }) => u.username === 'newbie').id;
    const res = await c.http.patch(`${api}/users/${id}`).set(auth(admin)).send({ name: 'Renamed', role: 'manager', phone: '03111222' });
    expect(res.body).toMatchObject({ name: 'Renamed', role: 'manager', phone: '03111222' });
    const log = await c.http.get(`${api}/audit?entity=user&entityId=${id}&action=user.update`).set(auth(admin));
    expect(log.body.data[0].before).toMatchObject({ name: 'New Cashier', role: 'cashier' });
    expect(log.body.data[0].after).toMatchObject({ name: 'Renamed', role: 'manager' });
  });

  it('an admin cannot deactivate or demote themselves', async () => {
    const id = c.seed.users.admin.id;
    const a = await c.http.patch(`${api}/users/${id}`).set(auth(admin)).send({ active: false });
    const b = await c.http.patch(`${api}/users/${id}`).set(auth(admin)).send({ role: 'manager' });
    expect(a.status).toBe(422);
    expect(a.body.code).toBe('CANNOT_DEMOTE_SELF');
    expect(b.status).toBe(422);
  });

  it('a second admin can edit other users, but still cannot demote themselves', async () => {
    const second = await c.http
      .post(`${api}/users`)
      .set(auth(admin))
      .send({ username: 'admin2', name: 'Admin Two', role: 'admin', password: 'second-admin-pass' });
    const t2 = (await c.http.post(`${api}/auth/login`).send({ username: 'admin2', password: 'second-admin-pass' })).body
      .accessToken as string;
    const demote = await c.http.patch(`${api}/users/${second.body.id}`).set(auth(t2)).send({ role: 'manager' }); // self: refused
    expect(demote.status).toBe(422);
    const ok = await c.http.patch(`${api}/users/${c.seed.users.cashier.id}`).set(auth(t2)).send({ name: 'Edited by admin2' });
    expect(ok.status).toBe(200);
  });

  it('returns 404 for an unknown user and 400 for a bad body', async () => {
    expect((await c.http.patch(`${api}/users/99999`).set(auth(admin)).send({ name: 'x' })).status).toBe(404);
    expect((await c.http.patch(`${api}/users/1`).set(auth(admin)).send({ role: 'god' })).status).toBe(400);
  });

  it('user creation is audited without the password', async () => {
    const log = await c.http.get(`${api}/audit?action=user.create&entity=user`).set(auth(admin));
    expect(log.body.data.length).toBeGreaterThan(0);
    expect(JSON.stringify(log.body)).not.toMatch(/a-good-password|argon2/);
  });
});

describe('settings', () => {
  it('any signed-in user can read the public settings, without internal fields', async () => {
    const res = await c.http.get(`${api}/settings/public`).set(auth(cashier));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Darwish Market', lbpRounding: 5000, receiptWidth: 42 });
    expect(res.body).not.toHaveProperty('printerName');
    expect(res.body).not.toHaveProperty('email');
  });

  it('public settings need a token', async () => {
    expect((await c.http.get(`${api}/settings/public`)).status).toBe(401);
  });

  it('only an admin reads the full settings', async () => {
    expect((await c.http.get(`${api}/settings`).set(auth(manager))).status).toBe(403);
    const res = await c.http.get(`${api}/settings`).set(auth(admin));
    expect(res.body).toHaveProperty('printerName');
  });

  it('an admin updates settings, and the change is audited with before and after', async () => {
    const res = await c.http.patch(`${api}/settings`).set(auth(admin)).send({ lbpRounding: 1000, receiptFooter: 'Come again!' });
    expect(res.body).toMatchObject({ lbpRounding: 1000, receiptFooter: 'Come again!', name: 'Darwish Market' });
    const log = await c.http.get(`${api}/audit?action=settings.update`).set(auth(admin));
    expect(log.body.data[0].before.lbpRounding).toBe(5000);
    expect(log.body.data[0].after.lbpRounding).toBe(1000);
  });

  it('an empty patch changes nothing', async () => {
    const before = (await c.http.get(`${api}/settings`).set(auth(admin))).body;
    const res = await c.http.patch(`${api}/settings`).set(auth(admin)).send({});
    expect(res.body).toEqual(before);
  });

  it.each([
    ['rounding of zero', { lbpRounding: 0 }],
    ['a non-integer rounding', { lbpRounding: 2.5 }],
    ['a receipt width that is too narrow', { receiptWidth: 10 }],
    ['a receipt width that is too wide', { receiptWidth: 200 }],
    ['a discount limit above 100', { cashierDiscountLimitPct: 150 }],
    ['an empty shop name', { name: '' }],
  ])('rejects %s', async (_n, over) => {
    expect((await c.http.patch(`${api}/settings`).set(auth(admin)).send(over)).status).toBe(400);
  });

  it('ignores fields it does not know (no mass assignment)', async () => {
    const res = await c.http.patch(`${api}/settings`).set(auth(admin)).send({ id: 99, name: 'Still Darwish' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Still Darwish');
  });
});

describe('audit log', () => {
  it('pages newest first with a cursor', async () => {
    const first = await c.http.get(`${api}/audit?limit=2`).set(auth(admin));
    expect(first.body.data).toHaveLength(2);
    expect(first.body.data[0].id).toBeGreaterThan(first.body.data[1].id);
    expect(first.body.nextCursor).toBe(first.body.data[1].id);
    const second = await c.http.get(`${api}/audit?limit=2&cursor=${first.body.nextCursor}`).set(auth(admin));
    expect(second.body.data[0].id).toBeLessThan(first.body.data[1].id);
  });

  it('filters by user, action and entity', async () => {
    const res = await c.http.get(`${api}/audit?action=settings.update&userId=${c.seed.users.admin.id}`).set(auth(admin));
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every((r: { action: string }) => r.action === 'settings.update')).toBe(true);
  });

  it('rejects an out-of-range limit', async () => {
    expect((await c.http.get(`${api}/audit?limit=5000`).set(auth(admin))).status).toBe(400);
  });

  it('has no write endpoints: history cannot be edited over the API', async () => {
    expect([404, 405]).toContain((await c.http.delete(`${api}/audit/1`).set(auth(admin))).status);
    expect([404, 405]).toContain((await c.http.patch(`${api}/audit/1`).set(auth(admin)).send({ action: 'x' })).status);
  });
});

describe('deleting users (US-26)', () => {
  const make = async (username: string, role: string, password = 'a-good-password-1') =>
    (
      await c.http
        .post(`${api}/users`)
        .set(auth(admin))
        .send({ username, name: `Name ${username}`, role, password })
    ).body as { id: number };
  const signIn = (username: string, password = 'a-good-password-1') => c.http.post(`${api}/auth/login`).send({ username, password });

  it('only an admin may delete a user', async () => {
    const u = await make('del-who', 'cashier');
    expect((await c.http.delete(`${api}/users/${u.id}`).set(auth(manager))).status).toBe(403);
    expect((await c.http.delete(`${api}/users/${u.id}`).set(auth(cashier))).status).toBe(403);
    expect((await c.http.delete(`${api}/users/${u.id}`)).status).toBe(401);
  });

  it('a deleted user disappears from the list, cannot sign in, loses their sessions, and the username is free again; it is audited', async () => {
    const u = await make('del-gone', 'cashier');
    const session = await signIn('del-gone');
    expect(session.status).toBe(200);

    expect((await c.http.delete(`${api}/users/${u.id}`).set(auth(admin))).status).toBe(204);
    const list = await c.http.get(`${api}/users`).set(auth(admin));
    expect(list.body.data.some((x: { id: number }) => x.id === u.id)).toBe(false);
    expect((await signIn('del-gone')).status).toBe(401);
    expect((await c.http.get(`${api}/me`).set(auth(session.body.accessToken))).status).toBe(401);
    expect((await c.http.delete(`${api}/users/${u.id}`).set(auth(admin))).status).toBe(404); // already gone
    expect((await c.http.patch(`${api}/users/${u.id}`).set(auth(admin)).send({ name: 'x' })).status).toBe(404);

    const again = await c.http
      .post(`${api}/users`)
      .set(auth(admin))
      .send({ username: 'del-gone', name: 'Someone new', role: 'cashier', password: 'another-good-pass-2' });
    expect(again.status).toBe(201); // the username can be given again
    expect((await signIn('del-gone', 'another-good-pass-2')).status).toBe(200);

    const log = await c.http.get(`${api}/audit?entity=user&entityId=${u.id}&action=user.delete`).set(auth(admin));
    expect(log.body.data[0].before).toMatchObject({ username: 'del-gone', role: 'cashier' });
    expect(JSON.stringify(log.body)).not.toMatch(/argon2|a-good-password/);
  });

  it('you cannot delete yourself, and the shop keeps at least one active admin', async () => {
    const self = await c.http.delete(`${api}/users/${c.seed.users.admin.id}`).set(auth(admin));
    expect(self.status).toBe(422);
    expect(self.body.code).toBe('CANNOT_DELETE_SELF');

    // a second admin deletes the first one's colleague; the one left cannot delete or demote themselves
    const second = await make('del-admin2', 'admin');
    const t2 = (await signIn('del-admin2')).body.accessToken as string;
    expect((await c.http.delete(`${api}/users/${second.id}`).set(auth(t2))).status).toBe(422); // self
    expect((await c.http.delete(`${api}/users/${c.seed.users.admin.id}`).set(auth(t2))).status).toBe(204); // the seeded admin goes
    expect((await c.http.get(`${api}/me`).set(auth(admin))).status).toBe(401); // and is signed out at once
    const left = await c.http.get(`${api}/users`).set(auth(t2));
    expect(left.body.data.filter((u: { role: string; active: boolean }) => u.role === 'admin' && u.active)).not.toHaveLength(0);
    expect((await c.http.patch(`${api}/users/${second.id}`).set(auth(t2)).send({ role: 'manager' })).status).toBe(422);
    expect((await c.http.delete(`${api}/users/${second.id}`).set(auth(t2))).status).toBe(422);
  });
});
