import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startCtx, type TestCtx } from '../helpers/app';

// Returns (US-14): stock back on the shelf, the refund out of the right register balance, and for an unpaid sale the
// value first reduces what the customer owes. The sale itself is never edited except for how much of it is settled.
let c: TestCtx;
let cashier: string;
let manager: string;
let admin: string;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
type Pay = { method: string; currency: string; amount: number };
const cash = (amount: number): Pay => ({ method: 'cash', currency: 'LBP', amount });

const sell = (over: Record<string, unknown> = {}, token = cashier) =>
  c.http.post(`${api}/sales`).set(auth(token)).set('Idempotency-Key', randomUUID()).send(c.newSaleBody(over));
const chocLine = (qty: string) => ({ productId: c.seed.products.choc.id, qty, unitPriceLbp: 50000 });

const giveBack = (
  saleId: number,
  items: { saleItemId: number; qty: string }[],
  refund?: Pay,
  key: string = randomUUID(),
  reason = 'changed mind',
) => c.http.post(`${api}/returns`).set(auth(manager)).set('Idempotency-Key', key).send({ saleId, items, reason, refund });

const qtyOf = async (productId: number) =>
  Number((await c.http.get(`${api}/stock?productId=${productId}`).set(auth(manager))).body.data[0].qty);
const expected = async (method: string, currency: string) => {
  const cur = await c.http.get(`${api}/registers/current`).set(auth(cashier));
  return cur.body.balances.find((b: { method: string; currency: string }) => b.method === method && b.currency === currency)
    .expected as number;
};

beforeAll(async () => {
  c = await startCtx();
  cashier = await c.login('cashier');
  manager = await c.login('manager');
  admin = await c.login('admin');
  await c.openRegister(cashier);
});
afterAll(() => c.close());

describe('returning part of a line', () => {
  it('returns some, then the rest, and never more than was sold', async () => {
    const sale = await sell({ items: [chocLine('3')], payments: [cash(150000)] });
    const item = sale.body.items[0].id as number;

    const tooMany = await giveBack(sale.body.id, [{ saleItemId: item, qty: '4' }], cash(200000));
    expect(tooMany.status).toBe(422);
    expect(tooMany.body).toMatchObject({ code: 'RETURN_EXCEEDS_SOLD', returnable: '3' });

    const stock0 = await qtyOf(c.seed.products.choc.id);
    const cash0 = await expected('cash', 'LBP');
    const first = await giveBack(sale.body.id, [{ saleItemId: item, qty: '1' }], cash(50000));
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ valueLbp: 50000, refundLbp: 50000, balanceReducedLbp: 0, saleId: sale.body.id });
    expect(await qtyOf(c.seed.products.choc.id)).toBe(stock0 + 1);
    expect(await expected('cash', 'LBP')).toBe(cash0 - 50000);

    const rest = await giveBack(sale.body.id, [{ saleItemId: item, qty: '2' }], cash(100000));
    expect(rest.status).toBe(201);

    const none = await giveBack(sale.body.id, [{ saleItemId: item, qty: '1' }], cash(50000));
    expect(none.status).toBe(422);
    expect(none.body).toMatchObject({ code: 'RETURN_EXCEEDS_SOLD', returnable: '0' });
  });

  it('a weighed item can be returned by weight', async () => {
    const sale = await sell({ items: [{ productId: c.seed.products.kg.id, qty: '0.4', unitPriceLbp: 400000 }], payments: [cash(160000)] });
    const res = await giveBack(sale.body.id, [{ saleItemId: sale.body.items[0].id, qty: '0.1' }], cash(40000));
    expect(res.status).toBe(201);
    expect(res.body.valueLbp).toBe(40000);
    expect(res.body.items[0].qty).toBe('0.1');
  });

  it('a discounted sale refunds what was actually paid, in proportion', async () => {
    const sale = await sell({ items: [chocLine('2')], discount: { type: 'percent', value: 10 }, payments: [cash(90000)] }, manager);
    expect(sale.body.totalLbp).toBe(90000);
    const res = await giveBack(sale.body.id, [{ saleItemId: sale.body.items[0].id, qty: '1' }], cash(45000));
    expect(res.status).toBe(201);
    expect(res.body.valueLbp).toBe(45000); // half of 90,000, not 50,000
    const tooMuch = await giveBack(sale.body.id, [{ saleItemId: sale.body.items[0].id, qty: '1' }], cash(50000));
    expect(tooMuch.status).toBe(422);
  });

  it('several lines of one sale can be returned together', async () => {
    const sale = await sell({
      items: [{ productId: c.seed.products.towel.id, qty: '1', unitPriceLbp: 75000 }, chocLine('2')],
      payments: [cash(175000)],
    });
    const [a, b] = sale.body.items as { id: number }[];
    const res = await giveBack(
      sale.body.id,
      [
        { saleItemId: a!.id, qty: '1' },
        { saleItemId: b!.id, qty: '2' },
      ],
      cash(175000),
    );
    expect(res.status).toBe(201);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.valueLbp).toBe(175000);
  });
});

describe('the refund must be what is owed', () => {
  it('asks for a refund when money is due back', async () => {
    const sale = await sell();
    const res = await giveBack(sale.body.id, [{ saleItemId: sale.body.items[0].id, qty: '1' }], undefined);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('REFUND_REQUIRED');
    // The amount to hand back comes with the error, so a screen can offer it without redoing the maths.
    expect(res.body.refundLbp).toBeGreaterThan(0);
    expect(res.body.balanceReducedLbp).toBe(0);
    const again = await giveBack(sale.body.id, [{ saleItemId: sale.body.items[0].id, qty: '1' }], cash(res.body.refundLbp));
    expect(again.status).toBe(201);
  });

  it('refuses a refund that does not match, and changes nothing', async () => {
    const sale = await sell();
    const stock = await qtyOf(c.seed.products.towel.id);
    const till = await expected('cash', 'LBP');
    const res = await giveBack(sale.body.id, [{ saleItemId: sale.body.items[0].id, qty: '1' }], cash(1000));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('REFUND_MISMATCH');
    expect(await qtyOf(c.seed.products.towel.id)).toBe(stock);
    expect(await expected('cash', 'LBP')).toBe(till);
  });

  it('a dollar refund may differ by up to a cent, and leaves the dollar balance', async () => {
    const sale = await sell(); // 75,000 LBP is $0.8333
    const usd0 = await expected('cash', 'USD');
    const ok = await giveBack(sale.body.id, [{ saleItemId: sale.body.items[0].id, qty: '1' }], {
      method: 'cash',
      currency: 'USD',
      amount: 83,
    });
    expect(ok.status).toBe(201);
    expect(await expected('cash', 'USD')).toBe(usd0 - 83);

    const other = await sell();
    const wrong = await giveBack(other.body.id, [{ saleItemId: other.body.items[0].id, qty: '1' }], {
      method: 'cash',
      currency: 'USD',
      amount: 80,
    });
    expect(wrong.status).toBe(422);
  });

  it('can be refunded through a wallet, which comes out of that wallet balance', async () => {
    const sale = await sell({ payments: [{ method: 'whish', currency: 'LBP', amount: 75000 }] });
    const whish0 = await expected('whish', 'LBP');
    const res = await giveBack(sale.body.id, [{ saleItemId: sale.body.items[0].id, qty: '1' }], {
      method: 'whish',
      currency: 'LBP',
      amount: 75000,
    });
    expect(res.status).toBe(201);
    expect(await expected('whish', 'LBP')).toBe(whish0 - 75000);
  });

  it('rejects an unknown method or a non-positive amount', async () => {
    const sale = await sell();
    const item = sale.body.items[0].id;
    expect(
      (await giveBack(sale.body.id, [{ saleItemId: item, qty: '1' }], { method: 'bitcoin', currency: 'LBP', amount: 75000 })).status,
    ).toBe(400);
    expect((await giveBack(sale.body.id, [{ saleItemId: item, qty: '1' }], cash(0))).status).toBe(400);
  });
});

describe('what may be returned', () => {
  it('only items of that sale', async () => {
    const a = await sell();
    const b = await sell();
    const res = await giveBack(a.body.id, [{ saleItemId: b.body.items[0].id, qty: '1' }], cash(75000));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_REFERENCE');
  });

  it('not the same line twice in one request', async () => {
    const sale = await sell({ items: [chocLine('2')], payments: [cash(100000)] });
    const item = sale.body.items[0].id;
    const res = await giveBack(
      sale.body.id,
      [
        { saleItemId: item, qty: '1' },
        { saleItemId: item, qty: '1' },
      ],
      cash(100000),
    );
    expect(res.status).toBe(400);
  });

  it.each([
    ['a zero quantity', '0'],
    ['a negative quantity', '-1'],
    ['too many decimals', '0.0001'],
    ['text', 'one'],
  ])('rejects %s', async (_n, qty) => {
    const sale = await sell();
    expect((await giveBack(sale.body.id, [{ saleItemId: sale.body.items[0].id, qty }], cash(75000))).status).toBe(400);
  });

  it('404 for a sale that does not exist; an empty list is a validation error', async () => {
    expect((await giveBack(99999999, [{ saleItemId: 1, qty: '1' }], cash(1))).status).toBe(404);
    const sale = await sell();
    expect((await giveBack(sale.body.id, [], cash(1))).status).toBe(400);
  });
});

describe('safety', () => {
  it('is idempotent: a repeated request restores stock and pays out once', async () => {
    const sale = await sell();
    const key = randomUUID();
    const stock = await qtyOf(c.seed.products.towel.id);
    const till = await expected('cash', 'LBP');
    const body = [{ saleItemId: sale.body.items[0].id, qty: '1' }];
    const first = await giveBack(sale.body.id, body, cash(75000), key);
    const again = await giveBack(sale.body.id, body, cash(75000), key);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.body.id).toBe(first.body.id);
    expect(await qtyOf(c.seed.products.towel.id)).toBe(stock + 1);
    expect(await expected('cash', 'LBP')).toBe(till - 75000);
  });

  it('the same key with a different request is refused', async () => {
    const sale = await sell({ items: [chocLine('2')], payments: [cash(100000)] });
    const item = sale.body.items[0].id;
    const key = randomUUID();
    await giveBack(sale.body.id, [{ saleItemId: item, qty: '1' }], cash(50000), key);
    const other = await giveBack(sale.body.id, [{ saleItemId: item, qty: '2' }], cash(100000), key);
    expect(other.status).toBe(422);
    expect(other.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('two parallel returns of the last unit: exactly one succeeds', async () => {
    const sale = await sell();
    const body = [{ saleItemId: sale.body.items[0].id, qty: '1' }];
    const [a, b] = await Promise.all([giveBack(sale.body.id, body, cash(75000)), giveBack(sale.body.id, body, cash(75000))]);
    expect([a.status, b.status].sort()).toEqual([201, 422]);
  });

  it('a cashier cannot return alone (see return-approvals); the key is required; a token is required', async () => {
    const sale = await sell();
    const body = { saleId: sale.body.id, items: [{ saleItemId: sale.body.items[0].id, qty: '1' }], refund: cash(75000) };
    const alone = await c.http.post(`${api}/returns`).set(auth(cashier)).set('Idempotency-Key', randomUUID()).send(body);
    expect(alone.status).toBe(403);
    expect(alone.body.code).toBe('RETURN_NEEDS_APPROVAL');
    expect((await c.http.post(`${api}/returns`).set(auth(manager)).send(body)).status).toBe(400);
    expect((await c.http.post(`${api}/returns`).set('Idempotency-Key', randomUUID()).send(body)).status).toBe(401);
  });

  it('is audited with who did it and why', async () => {
    const sale = await sell();
    await giveBack(sale.body.id, [{ saleItemId: sale.body.items[0].id, qty: '1' }], cash(75000), randomUUID(), 'customer complained');
    const log = await c.http.get(`${api}/audit?action=sale.return&entityId=${sale.body.id}`).set(auth(admin));
    expect(log.body.data[0]).toMatchObject({ userId: c.seed.users.manager.id, after: { refundLbp: 75000, reason: 'customer complained' } });
  });

  it('leaves the original sale untouched', async () => {
    const sale = await sell();
    await giveBack(sale.body.id, [{ saleItemId: sale.body.items[0].id, qty: '1' }], cash(75000));
    const after = await c.http.get(`${api}/sales/${sale.body.id}`).set(auth(cashier));
    expect(after.body).toMatchObject({ totalLbp: 75000, paidLbp: 75000, restLbp: 0, status: 'paid', profitLbp: sale.body.profitLbp });
    expect(after.body.items).toEqual(sale.body.items.map((i: object) => ({ ...i, returnedQty: '1' }))); // only the count of what came back moves
  });

  it('puts the stock back in the ledger as a return', async () => {
    const sale = await sell();
    const ret = await giveBack(sale.body.id, [{ saleItemId: sale.body.items[0].id, qty: '1' }], cash(75000));
    const ledger = await c.http.get(`${api}/stock/${c.seed.products.towel.id}/movements?limit=1`).set(auth(manager));
    expect(ledger.body.data[0]).toMatchObject({ qtyDelta: '1', reason: 'return', refType: 'return', refId: ret.body.id });
  });
});

describe('returning an unpaid or part-paid sale (credit)', () => {
  const customerId = () => c.seed.customers.registered.id;
  const balance = async () => (await c.http.get(`${api}/customers/${customerId()}`).set(auth(cashier))).body.balanceLbp as number;
  const detail = async (id: number) => (await c.http.get(`${api}/sales/${id}`).set(auth(cashier))).body;

  it('an unpaid sale: the value comes off what the customer owes and nothing is handed back', async () => {
    const before = await balance();
    const sale = await sell({ customerId: customerId(), payments: [] });
    expect(await balance()).toBe(before + 75000);

    const res = await giveBack(sale.body.id, [{ saleItemId: sale.body.items[0].id, qty: '1' }]);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ valueLbp: 75000, refundLbp: 0, balanceReducedLbp: 75000, refund: null });
    expect(await balance()).toBe(before);
    expect(await detail(sale.body.id)).toMatchObject({ restLbp: 0, paidLbp: 75000, status: 'paid' });
  });

  it('refuses a cash refund when there is nothing to hand back', async () => {
    const sale = await sell({ customerId: customerId(), payments: [] });
    const res = await giveBack(sale.body.id, [{ saleItemId: sale.body.items[0].id, qty: '1' }], cash(75000));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('REFUND_NOT_ALLOWED');
  });

  it('a part-paid sale: first the owed part, then cash for what was actually paid', async () => {
    const before = await balance();
    const sale = await sell({ customerId: customerId(), items: [chocLine('2')], payments: [cash(30000)] }); // owes 70,000
    expect(await balance()).toBe(before + 70000);
    const item = sale.body.items[0].id;

    const one = await giveBack(sale.body.id, [{ saleItemId: item, qty: '1' }]); // 50,000: all of it comes off the debt
    expect(one.body).toMatchObject({ valueLbp: 50000, balanceReducedLbp: 50000, refundLbp: 0 });
    expect(await balance()).toBe(before + 20000);
    expect(await detail(sale.body.id)).toMatchObject({ restLbp: 20000, status: 'partial' });

    const two = await giveBack(sale.body.id, [{ saleItemId: item, qty: '1' }], cash(30000)); // 20,000 off the debt, 30,000 back in cash
    expect(two.body).toMatchObject({ valueLbp: 50000, balanceReducedLbp: 20000, refundLbp: 30000 });
    expect(await balance()).toBe(before);
    expect(await detail(sale.body.id)).toMatchObject({ restLbp: 0, status: 'paid' });
  });

  it('keeps the invariants: balance = sum of open sales, paid + rest = total', async () => {
    const open = await c.http.get(`${api}/customers/${customerId()}/open-sales`).set(auth(cashier));
    const rest = (open.body.data as { restLbp: number }[]).reduce((a, s) => a + s.restLbp, 0);
    expect(await balance()).toBe(rest);
    for (const s of open.body.data as { totalLbp: number; paidLbp: number; restLbp: number }[])
      expect(s.paidLbp + s.restLbp).toBe(s.totalLbp);
  });
});

describe('the register and the list', () => {
  it('the Z-report shows refunds, and still adds up to the live balances', async () => {
    const cur = await c.http.get(`${api}/registers/current`).set(auth(cashier));
    const z = await c.http.get(`${api}/reports/register/${cur.body.id}`).set(auth(manager));
    const cashLbp = z.body.balances.find((b: { method: string; currency: string }) => b.method === 'cash' && b.currency === 'LBP');
    expect(cashLbp.refundsOut).toBeGreaterThan(0);
    expect(z.body.totals.refundsCount).toBeGreaterThan(5);
    for (const live of cur.body.balances as { method: string; currency: string; expected: number }[]) {
      const rebuilt = z.body.balances.find(
        (b: { method: string; currency: string }) => b.method === live.method && b.currency === live.currency,
      );
      expect(rebuilt.expected, `${live.method}/${live.currency}`).toBe(live.expected);
    }
  });

  it('lists returns with their items, filtered by sale', async () => {
    const sale = await sell({ items: [chocLine('2')], payments: [cash(100000)] });
    await giveBack(sale.body.id, [{ saleItemId: sale.body.items[0].id, qty: '1' }], cash(50000));
    const res = await c.http.get(`${api}/returns?saleId=${sale.body.id}`).set(auth(manager));
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ saleId: sale.body.id, refundLbp: 50000, items: [{ qty: '1', amountLbp: 50000 }] });
    expect((await c.http.get(`${api}/returns`).set(auth(cashier))).status).toBe(403);
  });

  it('needs an open register: after closing, a return is refused', async () => {
    const sale = await sell();
    const cur = await c.http.get(`${api}/registers/current`).set(auth(cashier));
    const counted = (cur.body.balances as { method: string; currency: string; expected: number }[]).map((b) => ({
      method: b.method,
      currency: b.currency,
      amount: b.expected,
    }));
    expect((await c.http.post(`${api}/registers/${cur.body.id}/close`).set(auth(cashier)).send({ countedBalances: counted })).status).toBe(
      200,
    );

    const res = await giveBack(sale.body.id, [{ saleItemId: sale.body.items[0].id, qty: '1' }], cash(75000));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REGISTER_CLOSED');
  });
});
