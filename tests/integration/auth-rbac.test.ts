import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startCtx, type TestCtx } from '../helpers/app';

let c: TestCtx;
beforeAll(async () => {
  c = await startCtx();
});
afterAll(() => c.close());

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('auth (US-25)', () => {
  it('logs in with valid credentials', async () => {
    const u = c.seed.users.cashier;
    const res = await c.http.post('/api/v1/auth/login').send({ username: u.username, password: u.password });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(String(res.headers['set-cookie'])).toMatch(/HttpOnly/i);
  });

  it('never returns the password or its hash', async () => {
    const t = await c.login('admin');
    const res = await c.http.get('/api/v1/users').set(auth(t));
    // (the flag "mustResetPassword" legitimately contains the word, so look for the secrets themselves)
    expect(JSON.stringify(res.body)).not.toMatch(/argon2|password_?hash|pin_?hash|"password"|"pin"/i);
  });

  it('rejects a wrong password with a generic message', async () => {
    const res = await c.http.post('/api/v1/auth/login').send({ username: c.seed.users.cashier.username, password: 'nope' });
    expect(res.status).toBe(401);
    expect(res.body.detail).not.toMatch(/user.*not found/i);
  });

  it('locks out after 5 failures in 15 minutes', async () => {
    // A throwaway user, so locking it does not affect the shared seed accounts the other tests sign in with.
    const admin = await c.login('admin');
    await c.http
      .post('/api/v1/users')
      .set(auth(admin))
      .send({ username: 'lockme', name: 'Lock Me', role: 'cashier', password: 'right-password-1' });

    for (let i = 0; i < 5; i++) await c.http.post('/api/v1/auth/login').send({ username: 'lockme', password: 'bad' });
    const res = await c.http.post('/api/v1/auth/login').send({ username: 'lockme', password: 'right-password-1' });
    expect([423, 429]).toContain(res.status);
    expect(res.headers['retry-after']).toBeTruthy();

    // other accounts are unaffected
    const other = await c.http
      .post('/api/v1/auth/login')
      .send({ username: c.seed.users.cashier.username, password: c.seed.users.cashier.password });
    expect(other.status).toBe(200);
  });

  it('rejects an expired / tampered token', async () => {
    const res = await c.http.get('/api/v1/me').set(auth('eyJhbGciOiJIUzI1NiJ9.e30.bad'));
    expect(res.status).toBe(401);
  });
});

describe('RBAC matrix (US-26)', () => {
  const cases: Array<[string, 'get' | 'post' | 'patch', string, 'cashier' | 'manager' | 'admin', number]> = [
    ['cashier cannot read reports', 'get', '/api/v1/reports/dashboard', 'cashier', 403],
    ['cashier cannot create products', 'post', '/api/v1/products', 'cashier', 403],
    ['cashier cannot create a category', 'post', '/api/v1/categories', 'cashier', 403],
    ['cashier cannot rename a supplier', 'patch', '/api/v1/suppliers/1', 'cashier', 403],
    ['cashier can read the units', 'get', '/api/v1/units', 'cashier', 200],
    ['cashier cannot read expenses', 'get', '/api/v1/expenses', 'cashier', 403],
    ['cashier cannot discard a queued sale', 'post', '/api/v1/sales/queued-discard', 'cashier', 403],
    ['cashier can list their own sales', 'get', '/api/v1/sales', 'cashier', 200],
    ['cashier cannot list stocktakes', 'get', '/api/v1/stocktakes', 'cashier', 403],
    ['cashier cannot start a stocktake', 'post', '/api/v1/stocktakes', 'cashier', 403],
    ['cashier cannot read services', 'get', '/api/v1/services', 'cashier', 403],
    ['cashier cannot record a service', 'post', '/api/v1/services', 'cashier', 403],
    ['cashier cannot read the duplicate barcodes', 'get', '/api/v1/barcodes/duplicates', 'cashier', 403],
    ['cashier cannot merge products', 'post', '/api/v1/products/merge', 'cashier', 403],
    ['cashier cannot turn the barcode rule on', 'post', '/api/v1/barcodes/enforce', 'cashier', 403],
    ['manager can read stocktakes', 'get', '/api/v1/stocktakes', 'manager', 200],
    ['manager can read services', 'get', '/api/v1/services', 'manager', 200],
    ['manager can read the barcode status', 'get', '/api/v1/barcodes/status', 'manager', 200],
    ['cashier may start a void (it then needs an approval; an empty one is just invalid)', 'post', '/api/v1/sales/1/void', 'cashier', 400],
    [
      'cashier may start a delete (it then needs an approval; an empty one is just invalid)',
      'post',
      '/api/v1/sales/1/delete',
      'cashier',
      400,
    ],
    ['cashier can read the service types', 'get', '/api/v1/service-categories', 'cashier', 200],
    ['cashier cannot list the returns', 'get', '/api/v1/returns', 'cashier', 403],
    ['cashier may start a return (it then needs an approval; an empty one is just invalid)', 'post', '/api/v1/returns', 'cashier', 400],
    ['cashier cannot record an expense', 'post', '/api/v1/expenses', 'cashier', 403],
    ['manager can read expenses', 'get', '/api/v1/expenses', 'manager', 200],
    ['cashier cannot read users', 'get', '/api/v1/users', 'cashier', 403],
    ['manager cannot read users', 'get', '/api/v1/users', 'manager', 403],
    ['manager cannot change settings', 'patch', '/api/v1/settings', 'manager', 403],
    ['manager can read reports', 'get', '/api/v1/reports/dashboard', 'manager', 200],
    ['admin can read the audit log', 'get', '/api/v1/audit', 'admin', 200],
    ['cashier cannot read the audit log', 'get', '/api/v1/audit', 'cashier', 403],
  ];
  it.each(cases)('%s', async (_n, method, path, role, status) => {
    const t = await c.login(role);
    const res = await c.http[method](path).set(auth(t)).send({});
    expect(res.status).toBe(status);
  });

  it('changing a product price writes an audit row with before/after (US-27)', async () => {
    const m = await c.login('manager');
    const a = await c.login('admin');
    const id = c.seed.products.choc.id;
    await c.http.patch(`/api/v1/products/${id}`).set(auth(m)).send({ priceMinor: 55000 });
    const log = await c.http.get(`/api/v1/audit?entity=product&entityId=${id}`).set(auth(a));
    const row = log.body.data[0];
    expect(row.action).toBe('product.price.update');
    expect(row.before.priceMinor).toBe(50000);
    expect(row.after.priceMinor).toBe(55000);
  });
});

describe('input hardening', () => {
  it('is not vulnerable to SQL injection in search', async () => {
    const t = await c.login('cashier');
    const res = await c.http.get("/api/v1/products?q=' OR 1=1; DROP TABLE products;--").set(auth(t));
    expect(res.status).toBe(200);
    const after = await c.http.get('/api/v1/products').set(auth(t));
    expect(after.body.data.length).toBeGreaterThan(0);
  });

  it('returns RFC 7807 errors with a code', async () => {
    const t = await c.login('cashier');
    const res = await c.http.get('/api/v1/products/by-barcode/does-not-exist').set(auth(t));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});
