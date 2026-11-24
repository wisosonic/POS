import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startCtx, type TestCtx } from '../helpers/app';

// Customers and their accounts (US-24, US-31 to US-33): who owes what, payments applied oldest sale first.
let c: TestCtx;
let cashier: string;
let manager: string;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
type Pay = { method: string; currency: string; amount: number };
const cash = (amount: number): Pay => ({ method: 'cash', currency: 'LBP', amount });

const newCustomer = async (name: string, extra: Record<string, unknown> = {}) =>
  (
    await c.http
      .post(`${api}/customers`)
      .set(auth(cashier))
      .send({ name, ...extra })
  ).body as { id: number; name: string };
const sell = (customerId: number, payments: Pay[] = [], over: Record<string, unknown> = {}) =>
  c.http
    .post(`${api}/sales`)
    .set(auth(cashier))
    .set('Idempotency-Key', randomUUID())
    .send(c.newSaleBody({ customerId, payments, ...over }));
const choc = (qty: string) => ({ productId: c.seed.products.choc.id, qty, unitPriceLbp: 50000 });
const payOn = (customerId: number, body: Record<string, unknown>, key: string = randomUUID(), token = cashier) =>
  c.http.post(`${api}/customers/${customerId}/payments`).set(auth(token)).set('Idempotency-Key', key).send(body);
const info = async (id: number) => (await c.http.get(`${api}/customers/${id}`).set(auth(cashier))).body;
const openSales = async (id: number) =>
  (await c.http.get(`${api}/customers/${id}/open-sales`).set(auth(cashier))).body.data as {
    id: number;
    ref: number;
    totalLbp: number;
    paidLbp: number;
    restLbp: number;
    status: string;
  }[];

beforeAll(async () => {
  c = await startCtx();
  cashier = await c.login('cashier');
  manager = await c.login('manager');
  await c.openRegister(cashier);
});
afterAll(() => c.close());

describe('managing customers', () => {
  it('a cashier can add a customer at the till', async () => {
    const res = await c.http
      .post(`${api}/customers`)
      .set(auth(cashier))
      .send({ name: '  Ahmad Darwish ', phone: '03 111 222', address: 'Beirut' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Ahmad Darwish', phone: '03 111 222', address: 'Beirut', balanceLbp: 0, isWalkIn: false });
  });

  it.each([
    ['an empty name', { name: '   ' }],
    ['no name', {}],
    ['a name over 100 characters', { name: 'x'.repeat(101) }],
  ])('refuses %s', async (_n, body) => {
    expect((await c.http.post(`${api}/customers`).set(auth(cashier)).send(body)).status).toBe(400);
  });

  it('searches by part of the name or phone, case-insensitively', async () => {
    await newCustomer('Fatima Shbeb', { phone: '70 555 000' });
    const byName = await c.http.get(`${api}/customers?q=shbe`).set(auth(cashier));
    expect(byName.body.data.map((x: { name: string }) => x.name)).toEqual(['Fatima Shbeb']);
    const byPhone = await c.http.get(`${api}/customers?q=555`).set(auth(cashier));
    expect(byPhone.body.data.map((x: { name: string }) => x.name)).toEqual(['Fatima Shbeb']);
  });

  it('treats % and _ as plain characters in the search', async () => {
    expect((await c.http.get(`${api}/customers?q=%25`).set(auth(cashier))).body.data).toEqual([]);
    expect((await c.http.get(`${api}/customers?q=_`).set(auth(cashier))).body.data).toEqual([]);
  });

  it('pages through the list', async () => {
    const first = await c.http.get(`${api}/customers?limit=2`).set(auth(cashier));
    expect(first.body.data).toHaveLength(2);
    const next = await c.http.get(`${api}/customers?limit=2&cursor=${first.body.nextCursor}`).set(auth(cashier));
    expect(next.body.data[0].id).toBeGreaterThan(first.body.data[1].id);
  });

  it('only a manager edits a customer; the change is audited', async () => {
    const cust = await newCustomer('Edit Me');
    expect((await c.http.patch(`${api}/customers/${cust.id}`).set(auth(cashier)).send({ phone: '1' })).status).toBe(403);
    const res = await c.http.patch(`${api}/customers/${cust.id}`).set(auth(manager)).send({ phone: '03 999 888' });
    expect(res.body.phone).toBe('03 999 888');
    expect(res.body.name).toBe('Edit Me');
    const admin = await c.login('admin');
    const log = await c.http.get(`${api}/audit?entity=customer&entityId=${cust.id}&action=customer.update`).set(auth(admin));
    expect(log.body.data[0].after).toEqual({ phone: '03 999 888' });
  });

  it('Walk-In is protected', async () => {
    const res = await c.http.patch(`${api}/customers/1`).set(auth(manager)).send({ name: 'Renamed' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('WALK_IN_PROTECTED');
    expect((await info(1)).isWalkIn).toBe(true);
  });

  it('404 for an unknown customer, and a token is required', async () => {
    expect((await c.http.get(`${api}/customers/999999`).set(auth(cashier))).status).toBe(404);
    expect((await c.http.get(`${api}/customers`)).status).toBe(401);
  });
});

describe('paying on account: oldest sale first (decision table #14)', () => {
  let ali: { id: number };
  let first: { id: number; ref: number };
  let second: { id: number; ref: number };

  beforeAll(async () => {
    ali = await newCustomer('Ali Owes');
    first = (await sell(ali.id, [], { items: [{ productId: c.seed.products.towel.id, qty: '1', unitPriceLbp: 75000 }] })).body; // 75,000
    second = (await sell(ali.id, [cash(20000)], { items: [choc('2')] })).body; // 100,000, paid 20,000, owes 80,000
  });

  it('starts with the sum of what is unpaid', async () => {
    expect((await info(ali.id)).balanceLbp).toBe(75000 + 80000);
    expect((await openSales(ali.id)).map((s) => s.id)).toEqual([first.id, second.id]); // oldest first
  });

  it('a payment settles the oldest sale before touching the next', async () => {
    const res = await payOn(ali.id, { method: 'cash', currency: 'LBP', amount: 80000 });
    expect(res.status).toBe(201);
    expect(res.body.allocations).toEqual([
      { saleId: first.id, ref: first.ref, amountLbp: 75000 },
      { saleId: second.id, ref: second.ref, amountLbp: 5000 },
    ]);
    expect(res.body.balanceLbp).toBe(75000);

    const open = await openSales(ali.id);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ id: second.id, restLbp: 75000, paidLbp: 25000, status: 'partial' });
    const settled = await c.http.get(`${api}/sales/${first.id}`).set(auth(cashier));
    expect(settled.body).toMatchObject({ status: 'paid', restLbp: 0, paidLbp: 75000 });
  });

  it('the balance is always the sum of the open sales', async () => {
    const rest = (await openSales(ali.id)).reduce((a, s) => a + s.restLbp, 0);
    expect((await info(ali.id)).balanceLbp).toBe(rest);
  });

  it('a dollar payment is converted at the current rate', async () => {
    const res = await payOn(ali.id, { method: 'cash', currency: 'USD', amount: 50 }); // $0.50 = 45,000 LBP
    expect(res.body).toMatchObject({ amountLbp: 45000, balanceLbp: 30000 });
  });

  it('a wallet payment is allowed and goes into that wallet', async () => {
    const before = (await c.http.get(`${api}/registers/current`).set(auth(cashier))).body.balances.find(
      (b: { method: string; currency: string }) => b.method === 'whish' && b.currency === 'LBP',
    ).expected;
    expect((await payOn(ali.id, { method: 'whish', currency: 'LBP', amount: 10000 })).status).toBe(201);
    const after = (await c.http.get(`${api}/registers/current`).set(auth(cashier))).body.balances.find(
      (b: { method: string; currency: string }) => b.method === 'whish' && b.currency === 'LBP',
    ).expected;
    expect(after).toBe(before + 10000);
  });

  it('cannot pay more than is owed, and a failed payment changes nothing', async () => {
    const owed = (await info(ali.id)).balanceLbp as number;
    const res = await payOn(ali.id, { method: 'cash', currency: 'LBP', amount: owed + 1 });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PAYMENT_EXCEEDS_BALANCE');
    expect((await info(ali.id)).balanceLbp).toBe(owed);
  });

  it('paying the exact remainder clears the account and removes them from the receivables list', async () => {
    const owed = (await info(ali.id)).balanceLbp as number;
    expect((await payOn(ali.id, { method: 'cash', currency: 'LBP', amount: owed })).status).toBe(201);
    expect((await info(ali.id)).balanceLbp).toBe(0);
    expect(await openSales(ali.id)).toEqual([]);
    const report = await c.http.get(`${api}/reports/receivables`).set(auth(manager));
    expect(report.body.data.map((r: { customerId: number }) => r.customerId)).not.toContain(ali.id);
  });

  it('a customer with nothing owing cannot pay', async () => {
    const res = await payOn(ali.id, { method: 'cash', currency: 'LBP', amount: 1000 });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PAYMENT_EXCEEDS_BALANCE');
  });
});

describe('payment safety', () => {
  let who: { id: number };
  beforeAll(async () => {
    who = await newCustomer('Safe Payer');
    await sell(who.id, [], { items: [choc('2')] }); // owes 100,000
  });

  it('is idempotent: a repeat applies once', async () => {
    const key = randomUUID();
    const body = { method: 'cash', currency: 'LBP', amount: 10000 };
    const a = await payOn(who.id, body, key);
    const b = await payOn(who.id, body, key);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.body.id).toBe(a.body.id);
    expect((await info(who.id)).balanceLbp).toBe(90000);
  });

  it('the same key for a different payment is refused', async () => {
    const key = randomUUID();
    await payOn(who.id, { method: 'cash', currency: 'LBP', amount: 5000 }, key);
    const res = await payOn(who.id, { method: 'cash', currency: 'LBP', amount: 6000 }, key);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('parallel duplicates apply exactly once', async () => {
    const before = (await info(who.id)).balanceLbp as number;
    const key = randomUUID();
    const rs = await Promise.all(Array.from({ length: 5 }, () => payOn(who.id, { method: 'cash', currency: 'LBP', amount: 1000 }, key)));
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    expect((await info(who.id)).balanceLbp).toBe(before - 1000);
  });

  it('parallel different payments never take the balance below zero', async () => {
    const owed = (await info(who.id)).balanceLbp as number;
    const rs = await Promise.all(
      Array.from({ length: 6 }, () => payOn(who.id, { method: 'cash', currency: 'LBP', amount: Math.ceil(owed / 2) })),
    );
    const accepted = rs.filter((r) => r.status === 201).length;
    expect(accepted).toBeLessThanOrEqual(2); // two halves can fit, a third cannot
    expect((await info(who.id)).balanceLbp).toBeGreaterThanOrEqual(0);
    const open = await openSales(who.id);
    expect((await info(who.id)).balanceLbp).toBe(open.reduce((a, s) => a + s.restLbp, 0));
  });

  it.each([
    ['a zero amount', { method: 'cash', currency: 'LBP', amount: 0 }],
    ['a negative amount', { method: 'cash', currency: 'LBP', amount: -1 }],
    ['a fractional amount', { method: 'cash', currency: 'LBP', amount: 1.5 }],
    ['an unknown method', { method: 'bitcoin', currency: 'LBP', amount: 1000 }],
    ['an unknown currency', { method: 'cash', currency: 'EUR', amount: 1000 }],
  ])('refuses %s', async (_n, body) => {
    expect((await payOn(who.id, body)).status).toBe(400);
  });

  it('Walk-In has no account, and an unknown customer is 404', async () => {
    const walkIn = await payOn(1, { method: 'cash', currency: 'LBP', amount: 1000 });
    expect(walkIn.status).toBe(422);
    expect(walkIn.body.code).toBe('WALK_IN_NO_ACCOUNT');
    expect((await payOn(999999, { method: 'cash', currency: 'LBP', amount: 1000 })).status).toBe(404);
  });

  it('needs a token and an Idempotency-Key', async () => {
    const body = { method: 'cash', currency: 'LBP', amount: 1000 };
    expect((await c.http.post(`${api}/customers/${who.id}/payments`).set('Idempotency-Key', randomUUID()).send(body)).status).toBe(401);
    expect((await c.http.post(`${api}/customers/${who.id}/payments`).set(auth(cashier)).send(body)).status).toBe(400);
  });
});

describe('receivables (US-33) and history', () => {
  it('lists who owes, biggest first, with the oldest unpaid date and a grand total', async () => {
    const small = await newCustomer('Owes Little');
    const big = await newCustomer('Owes Lots');
    await sell(small.id, [], { items: [choc('1')] });
    await sell(big.id, [], { items: [choc('4')] });
    const res = await c.http.get(`${api}/reports/receivables`).set(auth(manager));
    const ids = res.body.data.map((r: { customerId: number }) => r.customerId);
    expect(ids.indexOf(big.id)).toBeLessThan(ids.indexOf(small.id));
    const row = res.body.data.find((r: { customerId: number }) => r.customerId === big.id);
    expect(row).toMatchObject({ name: 'Owes Lots', balanceLbp: 200000, openSales: 1 });
    expect(row.oldestUnpaidAt).toBeTruthy();
    expect(res.body.totalOwedLbp).toBe((res.body.data as { balanceLbp: number }[]).reduce((a, r) => a + r.balanceLbp, 0));
  });

  it('is for managers only', async () => {
    expect((await c.http.get(`${api}/reports/receivables`).set(auth(cashier))).status).toBe(403);
  });

  it('the customer filter shows only those who owe', async () => {
    const res = await c.http.get(`${api}/customers?withBalance=true&limit=200`).set(auth(cashier));
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every((x: { balanceLbp: number }) => x.balanceLbp > 0)).toBe(true);
  });

  it('shows a customer’s sales newest first', async () => {
    const cust = await newCustomer('Regular');
    const a = await sell(cust.id, [cash(75000)]);
    const b = await sell(cust.id, [cash(75000)]);
    const res = await c.http.get(`${api}/customers/${cust.id}/sales`).set(auth(cashier));
    expect(res.body.data.map((s: { id: number }) => s.id)).toEqual([b.body.id, a.body.id]);
  });

  it('Walk-In never shows a balance, whatever happens', async () => {
    expect((await info(1)).balanceLbp).toBe(0);
    expect((await sell(1, [])).status).toBe(422); // pay-later is refused for Walk-In
    expect((await info(1)).balanceLbp).toBe(0);
  });
});

describe('the register must be open to take a payment', () => {
  it('refuses once the register is closed', async () => {
    const debtor = await newCustomer('Late Payer');
    await sell(debtor.id, [], { items: [choc('1')] });
    const cur = await c.http.get(`${api}/registers/current`).set(auth(cashier));
    const counted = (cur.body.balances as { method: string; currency: string; expected: number }[]).map((b) => ({
      method: b.method,
      currency: b.currency,
      amount: b.expected,
    }));
    await c.http.post(`${api}/registers/${cur.body.id}/close`).set(auth(cashier)).send({ countedBalances: counted });
    const res = await payOn(debtor.id, { method: 'cash', currency: 'LBP', amount: 1000 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REGISTER_CLOSED');
    expect((await info(debtor.id)).balanceLbp).toBe(50000);
  });
});

describe('deleting a customer (US-24)', () => {
  let admin: string;
  beforeAll(async () => {
    admin = await c.login('admin');
    await c.openRegister(cashier); // an earlier test in this file closed the register
  });

  it('only a manager may; the customer disappears from the list and the lookups, and it is audited', async () => {
    const x = await newCustomer('Delete me', { phone: '03999111' });
    expect((await c.http.delete(`${api}/customers/${x.id}`).set(auth(cashier))).status).toBe(403);
    expect((await c.http.delete(`${api}/customers/${x.id}`)).status).toBe(401);

    expect((await c.http.delete(`${api}/customers/${x.id}`).set(auth(manager))).status).toBe(204);
    const list = await c.http.get(`${api}/customers?q=Delete me`).set(auth(cashier));
    expect(list.body.data.some((k: { id: number }) => k.id === x.id)).toBe(false);
    expect((await c.http.get(`${api}/customers/${x.id}`).set(auth(cashier))).status).toBe(404);
    expect((await c.http.delete(`${api}/customers/${x.id}`).set(auth(manager))).status).toBe(404); // already gone
    expect((await c.http.patch(`${api}/customers/${x.id}`).set(auth(manager)).send({ name: 'x' })).status).toBe(404);
    const log = await c.http.get(`${api}/audit?entity=customer&entityId=${x.id}&action=customer.delete`).set(auth(admin));
    expect(log.body.data[0].before).toMatchObject({ name: 'Delete me' });
  });

  it('a deleted customer cannot be chosen for a new sale', async () => {
    const x = await newCustomer('Gone before the sale');
    await c.http.delete(`${api}/customers/${x.id}`).set(auth(manager));
    const res = await sell(x.id, [cash(50000)], { items: [choc('1')] });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('keeps their past sales, with their name on them', async () => {
    const x = await newCustomer('Paid in full then gone');
    const made = await sell(x.id, [cash(100000)], { items: [choc('2')] });
    expect(made.status).toBe(201);
    expect((await c.http.delete(`${api}/customers/${x.id}`).set(auth(manager))).status).toBe(204);
    const sale = await c.http.get(`${api}/sales?ref=${made.body.ref}`).set(auth(manager));
    expect(sale.body.data[0].customerName).toBe('Paid in full then gone');
  });

  it('refuses someone who still owes money, and Walk-In', async () => {
    const x = await newCustomer('Still owes');
    expect((await sell(x.id, [cash(0)].slice(1), { items: [choc('1')] })).status).toBe(201); // all on account
    const owes = await c.http.delete(`${api}/customers/${x.id}`).set(auth(manager));
    expect(owes.status).toBe(422);
    expect(owes.body.code).toBe('CUSTOMER_OWES');
    expect((await info(x.id)).name).toBe('Still owes'); // still there

    const walkIn = await c.http.delete(`${api}/customers/1`).set(auth(manager));
    expect(walkIn.status).toBe(422);
    expect(walkIn.body.code).toBe('WALK_IN_PROTECTED');
  });
});
