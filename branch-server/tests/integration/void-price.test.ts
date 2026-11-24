import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCtx, type TestCtx } from '../helpers/app';

// US-14b / US-09: cancelling a sale while its register is open, and selling at another price. A cashier needs a manager's
// approval for each (their own name and password, for that one sale or that one product and price, once, for ten minutes).
let c: TestCtx;
let cashier: string;
let cashier2: string;
let manager: string;
let admin: string;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const cash = (amount: number) => ({ method: 'cash', currency: 'LBP', amount });

const sell = (over: Record<string, unknown> = {}, token = cashier) =>
  c.http.post(`${api}/sales`).set(auth(token)).set('Idempotency-Key', randomUUID()).send(c.newSaleBody(over));
const voidIt = (saleId: number, over: Record<string, unknown> = {}, token = cashier, key = randomUUID()) =>
  c.http
    .post(`${api}/sales/${saleId}/void`)
    .set(auth(token))
    .set('Idempotency-Key', key)
    .send({ reason: 'rang up twice', ...over });
const approve = (body: Record<string, unknown>, token = cashier) =>
  c.http
    .post(`${api}/auth/approve`)
    .set(auth(token))
    .send({ username: c.seed.users.manager.username, password: c.seed.users.manager.password, ...body });
const qtyOf = async (productId: number) =>
  Number((await c.http.get(`${api}/stock?productId=${productId}`).set(auth(manager))).body.data[0].qty);
const bucket = async (method: string, currency: string) =>
  (await c.http.get(`${api}/registers/current`).set(auth(cashier))).body.balances.find(
    (b: { method: string; currency: string }) => b.method === method && b.currency === currency,
  ).expected as number;
const owed = async (id: number) => (await c.http.get(`${api}/customers/${id}`).set(auth(manager))).body.balanceLbp as number;
const towel = () => c.seed.products.towel.id;

beforeAll(async () => {
  c = await startCtx();
  cashier = await c.login('cashier');
  manager = await c.login('manager');
  admin = await c.login('admin');
  await c.openRegister(cashier);
  const made = await c.http
    .post(`${api}/users`)
    .set(auth(admin))
    .send({ username: 'cashier-two', name: 'Cashier Two', role: 'cashier', password: 'a-long-enough-password' });
  expect(made.status).toBe(201);
  cashier2 = (await c.http.post(`${api}/auth/login`).send({ username: 'cashier-two', password: 'a-long-enough-password' })).body
    .accessToken;
});
afterAll(() => c.close());

describe('US-14b: cancelling a sale', () => {
  it('a manager cancels: stock back, money out of the drawer, the sale marked void and no longer counted', async () => {
    const stock0 = await qtyOf(towel());
    const cash0 = await bucket('cash', 'LBP');
    const sale = await sell({ payments: [cash(100000)] }); // 75,000 due, 25,000 change
    expect(sale.status).toBe(201);
    expect(await qtyOf(towel())).toBe(stock0 - 1);
    expect(await bucket('cash', 'LBP')).toBe(cash0 + 75000);

    const res = await voidIt(sale.body.id, { reason: 'customer left' }, manager);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ref: sale.body.ref, status: 'void', totalLbp: 75000, reason: 'customer left' });
    expect(await qtyOf(towel())).toBe(stock0);
    expect(await bucket('cash', 'LBP')).toBe(cash0); // paid 100,000 in, 25,000 change out: all of it reversed

    const after = await c.http.get(`${api}/sales/${sale.body.id}`).set(auth(manager));
    expect(after.body.status).toBe('void');
    expect(after.body.items).toHaveLength(1); // the record is kept whole
    expect(after.body.payments).toHaveLength(1);

    const log = await c.http.get(`${api}/audit?action=sale.void&entityId=${sale.body.id}`).set(auth(admin));
    expect(log.body.data[0]).toMatchObject({ userId: c.seed.users.manager.id, after: { status: 'void', reason: 'customer left' } });
  });

  it('a voided sale cannot be voided again, returned, or reprinted as if valid', async () => {
    const sale = await sell();
    await voidIt(sale.body.id, {}, manager);
    const again = await voidIt(sale.body.id, {}, manager);
    expect(again.status).toBe(422);
    expect(again.body.code).toBe('SALE_ALREADY_VOID');
    const ret = await c.http
      .post(`${api}/returns`)
      .set(auth(manager))
      .set('Idempotency-Key', randomUUID())
      .send({ saleId: sale.body.id, items: [{ saleItemId: sale.body.items[0].id, qty: '1' }], refund: cash(75000) });
    expect(ret.body.code).toBe('SALE_VOID');
    const text = await c.http.get(`${api}/sales/${sale.body.id}/receipt?format=text`).set(auth(manager));
    expect(text.text).toContain('*** VOIDED SALE ***');
  });

  it('the day figures come back to what they were, as if the sale never happened', async () => {
    const d0 = (await c.http.get(`${api}/reports/dashboard`).set(auth(manager))).body;
    const sale = await sell();
    await voidIt(sale.body.id, {}, manager);
    const d1 = (await c.http.get(`${api}/reports/dashboard`).set(auth(manager))).body;
    expect(d1).toEqual({ ...d0, hours: d1.hours, generatedAt: d1.generatedAt });
  });

  it('reason is required', async () => {
    const sale = await sell();
    expect((await voidIt(sale.body.id, { reason: '   ' }, manager)).status).toBe(400);
    expect(
      (await c.http.post(`${api}/sales/${sale.body.id}/void`).set(auth(manager)).set('Idempotency-Key', randomUUID()).send({})).status,
    ).toBe(400);
    expect((await c.http.post(`${api}/sales/${sale.body.id}/void`).set(auth(manager)).send({ reason: 'x' })).status).toBe(400); // key required
  });

  it('a credit sale: the amount the customer owed is taken off their balance', async () => {
    const before = await owed(2);
    const sale = await sell({ customerId: 2, payments: [cash(25000)] }); // 50,000 on account
    expect(await owed(2)).toBe(before + 50000);
    expect((await voidIt(sale.body.id, {}, manager)).status).toBe(200);
    expect(await owed(2)).toBe(before);
    const open = (await c.http.get(`${api}/customers/2/open-sales`).set(auth(manager))).body.data as { id: number }[];
    expect(open.map((o) => o.id)).not.toContain(sale.body.id); // nothing is owed on a cancelled sale, so a payment can never land on it
  });

  it('is refused once the customer has paid part of it from their account, or part of it was taken back', async () => {
    const credit = await sell({ customerId: 2, payments: [cash(25000)] });
    expect(credit.body, JSON.stringify(credit.body)).toHaveProperty('id');
    const paid = await c.http
      .post(`${api}/customers/2/payments`)
      .set(auth(cashier))
      .set('Idempotency-Key', randomUUID())
      .send({ method: 'cash', currency: 'LBP', amount: 5000 });
    expect(paid.status).toBe(201);
    const refused = await voidIt(credit.body.id, {}, manager);
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.code).toBe('SALE_HAS_ACCOUNT_PAYMENTS');

    const two = await sell({ items: [{ productId: towel(), qty: '2', unitPriceLbp: 75000 }], payments: [cash(150000)] });
    await c.http
      .post(`${api}/returns`)
      .set(auth(manager))
      .set('Idempotency-Key', randomUUID())
      .send({ saleId: two.body.id, items: [{ saleItemId: two.body.items[0].id, qty: '1' }], refund: cash(75000) });
    const afterReturn = await voidIt(two.body.id, {}, manager);
    expect(afterReturn.status).toBe(422);
    expect(afterReturn.body.code).toBe('SALE_HAS_RETURNS');
  });

  it('a replay of the same void answers with the first result and does nothing more', async () => {
    const stock0 = await qtyOf(towel());
    const sale = await sell();
    const key = randomUUID();
    const first = await voidIt(sale.body.id, {}, manager, key);
    const replay = await voidIt(sale.body.id, {}, manager, key);
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.header['idempotent-replay']).toBe('true');
    expect(await qtyOf(towel())).toBe(stock0);
  });

  it('an unknown sale is 404', async () => {
    expect((await voidIt(999999, {}, manager)).status).toBe(404);
  });
});

describe('US-14b: a cashier cancels only with a manager', () => {
  it('without an approval the server refuses and says which sale and how much; nothing changes', async () => {
    const sale = await sell();
    const cash0 = await bucket('cash', 'LBP');
    const res = await voidIt(sale.body.id);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'VOID_NEEDS_APPROVAL', saleId: sale.body.id, saleRef: sale.body.ref, totalLbp: 75000 });
    expect(await bucket('cash', 'LBP')).toBe(cash0);
    expect((await c.http.get(`${api}/sales/${sale.body.id}`).set(auth(cashier))).body.status).toBe('paid');
  });

  it('with the approval it is cancelled, audited with who approved; the approval is single-use, for that sale and that cashier only', async () => {
    const sale = await sell();
    const other = await sell();
    const token = (await approve({ scope: 'void', saleId: sale.body.id })).body.approvalToken as string;

    expect((await voidIt(other.body.id, { approvalToken: token })).status).toBe(403); // another sale
    expect((await voidIt(sale.body.id, { approvalToken: token }, cashier2)).status).toBe(403); // another cashier
    const done = await voidIt(sale.body.id, { approvalToken: token });
    expect(done.status).toBe(200);
    const log = await c.http.get(`${api}/audit?action=sale.void&entityId=${sale.body.id}`).set(auth(admin));
    expect(log.body.data[0]).toMatchObject({ userId: c.seed.users.cashier.id, after: { approvedBy: c.seed.users.manager.id } });

    const again = await voidIt(other.body.id, { approvalToken: token }); // used up
    expect(again.status).toBe(403);
  });

  it('a discount or return approval is not a void approval', async () => {
    const sale = await sell();
    const discount = (await approve({ scope: 'discount', pct: 50 })).body.approvalToken as string;
    const ret = (await approve({ scope: 'return', saleId: sale.body.id, maxLbp: 75000 })).body.approvalToken as string;
    expect((await voidIt(sale.body.id, { approvalToken: discount })).status).toBe(403);
    expect((await voidIt(sale.body.id, { approvalToken: ret })).status).toBe(403);
  });

  it('runs out after ten minutes', async () => {
    const sale = await sell();
    const token = (await approve({ scope: 'void', saleId: sale.body.id })).body.approvalToken as string;
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(c.databasePath);
    db.prepare('UPDATE approvals SET expires_at = ? WHERE used_at IS NULL').run(new Date(Date.now() - 1000).toISOString());
    db.close();
    expect((await voidIt(sale.body.id, { approvalToken: token })).status).toBe(403);
  });

  it('asking for a void approval for an unknown sale is 404, and needs a manager password', async () => {
    expect((await approve({ scope: 'void', saleId: 999999 })).status).toBe(404);
    expect((await approve({ scope: 'void', saleId: 1, password: 'wrong-password-here' })).status).toBe(401);
  });
});

describe('US-09: selling at another price', () => {
  const at = (price: number, over: Record<string, unknown> = {}, token = cashier) =>
    sell({ items: [{ productId: towel(), qty: '1', unitPriceLbp: price, ...over }], payments: [cash(price)] }, token);

  it('a cashier without an approval is refused (the price on screen did not match the catalogue)', async () => {
    const res = await at(60000);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PRICE_MISMATCH');
  });

  it('with a price approval for that product at that price the sale goes through at that price, and the audit says who approved', async () => {
    const token = (await approve({ scope: 'price', productId: towel(), priceLbp: 60000 })).body.approvalToken as string;
    const res = await at(60000, { approvalToken: token });
    expect(res.status).toBe(201);
    expect(res.body.totalLbp).toBe(60000);
    expect(res.body.items[0].unitPriceLbp).toBe(60000);
    const log = await c.http.get(`${api}/audit?action=sale.price.override&entityId=${res.body.id}`).set(auth(admin));
    expect(log.body.data[0]).toMatchObject({
      before: { productId: towel(), unitPriceLbp: 75000 },
      after: { unitPriceLbp: 60000, approvedBy: c.seed.users.manager.id },
    });
    expect((await at(60000, { approvalToken: token })).status).toBe(422); // single use
  });

  it('is for that price only, that product only, and that cashier only; a failed sale does not use it up', async () => {
    const token = (await approve({ scope: 'price', productId: towel(), priceLbp: 60000 })).body.approvalToken as string;
    expect((await at(55000, { approvalToken: token })).status).toBe(422); // a different price
    expect((await at(60000, { approvalToken: token }, cashier2)).status).toBe(422); // another cashier
    const choc = await sell({
      items: [{ productId: c.seed.products.choc.id, qty: '1', unitPriceLbp: 60000, approvalToken: token }],
      payments: [cash(60000)],
    });
    expect(choc.status).toBe(422); // another product
    // part-paid for Walk-In fails the whole sale, so the approval must survive it
    const failed = await sell({
      items: [{ productId: towel(), qty: '1', unitPriceLbp: 60000, approvalToken: token }],
      payments: [cash(5000)],
    });
    expect(failed.status).toBe(422);
    expect(failed.body.code).toBe('CREDIT_REQUIRES_CUSTOMER');
    expect((await at(60000, { approvalToken: token })).status).toBe(201);
  });

  it('a discount or return approval is not a price approval', async () => {
    const discount = (await approve({ scope: 'discount', pct: 50 })).body.approvalToken as string;
    expect((await at(60000, { approvalToken: discount })).status).toBe(422);
  });

  it('a manager still sells at any price without one, and the catalogue price needs none', async () => {
    expect((await at(60000, {}, manager)).status).toBe(201);
    expect((await at(75000)).status).toBe(201);
  });

  it('the grant is audited without the password or the token; an unknown product is 404; a negative price is invalid', async () => {
    const token = (await approve({ scope: 'price', productId: towel(), priceLbp: 61000 })).body.approvalToken as string;
    const log = JSON.stringify((await c.http.get(`${api}/audit?action=approval.grant&limit=3`).set(auth(admin))).body);
    expect(log).toContain('"scope":"price"');
    expect(log).not.toContain(token);
    expect(log).not.toContain(c.seed.users.manager.password);
    expect((await approve({ scope: 'price', productId: 999999, priceLbp: 1000 })).status).toBe(404);
    expect((await approve({ scope: 'price', productId: towel(), priceLbp: -1 })).status).toBe(400);
  });
});

describe('a void in a closed register', () => {
  it('is refused: after the drawer is counted, a return is the way back', async () => {
    const sale = await sell();
    const cur = (await c.http.get(`${api}/registers/current`).set(auth(cashier))).body;
    const counted = (cur.balances as { method: string; currency: string; expected: number }[]).map((b) => ({
      method: b.method,
      currency: b.currency,
      amount: b.expected,
    }));
    const closed = await c.http.post(`${api}/registers/${cur.id}/close`).set(auth(cashier)).send({ countedBalances: counted });
    expect(closed.status).toBe(200);
    // counted what the running figures said; the close rebuilds every figure from the rows (void sales excluded): no difference
    for (const b of closed.body.balances as { variance: number }[]) expect(b.variance).toBe(0);
    const res = await voidIt(sale.body.id, {}, manager);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SALE_NOT_VOIDABLE');
  });
});
