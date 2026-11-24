import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startCtx, type TestCtx } from '../helpers/app';

// Several cashiers selling at the same moment (docs/11-multi-branch.md, P1). Sales go through the database adapter, which runs
// transactions one at a time, so no number may be skipped or repeated, no stock or balance update may be lost, and the same
// Idempotency-Key sent many times at once must record exactly one sale.
let c: TestCtx;
let cashier: string;
let manager: string;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

const sell = (body: Record<string, unknown>, key: string = randomUUID(), token = cashier) =>
  c.http.post(`${api}/sales`).set(auth(token)).set('Idempotency-Key', key).send(body);

beforeAll(async () => {
  c = await startCtx();
  cashier = await c.login('cashier');
  manager = await c.login('manager');
  await c.openRegister(manager);
});
afterAll(() => c.close());

describe('many cashiers selling at once (US-08, rule 3, rule 6)', () => {
  it('records every sale once, with unique receipt numbers, and every total adds up', async () => {
    const stockBefore = Number(
      (await c.http.get(`${api}/stock?productId=${c.seed.products.towel.id}`).set(auth(manager))).body.data[0].qty,
    );

    // 40 different sales at once, plus 20 copies of ONE sale (same key), plus 10 partly-paid sales on a customer's account.
    const sameKey = randomUUID();
    const sameBody = c.newSaleBody();
    const creditBody = () =>
      c.newSaleBody({ customerId: c.seed.customers.registered.id, payments: [{ method: 'cash', currency: 'LBP', amount: 25000 }] });

    const results = await Promise.all([
      ...Array.from({ length: 40 }, () => sell(c.newSaleBody())),
      ...Array.from({ length: 20 }, () => sell(sameBody, sameKey)),
      ...Array.from({ length: 10 }, () => sell(creditBody())),
    ]);

    const failed = results.filter((r) => r.status !== 201 && r.status !== 200);
    expect(failed.map((r) => `${r.status} ${JSON.stringify(r.body)}`)).toEqual([]);

    // The 20 copies: exactly one created (201), the rest replayed (200) with the same answer.
    const copies = results.slice(40, 60);
    expect(copies.filter((r) => r.status === 201)).toHaveLength(1);
    expect(new Set(copies.map((r) => r.body.id)).size).toBe(1);

    // 40 + 1 + 10 distinct sales, receipt numbers all different and with no gap.
    const created = results.filter((r) => r.status === 201);
    expect(created).toHaveLength(51);
    const refs = created.map((r) => r.body.ref as number).sort((a, b) => a - b);
    expect(new Set(refs).size).toBe(51);
    expect(refs[refs.length - 1]! - refs[0]!).toBe(50);

    // Stock: every sale took one towel (stock may go below zero by design, rule 17).
    const stockAfter = Number((await c.http.get(`${api}/stock?productId=${c.seed.products.towel.id}`).set(auth(manager))).body.data[0].qty);
    expect(stockBefore - stockAfter).toBe(51);

    // The drawer: opening + 41 full cash sales + 10 partial payments, and the register's own recount agrees with its running figure.
    const current = (await c.http.get(`${api}/registers/current`).set(auth(manager))).body;
    const cashLbp = current.balances.find((b: { method: string; currency: string }) => b.method === 'cash' && b.currency === 'LBP');
    expect(cashLbp.expected).toBe(3_000_000 + 41 * 75_000 + 10 * 25_000);
    const z = (await c.http.get(`${api}/reports/register/${current.id}`).set(auth(manager))).body;
    const zCash = z.balances.find((b: { method: string; currency: string }) => b.method === 'cash' && b.currency === 'LBP');
    expect(zCash.expected).toBe(cashLbp.expected);

    // The customer owes what the ten partial sales left open: balance = sum of open sales' rests.
    const customer = (await c.http.get(`${api}/customers/${c.seed.customers.registered.id}`).set(auth(manager))).body;
    expect(customer.balanceLbp).toBe(10 * 50_000);
    const open = (await c.http.get(`${api}/customers/${c.seed.customers.registered.id}/open-sales`).set(auth(manager))).body.data;
    expect(open.reduce((sum: number, s: { restLbp: number }) => sum + s.restLbp, 0)).toBe(customer.balanceLbp);
  });

  it('a customer payment made while sales are being recorded is applied once and keeps the balance right', async () => {
    const id = c.seed.customers.registered.id;
    const before = (await c.http.get(`${api}/customers/${id}`).set(auth(manager))).body.balanceLbp as number;
    const pay = () =>
      c.http
        .post(`${api}/customers/${id}/payments`)
        .set(auth(manager))
        .set('Idempotency-Key', randomUUID())
        .send({ method: 'cash', currency: 'LBP', amount: 50_000 });

    const results = await Promise.all([
      ...Array.from({ length: 10 }, () => pay()),
      ...Array.from({ length: 20 }, () => sell(c.newSaleBody())),
    ]);
    expect(results.filter((r) => r.status >= 400).map((r) => r.body)).toEqual([]);

    const after = (await c.http.get(`${api}/customers/${id}`).set(auth(manager))).body.balanceLbp as number;
    expect(after).toBe(before - 10 * 50_000);
    const open = (await c.http.get(`${api}/customers/${id}/open-sales`).set(auth(manager))).body.data;
    expect(open.reduce((sum: number, s: { restLbp: number }) => sum + s.restLbp, 0)).toBe(after); // customer.balance = Σ open rest
  });
});
