import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startCtx, type TestCtx } from '../helpers/app';

// Q6: opening balances set per method × currency; closing reports expected vs counted for each,
// including the Whish and OMT wallets. No third-party integration: balances are bookkeeping only. (US-11, US-12, US-13)
let c: TestCtx;
let cashier: string;
let manager: string;
let sessionId: number;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
type Bal = { method: string; currency: string; opening: number; expected: number; counted?: number; variance?: number; amount?: number };
const find = (bs: Bal[], method: string, currency: string) => bs.find((b) => b.method === method && b.currency === currency)!;

beforeAll(async () => {
  c = await startCtx();
  cashier = await c.login('cashier');
  manager = await c.login('manager');
});
afterAll(() => c.close());

describe('opening the register', () => {
  it('requires an opening balance for every method × currency (cash, whish, omt × USD, LBP)', async () => {
    const res = await c.http
      .post('/api/v1/registers/open')
      .set(auth(cashier))
      .send({ terminalId: 'T1', openingBalances: [{ method: 'cash', currency: 'LBP', amount: 1000 }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION');
  });

  it('opens with all six balances and echoes them', async () => {
    const reg = await c.openRegister(cashier);
    sessionId = reg.id;
    const cur = await c.http.get('/api/v1/registers/current').set(auth(cashier));
    expect(cur.body.balances).toHaveLength(6);
    expect(find(cur.body.balances, 'whish', 'USD').opening).toBe(1000);
    expect(find(cur.body.balances, 'omt', 'LBP').opening).toBe(1_000_000);
  });

  it('one till: refuses a second open session for the same terminal, whoever asks', async () => {
    const res = await c.http.post('/api/v1/registers/open').set(auth(manager)).send({ terminalId: 'T1', openingBalances: [] });
    expect(res.status).toBe(409);
  });

  it('a manager can sell in the till session opened by the cashier; the sale records who sold it', async () => {
    // paid in OMT USD so the LBP buckets asserted below stay untouched
    const res = await c.http
      .post('/api/v1/sales')
      .set(auth(manager))
      .set('Idempotency-Key', 'rg-mgr')
      .send(
        c.newSaleBody({
          items: [{ productId: c.seed.products.usd.id, qty: '1', unitPriceLbp: 225000 }],
          payments: [{ method: 'omt', currency: 'USD', amount: 250 }],
        }),
      );
    expect(res.status).toBe(201);
    expect(res.body.userId).toBe(c.seed.users.manager.id);
    expect(res.body.sessionId).toBe(sessionId);
  });
});

describe('expected balances during the day', () => {
  it('a cash LBP sale increases cash LBP only', async () => {
    await c.http.post('/api/v1/sales').set(auth(cashier)).set('Idempotency-Key', 'rg-1').send(c.newSaleBody());
    const cur = await c.http.get('/api/v1/registers/current').set(auth(cashier));
    expect(find(cur.body.balances, 'cash', 'LBP').expected).toBe(3_000_000 + 75000);
    expect(find(cur.body.balances, 'whish', 'LBP').expected).toBe(500_000);
  });

  it('a Whish sale increases the Whish wallet only', async () => {
    await c.http
      .post('/api/v1/sales')
      .set(auth(cashier))
      .set('Idempotency-Key', 'rg-2')
      .send(c.newSaleBody({ payments: [{ method: 'whish', currency: 'LBP', amount: 75000 }] }));
    const cur = await c.http.get('/api/v1/registers/current').set(auth(cashier));
    expect(find(cur.body.balances, 'whish', 'LBP').expected).toBe(500_000 + 75000);
    expect(find(cur.body.balances, 'cash', 'LBP').expected).toBe(3_000_000 + 75000);
  });

  it('change given reduces cash, not the wallet', async () => {
    await c.http
      .post('/api/v1/sales')
      .set(auth(cashier))
      .set('Idempotency-Key', 'rg-3')
      .send(c.newSaleBody({ payments: [{ method: 'cash', currency: 'LBP', amount: 100000 }] })); // 25,000 change → net +75,000
    const cur = await c.http.get('/api/v1/registers/current').set(auth(cashier));
    expect(find(cur.body.balances, 'cash', 'LBP').expected).toBe(3_000_000 + 75000 + 75000);
  });

  it('a manager cash-out (e.g. wallet top-up) moves money between buckets (US-13)', async () => {
    const res = await c.http
      .post(`/api/v1/registers/${sessionId}/cash-movements`)
      .set(auth(manager))
      .send({
        type: 'transfer',
        from: { method: 'cash', currency: 'LBP' },
        to: { method: 'omt', currency: 'LBP' },
        amount: 200000,
        reason: 'OMT float top-up',
      });
    expect(res.status).toBe(201);
    const cur = await c.http.get('/api/v1/registers/current').set(auth(cashier));
    expect(find(cur.body.balances, 'omt', 'LBP').expected).toBe(1_000_000 + 200000);
    expect(find(cur.body.balances, 'cash', 'LBP').expected).toBe(3_000_000 + 150000 - 200000);
  });

  it('cash-movements require a reason and manager role', async () => {
    const noReason = await c.http
      .post(`/api/v1/registers/${sessionId}/cash-movements`)
      .set(auth(manager))
      .send({ type: 'out', from: { method: 'cash', currency: 'LBP' }, amount: 1000 });
    expect(noReason.status).toBe(400);
    const asCashier = await c.http
      .post(`/api/v1/registers/${sessionId}/cash-movements`)
      .set(auth(cashier))
      .send({ type: 'out', from: { method: 'cash', currency: 'LBP' }, amount: 1000, reason: 'x' });
    expect(asCashier.status).toBe(403);
  });
});

describe('closing the register (Z-report)', () => {
  it('requires a counted amount for every bucket', async () => {
    const res = await c.http.post(`/api/v1/registers/${sessionId}/close`).set(auth(cashier)).send({ countedBalances: [] });
    expect(res.status).toBe(400);
  });

  it('returns expected, counted and variance for cash, Whish and OMT in each currency', async () => {
    const cur = await c.http.get('/api/v1/registers/current').set(auth(cashier));
    const counted = (cur.body.balances as Bal[]).map((b) => ({
      method: b.method,
      currency: b.currency,
      amount: b.method === 'cash' && b.currency === 'LBP' ? b.expected - 10000 : b.expected, // 10,000 short in cash LBP
    }));
    const res = await c.http.post(`/api/v1/registers/${sessionId}/close`).set(auth(cashier)).send({ countedBalances: counted });
    expect(res.status).toBe(200);
    const z = res.body.balances as Bal[];
    expect(z).toHaveLength(6);
    expect(find(z, 'cash', 'LBP').variance).toBe(-10000);
    expect(find(z, 'whish', 'LBP')).toMatchObject({ expected: 575000, counted: 575000, variance: 0 });
    expect(find(z, 'omt', 'LBP')).toMatchObject({ expected: 1_200_000, variance: 0 });
    expect(res.body).toMatchObject({ status: 'closed' });
  });

  it('after closing, no more sales on that session (REGISTER_CLOSED)', async () => {
    const res = await c.http.post('/api/v1/sales').set(auth(cashier)).set('Idempotency-Key', 'rg-after').send(c.newSaleBody());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REGISTER_CLOSED');
  });

  it('the closed Z-report is retrievable by a manager and is immutable', async () => {
    const z = await c.http.get(`/api/v1/reports/register/${sessionId}`).set(auth(manager));
    expect(z.status).toBe(200);
    const again = await c.http.post(`/api/v1/registers/${sessionId}/close`).set(auth(cashier)).send({ countedBalances: [] });
    expect(again.status).toBe(409);
  });

  it('the next session can default its opening balances to the previous closing counts', async () => {
    const res = await c.http.get('/api/v1/registers/suggested-opening').set(auth(cashier));
    expect(res.status).toBe(200);
    expect(find(res.body.balances, 'whish', 'LBP').amount).toBe(575000);
  });
});
