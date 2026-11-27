import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startCtx, type TestCtx } from '../helpers/app';

// US-12 and docs/13 §6 (decision D7): a cashier may count the drawer blind. The shop chooses; the default is blind for cashiers.
let c: TestCtx;
let cashier: string;
let manager: string;
let admin: string;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const OPENING = [
  { method: 'cash', currency: 'USD', amount: 7000 },
  { method: 'cash', currency: 'LBP', amount: 3_000_000 },
];
type Bal = { method: string; currency: string; opening: number; expected: number | null; counted?: number | null };

beforeAll(async () => {
  c = await startCtx({ blindCount: true });
  cashier = await c.login('cashier');
  manager = await c.login('manager');
  admin = await c.login('admin');
});
afterAll(() => c.close());

describe('counting the drawer blind (US-12)', () => {
  it('is on by default, and the admin can read the setting', async () => {
    const s = await c.http.get(`${api}/settings`).set(auth(admin));
    expect(s.body.cashierBlindCount).toBe(true);
  });

  it('a cashier is not told what the drawer should hold, while a manager is', async () => {
    const opened = await c.http.post(`${api}/registers/open`).set(auth(cashier)).send({ openingBalances: OPENING });
    expect(opened.status).toBe(201);
    expect((opened.body.balances as Bal[]).every((b) => b.expected === null && b.opening > 0)).toBe(true);
    const mine = await c.http.get(`${api}/registers/current`).set(auth(cashier));
    expect((mine.body.balances as Bal[]).map((b) => b.expected)).toEqual([null, null]);
    const theirs = await c.http.get(`${api}/registers/current`).set(auth(manager));
    expect((theirs.body.balances as Bal[]).map((b) => b.expected).sort()).toEqual([3_000_000, 7000]);
  });

  it('turning it off shows the cashier the expectation again, and only an admin may change it', async () => {
    const denied = await c.http.patch(`${api}/settings`).set(auth(manager)).send({ cashierBlindCount: false });
    expect(denied.status).toBe(403);
    const off = await c.http.patch(`${api}/settings`).set(auth(admin)).send({ cashierBlindCount: false });
    expect(off.body.cashierBlindCount).toBe(false);
    const mine = await c.http.get(`${api}/registers/current`).set(auth(cashier));
    expect((mine.body.balances as Bal[]).map((b) => b.expected).sort()).toEqual([3_000_000, 7000]);
    await c.http.patch(`${api}/settings`).set(auth(admin)).send({ cashierBlindCount: true });
  });

  it('the closing report still shows the cashier everything, and the variance is judged on the server', async () => {
    const current = await c.http.get(`${api}/registers/current`).set(auth(cashier));
    const counted = [
      { method: 'cash', currency: 'USD', amount: 7000 },
      { method: 'cash', currency: 'LBP', amount: 2_990_000 },
    ];
    const closed = await c.http.post(`${api}/registers/${current.body.id}/close`).set(auth(cashier)).send({ countedBalances: counted });
    expect(closed.status).toBe(200);
    const lbp = (closed.body.balances as (Bal & { variance: number })[]).find((b) => b.currency === 'LBP')!;
    expect(lbp.expected).toBe(3_000_000);
    expect(lbp.variance).toBe(-10_000);
  });
});
