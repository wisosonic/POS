import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminAuth, branchAuth, startHq, type Hq } from '../helpers';
import { startCtx, type TestCtx } from '../../../branch-server/tests/helpers/app';
import { computeControls, runControl } from '../../../branch-server/src/modules/sync/control';
import { getLink } from '../../../branch-server/src/modules/sync/service';
import { CONTROLS } from '../../../branch-server/core/src/sync';

// The daily reconciliation (docs/12 §24, P4c): the branch says what it holds per table and day, HQ compares with its copy. A row lost at HQ, or a
// value changed there, is FOUND, said once, and cured by sending everything again. The comparison covers days that are over; these tests ask for
// "tomorrow" as the end so that today's rows (all the data there is) are in it.
let hq: Hq;
let c: TestCtx;
let admin: string;
let manager: string;
let cashier: string;
let blockPush = false;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const key = () => crypto.randomUUID();
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);
const verify = async () => (await c.http.get(`${api}/sync/verify`).set(auth(admin))).body;
const until = async (check: () => Promise<boolean>, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
};
const inSync = async () => (await verify()).inSync === true;
const control = async () => runControl(c.app.database, (await getLink(c.app.database))!, { today: tomorrow() });
const report = async (extra = '') =>
  (await hq.http.get(`${api}/reports/reconciliation?from=${today()}&to=${today()}${extra}`).set(adminAuth)).body;
const audits = (action: string) =>
  hq.app.database.one<{ n: number }>('SELECT COUNT(*) AS n FROM hq_audit WHERE action = ?', [action]).then((r) => r!.n);

beforeAll(async () => {
  hq = await startHq();
  c = await startCtx({
    sync: {
      intervalMs: 60,
      backoffMs: [60, 200],
      idleMs: 40,
      controlEveryMs: 100,
      fetchImpl: async (input, init) => {
        if (blockPush && String(input).includes('/sync/facts')) throw new TypeError('network down');
        return fetch(input, init);
      },
    },
  });
  admin = await c.login('admin');
  manager = await c.login('manager');
  cashier = await c.login('cashier');
  await c.openRegister(cashier);
  const sale = await c.http.post(`${api}/sales`).set(auth(cashier)).set('Idempotency-Key', key()).send(c.newSaleBody());
  expect(sale.status).toBe(201);
  const sold = (await c.http.get(`${api}/sales/${sale.body.id}`).set(auth(cashier))).body;
  expect(
    (
      await c.http
        .post(`${api}/returns`)
        .set(auth(manager))
        .set('Idempotency-Key', key())
        .send({
          saleId: sale.body.id,
          items: [{ saleItemId: sold.items[0].id, qty: '1' }],
          reason: 'changed mind',
          refund: { method: 'cash', currency: 'LBP', amount: 75000 },
        })
    ).status,
  ).toBe(201);
  for (const title of ['Rent', 'Cleaning'])
    expect((await c.http.post(`${api}/expenses`).set(auth(manager)).send({ title, amountMinor: 200_000, currency: 'LBP' })).status).toBe(
      201,
    );
  expect(
    (
      await c.http
        .post(`${api}/services`)
        .set(auth(manager))
        .set('Idempotency-Key', key())
        .send({ costMinor: 0, feeMinor: 50000, currency: 'LBP' })
    ).status,
  ).toBe(201);
  const code = (await hq.http.post(`${api}/branches`).set(adminAuth).send({ code: 'REC', name: 'Records' })).body.enrolCode as string;
  expect((await c.http.post(`${api}/sync/connect`).set(auth(admin)).send({ url: hq.url, code })).status).toBe(200);
  expect(await until(inSync)).toBe(true);
});
afterAll(async () => {
  await c.close();
  await hq.close();
});

describe('when a branch and HQ agree (US-HQ-reconcile)', () => {
  it('the control is made once the branch has sent everything, and every day of it compares equal', async () => {
    const r = await control();
    expect(r).toMatchObject({ mismatched: 0 });
    expect('sent' in r && r.sent).toBe(7);
    const today1 = (await report()).data;
    expect(today1).toEqual([expect.objectContaining({ status: 'ok', differences: [] })]);
    const all = await hq.http.get(`${api}/reports/reconciliation?onlyMismatch=true`).set(adminAuth);
    expect(all.body.data).toEqual([]);
  });

  it('it is not vacuous: today really holds rows in every kind of table that happened', async () => {
    const computed = await computeControls(c.app.database, { today: tomorrow(), days: 1 });
    if ('skipped' in computed) throw new Error(computed.skipped);
    const t = computed.days[0]!.tables;
    for (const name of [
      'sales',
      'sale_items',
      'payments',
      'stock_movements',
      'returns',
      'return_items',
      'expenses',
      'service_sales',
      'register_sessions',
      'register_balances',
    ])
      expect(t[name]!.n, name).toBeGreaterThan(0);
    expect(Object.keys(t)).toEqual(CONTROLS.map((x) => x.name));
  });

  it('the branch does it by itself, and its status says what HQ found', async () => {
    expect(
      await until(async () => {
        const s = (await c.http.get(`${api}/sync/status`).set(auth(admin))).body;
        return s.control?.outcome?.mismatched === 0 && s.control.outcome.sent === 7;
      }),
    ).toBe(true);
    const overview = (await hq.http.get(`${api}/reports/overview`).set(adminAuth)).body;
    expect(overview.branches[0].reconciliation).toMatchObject({ mismatchDays: 0 });
    expect(overview.branches[0].reconciliation.lastCheckedAt).toBeTruthy();
  });
});

describe('when something is lost or changed at HQ', () => {
  it('a row that went missing at HQ is found, said once, and shows which table and by how much', async () => {
    await hq.app.database.run('DELETE FROM expenses WHERE branch_id = 1 AND id = (SELECT MIN(id) FROM expenses WHERE branch_id = 1)');
    expect((await control()) as unknown).toMatchObject({ mismatched: 1 });
    const bad = (await report('&onlyMismatch=true')).data;
    expect(bad).toHaveLength(1);
    expect(bad[0].differences).toEqual([{ table: 'expenses', branch: { n: 2, s: 400000 }, hq: { n: 1, s: 200000 } }]);
    expect(await audits('reconcile.mismatch')).toBe(1);
    await control(); // checked again: still wrong, but not said again
    expect(await audits('reconcile.mismatch')).toBe(1);
    const overview = (await hq.http.get(`${api}/reports/overview`).set(adminAuth)).body;
    expect(overview.branches[0].reconciliation.mismatchDays).toBe(1);
  });

  it('a value changed at HQ is found even when the count is the same', async () => {
    await hq.app.database.run('UPDATE sales SET total_lbp = total_lbp + 5000 WHERE branch_id = 1 AND id = 1');
    const r = await control();
    expect(r).toMatchObject({ mismatched: 1 });
    const diffs = (await report('&onlyMismatch=true')).data[0].differences as {
      table: string;
      branch: { n: number; s: number };
      hq: { n: number; s: number };
    }[];
    expect(diffs.map((d) => d.table).sort()).toEqual(['expenses', 'sales']);
    const sales = diffs.find((d) => d.table === 'sales')!;
    expect(sales.hq.n).toBe(sales.branch.n);
    expect(sales.hq.s).toBe(sales.branch.s + 5000);
  });

  it('sending everything again cures it, and HQ says it is resolved (once)', async () => {
    expect((await c.http.post(`${api}/sync/resync`).set(auth(admin))).status).toBe(200);
    expect(
      await until(async () => {
        const p = (await c.http.get(`${api}/sync/status`).set(auth(admin))).body.progress;
        return p.snapshot.done === true && p.pending === 0 && (await inSync());
      }),
    ).toBe(true);
    expect(await control()).toMatchObject({ mismatched: 0 });
    expect((await report('&onlyMismatch=true')).data).toEqual([]);
    expect(await audits('reconcile.resolved')).toBe(1);
    const rows = c.app.database.one<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'hq.resync'");
    expect((await rows)!.n).toBe(1); // the branch audited who asked for it
  });
});

describe('when it is not the moment, or the message is wrong', () => {
  it('a branch that still has records to send says nothing (no false alarm)', async () => {
    blockPush = true;
    try {
      expect(
        (await c.http.post(`${api}/expenses`).set(auth(manager)).send({ title: 'Unsent', amountMinor: 1000, currency: 'LBP' })).status,
      ).toBe(201);
      const r = await control();
      expect(r).toEqual({ skipped: 'the branch still has records to send' });
    } finally {
      blockPush = false;
    }
    expect(await until(inSync)).toBe(true);
    expect(await control()).toMatchObject({ mismatched: 0 }); // and once it has caught up, it agrees
  });

  it('a branch that is not connected has nothing to compare', async () => {
    const other = await startCtx();
    try {
      expect(await computeControls(other.app.database, { today: tomorrow() })).toEqual({ skipped: 'the branch still has records to send' });
    } finally {
      await other.close();
    }
  });

  it('HQ refuses a control it cannot read, ignores a table it does not know, and needs the branch’s token', async () => {
    const token = (await c.app.database.one<{ branch_token: string }>('SELECT branch_token FROM hq_link WHERE id = 1'))!.branch_token;
    const post = (body: unknown, headers: Record<string, string> = branchAuth(token)) =>
      hq.http
        .post(`${api}/sync/control`)
        .set(headers)
        .send(body as object);
    const day = (d: string, tables: Record<string, unknown> = {}) => ({ day: d, tables });
    expect((await post({ days: [day(today())] }, {})).status).toBe(401);
    expect((await post({ days: [] })).status).toBe(400);
    expect((await post({ days: [day('yesterday')] })).body.code).toBe('CONTROL_INVALID');
    expect((await post({ days: [day('2999-01-01')] })).body.code).toBe('CONTROL_INVALID');
    expect((await post({ days: [day(today(), { sales: { n: -1, s: 0 } })] })).status).toBe(400);
    // a table from a newer version is skipped, not a difference
    const ok = await post({ days: [day(today(), { future_things: { n: 5, s: 5 } })] });
    expect([ok.status, ok.body]).toEqual([200, { checked: 1, mismatched: 0 }]);
  });
});
