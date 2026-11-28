import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminAuth, startHq, type Hq } from '../helpers';
import { startCtx, type TestCtx } from '../../../branch-server/tests/helpers/app';
import { runControl } from '../../../branch-server/src/modules/sync/control';
import { getLink } from '../../../branch-server/src/modules/sync/service';

// The chain under a burst (docs/09, P7): three branches sell at the same time while syncing to HQ, a retried sale is not a second sale, and in the end HQ holds
// exactly what the branches hold, branch by branch, with the daily control agreeing. This is a correctness check at a small scale on one machine (the same
// ids at every branch, SQLite everywhere), not a measure of real hardware: that needs the real machines (docs/17).
const BRANCHES = 3;
const SALES_EACH = 40;
const WAVE = 8; // sales in flight at once at one branch
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
let hq: Hq;
const branches: { ctx: TestCtx; cashier: string; admin: string; code: string }[] = [];
const until = async (check: () => Promise<boolean>, ms = 60_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
};

beforeAll(async () => {
  hq = await startHq();
  for (let i = 0; i < BRANCHES; i++) {
    const ctx = await startCtx({ sync: { intervalMs: 60, backoffMs: [60, 200], idleMs: 40 } });
    const code = `L${i + 1}`;
    const enrol = (
      await hq.http
        .post(`${api}/branches`)
        .set(adminAuth)
        .send({ code, name: `Load ${code}` })
    ).body.enrolCode as string;
    const admin = await ctx.login('admin');
    expect((await ctx.http.post(`${api}/sync/connect`).set(auth(admin)).send({ url: hq.url, code: enrol })).status).toBe(200);
    const cashier = await ctx.login('cashier');
    await ctx.openRegister(cashier);
    branches.push({ ctx, cashier, admin, code });
  }
});
afterAll(async () => {
  for (const b of branches) await b.ctx.close();
  await hq.close();
});

describe('three branches sell at once and HQ ends up with all of it (US-OPS-load)', () => {
  it('every sale is recorded once even when retried, and HQ holds exactly what each branch holds', async () => {
    const started = Date.now();
    await Promise.all(
      branches.map(async (b) => {
        const keys = Array.from({ length: SALES_EACH }, () => crypto.randomUUID());
        for (let i = 0; i < keys.length; i += WAVE) {
          const wave = keys.slice(i, i + WAVE);
          const answers = await Promise.all(
            wave.map((k) =>
              b.ctx.http
                .post(`${api}/sales`)
                .set(auth(b.cashier))
                .set('Idempotency-Key', k)
                .send(b.ctx.newSaleBody({ clientSaleId: k })),
            ),
          );
          for (const a of answers) expect(a.status).toBe(201);
          // a retry of the first one in the wave (a till that did not hear the answer): the same sale, not a second
          const again = await b.ctx.http
            .post(`${api}/sales`)
            .set(auth(b.cashier))
            .set('Idempotency-Key', wave[0]!)
            .send(b.ctx.newSaleBody({ clientSaleId: wave[0]! }));
          expect([200, 201]).toContain(again.status);
        }
      }),
    );
    const sellMs = Date.now() - started;

    // each branch has exactly its own sales
    for (const b of branches) {
      const n = (await b.ctx.app.database.one<{ n: number }>('SELECT COUNT(*) AS n FROM sales'))!.n;
      expect(n, b.code).toBe(SALES_EACH);
    }
    // everything reaches HQ and agrees, table by table
    for (const b of branches) {
      expect(await until(async () => (await b.ctx.http.get(`${api}/sync/verify`).set(auth(b.admin))).body.inSync === true), b.code).toBe(
        true,
      );
    }
    // the daily control agrees too
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    for (const b of branches) {
      const link = (await getLink(b.ctx.app.database))!;
      expect(await runControl(b.ctx.app.database, link, { today: tomorrow }), b.code).toMatchObject({ mismatched: 0 });
    }
    // HQ keeps the branches apart even though every one of them numbered its sales from 1
    const perBranch = await hq.app.database.all<{ branch_id: number; n: number; mx: number }>(
      'SELECT branch_id, COUNT(*) AS n, MAX(id) AS mx FROM sales GROUP BY branch_id',
    );
    expect(perBranch).toHaveLength(BRANCHES);
    for (const p of perBranch) expect(p).toMatchObject({ n: SALES_EACH });
    expect((await hq.app.database.one<{ n: number }>('SELECT COUNT(*) AS n FROM sales'))!.n).toBe(BRANCHES * SALES_EACH);
    // the money: HQ's total for the day equals the sum of the branches' own
    const own = await Promise.all(
      branches.map(
        async (b) =>
          (await b.ctx.app.database.one<{ s: number }>("SELECT COALESCE(SUM(total_lbp), 0) AS s FROM sales WHERE status <> 'void'"))!.s,
      ),
    );
    const atHq = (await hq.app.database.one<{ s: number }>("SELECT COALESCE(SUM(total_lbp), 0) AS s FROM sales WHERE status <> 'void'"))!.s;
    expect(atHq).toBe(own.reduce((a, b) => a + b, 0));
    // the monitoring answer sees a chain that is fine
    expect(
      await until(
        async () =>
          ((await hq.http.get(`${api}/monitoring/branches`).set(adminAuth)).body.summary as { withProblems: number }).withProblems === 0,
      ),
    ).toBe(true);
    process.stdout.write(`chain-load: ${BRANCHES * SALES_EACH} sales over ${BRANCHES} branches in ${sellMs} ms, all at HQ\n`);
  });
});
