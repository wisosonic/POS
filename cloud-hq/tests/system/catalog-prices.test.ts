import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminAuth, branchAuth, startHq, type Hq } from '../helpers';
import { api, auth, startFreshBranch, until, type FreshBranch } from './freshBranch';

// A branch's own price for a product (docs/12 §20, P3c): HQ keeps the override and the branch receives the product at the price it should sell at.
let hq: Hq;
let a: FreshBranch;
let b: FreshBranch;
let idA = 0;
let idB = 0;
let product = 0;

const priceAt = async (br: FreshBranch, id = product) =>
  (await br.http.get(`${api}/products/${id}`).set(auth(br.admin))).body.priceMinor as number;
const setOverride = (branchId: number, price: number, id = product) =>
  hq.http.put(`${api}/branches/${branchId}/prices/${id}`).set(adminAuth).send({ priceMinor: price });
const setBase = (price: number, id = product) => hq.http.patch(`${api}/products/${id}`).set(adminAuth).send({ priceMinor: price });
const branchIdOf = async (code: string) =>
  (await hq.app.database.one<{ id: number }>('SELECT id FROM branches WHERE code = ?', [code]))!.id;
// A branch's own token, from its own link (it is never shown again, and enrolling anew would replace it).
const tokenOf = async (br: FreshBranch) =>
  (await br.app.database.one<{ branch_token: string }>('SELECT branch_token FROM hq_link WHERE id = 1'))!.branch_token;
const seen = async (br: FreshBranch) => (await hq.http.get(`${api}/sync/ping`).set(branchAuth(await tokenOf(br)))).body.changeSeq as number;
const cursorOf = async (br: FreshBranch) =>
  (await br.app.database.one<{ down_cursor: number }>('SELECT down_cursor FROM sync_control WHERE id = 1'))!.down_cursor;

beforeAll(async () => {
  hq = await startHq();
  a = await startFreshBranch();
  b = await startFreshBranch();
  product = (
    await hq.http
      .post(`${api}/products`)
      .set(adminAuth)
      .send({ name: 'Sugar', barcode: '5281000009001', priceMinor: 100000, costMinor: 60000 })
  ).body.id;
  expect((await a.connect(hq, 'PA')).status).toBe(200);
  expect((await b.connect(hq, 'PB')).status).toBe(200);
  idA = await branchIdOf('PA');
  idB = await branchIdOf('PB');
  expect(await until(async () => (await priceAt(a)) === 100000 && (await priceAt(b)) === 100000)).toBe(true);
});
afterAll(async () => {
  await a.close();
  await b.close();
  await hq.close();
});

describe('overrides at HQ', () => {
  it('are set for one branch and product, listed, and refused for nothing that exists (US-HQ-prices)', async () => {
    const r = await setOverride(idA, 80000);
    expect([r.status, r.body.changed]).toEqual([200, true]);
    const list = (await hq.http.get(`${api}/branches/${idA}/prices`).set(adminAuth)).body.data;
    expect(list).toEqual([
      expect.objectContaining({ productId: product, productName: 'Sugar', basePriceMinor: 100000, priceMinor: 80000, currency: 'LBP' }),
    ]);
    expect((await hq.http.get(`${api}/products/${product}/prices`).set(adminAuth)).body.data).toEqual([
      { branchId: idA, priceMinor: 80000 },
    ]);
    expect((await setOverride(9999, 1)).status).toBe(404);
    expect((await setOverride(idA, 1, 9999)).status).toBe(404);
    for (const bad of [-1, 1.5, '5', null])
      expect(
        (await hq.http.put(`${api}/branches/${idA}/prices/${product}`).set(adminAuth).send({ priceMinor: bad })).status,
        String(bad),
      ).toBe(400);
    expect((await hq.http.put(`${api}/branches/${idA}/prices/${product}`).send({ priceMinor: 5 })).status).toBe(401);
  });

  it('the same price again writes nothing', async () => {
    const lines = async () => (await hq.app.database.one<{ n: number }>('SELECT COUNT(*) AS n FROM change_log'))!.n;
    const before = await lines();
    const r = await setOverride(idA, 80000);
    expect(r.body.changed).toBe(false);
    expect(await lines()).toBe(before);
  });
});

describe('the branch receives the price it should sell at', () => {
  it('only the branch with an override sees it; the other keeps the base price', async () => {
    expect(await until(async () => (await priceAt(a)) === 80000)).toBe(true);
    expect(await priceAt(b)).toBe(100000);
  });

  it('a change of the base price reaches both, and the override stays where it is', async () => {
    await setBase(120000);
    expect(await until(async () => (await priceAt(b)) === 120000)).toBe(true);
    expect(await priceAt(a)).toBe(80000);
  });

  it('another branch’s override does not make this branch ask for changes again and again', async () => {
    await new Promise((r) => setTimeout(r, 600)); // everything settles
    const cursorB = await cursorOf(b);
    const newsB = await seen(b);
    const newsA = await seen(a);
    await setOverride(idA, 70000); // meant for A only
    expect(await until(async () => (await priceAt(a)) === 70000)).toBe(true);
    expect(await seen(b)).toBe(newsB); // B cannot see the line, so its "news" number does not move
    expect(await seen(a)).toBeGreaterThan(newsA); // A can
    expect(await cursorOf(b)).toBe(cursorB);
    expect(await priceAt(b)).toBe(120000);
  });

  it('a sale at the branch is made at its own price', async () => {
    const open = await a.http
      .post(`${api}/registers/open`)
      .set(auth(a.cashier))
      .send({
        terminalId: 'T1',
        openingBalances: [
          { method: 'cash', currency: 'USD', amount: 0 },
          { method: 'cash', currency: 'LBP', amount: 0 },
        ],
      });
    expect(open.status, JSON.stringify(open.body)).toBeLessThan(300);
    const sale = await a.http
      .post(`${api}/sales`)
      .set(auth(a.cashier))
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        clientSaleId: crypto.randomUUID(),
        customerId: 1,
        items: [{ productId: product, qty: '1', unitPriceLbp: 70000 }],
        payments: [{ method: 'cash', currency: 'LBP', amount: 100000 }],
      });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    const line = await a.app.database.one<{ unit_price_lbp: number }>('SELECT unit_price_lbp FROM sale_items WHERE sale_id = ?', [
      sale.body.id,
    ]);
    expect(line?.unit_price_lbp).toBe(70000);
  });

  it('removing the override brings the base price back for that branch', async () => {
    expect((await hq.http.delete(`${api}/branches/${idA}/prices/${product}`).set(adminAuth)).status).toBe(204);
    expect(await until(async () => (await priceAt(a)) === 120000)).toBe(true);
    expect((await hq.http.get(`${api}/branches/${idA}/prices`).set(adminAuth)).body.data).toEqual([]);
    expect((await hq.http.delete(`${api}/branches/${idA}/prices/${product}`).set(adminAuth)).status).toBe(204); // nothing to remove: fine
  });

  it('a branch that connects later gets its override from the start', async () => {
    await setOverride(idB, 90000);
    const c = await startFreshBranch();
    try {
      expect((await c.connect(hq, 'PC')).status).toBe(200);
      const idC = await branchIdOf('PC');
      await setOverride(idC, 65000);
      expect(await until(async () => (await priceAt(c)) === 65000)).toBe(true);
      expect(await until(async () => (await priceAt(b)) === 90000)).toBe(true);
    } finally {
      await c.close();
    }
  });
});

describe('currency', () => {
  it('a product’s currency cannot change while a branch has its own price in it', async () => {
    const r = await hq.http.patch(`${api}/products/${product}`).set(adminAuth).send({ currency: 'USD' });
    expect([r.status, r.body.code]).toEqual([409, 'PRICE_OVERRIDES_EXIST']);
    await hq.http.delete(`${api}/branches/${idB}/prices/${product}`).set(adminAuth);
    for (const code of ['PC']) {
      const id = await branchIdOf(code);
      await hq.http.delete(`${api}/branches/${id}/prices/${product}`).set(adminAuth);
    }
    expect((await hq.http.patch(`${api}/products/${product}`).set(adminAuth).send({ currency: 'USD' })).status).toBe(200);
  });
});
