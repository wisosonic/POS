import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startCtx, type TestCtx } from '../helpers/app';
import { bumpExpected, walletBuckets } from '../../src/modules/registers/service';
import { walletBalances, walletLedgerCheck } from '../../src/modules/registers/wallets';

// Cash belongs to each till, Whish and OMT belong to the branch (docs/13-branch-wallets.md; US-11 open, US-12 close, US-13 movements).
// A till's register holds cash only; every wallet movement is one row in the branch's wallet ledger, written in the same transaction as
// what caused it, and the ledger always equals what the underlying rows say (walletLedgerCheck).
let c: TestCtx;
let cashier: string;
let manager: string;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PRICE = 75_000;

const sell = (payments: { method: string; currency: string; amount: number }[], over: Record<string, unknown> = {}, token = cashier) =>
  c.http
    .post(`${api}/sales`)
    .set(auth(token))
    .set('Idempotency-Key', randomUUID())
    .send(c.newSaleBody({ payments, ...over }));
const whish = (amount = PRICE) => [{ method: 'whish', currency: 'LBP', amount }];
const entries = async () =>
  await c.app.database.all<{
    method: string;
    currency: string;
    amount: number;
    kind: string;
    ref_type: string | null;
    ref_id: number | null;
    session_id: number | null;
    reason: string | null;
  }>('SELECT method, currency, amount, kind, ref_type, ref_id, session_id, reason FROM wallet_entries ORDER BY id');
const wallets = async () => walletBalances(c.app.database, await walletBuckets(c.app.database));
const balance = async (method: string, currency = 'LBP') => (await wallets()).find((b) => b.method === method && b.currency === currency)!;
const cashExpected = async (currency = 'LBP') => {
  const cur = await c.http.get(`${api}/registers/current`).set(auth(cashier));
  return (cur.body.balances as { method: string; currency: string; expected: number }[]).find(
    (b) => b.method === 'cash' && b.currency === currency,
  )!.expected;
};
const ledgerAgrees = async () => {
  const rows = await walletLedgerCheck(c.app.database);
  expect(
    rows.filter((r) => r.ledger !== r.derived),
    JSON.stringify(rows),
  ).toEqual([]);
};

beforeAll(async () => {
  c = await startCtx();
  cashier = await c.login('cashier');
  manager = await c.login('manager');
  await c.openRegister(cashier);
});
afterAll(() => c.close());

describe('a till holds cash only (US-11, US-12)', () => {
  it('has two balances, both cash, and suggests nothing else', async () => {
    const cur = await c.http.get(`${api}/registers/current`).set(auth(cashier));
    expect(cur.body.balances.map((b: { method: string; currency: string }) => `${b.method}/${b.currency}`).sort()).toEqual([
      'cash/LBP',
      'cash/USD',
    ]);
    const hint = await c.http.get(`${api}/registers/suggested-opening`).set(auth(cashier));
    expect(hint.body.balances.map((b: { method: string }) => b.method)).toEqual(['cash', 'cash']);
  });

  it("refuses a wallet balance at opening and at closing, saying it is not this register's", async () => {
    const cur = (await c.http.get(`${api}/registers/current`).set(auth(cashier))).body;
    const closeWith = (extra: object[]) =>
      c.http
        .post(`${api}/registers/${cur.id}/close`)
        .set(auth(cashier))
        .send({
          countedBalances: [{ method: 'cash', currency: 'LBP', amount: 0 }, { method: 'cash', currency: 'USD', amount: 0 }, ...extra],
        });
    const res = await closeWith([{ method: 'whish', currency: 'LBP', amount: 1 }]);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('whish/LBP is not a balance of this register');
  });

  it('knows who holds each method: cash the till, Whish and OMT the branch', async () => {
    const rows = await c.app.database.all<{ code: string; holder: string }>('SELECT code, holder FROM payment_methods ORDER BY code');
    expect(rows).toEqual([
      { code: 'cash', holder: 'till' },
      { code: 'omt', holder: 'branch' },
      { code: 'whish', holder: 'branch' },
    ]);
  });
});

describe('a sale paid by a wallet moves the branch wallet, not the till (US-04)', () => {
  it("writes one ledger entry with its cause, and leaves the till's cash alone", async () => {
    const cashBefore = await cashExpected();
    const sale = await sell(whish());
    expect(sale.status).toBe(201);
    expect((await entries()).at(-1)).toMatchObject({
      method: 'whish',
      currency: 'LBP',
      amount: PRICE,
      kind: 'sale',
      ref_type: 'sale',
      ref_id: sale.body.id,
    });
    expect((await entries()).at(-1)!.session_id).not.toBeNull();
    expect(await cashExpected()).toBe(cashBefore);
    expect((await balance('whish')).expected).toBe(PRICE);
    expect((await balance('omt')).expected).toBe(0);
    await ledgerAgrees();
  });

  it('a replay of the same sale writes no second entry', async () => {
    const key = randomUUID();
    const body = c.newSaleBody({ payments: whish() });
    const before = (await entries()).length;
    await c.http.post(`${api}/sales`).set(auth(cashier)).set('Idempotency-Key', key).send(body);
    await c.http.post(`${api}/sales`).set(auth(cashier)).set('Idempotency-Key', key).send(body);
    expect((await entries()).length).toBe(before + 1);
    await ledgerAgrees();
  });

  it('a mixed payment (cash and a wallet) splits correctly', async () => {
    const cashBefore = await cashExpected();
    const walletBefore = (await balance('omt')).expected;
    expect(
      (
        await sell([
          { method: 'cash', currency: 'LBP', amount: 25_000 },
          { method: 'omt', currency: 'LBP', amount: 50_000 },
        ])
      ).status,
    ).toBe(201);
    expect(await cashExpected()).toBe(cashBefore + 25_000);
    expect((await balance('omt')).expected).toBe(walletBefore + 50_000);
    await ledgerAgrees();
  });

  it('closing the till does not touch the wallets, and the next till session sees the same balance', async () => {
    const before = await wallets();
    const was = before.find((b) => b.method === 'whish' && b.currency === 'LBP')!.expected;
    const cur = (await c.http.get(`${api}/registers/current`).set(auth(cashier))).body;
    const counted = cur.balances.map((b: { method: string; currency: string; expected: number }) => ({
      method: b.method,
      currency: b.currency,
      amount: b.expected,
    }));
    expect((await c.http.post(`${api}/registers/${cur.id}/close`).set(auth(cashier)).send({ countedBalances: counted })).status).toBe(200);
    expect(await wallets()).toEqual(before);
    await c.openRegister(cashier);
    expect(await wallets()).toEqual(before);
    expect((await sell(whish())).status).toBe(201);
    expect((await balance('whish')).expected).toBe(was + PRICE);
    await ledgerAgrees();
  });
});

describe('cancelling, returning and deleting keep the ledger honest (US-14)', () => {
  it('a cancelled sale adds a correction and never edits the entry it undoes', async () => {
    const before = await balance('whish');
    const sale = await sell(whish());
    const first = (await entries()).at(-1)!;
    const voided = await c.http
      .post(`${api}/sales/${sale.body.id}/void`)
      .set(auth(manager))
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'test' });
    expect(voided.status).toBe(200);
    expect((await entries()).at(-1)).toMatchObject({ amount: -PRICE, kind: 'correction', ref_id: sale.body.id });
    expect((await entries()).at(-1)!.reason).toBeTruthy();
    expect((await entries()).find((e) => e.ref_id === sale.body.id && e.kind === 'sale')).toMatchObject(first);
    expect((await balance('whish')).expected).toBe(before.expected);
    await ledgerAgrees();
  });

  it('a refund paid back through a wallet takes it out of that wallet', async () => {
    const sale = await sell(whish());
    const before = (await balance('whish')).expected;
    const ret = await c.http
      .post(`${api}/returns`)
      .set(auth(manager))
      .set('Idempotency-Key', randomUUID())
      .send({
        saleId: sale.body.id,
        items: [{ saleItemId: sale.body.items[0].id, qty: '1' }],
        reason: 'test',
        refund: { method: 'whish', currency: 'LBP', amount: PRICE },
      });
    expect(ret.status).toBe(201);
    expect((await entries()).at(-1)).toMatchObject({ amount: -PRICE, kind: 'refund', ref_type: 'return' });
    expect((await balance('whish')).expected).toBe(before - PRICE);
    await ledgerAgrees();
  });

  it('deleting a sale for good takes its wallet payment and its wallet refund back with corrections', async () => {
    const sale = await sell(whish());
    const before = (await balance('whish')).expected; // includes the sale
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
    const afterRefund = (await balance('whish')).expected;
    expect(afterRefund).toBe(before - PRICE);
    const n = (await entries()).length;
    const gone = await c.http
      .post(`${api}/sales/${sale.body.id}/delete`)
      .set(auth(manager))
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'entered by mistake' });
    expect(gone.status).toBe(200);
    // two corrections: the sale's payment goes (-75,000), the refund is undone (+75,000)
    expect(
      (await entries())
        .slice(n)
        .map((e) => [e.kind, e.amount])
        .sort(),
    ).toEqual(
      [
        ['correction', -PRICE],
        ['correction', PRICE],
      ].sort(),
    );
    expect((await balance('whish')).expected).toBe(before - PRICE);
    await ledgerAgrees();
  });
});

describe('everything else that moves a wallet (US-13, US-31)', () => {
  it('a customer paying their account through a wallet', async () => {
    const who = (await c.http.post(`${api}/customers`).set(auth(cashier)).send({ name: 'Wallet Payer' })).body as { id: number };
    expect((await sell([], { customerId: who.id })).status).toBe(201); // all on account
    const before = (await balance('omt')).expected;
    const paid = await c.http
      .post(`${api}/customers/${who.id}/payments`)
      .set(auth(cashier))
      .set('Idempotency-Key', randomUUID())
      .send({ method: 'omt', currency: 'LBP', amount: 40_000 });
    expect(paid.status).toBe(201);
    expect((await entries()).at(-1)).toMatchObject({
      method: 'omt',
      amount: 40_000,
      kind: 'customer_payment',
      ref_type: 'customer_payment',
    });
    expect((await balance('omt')).expected).toBe(before + 40_000);
    await ledgerAgrees();
  });

  it('moving cash into a wallet: the till loses cash, the branch wallet gains, one reason on both', async () => {
    const cur = (await c.http.get(`${api}/registers/current`).set(auth(cashier))).body;
    const cashBefore = await cashExpected();
    const before = (await balance('whish')).expected;
    const moved = await c.http
      .post(`${api}/registers/${cur.id}/cash-movements`)
      .set(auth(manager))
      .send({
        type: 'transfer',
        from: { method: 'cash', currency: 'LBP' },
        to: { method: 'whish', currency: 'LBP' },
        amount: 200_000,
        reason: 'Top up the Whish float',
      });
    expect(moved.status).toBe(201);
    expect(await cashExpected()).toBe(cashBefore - 200_000);
    expect((await balance('whish')).expected).toBe(before + 200_000);
    expect((await entries()).at(-1)).toMatchObject({
      kind: 'movement',
      ref_type: 'register_movement',
      amount: 200_000,
      reason: 'Top up the Whish float',
    });
    await ledgerAgrees();
  });

  it('an expense paid from a wallet takes it out of that wallet, and says why', async () => {
    const before = (await balance('whish')).expected;
    const res = await c.http
      .post(`${api}/expenses`)
      .set(auth(manager))
      .send({ title: 'Courier', amountMinor: 15_000, currency: 'LBP', reference: '', payFrom: { method: 'whish' } });
    expect(res.status).toBe(201);
    expect((await entries()).at(-1)).toMatchObject({ kind: 'movement', amount: -15_000 });
    expect((await entries()).at(-1)!.reason).toContain('Courier');
    expect((await balance('whish')).expected).toBe(before - 15_000);
    await ledgerAgrees();
  });

  it('a wallet cannot be changed without saying why (the code refuses it, and so does the database)', async () => {
    const session = (await c.http.get(`${api}/registers/current`).set(auth(cashier))).body.id as number;
    await expect(bumpExpected(c.app.database, session, { method: 'whish', currency: 'LBP' }, 100)).rejects.toThrow(/needs its cause/);
    await expect(
      c.app.database.run(
        `INSERT INTO wallet_entries (method, currency, amount, kind, created_at) VALUES ('whish', 'LBP', 5, 'movement', 'x')`,
      ),
    ).rejects.toThrow();
  });
});

describe('wallet sales from many tills at once (docs/13 §9)', () => {
  it('loses and doubles nothing: 25 sales at the same moment add exactly 25 entries', async () => {
    const before = await balance('omt');
    const n = (await entries()).length;
    const results = await Promise.all(Array.from({ length: 25 }, () => sell([{ method: 'omt', currency: 'LBP', amount: PRICE }])));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect((await entries()).length).toBe(n + 25);
    expect((await balance('omt')).expected).toBe(before.expected + 25 * PRICE);
    await ledgerAgrees();
  });
});

describe('the ledger is append-only', () => {
  it('refuses to change or remove an entry', async () => {
    await expect(c.app.database.run(`UPDATE wallet_entries SET amount = amount + 1 WHERE id = 1`)).rejects.toThrow(/append-only/);
    await expect(c.app.database.run(`DELETE FROM wallet_entries WHERE id = 1`)).rejects.toThrow(/append-only/);
  });
});

describe('where a wallet stands: the latest count plus what moved since (docs/13 §3)', () => {
  it('the first count sets the baseline, a later one records its difference, and "since" splits by id', async () => {
    const db = c.app.database;
    const now = new Date().toISOString();
    const mark = (await db.one<{ m: number }>('SELECT MAX(id) AS m FROM wallet_entries'))!.m;
    const was = (await balance('whish')).expected;
    // a first count: no expected, no variance
    await db.run(
      `INSERT INTO wallet_counts (method, currency, counted, entry_mark, purpose, counted_by, counted_at) VALUES ('whish', 'LBP', 900000, ?, 'opening', 1, ?)`,
      [mark, now],
    );
    expect((await balance('whish')).expected).toBe(900_000);
    expect((await balance('whish')).lastCount).toMatchObject({ counted: 900_000, expected: null, variance: null });
    expect((await sell(whish())).status).toBe(201);
    expect((await balance('whish')).expected).toBe(900_000 + PRICE);
    expect((await balance('whish')).inSince).toBe(PRICE);
    // the database wants expected and variance together
    await expect(
      db.run(
        `INSERT INTO wallet_counts (method, currency, counted, expected, entry_mark, purpose, counted_by, counted_at) VALUES ('whish', 'LBP', 1, 1, 0, 'check', 1, ?)`,
        [now],
      ),
    ).rejects.toThrow();
    await expect(db.run(`UPDATE wallet_counts SET counted = 1`)).rejects.toThrow(/append-only/);
    expect(was).toBeGreaterThan(0);
  });
});
