import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCtx, type TestCtx } from '../helpers/app';

// docs/14-connection-and-till-backend.md §3: the till's ping. A heartbeat that also says what changed, with no business data.
let c: TestCtx;
let admin: string;
let manager: string;
let cashier: string;
let device = '';
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const till = (token: string) => ({ 'X-Terminal-Token': token });
const ping = (token?: string) => {
  const req = c.http.get(`${api}/ping`);
  return token === undefined ? req : req.set(till(token));
};
const versions = async () => (await ping(device)).body.versions as Record<string, number>;

beforeAll(async () => {
  c = await startCtx();
  admin = await c.login('admin');
  manager = await c.login('manager');
  cashier = await c.login('cashier');
  const code = await c.http.post(`${api}/terminals/1/enrol-code`).set(auth(admin));
  const done = await c.http.post(`${api}/terminals/enrol`).set(auth(admin)).send({ code: code.body.enrolCode });
  device = done.body.token as string;
});
afterAll(() => c.close());

describe('who may ping (US-26)', () => {
  it('needs a device token: no token, and a token nobody holds, are both refused (it is not an open door)', async () => {
    const none = await ping();
    expect(none.status).toBe(401);
    expect(none.body.code).toBe('TERMINAL_REQUIRED');
    const unknown = await ping('not-a-device-token');
    expect(unknown.status).toBe(401);
    expect(unknown.body.code).toBe('TERMINAL_UNKNOWN');
  });

  it('needs no signed-in person: the till pings before anyone has signed in', async () => {
    expect((await ping(device)).status).toBe(200);
  });

  it('a signed-in person without a device token is still refused (a browser is not a till)', async () => {
    expect((await c.http.get(`${api}/ping`).set(auth(manager))).status).toBe(401);
  });

  it('a till that was switched off can no longer ping', async () => {
    const made = await c.http.post(`${api}/terminals`).set(auth(admin)).send({ name: 'Till 2' });
    expect(made.status).toBe(201);
    const id = made.body.terminal.id as number;
    const code = await c.http.post(`${api}/terminals/${id}/enrol-code`).set(auth(admin));
    const enrolled = await c.http.post(`${api}/terminals/enrol`).set(auth(admin)).send({ code: code.body.enrolCode });
    const second = enrolled.body.token as string;
    expect((await ping(second)).status).toBe(200);
    expect((await c.http.post(`${api}/terminals/${id}/revoke`).set(auth(admin))).status).toBe(204);
    const after = await ping(second);
    expect(after.status).toBe(401);
    expect(after.body.code).toBe('TERMINAL_UNKNOWN');
  });
});

describe('what the answer holds', () => {
  it('says it is up, gives the time, the epoch and a number for each topic, and nothing else', async () => {
    const res = await ping(device);
    expect(res.body.ok).toBe(true);
    expect(Math.abs(Date.parse(res.body.serverTime) - Date.now())).toBeLessThan(10_000);
    expect(res.body.epoch).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.keys(res.body).sort()).toEqual(['epoch', 'ok', 'serverTime', 'versions']);
    expect(Object.keys(res.body.versions).sort()).toEqual(['catalog', 'rate', 'register', 'settings', 'stock', 'sync', 'wallets']);
    for (const n of Object.values(res.body.versions)) expect(Number.isInteger(n)).toBe(true);
  });

  it('keeps the same epoch while the server runs, and a new server has a different one', async () => {
    const first = (await ping(device)).body.epoch;
    expect((await ping(device)).body.epoch).toBe(first);
    const other = await startCtx();
    try {
      const otherAdmin = await other.login('admin');
      const code = await other.http.post(`${api}/terminals/1/enrol-code`).set(auth(otherAdmin));
      const done = await other.http.post(`${api}/terminals/enrol`).set(auth(otherAdmin)).send({ code: code.body.enrolCode });
      const theirs = await other.http.get(`${api}/ping`).set(till(done.body.token));
      expect(theirs.body.epoch).not.toBe(first);
    } finally {
      await other.close();
    }
  });

  it('carries no secret and no business figure', async () => {
    const text = JSON.stringify((await ping(device)).body);
    expect(text).not.toMatch(/token|hash|password|pin/i);
  });
});

describe('the numbers only go up, and only for what really changed', () => {
  it('a catalog edit raises the catalog number and not the rate or the settings', async () => {
    const before = await versions();
    const res = await c.http.patch(`${api}/products/${c.seed.products.choc.id}`).set(auth(manager)).send({ priceMinor: 53000 });
    expect(res.status).toBe(200);
    const after = await versions();
    expect(after.catalog).toBe(before.catalog! + 1);
    expect(after.rate).toBe(before.rate);
    expect(after.settings).toBe(before.settings);
  });

  it('a new exchange rate raises the rate number; a changed setting raises the settings number', async () => {
    const before = await versions();
    expect((await c.http.post(`${api}/exchange-rates`).set(auth(admin)).send({ rateLbpPerUsd: 91500 })).status).toBe(201);
    expect((await c.http.patch(`${api}/settings`).set(auth(admin)).send({ receiptFooter: 'Thank you' })).status).toBe(200);
    const after = await versions();
    expect(after.rate).toBe(before.rate! + 1);
    expect(after.settings).toBe(before.settings! + 1);
  });

  it('a sale raises stock; a replay of it, and a refused request, raise nothing', async () => {
    await c.http
      .post(`${api}/registers/open`)
      .set(auth(cashier))
      .set(till(device))
      .send({
        openingBalances: [
          { method: 'cash', currency: 'USD', amount: 0 },
          { method: 'cash', currency: 'LBP', amount: 3_000_000 },
        ],
      });
    const before = await versions();
    const key = randomUUID();
    const body = c.newSaleBody();
    const post = () => c.http.post(`${api}/sales`).set(auth(cashier)).set(till(device)).set('Idempotency-Key', key).send(body);
    expect((await post()).status).toBe(201);
    const afterSale = await versions();
    expect(afterSale.stock).toBe(before.stock! + 1);
    expect((await post()).status).toBe(200); // the replay
    const refused = await c.http
      .post(`${api}/sales`)
      .set(auth(cashier))
      .set(till(device))
      .set('Idempotency-Key', randomUUID())
      .send(c.newSaleBody({ items: [{ productId: c.seed.products.towel.id, qty: '1', unitPriceLbp: 1 }] }));
    expect(refused.status).toBe(422);
    expect(await versions()).toEqual(afterSale);
  });

  it('a wallet movement raises the wallets number', async () => {
    const before = await versions();
    const res = await c.http
      .post(`${api}/wallets/movements`)
      .set(auth(manager))
      .send({ bucket: { method: 'whish', currency: 'LBP' }, type: 'in', amount: 1000, reason: 'Top-up' });
    expect(res.status).toBe(201);
    expect((await versions()).wallets).toBe(before.wallets! + 1);
  });

  it('never goes down across many changes', async () => {
    let last = await versions();
    for (let i = 0; i < 3; i++) {
      await c.http
        .post(`${api}/exchange-rates`)
        .set(auth(admin))
        .send({ rateLbpPerUsd: 92000 + i });
      const now = await versions();
      for (const [topic, n] of Object.entries(now)) expect(n).toBeGreaterThanOrEqual(last[topic]!);
      last = now;
    }
  });
});
