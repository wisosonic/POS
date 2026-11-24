import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startCtx, type TestCtx } from '../helpers/app';

let c: TestCtx;
let manager: string;
let cashier: string;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const api = '/api/v1';

beforeAll(async () => {
  c = await startCtx();
  manager = await c.login('manager');
  cashier = await c.login('cashier');
});
afterAll(() => c.close());

describe('lookups: categories, brands, units, suppliers (US-15)', () => {
  it('a manager adds a category and any signed-in user can list it, sorted by name', async () => {
    expect((await c.http.post(`${api}/categories`).set(auth(manager)).send({ name: 'Zeta drinks' })).status).toBe(201);
    expect((await c.http.post(`${api}/categories`).set(auth(manager)).send({ name: 'alpha snacks' })).status).toBe(201);
    const list = await c.http.get(`${api}/categories`).set(auth(cashier));
    expect(list.status).toBe(200);
    const names = list.body.data.map((x: { name: string }) => x.name);
    expect(names.indexOf('alpha snacks')).toBeLessThan(names.indexOf('Zeta drinks'));
  });

  it('refuses a second brand with the same name, ignoring case', async () => {
    await c.http.post(`${api}/brands`).set(auth(manager)).send({ name: 'Cedars' });
    const dup = await c.http.post(`${api}/brands`).set(auth(manager)).send({ name: '  cedars ' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('DUPLICATE_NAME');
  });

  it('a unit says whether it is sold by weight, and can be changed', async () => {
    const made = await c.http.post(`${api}/units`).set(auth(manager)).send({ name: 'Litre', fractional: true });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ name: 'Litre', fractional: true });
    const patched = await c.http.patch(`${api}/units/${made.body.id}`).set(auth(manager)).send({ fractional: false });
    expect(patched.body.fractional).toBe(false);
    expect(patched.body.name).toBe('Litre');
  });

  it('a supplier keeps phone and address; a patch of one field leaves the others alone', async () => {
    const made = await c.http
      .post(`${api}/suppliers`)
      .set(auth(manager))
      .send({ name: 'Beirut Wholesale', phone: '01234567', address: 'Hamra' });
    expect(made.body).toMatchObject({ phone: '01234567', address: 'Hamra', email: null });
    const patched = await c.http.patch(`${api}/suppliers/${made.body.id}`).set(auth(manager)).send({ phone: '03999999' });
    expect(patched.body).toMatchObject({ name: 'Beirut Wholesale', phone: '03999999', address: 'Hamra' });
  });

  it('renaming to another entry’s name is refused; keeping its own name is fine', async () => {
    const a = await c.http.post(`${api}/categories`).set(auth(manager)).send({ name: 'Dairy' });
    await c.http.post(`${api}/categories`).set(auth(manager)).send({ name: 'Bakery' });
    expect((await c.http.patch(`${api}/categories/${a.body.id}`).set(auth(manager)).send({ name: 'bakery' })).status).toBe(409);
    expect((await c.http.patch(`${api}/categories/${a.body.id}`).set(auth(manager)).send({ name: 'Dairy' })).status).toBe(200);
  });

  it('an unknown id is 404 and an empty name is rejected', async () => {
    expect((await c.http.patch(`${api}/brands/99999`).set(auth(manager)).send({ name: 'x' })).status).toBe(404);
    expect((await c.http.post(`${api}/brands`).set(auth(manager)).send({ name: '   ' })).status).toBe(400);
  });
});
