import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startCtx, type TestCtx } from '../helpers/app';

// Several tills in one branch (docs/11-multi-branch.md §3.4): terminals, device tokens and one register per terminal.
let c: TestCtx;
let cashier: string;
let manager: string;
let admin: string;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const till = (token: string) => ({ 'X-Terminal-Token': token });

const opening = (cash = 3_000_000) =>
  ['cash', 'whish', 'omt'].flatMap((method) => [
    { method, currency: 'USD', amount: 0 },
    { method, currency: 'LBP', amount: method === 'cash' ? cash : 0 },
  ]);
const sell = (userToken: string, deviceToken: string) =>
  c.http.post(`${api}/sales`).set(auth(userToken)).set(till(deviceToken)).set('Idempotency-Key', randomUUID()).send(c.newSaleBody());
const current = (userToken: string, deviceToken: string) =>
  c.http.get(`${api}/registers/current`).set(auth(userToken)).set(till(deviceToken));

let token1 = '';
let token2 = '';

beforeAll(async () => {
  c = await startCtx();
  cashier = await c.login('cashier');
  manager = await c.login('manager');
  admin = await c.login('admin');
});
afterAll(() => c.close());

describe('terminals · set up and enrolment (US-26)', () => {
  it('while the shop has one till and none is enrolled, a device needs no token (the shop as it is today)', async () => {
    const res = await c.http.get(`${api}/terminals/me`).set(auth(cashier));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ code: 'T1', name: 'Till 1', openSessionId: null });
  });

  it('only an admin sets terminals up; a manager may look at the list', async () => {
    expect((await c.http.post(`${api}/terminals`).set(auth(manager)).send({ name: 'Till 2' })).status).toBe(403);
    expect((await c.http.post(`${api}/terminals`).set(auth(cashier)).send({ name: 'Till 2' })).status).toBe(403);
    expect((await c.http.get(`${api}/terminals`).set(auth(cashier))).status).toBe(403);
    const list = await c.http.get(`${api}/terminals`).set(auth(manager));
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ code: 'T1', enrolled: false, active: true, branch: { code: 'B1' } });
  });

  it('enrols the first till: a one-time code becomes a device token, shown once', async () => {
    const code = await c.http.post(`${api}/terminals/1/enrol-code`).set(auth(admin));
    expect(code.status).toBe(200);
    expect(code.body.enrolCode).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);

    expect((await c.http.post(`${api}/terminals/enrol`).set(auth(manager)).send({ code: code.body.enrolCode })).status).toBe(403);
    const done = await c.http.post(`${api}/terminals/enrol`).set(auth(admin)).send({ code: code.body.enrolCode });
    expect(done.status).toBe(200);
    expect(done.body.terminal).toMatchObject({ code: 'T1' });
    token1 = done.body.token;
    expect(token1.length).toBeGreaterThan(30);

    // single use
    const again = await c.http.post(`${api}/terminals/enrol`).set(auth(admin)).send({ code: code.body.enrolCode });
    expect(again.status).toBe(422);
    expect(again.body.code).toBe('ENROL_CODE_INVALID');
    // the list never shows a code or a token
    expect(JSON.stringify((await c.http.get(`${api}/terminals`).set(auth(manager))).body)).not.toContain(token1);
  });

  it('once a till is enrolled, a device with no token is refused', async () => {
    const res = await c.http.get(`${api}/terminals/me`).set(auth(cashier));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TERMINAL_REQUIRED');
    expect((await c.http.get(`${api}/terminals/me`).set(auth(cashier)).set(till(token1))).body.code).toBe('T1');
  });

  it('adds a second till and enrols it', async () => {
    const created = await c.http.post(`${api}/terminals`).set(auth(admin)).send({ name: 'Till 2' });
    expect(created.status).toBe(201);
    expect(created.body.terminal).toMatchObject({ code: 'T2', name: 'Till 2' });
    const done = await c.http
      .post(`${api}/terminals/enrol`)
      .set(auth(admin))
      .send({ code: created.body.enrolCode.toLowerCase().replace('-', ' ') });
    expect(done.status).toBe(200); // the code is read off one screen and typed into another: case, space and dash do not matter
    token2 = done.body.token;
    expect(token2).not.toBe(token1);
  });

  it('refuses a wrong, expired-looking or unknown code and an unknown token', async () => {
    const bad = await c.http.post(`${api}/terminals/enrol`).set(auth(admin)).send({ code: 'AAAAA-BBBBB' });
    expect(bad.status).toBe(422);
    const unknown = await c.http.get(`${api}/terminals/me`).set(auth(cashier)).set(till('not-a-real-token'));
    expect(unknown.status).toBe(401);
    expect(unknown.body.code).toBe('TERMINAL_UNKNOWN');
  });

  it('a duplicate terminal code is refused', async () => {
    const res = await c.http.post(`${api}/terminals`).set(auth(admin)).send({ name: 'Another', code: 'T2' });
    expect(res.status).toBe(409);
  });
});

describe('terminals · one register each, selling at the same time', () => {
  it('each till opens its own register and sees only its own', async () => {
    const o1 = await c.http
      .post(`${api}/registers/open`)
      .set(auth(cashier))
      .set(till(token1))
      .send({ openingBalances: opening(3_000_000) });
    const o2 = await c.http
      .post(`${api}/registers/open`)
      .set(auth(manager))
      .set(till(token2))
      .send({ openingBalances: opening(1_000_000) });
    expect(o1.status).toBe(201);
    expect(o2.status).toBe(201);
    expect(o1.body.terminalId).toBe('T1');
    expect(o2.body.terminalId).toBe('T2');
    expect(o1.body.id).not.toBe(o2.body.id);
    expect((await current(cashier, token1)).body.id).toBe(o1.body.id);
    expect((await current(cashier, token2)).body.id).toBe(o2.body.id);
  });

  it('a till cannot open a second register', async () => {
    const twice = await c.http.post(`${api}/registers/open`).set(auth(cashier)).set(till(token1)).send({ openingBalances: opening() });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('REGISTER_ALREADY_OPEN');
  });

  it('two tills selling at once: every sale lands in its own register and every figure adds up', async () => {
    const results = await Promise.all([
      ...Array.from({ length: 25 }, () => sell(cashier, token1)),
      ...Array.from({ length: 15 }, () => sell(manager, token2)),
    ]);
    expect(results.filter((r) => r.status !== 201).map((r) => r.body)).toEqual([]);

    const refs = results.map((r) => r.body.ref as number);
    expect(new Set(refs).size).toBe(40); // one number series for the branch, no repeats
    const s1 = (await current(cashier, token1)).body;
    const s2 = (await current(cashier, token2)).body;
    const cash = (s: { balances: { method: string; currency: string; expected: number }[] }) =>
      s.balances.find((b) => b.method === 'cash' && b.currency === 'LBP')!.expected;
    expect(cash(s1)).toBe(3_000_000 + 25 * 75_000);
    expect(cash(s2)).toBe(1_000_000 + 15 * 75_000);

    // the sales know which register took them, and the Z-reports recount the same figures
    expect(results.slice(0, 25).every((r) => r.body.sessionId === s1.id)).toBe(true);
    expect(results.slice(25).every((r) => r.body.sessionId === s2.id)).toBe(true);
    const z1 = (await c.http.get(`${api}/reports/register/${s1.id}`).set(auth(manager))).body;
    expect(z1.totals.salesCount).toBe(25);
    expect(cash(z1)).toBe(cash(s1));
  });

  it('closing one till leaves the other selling; the closed one cannot sell', async () => {
    const s2 = (await current(cashier, token2)).body;
    const counted = s2.balances.map((b: { method: string; currency: string; expected: number }) => ({
      method: b.method,
      currency: b.currency,
      amount: b.expected,
    }));
    expect((await c.http.post(`${api}/registers/${s2.id}/close`).set(auth(manager)).send({ countedBalances: counted })).status).toBe(200);
    expect((await sell(cashier, token2)).status).toBe(409); // REGISTER_CLOSED for till 2
    expect((await sell(cashier, token1)).status).toBe(201); // till 1 carries on
    expect((await current(cashier, token2)).status).toBe(404);
  });

  it('a till cannot open a register in another till’s name', async () => {
    const wrong = await c.http
      .post(`${api}/registers/open`)
      .set(auth(cashier))
      .set(till(token2))
      .send({ terminalId: 'T1', openingBalances: opening() });
    expect(wrong.status).toBe(400);
    expect((await current(cashier, token2)).status).toBe(404); // nothing was opened
  });

  it("a till's suggested opening is what that till counted, not another till's", async () => {
    const res = await c.http.get(`${api}/registers/suggested-opening`).set(auth(cashier)).set(till(token2));
    const cashLbp = res.body.balances.find((b: { method: string; currency: string }) => b.method === 'cash' && b.currency === 'LBP');
    expect(res.body.source).toBe('last-close');
    expect(cashLbp.amount).toBe(1_000_000 + 15 * 75_000);
    const first = await c.http.get(`${api}/registers/suggested-opening`).set(auth(cashier)).set(till(token1));
    expect(first.body.source).toBe('default'); // till 1 has not closed yet
  });
});

describe('terminals · switching off and replacing', () => {
  it('a till with an open register cannot be switched off; the last till cannot either', async () => {
    const open = await c.http.patch(`${api}/terminals/1`).set(auth(admin)).send({ active: false });
    expect(open.status).toBe(409);
    expect(open.body.code).toBe('TERMINAL_HAS_OPEN_REGISTER');
  });

  it('revoking a till stops its token at once; enrolling again gives a new one', async () => {
    expect((await c.http.post(`${api}/terminals/2/revoke`).set(auth(manager))).status).toBe(403);
    expect((await c.http.post(`${api}/terminals/2/revoke`).set(auth(admin))).status).toBe(204);
    expect((await c.http.get(`${api}/terminals/me`).set(auth(cashier)).set(till(token2))).status).toBe(401);

    const code = await c.http.post(`${api}/terminals/2/enrol-code`).set(auth(admin));
    const done = await c.http.post(`${api}/terminals/enrol`).set(auth(admin)).send({ code: code.body.enrolCode });
    expect(done.status).toBe(200);
    expect((await c.http.get(`${api}/terminals/me`).set(auth(cashier)).set(till(done.body.token))).body.code).toBe('T2');
  });

  it('switching a till off (register closed) makes its token useless; it cannot be switched off if it is the only one left', async () => {
    expect((await c.http.patch(`${api}/terminals/2`).set(auth(admin)).send({ active: false })).status).toBe(200);
    expect((await c.http.get(`${api}/terminals/me`).set(auth(cashier)).set(till(token2))).status).toBe(401);
    // only T1 is active now, and it has an open register: the "last till" rule is checked after that one, so close it first
    const s1 = (await current(cashier, token1)).body;
    const counted = s1.balances.map((b: { method: string; currency: string; expected: number }) => ({
      method: b.method,
      currency: b.currency,
      amount: b.expected,
    }));
    await c.http.post(`${api}/registers/${s1.id}/close`).set(auth(manager)).send({ countedBalances: counted });
    const last = await c.http.patch(`${api}/terminals/1`).set(auth(admin)).send({ active: false });
    expect(last.status).toBe(422);
    expect(last.body.code).toBe('LAST_TERMINAL');
  });
});
