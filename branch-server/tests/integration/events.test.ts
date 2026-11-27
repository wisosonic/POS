import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startCtx, type TestCtx } from '../helpers/app';

// What a request changes is published inside the server (events/bus.ts) and counted for the till's ping (docs/14 §3). There is no stream to a
// screen any more (`GET /events` was removed in step 6): the till asks `GET /ping` and fetches the topics whose number moved.
let c: TestCtx;
let cashier: string;
let manager: string;
let admin: string;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
let heard: string[] = [];

const sell = (over: Record<string, unknown> = {}, key: string = randomUUID()) =>
  c.http.post(`${api}/sales`).set(auth(cashier)).set('Idempotency-Key', key).send(c.newSaleBody(over));

beforeAll(async () => {
  c = await startCtx();
  cashier = await c.login('cashier');
  manager = await c.login('manager');
  admin = await c.login('admin');
  await c.openRegister(cashier);
  c.app.events.tap((e) => heard.push(e.type));
});
afterAll(() => c.close());

describe('what a request changes is published inside the server', () => {
  it('there is no stream any more: GET /events is gone', async () => {
    expect((await c.http.get(`${api}/events`).set(auth(manager))).status).toBe(404);
  });

  it('a sale publishes the sale and that the stock changed', async () => {
    heard = [];
    expect((await sell()).status).toBe(201);
    expect(heard).toContain('sale.completed');
    expect(heard).toContain('stock.changed');
  });

  it('a replayed sale and a refused request publish nothing; the next real change does', async () => {
    const key = randomUUID();
    const body = c.newSaleBody();
    const post = () => c.http.post(`${api}/sales`).set(auth(cashier)).set('Idempotency-Key', key).send(body);
    expect((await post()).status).toBe(201);
    heard = [];
    expect((await post()).status).toBe(200); // a replay
    expect((await sell({ items: [{ productId: c.seed.products.towel.id, qty: '1', unitPriceLbp: 1 }] })).status).toBe(422);
    expect(heard).toEqual([]);
    expect((await c.http.post(`${api}/exchange-rates`).set(auth(admin)).send({ rateLbpPerUsd: 91000 })).status).toBe(201);
    expect(heard).toEqual(['rate.changed']);
  });

  it('a product edit publishes catalog.changed', async () => {
    heard = [];
    const res = await c.http.patch(`${api}/products/${c.seed.products.choc.id}`).set(auth(manager)).send({ priceMinor: 52000 });
    expect(res.status).toBe(200);
    expect(heard).toContain('catalog.changed');
  });

  it('closing the register publishes register.updated', async () => {
    heard = [];
    const current = (await c.http.get(`${api}/registers/current`).set(auth(cashier))).body;
    const counted = current.balances.map((b: { method: string; currency: string; expected: number }) => ({
      method: b.method,
      currency: b.currency,
      amount: b.expected,
    }));
    expect((await c.http.post(`${api}/registers/${current.id}/close`).set(auth(manager)).send({ countedBalances: counted })).status).toBe(
      200,
    );
    expect(heard).toContain('register.updated');
  });
});

describe('shutting the server down', () => {
  it('closes at once, with nothing held open', async () => {
    const own = await startCtx();
    const started = Date.now();
    await own.close();
    expect(Date.now() - started).toBeLessThan(3000);
  }, 15_000);
});
