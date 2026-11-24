import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startCtx, type TestCtx } from '../helpers/app';

// The register (US-11, US-12, US-13): opening balances per method and currency, movements between balances, and a
// Z-report whose every figure can be derived by hand. One till, so one open session at a time.
let c: TestCtx;
let cashier: string;
let manager: string;
let admin: string;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

type Bal = { method: string; currency: string; opening: number; expected: number; counted?: number | null; variance?: number | null };
type Z = Bal & { salesIn: number; changeOut: number; customerPaymentsIn: number; refundsOut: number; movementsNet: number };
const find = <T extends { method: string; currency: string }>(list: T[], method: string, currency: string) =>
  list.find((b) => b.method === method && b.currency === currency)!;

const OPENING = [
  { method: 'cash', currency: 'USD', amount: 7000 },
  { method: 'cash', currency: 'LBP', amount: 3_000_000 },
  { method: 'whish', currency: 'USD', amount: 1000 },
  { method: 'whish', currency: 'LBP', amount: 500_000 },
  { method: 'omt', currency: 'USD', amount: 2000 },
  { method: 'omt', currency: 'LBP', amount: 1_000_000 },
];
const open = (token: string, body: Record<string, unknown> = { openingBalances: OPENING }) =>
  c.http.post(`${api}/registers/open`).set(auth(token)).send(body);
const current = (token = cashier) => c.http.get(`${api}/registers/current`).set(auth(token));
const sell = (over: Record<string, unknown> = {}, token = cashier) =>
  c.http.post(`${api}/sales`).set(auth(token)).set('Idempotency-Key', randomUUID()).send(c.newSaleBody(over));
const moveMoney = (sessionId: number, body: Record<string, unknown>, token = manager) =>
  c.http.post(`${api}/registers/${sessionId}/cash-movements`).set(auth(token)).send(body);
const closeWith = (sessionId: number, counted: { method: string; currency: string; amount: number }[], token = cashier) =>
  c.http.post(`${api}/registers/${sessionId}/close`).set(auth(token)).send({ countedBalances: counted });
const exactCount = (balances: Bal[]) => balances.map((b) => ({ method: b.method, currency: b.currency, amount: b.expected }));

beforeAll(async () => {
  c = await startCtx();
  cashier = await c.login('cashier');
  manager = await c.login('manager');
  admin = await c.login('admin');
});
afterAll(() => c.close());

describe('before anything is open', () => {
  it('there is no current register, and the suggestion is all zeros', async () => {
    const res = await current();
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NO_OPEN_REGISTER');
    const hint = await c.http.get(`${api}/registers/suggested-opening`).set(auth(cashier));
    expect(hint.body.source).toBe('default');
    expect(hint.body.balances).toHaveLength(6);
    expect(hint.body.balances.every((b: { amount: number }) => b.amount === 0)).toBe(true);
  });

  it.each<[string, () => Record<string, unknown>]>([
    ['no balances at all', () => ({})],
    ['an unknown currency', () => ({ openingBalances: OPENING.map((b, i) => (i === 0 ? { ...b, currency: 'EUR' } : b)) })],
    ['a negative amount', () => ({ openingBalances: OPENING.map((b, i) => (i === 1 ? { ...b, amount: -1 } : b)) })],
    ['a fractional amount', () => ({ openingBalances: OPENING.map((b, i) => (i === 1 ? { ...b, amount: 10.5 } : b)) })],
    ['a balance listed twice', () => ({ openingBalances: [...OPENING, OPENING[0]] })],
    ['a method that does not exist', () => ({ openingBalances: [...OPENING.slice(1), { method: 'paypal', currency: 'USD', amount: 1 }] })],
    ['one balance missing', () => ({ openingBalances: OPENING.slice(1) })],
  ])('refuses %s', async (_n, body) => {
    const res = await open(cashier, body());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION');
    expect(await current()).toMatchObject({ status: 404 }); // nothing was opened
  });

  it('the till is closed, so a sale is refused', async () => {
    const res = await sell();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REGISTER_CLOSED');
  });

  it('a token is required', async () => {
    expect((await c.http.post(`${api}/registers/open`).send({ openingBalances: OPENING })).status).toBe(401);
    expect((await c.http.get(`${api}/registers/current`)).status).toBe(401);
  });
});

describe('opening', () => {
  let sessionId: number;

  it('two simultaneous attempts open exactly one register', async () => {
    const [a, b] = await Promise.all([open(cashier), open(manager)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    sessionId = [a, b].find((r) => r.status === 201)!.body.id;
  });

  it('defaults the terminal to T1 and records who opened it and when', async () => {
    const res = await current();
    expect(res.body).toMatchObject({ id: sessionId, terminalId: 'T1', status: 'open' });
    expect([c.seed.users.cashier.id, c.seed.users.manager.id]).toContain(res.body.openedBy);
    expect(new Date(res.body.openedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('starts every expected balance at its opening amount', async () => {
    const res = await current();
    expect(res.body.balances).toHaveLength(6);
    for (const b of res.body.balances as Bal[]) expect(b.expected).toBe(b.opening);
    expect(find(res.body.balances as Bal[], 'cash', 'LBP').opening).toBe(3_000_000);
  });

  it('a second open is refused whatever the body, with a clear code', async () => {
    for (const body of [{ openingBalances: OPENING }, { openingBalances: [] }, {}]) {
      const res = await open(manager, body);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('REGISTER_ALREADY_OPEN');
    }
  });

  it('is audited', async () => {
    const log = await c.http.get(`${api}/audit?action=register.open&entityId=${sessionId}`).set(auth(admin));
    expect(log.body.data).toHaveLength(1);
  });
});

describe('a known day: every Z-report figure derived by hand', () => {
  let sessionId: number;
  let firstSale: { id: number; items: { id: number }[] };

  it('runs a day of sales, an account payment, a refund and a transfer', async () => {
    sessionId = (await current()).body.id;

    // 1. cash LBP sale with change: received 100,000 for 75,000, so 25,000 goes back
    const s1 = await sell({ payments: [{ method: 'cash', currency: 'LBP', amount: 100000 }] });
    firstSale = s1.body;
    // 2. Whish sale
    await sell({ payments: [{ method: 'whish', currency: 'LBP', amount: 75000 }] });
    // 3. USD product ($2.50 = 225,000 LBP) paid with $3.00 cash = 270,000 LBP: 45,000 LBP change
    await sell({
      items: [{ productId: c.seed.products.usd.id, qty: '1', unitPriceLbp: 225000 }],
      payments: [{ method: 'cash', currency: 'USD', amount: 300 }],
    });
    // 4. on credit, then 20,000 paid on the account through OMT
    const credit = c.seed.customers.registered.id;
    await sell({ customerId: credit, payments: [] });
    const pay = await c.http
      .post(`${api}/customers/${credit}/payments`)
      .set(auth(cashier))
      .set('Idempotency-Key', randomUUID())
      .send({ method: 'omt', currency: 'LBP', amount: 20000 });
    expect(pay.status).toBe(201);
    // 5. the first sale's towel comes back: 75,000 refunded in cash
    const ret = await c.http
      .post(`${api}/returns`)
      .set(auth(manager))
      .set('Idempotency-Key', randomUUID())
      .send({
        saleId: firstSale.id,
        items: [{ saleItemId: firstSale.items[0]!.id, qty: '1' }],
        refund: { method: 'cash', currency: 'LBP', amount: 75000 },
      });
    expect(ret.status).toBe(201);
    // 6. 200,000 of cash is moved into the OMT float
    const move = await moveMoney(sessionId, {
      type: 'transfer',
      from: { method: 'cash', currency: 'LBP' },
      to: { method: 'omt', currency: 'LBP' },
      amount: 200000,
      reason: 'OMT float',
    });
    expect(move.status).toBe(201);
  });

  it('the live balances equal opening + received - change + account payments - refunds ± movements', async () => {
    const live = (await current()).body.balances as Bal[];
    // cash LBP: 3,000,000 + 100,000 - (25,000 + 45,000) - 75,000 - 200,000
    expect(find(live, 'cash', 'LBP').expected).toBe(2_755_000);
    expect(find(live, 'cash', 'USD').expected).toBe(7300);
    expect(find(live, 'whish', 'LBP').expected).toBe(575_000);
    expect(find(live, 'omt', 'LBP').expected).toBe(1_220_000); // + 20,000 account payment + 200,000 transfer
    expect(find(live, 'whish', 'USD').expected).toBe(1000);
    expect(find(live, 'omt', 'USD').expected).toBe(2000);
  });

  it('the Z-report shows where each figure came from', async () => {
    const z = await c.http.get(`${api}/reports/register/${sessionId}`).set(auth(manager));
    const cashLbp = find(z.body.balances as Z[], 'cash', 'LBP');
    expect(cashLbp).toMatchObject({
      opening: 3_000_000,
      salesIn: 100000,
      changeOut: 70000,
      customerPaymentsIn: 0,
      refundsOut: 75000,
      movementsNet: -200000,
      expected: 2_755_000,
    });
    expect(find(z.body.balances as Z[], 'omt', 'LBP')).toMatchObject({
      customerPaymentsIn: 20000,
      movementsNet: 200000,
      expected: 1_220_000,
    });
    expect(find(z.body.balances as Z[], 'cash', 'USD')).toMatchObject({ salesIn: 300, changeOut: 0, expected: 7300 });
    expect(find(z.body.balances as Z[], 'whish', 'LBP')).toMatchObject({ salesIn: 75000, expected: 575_000 });
  });

  it('and the session totals', async () => {
    const z = await c.http.get(`${api}/reports/register/${sessionId}`).set(auth(manager));
    expect(z.body.totals).toMatchObject({
      salesCount: 4,
      salesTotalLbp: 75000 + 75000 + 225000 + 75000,
      owedOnAccountLbp: 55000, // 75,000 on credit less the 20,000 paid
      customerPaymentsCount: 1,
      refundsCount: 1,
      movementsCount: 1,
    });
  });

  it('closing with a count that is over in one balance and short in another reports both variances', async () => {
    const live = (await current()).body.balances as Bal[];
    const counted = exactCount(live).map((b) => {
      if (b.method === 'omt' && b.currency === 'LBP') return { ...b, amount: b.amount - 5000 }; // short
      if (b.method === 'cash' && b.currency === 'USD') return { ...b, amount: b.amount + 100 }; // over by $1
      return b;
    });
    const res = await closeWith(sessionId, counted);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'closed', closedBy: c.seed.users.cashier.id });
    expect(res.body.closedAt).toBeTruthy();
    const z = res.body.balances as Bal[];
    expect(find(z, 'omt', 'LBP')).toMatchObject({ expected: 1_220_000, counted: 1_215_000, variance: -5000 });
    expect(find(z, 'cash', 'USD')).toMatchObject({ expected: 7300, counted: 7400, variance: 100 });
    expect(find(z, 'cash', 'LBP').variance).toBe(0);
  });

  it('writes the variances to the audit log', async () => {
    const log = await c.http.get(`${api}/audit?action=register.close&entityId=${sessionId}`).set(auth(admin));
    expect(log.body.data[0].after.variances).toEqual({ 'cash/USD': 100, 'omt/LBP': -5000 });
  });

  it('the closed Z-report is frozen: asking again gives the same figures', async () => {
    const a = await c.http.get(`${api}/reports/register/${sessionId}`).set(auth(manager));
    const b = await c.http.get(`${api}/reports/register/${sessionId}`).set(auth(manager));
    expect(b.body).toEqual(a.body);
    expect(find(a.body.balances as Z[], 'omt', 'LBP')).toMatchObject({ counted: 1_215_000, variance: -5000 });
  });

  it('after closing there is no current register and nothing can be added to it', async () => {
    expect((await current()).status).toBe(404);
    const move = await moveMoney(sessionId, { type: 'in', to: { method: 'cash', currency: 'LBP' }, amount: 1000, reason: 'late' });
    expect(move.status).toBe(409);
    expect(move.body.code).toBe('REGISTER_ALREADY_CLOSED');
    expect(
      (await closeWith(sessionId, exactCount((await c.http.get(`${api}/reports/register/${sessionId}`).set(auth(manager))).body.balances)))
        .status,
    ).toBe(409);
  });
});

describe('the next day', () => {
  it('offers the last counts as the new opening, and a new session is a new session', async () => {
    const hint = await c.http.get(`${api}/registers/suggested-opening`).set(auth(cashier));
    expect(hint.body.source).toBe('last-close');
    expect(find(hint.body.balances as { method: string; currency: string; amount: number }[], 'omt', 'LBP').amount).toBe(1_215_000);

    const reopened = await open(cashier, { openingBalances: hint.body.balances });
    expect(reopened.status).toBe(201);
    const oldId = hint.body.sessionId as number;
    expect(reopened.body.id).not.toBe(oldId);
    expect(find(reopened.body.balances as Bal[], 'cash', 'USD').opening).toBe(7400);
  });

  it('new sales go to the new session and leave the old report untouched', async () => {
    const oldZ = (await c.http.get(`${api}/registers`).set(auth(manager))).body.data.find((s: { status: string }) => s.status === 'closed');
    const sale = await sell();
    expect(sale.body.sessionId).toBe((await current()).body.id);
    expect(sale.body.sessionId).not.toBe(oldZ.id);
    const after = await c.http.get(`${api}/reports/register/${oldZ.id}`).set(auth(manager));
    expect(find(after.body.balances as Z[], 'cash', 'LBP').expected).toBe(2_755_000);
  });

  it('history lists sessions newest first, for managers only', async () => {
    const res = await c.http.get(`${api}/registers`).set(auth(manager));
    expect(res.body.data.length).toBe(2);
    expect(res.body.data[0].id).toBeGreaterThan(res.body.data[1].id);
    expect(res.body.data[1].balances.every((b: Bal) => typeof b.counted === 'number')).toBe(true);
    expect((await c.http.get(`${api}/registers`).set(auth(cashier))).status).toBe(403);
  });
});

describe('cash movements (US-13)', () => {
  let sessionId: number;
  beforeAll(async () => {
    sessionId = (await current()).body.id;
  });
  const bal = async (method: string, currency: string) => find((await current()).body.balances as Bal[], method, currency).expected;

  it('money in raises one balance; money out lowers one', async () => {
    const cash0 = await bal('cash', 'LBP');
    await moveMoney(sessionId, { type: 'in', to: { method: 'cash', currency: 'LBP' }, amount: 10000, reason: 'owner topped up the till' });
    expect(await bal('cash', 'LBP')).toBe(cash0 + 10000);
    await moveMoney(sessionId, { type: 'out', from: { method: 'cash', currency: 'LBP' }, amount: 4000, reason: 'bought bags' });
    expect(await bal('cash', 'LBP')).toBe(cash0 + 6000);
  });

  it('a transfer moves value between balances and the total is unchanged', async () => {
    const [a0, b0] = [await bal('cash', 'USD'), await bal('omt', 'USD')];
    await moveMoney(sessionId, {
      type: 'transfer',
      from: { method: 'cash', currency: 'USD' },
      to: { method: 'omt', currency: 'USD' },
      amount: 500,
      reason: 'top up OMT',
    });
    expect(await bal('cash', 'USD')).toBe(a0 - 500);
    expect(await bal('omt', 'USD')).toBe(b0 + 500);
  });

  it('may take a balance below zero: it is bookkeeping, and the count at closing is the truth', async () => {
    const res = await moveMoney(sessionId, {
      type: 'out',
      from: { method: 'whish', currency: 'USD' },
      amount: 999_999,
      reason: 'correction',
    });
    expect(res.status).toBe(201);
    expect(await bal('whish', 'USD')).toBeLessThan(0);
    await moveMoney(sessionId, { type: 'in', to: { method: 'whish', currency: 'USD' }, amount: 999_999, reason: 'undo correction' });
  });

  it.each<[string, Record<string, unknown>, number, string?]>([
    [
      'a transfer to the same balance',
      { type: 'transfer', from: { method: 'cash', currency: 'LBP' }, to: { method: 'cash', currency: 'LBP' }, amount: 1, reason: 'x' },
      422,
      'SAME_BUCKET',
    ],
    [
      'a transfer across currencies',
      { type: 'transfer', from: { method: 'cash', currency: 'USD' }, to: { method: 'omt', currency: 'LBP' }, amount: 1, reason: 'x' },
      422,
      'CURRENCY_MISMATCH',
    ],
    [
      '"in" with a source',
      { type: 'in', from: { method: 'cash', currency: 'LBP' }, to: { method: 'cash', currency: 'LBP' }, amount: 1, reason: 'x' },
      400,
    ],
    ['"in" without a destination', { type: 'in', amount: 1, reason: 'x' }, 400],
    [
      '"out" with a destination',
      { type: 'out', from: { method: 'cash', currency: 'LBP' }, to: { method: 'omt', currency: 'LBP' }, amount: 1, reason: 'x' },
      400,
    ],
    ['a transfer without a destination', { type: 'transfer', from: { method: 'cash', currency: 'LBP' }, amount: 1, reason: 'x' }, 400],
    ['an unknown method', { type: 'out', from: { method: 'paypal', currency: 'LBP' }, amount: 1, reason: 'x' }, 400],
    ['a zero amount', { type: 'out', from: { method: 'cash', currency: 'LBP' }, amount: 0, reason: 'x' }, 400],
    ['a negative amount', { type: 'out', from: { method: 'cash', currency: 'LBP' }, amount: -5, reason: 'x' }, 400],
    ['a fractional amount', { type: 'out', from: { method: 'cash', currency: 'LBP' }, amount: 1.5, reason: 'x' }, 400],
    ['a blank reason', { type: 'out', from: { method: 'cash', currency: 'LBP' }, amount: 1, reason: '   ' }, 400],
    ['a reason that is too long', { type: 'out', from: { method: 'cash', currency: 'LBP' }, amount: 1, reason: 'x'.repeat(201) }, 400],
  ])('refuses %s', async (_n, body, status, code) => {
    const before = await bal('cash', 'LBP');
    const res = await moveMoney(sessionId, body);
    expect(res.status).toBe(status);
    if (code) expect(res.body.code).toBe(code);
    expect(await bal('cash', 'LBP')).toBe(before);
  });

  it('only managers may move money, and the session must exist', async () => {
    const body = { type: 'out', from: { method: 'cash', currency: 'LBP' }, amount: 1, reason: 'x' };
    expect((await moveMoney(sessionId, body, cashier)).status).toBe(403);
    expect((await c.http.post(`${api}/registers/${sessionId}/cash-movements`).send(body)).status).toBe(401);
    expect((await moveMoney(999999, body)).status).toBe(404);
  });

  it('each movement is audited with its reason', async () => {
    const log = await c.http.get(`${api}/audit?action=register.cash-movement&entityId=${sessionId}`).set(auth(admin));
    expect(log.body.data.map((r: { after: { reason: string } }) => r.after.reason)).toEqual(
      expect.arrayContaining(['bought bags', 'top up OMT']),
    );
  });
});

describe('closing: the count must cover every balance', () => {
  let sessionId: number;
  beforeAll(async () => {
    sessionId = (await current()).body.id;
  });
  const exact = async () => exactCount((await current()).body.balances as Bal[]);

  it.each<[string, (e: { method: string; currency: string; amount: number }[]) => unknown[]]>([
    ['an empty count', () => []],
    ['one balance missing', (e) => e.slice(1)],
    ['a balance counted twice', (e) => [...e, e[0]]],
    ['an unknown balance', (e) => [...e.slice(1), { method: 'paypal', currency: 'USD', amount: 1 }]],
    ['a negative count', (e) => e.map((b, i) => (i === 0 ? { ...b, amount: -1 } : b))],
    ['a fractional count', (e) => e.map((b, i) => (i === 0 ? { ...b, amount: 1.5 } : b))],
  ])('refuses %s and the register stays open', async (_n, mutate) => {
    const res = await c.http
      .post(`${api}/registers/${sessionId}/close`)
      .set(auth(cashier))
      .send({ countedBalances: mutate(await exact()) });
    expect(res.status).toBe(400);
    expect((await current()).status).toBe(200);
  });

  it('a missing session is 404 and a token is required', async () => {
    expect((await closeWith(999999, await exact())).status).toBe(404);
    expect((await c.http.post(`${api}/registers/${sessionId}/close`).send({ countedBalances: await exact() })).status).toBe(401);
  });

  it('a perfect count has zero variance everywhere', async () => {
    const res = await closeWith(sessionId, await exact());
    expect(res.status).toBe(200);
    expect((res.body.balances as Bal[]).every((b) => b.variance === 0)).toBe(true);
  });

  it('the Z-report is for managers only', async () => {
    expect((await c.http.get(`${api}/reports/register/${sessionId}`).set(auth(cashier))).status).toBe(403);
    expect((await c.http.get(`${api}/reports/register/999999`).set(auth(manager))).status).toBe(404);
  });
});
