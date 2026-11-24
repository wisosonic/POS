import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startCtx, type TestCtx } from '../helpers/app';

// Expenses (US-24) and the list of cash movements (US-13): an expense paid from the drawer also leaves the register
// balance, so the closing count still agrees. One expense paid some other way touches nothing in the register.
let c: TestCtx;
let cashier: string;
let manager: string;
let sessionId: number;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
type B = { method: string; currency: string; expected: number };

const expense = (over: Record<string, unknown> = {}, token = manager) =>
  c.http
    .post(`${api}/expenses`)
    .set(auth(token))
    .send({ title: 'Electricity', amountMinor: 200_000, currency: 'LBP', ...over });
const bucket = async (method: string, currency: string) => {
  const cur = await c.http.get(`${api}/registers/current`).set(auth(cashier));
  return (cur.body.balances as B[]).find((b) => b.method === method && b.currency === currency)!.expected;
};
const count = async () => (await c.http.get(`${api}/expenses?limit=200`).set(auth(manager))).body.data.length as number;

beforeAll(async () => {
  c = await startCtx();
  cashier = await c.login('cashier');
  manager = await c.login('manager');
});
afterAll(() => c.close());

describe('expenses that do not touch the till', () => {
  it('records an expense paid some other way, with no register open', async () => {
    const res = await expense({ title: 'Rent', amountMinor: 5_000_000, reference: 'INV-7', note: 'October' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ title: 'Rent', amountMinor: 5_000_000, currency: 'LBP', reference: 'INV-7', paidFromRegister: false });
  });

  it('refuses to pay from the drawer while the register is closed, and records nothing', async () => {
    const before = await count();
    const res = await expense({ title: 'Delivery', payFrom: { method: 'cash' } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REGISTER_CLOSED');
    expect(await count()).toBe(before);
  });
});

describe('expenses paid from the drawer', () => {
  beforeAll(async () => {
    sessionId = (await c.openRegister(cashier)).id;
  });

  it('the money leaves the chosen balance, in the expense’s currency, and shows in the movements', async () => {
    const before = await bucket('cash', 'LBP');
    const res = await expense({ title: 'Cleaning supplies', amountMinor: 150_000, payFrom: { method: 'cash' } });
    expect(res.status).toBe(201);
    expect(res.body.paidFromRegister).toBe(true);
    expect(await bucket('cash', 'LBP')).toBe(before - 150_000);

    const moves = await c.http.get(`${api}/registers/${sessionId}/cash-movements`).set(auth(manager));
    expect(moves.status).toBe(200);
    expect(moves.body.data[0]).toMatchObject({
      type: 'out',
      from: { method: 'cash', currency: 'LBP' },
      to: null,
      amount: 150_000,
      reason: 'Expense: Cleaning supplies',
    });
  });

  it('a dollar expense paid from the Whish wallet takes dollars out of that wallet only', async () => {
    const [whishUsd, cashUsd, whishLbp] = [await bucket('whish', 'USD'), await bucket('cash', 'USD'), await bucket('whish', 'LBP')];
    const res = await expense({ title: 'Software', amountMinor: 1500, currency: 'USD', payFrom: { method: 'whish' } });
    expect(res.status).toBe(201);
    expect(await bucket('whish', 'USD')).toBe(whishUsd - 1500);
    expect(await bucket('cash', 'USD')).toBe(cashUsd);
    expect(await bucket('whish', 'LBP')).toBe(whishLbp);
  });

  it('the Z-report rebuilt from the rows agrees with the running balance', async () => {
    const z = await c.http.get(`${api}/reports/register/${sessionId}`).set(auth(manager));
    const rebuilt = (z.body.balances as (B & { movementsNet: number })[]).find((b) => b.method === 'cash' && b.currency === 'LBP')!;
    expect(rebuilt.expected).toBe(await bucket('cash', 'LBP'));
    expect(rebuilt.movementsNet).toBe(-150_000);
  });

  it('an expense paid from the drawer is not recorded when the register session cannot take it', async () => {
    const before = await count();
    const res = await expense({ title: 'Mystery', payFrom: { method: 'bitcoin' } });
    expect(res.status).toBe(400);
    expect(await count()).toBe(before);
  });
});

describe('listing, categories and rules', () => {
  it('lists newest first with the totals of everything matched, per currency', async () => {
    const res = await c.http.get(`${api}/expenses?limit=1`).set(auth(manager));
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].title).toBe('Software');
    expect(res.body.nextCursor).not.toBeNull();
    expect(res.body.totals).toEqual({ USD: 1500, LBP: 5_000_000 + 150_000 });
  });

  it('files an expense under a category and filters by it', async () => {
    const cat = await c.http.post(`${api}/expense-categories`).set(auth(manager)).send({ name: 'Utilities' });
    expect(cat.status).toBe(201);
    const dup = await c.http.post(`${api}/expense-categories`).set(auth(manager)).send({ name: 'utilities' });
    expect(dup.status).toBe(409);
    expect(dup.body.detail).toMatch(/already an expense category/);

    await expense({ title: 'Water', amountMinor: 80_000, categoryId: cat.body.id });
    const only = await c.http.get(`${api}/expenses?categoryId=${cat.body.id}`).set(auth(manager));
    expect(only.body.data.map((e: { title: string }) => e.title)).toEqual(['Water']);
    expect(only.body.data[0].categoryName).toBe('Utilities');
    expect(only.body.totals.LBP).toBe(80_000);
  });

  it('refuses a missing title, a zero amount and an unknown category', async () => {
    expect((await expense({ title: '  ' })).status).toBe(400);
    expect((await expense({ amountMinor: 0 })).status).toBe(400);
    expect((await expense({ categoryId: 99999 })).status).toBe(422);
  });

  it('a cashier can neither record nor read expenses, nor list cash movements', async () => {
    expect((await expense({}, cashier)).status).toBe(403);
    expect((await c.http.get(`${api}/expenses`).set(auth(cashier))).status).toBe(403);
    expect((await c.http.get(`${api}/registers/${sessionId}/cash-movements`).set(auth(cashier))).status).toBe(403);
  });

  it('there is no way to edit or delete an expense', async () => {
    const list = await c.http.get(`${api}/expenses?limit=1`).set(auth(manager));
    const id = list.body.data[0].id;
    expect((await c.http.patch(`${api}/expenses/${id}`).set(auth(manager)).send({ amountMinor: 1 })).status).toBe(404);
    expect((await c.http.delete(`${api}/expenses/${id}`).set(auth(manager))).status).toBe(404);
  });
});
