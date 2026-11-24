import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCtx, type TestCtx } from '../helpers/app';

// US-14c (QUESTIONS.md #8, option C): a cancelled sale, or a sale that has had items taken back, can be deleted for good.
// Everything it did is taken back out in one transaction; a cashier needs a manager's approval; the audit log keeps the trace.
let c: TestCtx;
let cashier: string;
let manager: string;
let admin: string;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const towel = () => c.seed.products.towel.id;
const choc = () => c.seed.products.choc.id;

const read = <T>(sql: string, ...params: unknown[]): T => {
  const db = new Database(c.databasePath, { readonly: true });
  try {
    return db.prepare(sql).get(...params) as T;
  } finally {
    db.close();
  }
};
const level = (productId: number) =>
  read<{ n: number }>('SELECT COALESCE(SUM(qty_milli), 0) AS n FROM stock_levels WHERE product_id = ?', productId).n;
const ledger = (productId: number) =>
  read<{ n: number }>('SELECT COALESCE(SUM(qty_milli_delta), 0) AS n FROM stock_movements WHERE product_id = ?', productId).n;
const expected = (sessionId: number, method = 'cash', currency = 'LBP') =>
  read<{ expected: number; variance: number | null }>(
    'SELECT expected, variance FROM register_balances WHERE session_id = ? AND method = ? AND currency = ?',
    sessionId,
    method,
    currency,
  );
const owed = (customerId: number) => read<{ n: number }>('SELECT balance_lbp AS n FROM customers WHERE id = ?', customerId).n;
const openRest = (customerId: number) =>
  read<{ n: number }>(`SELECT COALESCE(SUM(rest_lbp), 0) AS n FROM sales WHERE customer_id = ? AND status <> 'void'`, customerId).n;
const rowsOfSale = (saleId: number) =>
  read<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM sales WHERE id = @s) + (SELECT COUNT(*) FROM sale_items WHERE sale_id = @s)
          + (SELECT COUNT(*) FROM payments WHERE sale_id = @s) + (SELECT COUNT(*) FROM returns WHERE sale_id = @s)
          + (SELECT COUNT(*) FROM stock_movements WHERE (ref_type IN ('sale','void') AND ref_id = @s)
               OR (ref_type = 'return' AND ref_id IN (SELECT id FROM returns WHERE sale_id = @s))) AS n`,
    { s: saleId },
  ).n;
const unlockRows = () => read<{ n: number }>('SELECT COUNT(*) AS n FROM sale_delete_unlock').n;

const sell = async (token: string, items: { productId: number; qty: string; unitPriceLbp: number }[], paid: number, customerId = 1) => {
  const res = await c.http
    .post(`${api}/sales`)
    .set(auth(token))
    .set('Idempotency-Key', randomUUID())
    .send(c.newSaleBody({ items, customerId, payments: paid > 0 ? [{ method: 'cash', currency: 'LBP', amount: paid }] : [] }));
  expect(res.status).toBe(201);
  return res.body as { id: number; ref: number };
};
const itemId = async (saleId: number) => (await c.http.get(`${api}/sales/${saleId}`).set(auth(manager))).body.items[0].id as number;
const giveBack = async (saleId: number, qty: string, refund: number) => {
  const res = await c.http
    .post(`${api}/returns`)
    .set(auth(manager))
    .set('Idempotency-Key', randomUUID())
    .send({
      saleId,
      items: [{ saleItemId: await itemId(saleId), qty }],
      reason: 'test',
      ...(refund > 0 ? { refund: { method: 'cash', currency: 'LBP', amount: refund } } : {}),
    });
  expect(res.status).toBe(201);
};
const voidIt = (saleId: number) =>
  c.http.post(`${api}/sales/${saleId}/void`).set(auth(manager)).set('Idempotency-Key', randomUUID()).send({ reason: 'test' });
const del = (
  saleId: number,
  token = manager,
  body: Record<string, unknown> = { reason: 'entered by mistake' },
  key: string = randomUUID(),
) => c.http.post(`${api}/sales/${saleId}/delete`).set(auth(token)).set('Idempotency-Key', key).send(body);
const approveDelete = (saleId: number, token = cashier) =>
  c.http
    .post(`${api}/auth/approve`)
    .set(auth(token))
    .send({ username: 'manager', password: c.seed.users.manager.password, scope: 'delete', saleId });

let session: number;
beforeAll(async () => {
  c = await startCtx();
  cashier = await c.login('cashier');
  manager = await c.login('manager');
  admin = await c.login('admin');
  session = (await c.openRegister(cashier)).id;
});
afterAll(() => c.close());

describe('deleting a cancelled sale', () => {
  it('removes the sale and everything under it, changes no figure, and leaves a record in the audit log', async () => {
    const stockBefore = [level(towel()), ledger(towel())];
    const cashBefore = expected(session);
    const s = await sell(cashier, [{ productId: towel(), qty: '2', unitPriceLbp: 75000 }], 150000);
    expect((await voidIt(s.id)).status).toBe(200);
    expect(rowsOfSale(s.id)).toBeGreaterThan(0);

    const res = await del(s.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: s.id, ref: s.ref, deleted: true });
    expect(rowsOfSale(s.id)).toBe(0); // the sale, its lines, payments and stock movements are all gone
    expect((await c.http.get(`${api}/sales/${s.id}`).set(auth(manager))).status).toBe(404);
    expect((await c.http.get(`${api}/sales/by-ref/${s.ref}`).set(auth(manager))).status).toBe(404);
    expect([level(towel()), ledger(towel())]).toEqual(stockBefore); // the sale and its cancellation cancelled each other out
    expect(expected(session)).toEqual(cashBefore);
    expect(unlockRows()).toBe(0);

    const log = await c.http.get(`${api}/audit?entity=sale&entityId=${s.id}&action=sale.delete`).set(auth(admin));
    expect(log.body.data[0].before).toMatchObject({ ref: s.ref, status: 'void', totalLbp: 150000, itemCount: 1 });
    expect(log.body.data[0].after).toMatchObject({ deleted: true, reason: 'entered by mistake' });
  });

  it('asking again with the same key answers the same, and does not run twice', async () => {
    const s = await sell(cashier, [{ productId: choc(), qty: '1', unitPriceLbp: 50000 }], 50000);
    await voidIt(s.id);
    const key = randomUUID();
    const first = await del(s.id, manager, { reason: 'twice' }, key);
    const again = await del(s.id, manager, { reason: 'twice' }, key);
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect((await del(s.id)).status).toBe(404); // a new request: it is not there any more
  });
});

describe('deleting a sale that has had items taken back', () => {
  it('puts the stock, the register and the customer back as if neither the sale nor the return had happened', async () => {
    const stockBefore = [level(towel()), ledger(towel())];
    const cashBefore = expected(session);
    const s = await sell(cashier, [{ productId: towel(), qty: '3', unitPriceLbp: 75000 }], 225000);
    await giveBack(s.id, '1', 75000);
    expect(level(towel())).toBe(stockBefore[0]! - 2000); // sold 3, one came back
    expect(expected(session).expected).toBe(cashBefore.expected + 225000 - 75000);

    const res = await del(s.id);
    expect(res.status).toBe(200);
    expect(rowsOfSale(s.id)).toBe(0);
    expect([level(towel()), ledger(towel())]).toEqual(stockBefore);
    expect(expected(session)).toEqual(cashBefore); // the takings and the refund are both out of the drawer's figure
    expect(unlockRows()).toBe(0);
  });

  it('takes the customer’s debt off, and the balance still equals what the remaining sales leave owing', async () => {
    const ali = (await c.http.post(`${api}/customers`).set(auth(cashier)).send({ name: 'Debt to delete' })).body.id as number;
    const before = owed(ali);
    const s = await sell(cashier, [{ productId: choc(), qty: '2', unitPriceLbp: 50000 }], 0, ali); // all 100,000 on account
    await giveBack(s.id, '1', 0); // 50,000 comes off their balance, nothing is refunded
    expect(owed(ali)).toBe(before + 50000);
    expect(owed(ali)).toBe(openRest(ali));

    expect((await del(s.id)).status).toBe(200);
    expect(owed(ali)).toBe(before);
    expect(owed(ali)).toBe(openRest(ali)); // the invariant: balance = what the open sales still owe
  });

  it('changes a register that was already counted: its expected figure and its variance follow', async () => {
    // a register of its own: the earlier tests keep using the first one
    const s = await sell(cashier, [{ productId: towel(), qty: '2', unitPriceLbp: 75000 }], 150000);
    await giveBack(s.id, '1', 75000);
    const cur = await c.http.get(`${api}/registers/current`).set(auth(cashier));
    const counted = (cur.body.balances as { method: string; currency: string; expected: number }[]).map((b) => ({
      method: b.method,
      currency: b.currency,
      amount: b.expected + (b.method === 'cash' && b.currency === 'LBP' ? 1000 : 0), // the drawer was 1,000 over
    }));
    expect((await c.http.post(`${api}/registers/${cur.body.id}/close`).set(auth(cashier)).send({ countedBalances: counted })).status).toBe(
      200,
    );
    const closed = expected(cur.body.id);
    expect(closed.variance).toBe(1000);

    expect((await del(s.id)).status).toBe(200); // its register is closed: still allowed, by decision
    const after = expected(cur.body.id);
    expect(after.expected).toBe(closed.expected - (150000 - 75000)); // the sale's takings less its refund are gone
    expect(after.variance).toBe(1000 + (150000 - 75000)); // counted - expected: the counted cash did not change
    expect(unlockRows()).toBe(0);
    session = (await c.openRegister(cashier)).id; // later tests sell again
  });
});

describe('what cannot be deleted', () => {
  it('an ordinary sale with nothing taken back, and a sale someone has already paid off from their account', async () => {
    const plain = await sell(cashier, [{ productId: choc(), qty: '1', unitPriceLbp: 50000 }], 50000);
    const refused = await del(plain.id);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('SALE_NOT_DELETABLE');
    expect(rowsOfSale(plain.id)).toBeGreaterThan(0);

    const ali = (await c.http.post(`${api}/customers`).set(auth(cashier)).send({ name: 'Paid part later' })).body.id as number;
    const onAccount = await sell(cashier, [{ productId: choc(), qty: '2', unitPriceLbp: 50000 }], 0, ali);
    await c.http
      .post(`${api}/customers/${ali}/payments`)
      .set(auth(cashier))
      .set('Idempotency-Key', randomUUID())
      .send({ method: 'cash', currency: 'LBP', amount: 20000 });
    await giveBack(onAccount.id, '1', 0);
    const paid = await del(onAccount.id);
    expect(paid.status).toBe(422);
    expect(paid.body.code).toBe('SALE_HAS_ACCOUNT_PAYMENTS');
    expect(rowsOfSale(onAccount.id)).toBeGreaterThan(0);
  });

  it('an unknown sale', async () => {
    expect((await del(999999)).status).toBe(404);
    expect((await c.http.post(`${api}/sales/1/delete`).set('Idempotency-Key', randomUUID()).send({ reason: 'x' })).status).toBe(401);
  });

  it('a reason is required, and so is an idempotency key', async () => {
    const s = await sell(cashier, [{ productId: choc(), qty: '1', unitPriceLbp: 50000 }], 50000);
    await voidIt(s.id);
    expect((await del(s.id, manager, { reason: '  ' })).status).toBe(400);
    expect((await c.http.post(`${api}/sales/${s.id}/delete`).set(auth(manager)).send({ reason: 'x' })).status).toBe(400);
    expect(rowsOfSale(s.id)).toBeGreaterThan(0);
  });
});

describe('a cashier deleting a sale', () => {
  it('needs a manager’s approval for that one sale, which works once', async () => {
    const mine = await sell(cashier, [{ productId: choc(), qty: '1', unitPriceLbp: 50000 }], 50000);
    const other = await sell(cashier, [{ productId: choc(), qty: '1', unitPriceLbp: 50000 }], 50000);
    await voidIt(mine.id);
    await voidIt(other.id);

    const alone = await del(mine.id, cashier);
    expect(alone.status).toBe(403);
    expect(alone.body.code).toBe('DELETE_NEEDS_APPROVAL');
    expect(alone.body).toMatchObject({ saleId: mine.id, saleRef: mine.ref });
    expect(rowsOfSale(mine.id)).toBeGreaterThan(0); // nothing was deleted

    const token = (await approveDelete(mine.id)).body.approvalToken as string;
    expect(token).toBeTruthy();
    expect((await del(other.id, cashier, { reason: 'x', approvalToken: token })).status).toBe(403); // a token is for one sale
    expect((await del(mine.id, cashier, { reason: 'x', approvalToken: 'not-a-token' })).status).toBe(403);
    expect((await del(mine.id, cashier, { reason: 'wrong till', approvalToken: token })).status).toBe(200);
    expect(rowsOfSale(mine.id)).toBe(0);
    expect((await del(other.id, cashier, { reason: 'x', approvalToken: token })).status).toBe(403); // used up

    const log = await c.http.get(`${api}/audit?entity=sale&entityId=${mine.id}&action=sale.delete`).set(auth(admin));
    expect(log.body.data[0].after).toMatchObject({ deleted: true, approvedBy: c.seed.users.manager.id });
  });

  it('a withdrawn approval changes nothing, and the token still works afterwards', async () => {
    const s = await sell(cashier, [{ productId: choc(), qty: '1', unitPriceLbp: 50000 }], 50000);
    const token = (await approveDelete(s.id)).body.approvalToken as string;
    // not deletable yet (an ordinary sale): refused before the token is used up
    expect((await del(s.id, cashier, { reason: 'x', approvalToken: token })).status).toBe(422);
    await voidIt(s.id);
    expect((await del(s.id, cashier, { reason: 'now it is cancelled', approvalToken: token })).status).toBe(200);
  });

  it('cannot reach a sale made by someone else (it is not found), and cannot approve themselves', async () => {
    const theirs = await sell(manager, [{ productId: choc(), qty: '1', unitPriceLbp: 50000 }], 50000);
    await voidIt(theirs.id);
    expect((await del(theirs.id, cashier)).status).toBe(404);
    const self = await c.http
      .post(`${api}/auth/approve`)
      .set(auth(cashier))
      .send({ username: 'cashier', password: c.seed.users.cashier.password, scope: 'delete', saleId: theirs.id });
    expect(self.status).toBe(401); // a cashier's own password is not a manager's approval
    expect(rowsOfSale(theirs.id)).toBeGreaterThan(0);
  });
});

describe('the database stays append-only for everything else', () => {
  it('only the rows of the sale being deleted can go, and only while it is being deleted', () => {
    const db = new Database(c.databasePath);
    try {
      const anySale = (db.prepare('SELECT id FROM sales ORDER BY id LIMIT 1').get() as { id: number }).id;
      for (const sql of [
        'DELETE FROM sales',
        'DELETE FROM sale_items',
        'DELETE FROM payments',
        'DELETE FROM returns',
        'DELETE FROM return_items',
        'DELETE FROM stock_movements',
        'DELETE FROM audit_log',
      ])
        expect(() => db.prepare(sql).run(), sql).toThrow(/append-only/);
      // an unlock for one sale does not open another sale's rows
      db.prepare('INSERT INTO sale_delete_unlock (sale_id) VALUES (-1)').run();
      expect(() => db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(anySale)).toThrow(/append-only/);
      expect(() => db.prepare('DELETE FROM sales WHERE id = ?').run(anySale)).toThrow(/append-only/);
      expect(() => db.prepare('DELETE FROM audit_log').run()).toThrow(/append-only/); // never
      db.prepare('DELETE FROM sale_delete_unlock').run();
    } finally {
      db.close();
    }
    expect(unlockRows()).toBe(0);
  });
});
