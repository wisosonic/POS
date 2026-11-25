import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startCtx, type TestCtx } from '../helpers/app';
import { walletLedgerCheck } from '../../src/modules/registers/wallets';

// The branch's wallets (docs/13-branch-wallets.md): where they stand, a manager's counts, movements no till caused, the ledger and the
// count history. Counting is never required and never blocks selling. Only managers and admins touch any of it (US-11, US-12, US-13).
let c: TestCtx;
let cashier: string;
let manager: string;
let admin: string;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PRICE = 75_000;

type State = {
  data: {
    method: string;
    currency: string;
    expected: number;
    inSince: number;
    outSince: number;
    lastCount: null | {
      counted: number;
      expected: number | null;
      variance: number | null;
      purpose: string;
      note: string | null;
      countedByName: string;
    };
  }[];
};
const state = async (token = manager) => (await c.http.get(`${api}/wallets`).set(auth(token))).body as State;
const wallet = async (method: string, currency = 'LBP') =>
  (await state()).data.find((w) => w.method === method && w.currency === currency)!;
const allZero = (over: Record<string, number> = {}) =>
  ['whish', 'omt'].flatMap((method) =>
    ['LBP', 'USD'].map((currency) => ({ method, currency, amount: over[`${method}/${currency}`] ?? 0 })),
  );
const count = (balances: object[], extra: object = {}, token = manager) =>
  c.http
    .post(`${api}/wallets/counts`)
    .set(auth(token))
    .send({ balances, ...extra });
const sellWhish = (amount = PRICE) =>
  c.http
    .post(`${api}/sales`)
    .set(auth(cashier))
    .set('Idempotency-Key', randomUUID())
    .send(c.newSaleBody({ payments: [{ method: 'whish', currency: 'LBP', amount }] }));

beforeAll(async () => {
  c = await startCtx();
  cashier = await c.login('cashier');
  manager = await c.login('manager');
  admin = await c.login('admin');
  await c.openRegister(cashier);
});
afterAll(() => c.close());

describe('who may see and count the wallets', () => {
  it('managers and admins only: a cashier is refused every wallet route', async () => {
    for (const [m, p] of [
      ['get', '/wallets'],
      ['get', '/wallets/entries'],
      ['get', '/wallets/counts'],
      ['post', '/wallets/counts'],
      ['post', '/wallets/movements'],
    ] as const)
      expect((await c.http[m](`${api}${p}`).set(auth(cashier)).send({})).status, p).toBe(403);
    expect((await c.http.get(`${api}/wallets`).set(auth(admin))).status).toBe(200);
  });
});

describe('where the wallets stand (GET /wallets)', () => {
  it('lists each wallet in each currency, with nothing counted yet', async () => {
    const s = await state();
    expect(s.data.map((w) => `${w.method}/${w.currency}`).sort()).toEqual(['omt/LBP', 'omt/USD', 'whish/LBP', 'whish/USD']);
    expect(s.data.every((w) => w.expected === 0 && w.lastCount === null)).toBe(true);
    expect(s.data.find((w) => w.method === 'whish')).toMatchObject({ inSince: 0, outSince: 0 });
  });

  it('follows the sales of every till', async () => {
    expect((await sellWhish()).status).toBe(201);
    expect((await sellWhish()).status).toBe(201);
    const w = await wallet('whish');
    expect(w.expected).toBe(2 * PRICE);
    expect(w.inSince).toBe(2 * PRICE);
  });
});

describe('counting the wallets (US-12)', () => {
  it.each<[string, () => object[]]>([
    ['an empty count', () => []],
    ['a wallet missing', () => allZero().slice(1)],
    ['a wallet counted twice', () => [...allZero(), allZero()[0]!]],
    ['cash, which belongs to a till and not to the branch', () => [...allZero(), { method: 'cash', currency: 'LBP', amount: 1 }]],
    ['an unknown method', () => [...allZero().slice(1), { method: 'paypal', currency: 'USD', amount: 1 }]],
    ['a negative amount', () => allZero().map((b, i) => (i === 0 ? { ...b, amount: -1 } : b))],
    ['a fractional amount', () => allZero().map((b, i) => (i === 0 ? { ...b, amount: 1.5 } : b))],
  ])('refuses %s and records nothing', async (_n, make) => {
    const before = (await c.http.get(`${api}/wallets/counts`).set(auth(manager))).body.data.length;
    const res = await count(make());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION');
    expect((await c.http.get(`${api}/wallets/counts`).set(auth(manager))).body.data.length).toBe(before);
  });

  it('the first count sets the baseline: nothing to compare with, so no variance', async () => {
    const res = await count(allZero({ 'whish/LBP': 1_000_000, 'omt/LBP': 500_000 }), { purpose: 'opening', note: 'first reading' });
    expect(res.status).toBe(201);
    expect(res.body.variances).toEqual({});
    const w = await wallet('whish');
    expect(w.expected).toBe(1_000_000); // the baseline replaces what the ledger had added up
    expect(w.lastCount).toMatchObject({ counted: 1_000_000, expected: null, variance: null, purpose: 'opening', note: 'first reading' });
    expect(w.lastCount!.countedByName).toBeTruthy();
    expect(w.inSince).toBe(0);
    expect((await wallet('omt')).expected).toBe(500_000);
  });

  it('a later count records what the ledger expected and how far out it was, and starts again from what was counted', async () => {
    expect((await sellWhish()).status).toBe(201); // +75,000 since the baseline
    expect((await wallet('whish')).expected).toBe(1_075_000);
    const res = await count(allZero({ 'whish/LBP': 1_070_000, 'omt/LBP': 500_000 }), { purpose: 'closing' });
    expect(res.status).toBe(201);
    expect(res.body.variances).toEqual({ 'whish/LBP': -5_000 }); // only what is out
    const w = await wallet('whish');
    expect(w.lastCount).toMatchObject({ counted: 1_070_000, expected: 1_075_000, variance: -5_000, purpose: 'closing' });
    expect(w.expected).toBe(1_070_000); // the count is the truth from now on
    expect(w.inSince).toBe(0);
    expect((await wallet('omt')).lastCount).toMatchObject({ variance: 0 });
  });

  it('never blocks selling: a sale made after a count is recorded and moves the wallet from the counted figure', async () => {
    expect((await sellWhish()).status).toBe(201);
    expect((await wallet('whish')).expected).toBe(1_070_000 + PRICE);
  });

  it('is audited with its variances', async () => {
    const log = await c.http.get(`${api}/audit?action=wallet.count`).set(auth(admin));
    expect(log.body.data.length).toBeGreaterThanOrEqual(2);
    expect(log.body.data[0].after).toMatchObject({ purpose: 'closing', variances: { 'whish/LBP': -5_000 } });
  });

  it('keeps the history of counts, newest first', async () => {
    const h = await c.http.get(`${api}/wallets/counts?method=whish&currency=LBP`).set(auth(manager));
    expect(h.body.data.map((x: { counted: number }) => x.counted)).toEqual([1_070_000, 1_000_000]);
    expect(h.body.data[0]).toMatchObject({ purpose: 'closing', expected: 1_075_000, variance: -5_000 });
    expect(h.body.data[1]).toMatchObject({ purpose: 'opening', expected: null, variance: null });
    const paged = await c.http.get(`${api}/wallets/counts?limit=2`).set(auth(manager));
    expect(paged.body.data).toHaveLength(2);
    expect(paged.body.nextCursor).not.toBeNull();
  });
});

describe('a change no till caused (POST /wallets/movements)', () => {
  const move = (body: object, token = manager) => c.http.post(`${api}/wallets/movements`).set(auth(token)).send(body);

  it('money in and money out change the wallet, say why, and are in the ledger with no till behind them', async () => {
    const before = (await wallet('omt')).expected;
    const inRes = await move({ bucket: { method: 'omt', currency: 'LBP' }, type: 'in', amount: 300_000, reason: 'Top up from the bank' });
    expect(inRes.status).toBe(201);
    expect(inRes.body).toMatchObject({ amount: 300_000, expected: before + 300_000 });
    const outRes = await move({ bucket: { method: 'omt', currency: 'LBP' }, type: 'out', amount: 20_000, reason: 'Provider fee' });
    expect(outRes.body.expected).toBe(before + 280_000);
    const last = (await c.http.get(`${api}/wallets/entries?method=omt&limit=2`).set(auth(manager))).body.data;
    expect(last[0]).toMatchObject({ kind: 'movement', amount: -20_000, reason: 'Provider fee', sessionId: null });
    expect(last[1]).toMatchObject({ kind: 'movement', amount: 300_000, reason: 'Top up from the bank', sessionId: null });
    expect(last[0].userName).toBeTruthy();
    const rows = await walletLedgerCheck(c.app.database);
    expect(rows.filter((r) => r.ledger !== r.derived)).toEqual([]);
  });

  it('may take a wallet below zero (it is bookkeeping, and the count is the truth)', async () => {
    const res = await move({ bucket: { method: 'whish', currency: 'USD' }, type: 'out', amount: 999_999, reason: 'correction' });
    expect(res.status).toBe(201);
    expect((await wallet('whish', 'USD')).expected).toBe(-999_999);
  });

  it.each<[string, object, number, string?]>([
    [
      'cash, which is not a wallet',
      { bucket: { method: 'cash', currency: 'LBP' }, type: 'in', amount: 1, reason: 'x' },
      422,
      'NOT_A_WALLET',
    ],
    ['an unknown method', { bucket: { method: 'paypal', currency: 'LBP' }, type: 'in', amount: 1, reason: 'x' }, 422, 'NOT_A_WALLET'],
    ['no reason', { bucket: { method: 'omt', currency: 'LBP' }, type: 'in', amount: 1 }, 400],
    ['a blank reason', { bucket: { method: 'omt', currency: 'LBP' }, type: 'in', amount: 1, reason: '   ' }, 400],
    ['a zero amount', { bucket: { method: 'omt', currency: 'LBP' }, type: 'in', amount: 0, reason: 'x' }, 400],
    ['a fractional amount', { bucket: { method: 'omt', currency: 'LBP' }, type: 'out', amount: 1.5, reason: 'x' }, 400],
    ['a type that does not exist', { bucket: { method: 'omt', currency: 'LBP' }, type: 'swap', amount: 1, reason: 'x' }, 400],
  ])('refuses %s', async (_n, body, status, code) => {
    const before = (await wallet('omt')).expected;
    const res = await move(body);
    expect(res.status).toBe(status);
    if (code) expect(res.body.code).toBe(code);
    expect((await wallet('omt')).expected).toBe(before);
  });
});

describe('the ledger (GET /wallets/entries)', () => {
  it('lists every entry newest first with its cause, and filters and pages', async () => {
    const all = (await c.http.get(`${api}/wallets/entries?limit=200`).set(auth(manager))).body;
    expect(all.data.length).toBeGreaterThan(5);
    const ids = all.data.map((e: { id: number }) => e.id);
    expect([...ids].sort((a, b) => b - a)).toEqual(ids);
    expect(all.data.find((e: { kind: string }) => e.kind === 'sale')).toMatchObject({ refType: 'sale', method: 'whish', currency: 'LBP' });
    const whishLbp = (await c.http.get(`${api}/wallets/entries?method=whish&currency=LBP&limit=200`).set(auth(manager))).body.data;
    expect(whishLbp.every((e: { method: string; currency: string }) => e.method === 'whish' && e.currency === 'LBP')).toBe(true);
    const first = (await c.http.get(`${api}/wallets/entries?limit=2`).set(auth(manager))).body;
    expect(first.data).toHaveLength(2);
    const next = (await c.http.get(`${api}/wallets/entries?limit=2&cursor=${first.nextCursor}`).set(auth(manager))).body;
    expect(next.data[0].id).toBeLessThan(first.data[1].id);
    expect((await c.http.get(`${api}/wallets/entries?limit=0`).set(auth(manager))).status).toBe(400);
  });
});

describe('the Z-report shows what a till did to the wallets, as information (US-12)', () => {
  it('has a wallets block with sales, refunds and movements per wallet, and no expected or counted figure', async () => {
    const cur = (await c.http.get(`${api}/registers/current`).set(auth(cashier))).body;
    const sale = await sellWhish();
    await c.http
      .post(`${api}/returns`)
      .set(auth(manager))
      .set('Idempotency-Key', randomUUID())
      .send({
        saleId: sale.body.id,
        items: [{ saleItemId: sale.body.items[0].id, qty: '1' }],
        reason: 'test',
        refund: { method: 'whish', currency: 'LBP', amount: PRICE },
      });
    await c.http
      .post(`${api}/registers/${cur.id}/cash-movements`)
      .set(auth(manager))
      .send({
        type: 'transfer',
        from: { method: 'cash', currency: 'LBP' },
        to: { method: 'omt', currency: 'LBP' },
        amount: 100_000,
        reason: 'float',
      });
    const z = (await c.http.get(`${api}/reports/register/${cur.id}`).set(auth(manager))).body;
    const whish = z.wallets.find((w: { method: string; currency: string }) => w.method === 'whish' && w.currency === 'LBP');
    expect(whish).toMatchObject({ refundsOut: PRICE, correctionsNet: 0 });
    expect(whish.salesIn).toBeGreaterThanOrEqual(PRICE * 3);
    expect(whish.net).toBe(whish.salesIn - whish.refundsOut);
    expect(z.wallets.find((w: { method: string }) => w.method === 'omt')).toMatchObject({ movementsNet: 100_000 });
    expect(whish).not.toHaveProperty('expected');
    expect(whish).not.toHaveProperty('counted');
    expect(z.balances.every((b: { method: string }) => b.method === 'cash')).toBe(true);
  });
});
