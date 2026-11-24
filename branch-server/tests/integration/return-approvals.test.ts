import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCtx, type TestCtx } from '../helpers/app';

// US-14 / US-09: a cashier cannot take goods back alone. A manager types their name and password at the till and sees the
// sale and the value; the approval is for that sale and up to that value, works once, for that cashier, for ten minutes.
let c: TestCtx;
let cashier: string;
let cashier2: string;
let manager: string;
let admin: string;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const cash = (amount: number) => ({ method: 'cash', currency: 'LBP', amount });

const sell = (qty = '1', total = 75000) =>
  c.http
    .post(`${api}/sales`)
    .set(auth(cashier))
    .set('Idempotency-Key', randomUUID())
    .send(
      c.newSaleBody({
        items: [{ productId: c.seed.products.towel.id, qty, unitPriceLbp: 75000 }],
        payments: [cash(total)],
      }),
    );
const giveBack = (saleId: number, itemId: number, qty: string, over: Record<string, unknown> = {}, token = cashier, key = randomUUID()) =>
  c.http
    .post(`${api}/returns`)
    .set(auth(token))
    .set('Idempotency-Key', key)
    .send({ saleId, items: [{ saleItemId: itemId, qty }], reason: 'changed mind', refund: cash(75000 * Number(qty)), ...over });
const approve = (body: Record<string, unknown>, token = cashier) =>
  c.http
    .post(`${api}/auth/approve`)
    .set(auth(token))
    .send({ username: c.seed.users.manager.username, password: c.seed.users.manager.password, scope: 'return', ...body });
const withDb = <T>(fn: (db: Database.Database) => T) => {
  const db = new Database(c.databasePath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
};
const expected = async () =>
  (await c.http.get(`${api}/registers/current`).set(auth(cashier))).body.balances.find(
    (b: { method: string; currency: string }) => b.method === 'cash' && b.currency === 'LBP',
  ).expected as number;

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

describe('US-14: a cashier takes goods back only with a manager', () => {
  it('without an approval the server refuses, says which sale and how much, and writes nothing', async () => {
    const sale = await sell();
    const cash0 = await expected();
    const res = await giveBack(sale.body.id, sale.body.items[0].id, '1');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RETURN_NEEDS_APPROVAL', saleId: sale.body.id, saleRef: sale.body.ref, valueLbp: 75000 });
    expect(await expected()).toBe(cash0);
    expect((await c.http.get(`${api}/sales/${sale.body.id}`).set(auth(cashier))).body.items[0].returnedQty).toBe('0');
  });

  it('with the manager approval the return is recorded, audited with who approved, and the approval is single-use', async () => {
    const sale = await sell('2', 150000);
    const item = sale.body.items[0].id;
    const given = await approve({ saleId: sale.body.id, maxLbp: 150000 });
    expect(given.status).toBe(200);
    expect(given.body).toMatchObject({ scope: 'return', saleId: sale.body.id, maxLbp: 150000, approvedBy: { name: expect.any(String) } });
    const token = given.body.approvalToken as string;

    const cash0 = await expected();
    const done = await giveBack(sale.body.id, item, '1', { approvalToken: token });
    expect(done.status).toBe(201);
    expect(await expected()).toBe(cash0 - 75000);

    const log = await c.http.get(`${api}/audit?action=sale.return&entityId=${sale.body.id}`).set(auth(admin));
    expect(log.body.data[0]).toMatchObject({
      userId: c.seed.users.cashier.id,
      after: { approvedBy: c.seed.users.manager.id, refundLbp: 75000 },
    });

    const again = await giveBack(sale.body.id, item, '1', { approvalToken: token });
    expect(again.status).toBe(403);
    expect(again.body.code).toBe('RETURN_NEEDS_APPROVAL');
    expect((await c.http.get(`${api}/sales/${sale.body.id}`).set(auth(cashier))).body.items[0].returnedQty).toBe('1');
  });

  it('the grant is audited without the password or the token', async () => {
    const sale = await sell();
    const token = (await approve({ saleId: sale.body.id, maxLbp: 75000 })).body.approvalToken as string;
    const log = JSON.stringify((await c.http.get(`${api}/audit?action=approval.grant&limit=5`).set(auth(admin))).body);
    expect(log).toContain('"scope":"return"');
    expect(log).not.toContain(token);
    expect(log).not.toContain(c.seed.users.manager.password);
  });

  it('is for that sale only', async () => {
    const a = await sell();
    const b = await sell();
    const token = (await approve({ saleId: a.body.id, maxLbp: 75000 })).body.approvalToken as string;
    expect((await giveBack(b.body.id, b.body.items[0].id, '1', { approvalToken: token })).status).toBe(403);
    expect((await giveBack(a.body.id, a.body.items[0].id, '1', { approvalToken: token })).status).toBe(201); // not used up by the wrong try
  });

  it('is for the cashier it was given to, and no one else', async () => {
    const sale = await sell();
    const token = (await approve({ saleId: sale.body.id, maxLbp: 75000 })).body.approvalToken as string;
    expect((await giveBack(sale.body.id, sale.body.items[0].id, '1', { approvalToken: token }, cashier2)).status).toBe(403);
    expect((await giveBack(sale.body.id, sale.body.items[0].id, '1', { approvalToken: token })).status).toBe(201);
  });

  it('covers no more than the value the manager was shown', async () => {
    const sale = await sell('2', 150000);
    const item = sale.body.items[0].id;
    const token = (await approve({ saleId: sale.body.id, maxLbp: 75000 })).body.approvalToken as string;
    const both = await giveBack(sale.body.id, item, '2', { approvalToken: token });
    expect(both.status).toBe(403);
    expect(both.body.valueLbp).toBe(150000); // the screen can ask again for the real value
    expect((await giveBack(sale.body.id, item, '1', { approvalToken: token })).status).toBe(201);
  });

  it('runs out after ten minutes', async () => {
    const sale = await sell();
    const token = (await approve({ saleId: sale.body.id, maxLbp: 75000 })).body.approvalToken as string;
    withDb((db) => db.prepare(`UPDATE approvals SET expires_at = ? WHERE used_at IS NULL`).run(new Date(Date.now() - 1000).toISOString()));
    expect((await giveBack(sale.body.id, sale.body.items[0].id, '1', { approvalToken: token })).status).toBe(403);
  });

  it('a return that fails for another reason does not use the approval up', async () => {
    const sale = await sell();
    const item = sale.body.items[0].id;
    const token = (await approve({ saleId: sale.body.id, maxLbp: 75000 })).body.approvalToken as string;
    const noRefund = await giveBack(sale.body.id, item, '1', { approvalToken: token, refund: undefined });
    expect(noRefund.status).toBe(422);
    expect(noRefund.body.code).toBe('REFUND_REQUIRED');
    expect((await giveBack(sale.body.id, item, '1', { approvalToken: token })).status).toBe(201);
  });

  it('a discount approval is not a return approval, and the other way round', async () => {
    const sale = await sell();
    const discount = (await approve({ scope: 'discount', pct: 50 })).body.approvalToken as string;
    expect((await giveBack(sale.body.id, sale.body.items[0].id, '1', { approvalToken: discount })).status).toBe(403);

    const forReturn = (await approve({ saleId: sale.body.id, maxLbp: 75000 })).body.approvalToken as string;
    const res = await c.http
      .post(`${api}/sales`)
      .set(auth(cashier))
      .set('Idempotency-Key', randomUUID())
      .send(
        c.newSaleBody({
          items: [{ productId: c.seed.products.towel.id, qty: '1', unitPriceLbp: 75000 }],
          discount: { type: 'percent', value: 40 },
          payments: [cash(45000)],
          approvalToken: forReturn,
        }),
      );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DISCOUNT_OVER_LIMIT');
  });

  it('a replay of the same return answers with the first result and uses nothing more', async () => {
    const sale = await sell();
    const token = (await approve({ saleId: sale.body.id, maxLbp: 75000 })).body.approvalToken as string;
    const key = randomUUID();
    const first = await giveBack(sale.body.id, sale.body.items[0].id, '1', { approvalToken: token }, cashier, key);
    const replay = await giveBack(sale.body.id, sale.body.items[0].id, '1', { approvalToken: token }, cashier, key);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(replay.body.ref).toBe(first.body.ref);
  });

  it('a manager still returns without any approval', async () => {
    const sale = await sell();
    expect((await giveBack(sale.body.id, sale.body.items[0].id, '1', {}, manager)).status).toBe(201);
  });
});

describe('asking for a return approval', () => {
  it('needs the manager name and password; a cashier, a wrong password or an unknown sale is refused', async () => {
    const sale = await sell();
    const body = { saleId: sale.body.id, maxLbp: 75000 };
    const bad = await approve({ ...body, password: 'wrong-password-here' });
    expect(bad.status).toBe(401);
    const cashierAsApprover = await approve({ ...body, username: c.seed.users.cashier.username, password: c.seed.users.cashier.password });
    expect(cashierAsApprover.status).toBe(401);
    expect(cashierAsApprover.body.detail).toBe(bad.body.detail); // does not reveal which part was wrong
    expect((await approve({ saleId: 999999, maxLbp: 75000 })).status).toBe(404);
  });

  it('refuses a missing sale, a zero or fractional value, and anonymous callers', async () => {
    expect((await approve({ maxLbp: 75000 })).status).toBe(400);
    expect((await approve({ saleId: 1, maxLbp: 0 })).status).toBe(400);
    expect((await approve({ saleId: 1, maxLbp: 10.5 })).status).toBe(400);
    expect(
      (await c.http.post(`${api}/auth/approve`).send({ scope: 'return', saleId: 1, maxLbp: 5, username: 'x', password: 'y' })).status,
    ).toBe(401);
  });

  it('wrong manager passwords lock approvals (shared with discounts) but not the manager signing in', async () => {
    const sale = await sell();
    const attempt = () => approve({ saleId: sale.body.id, maxLbp: 75000, password: 'nope-nope-nope' }, cashier2);
    for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(423);
    expect(
      (await c.http.post(`${api}/auth/login`).send({ username: c.seed.users.manager.username, password: c.seed.users.manager.password }))
        .status,
    ).toBe(200);
  });
});
