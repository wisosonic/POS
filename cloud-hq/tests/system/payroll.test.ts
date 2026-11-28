import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminAuth, startHq, type Hq } from '../helpers';
import { startCtx, type TestCtx } from '../../../branch-server/tests/helpers/app';
import { punch } from '../../../branch-server/src/modules/attendance/service';
import { runControl } from '../../../branch-server/src/modules/sync/control';
import { getLink } from '../../../branch-server/src/modules/sync/service';

// Payroll (docs/16 §5, P6b) end to end: attendance recorded at a branch becomes a payslip at HQ, through a run that is calculated, approved, paid and
// locked. The arithmetic itself is proved by the golden cases in branch-server/tests/unit/payroll.test.ts; this proves the plumbing around it.
let hq: Hq;
let br: TestCtx;
let admin = '';
let branchId = 0;
let sami = 0; // hourly, paid in lira
let lina = 0; // monthly, paid in dollars, with a loan
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const dayOffset = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const D1 = dayOffset(-3);
const D2 = dayOffset(-2);
const until = async (check: () => Promise<boolean>, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
};
const post = (path: string, body: object = {}) => hq.http.post(`${api}${path}`).set(adminAuth).send(body);
const get = (path: string) => hq.http.get(`${api}${path}`).set(adminAuth);
const slipOf = (r: { payslips: { employeeId: number }[] }, employeeId: number) =>
  r.payslips.find((s) => s.employeeId === employeeId) as {
    currency: string;
    grossMinor: number;
    deductionsMinor: number;
    netMinor: number;
    employerCostMinor: number;
    daysWorked: number;
    regularMinutes: number;
    overtimeMinutes: number;
    lines: { side: string; code: string; amountMinor: number }[];
    rules: { code: string; effectiveFrom: string }[];
  };
const hqDb = () => hq.app.database;

beforeAll(async () => {
  hq = await startHq();
  br = await startCtx({ sync: { intervalMs: 60, backoffMs: [60, 200], idleMs: 40 } });
  admin = await br.login('admin');
  const enrol = (await post('/branches', { code: 'P1', name: 'Payroll Branch' })).body.enrolCode as string;
  expect((await br.http.post(`${api}/sync/connect`).set(auth(admin)).send({ url: hq.url, code: enrol })).status).toBe(200);
  branchId = (await hqDb().one<{ id: number }>("SELECT id FROM branches WHERE code = 'P1'"))!.id;
  expect((await post('/exchange-rates', { rateLbpPerUsd: 90_000 })).status).toBe(201);

  // rules: social security (2% of the first 18,000,000, lowers the taxable amount) and a progressive tax
  expect(
    (
      await post('/payroll/rules', {
        code: 'nssf',
        name: 'Social security',
        kind: 'percent',
        reducesTax: true,
        rateBp: 200,
        capBaseMinor: 18_000_000,
        effectiveFrom: '2026-01-01',
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await post('/payroll/rules', {
        code: 'tax',
        name: 'Income tax',
        kind: 'brackets',
        base: 'taxable',
        brackets: [
          { fromMinor: 0, rateBp: 0 },
          { fromMinor: 5_000_000, rateBp: 500 },
        ],
        effectiveFrom: '2026-01-01',
      })
    ).status,
  ).toBe(201);

  const make = async (code: string, name: string) => (await post('/employees', { code, name, branchIds: [branchId] })).body.id as number;
  [sami, lina] = [await make('SAMI', 'Sami Khoury'), await make('LINA', 'Lina Haddad')];
  await make('ZED', 'Zed Nobody'); // an employee with no pay profile
  expect((await post(`/employees/${sami}/pin`, { pin: '1234' })).status).toBe(204);
  expect(
    await until(
      async () => !!(await br.app.database.one('SELECT 1 AS x FROM employees WHERE code = ? AND pin_hash IS NOT NULL', ['SAMI'])),
    ),
  ).toBe(true);

  // Sami: 600 minutes on D1 and 480 on D2, as the branch records them
  const db = br.app.database;
  const user = (await db.one<{ id: number }>('SELECT id FROM users LIMIT 1'))!.id;
  const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00Z`);
  for (const [t] of [[at(D1, '06:00')], [at(D1, '16:00')], [at(D2, '06:00')], [at(D2, '14:00')]] as const)
    await punch(db, user, { code: 'SAMI', pin: '1234' }, t);
});
afterAll(async () => {
  await br.close();
  await hq.close();
});

describe('profiles, rules and loans are dated and never edited (US-HR-payroll)', () => {
  it('a profile needs rules that exist; the one in force is the latest that has begun; history is append-only', async () => {
    const hourly = {
      effectiveFrom: '2026-01-01',
      type: 'hourly',
      baseMinor: 100_000,
      currency: 'LBP',
      overtimeAfterMinutes: 480,
      ruleCodes: ['nssf', 'tax'],
    };
    expect((await post(`/employees/${sami}/pay-profiles`, { ...hourly, ruleCodes: ['nope'] })).status).toBe(422);
    expect((await post(`/employees/${sami}/pay-profiles`, hourly)).status).toBe(201);
    // a later raise, from a day after the period: not used for it
    expect((await post(`/employees/${sami}/pay-profiles`, { ...hourly, effectiveFrom: dayOffset(5), baseMinor: 500_000 })).status).toBe(
      201,
    );
    expect(((await get(`/employees/${sami}/pay-profiles`)).body.data as unknown[]).length).toBe(2);
    expect(
      (
        await post(`/employees/${lina}/pay-profiles`, {
          effectiveFrom: '2026-01-01',
          type: 'monthly',
          baseMinor: 100_000,
          currency: 'USD',
          ruleCodes: ['nssf'],
        })
      ).status,
    ).toBe(201);
    await expect(hqDb().run('UPDATE pay_profiles SET base_minor = 1')).rejects.toThrow();
    await expect(hqDb().run('DELETE FROM payroll_rules')).rejects.toThrow();
    // a loan of $200, $50 a month
    expect((await post('/loans', { employeeId: lina, principalMinor: 20_000, currency: 'USD', installmentMinor: 5_000 })).status).toBe(201);
    expect((await post('/loans', { employeeId: lina, principalMinor: 100, currency: 'USD', installmentMinor: 500 })).status).toBe(422);
  });

  it('every payroll route is closed to anonymous callers', async () => {
    for (const path of ['/payroll/runs', '/payroll/rules', '/loans', `/employees/${sami}/pay-profiles`])
      expect((await hq.http.get(`${api}${path}`)).status).toBe(401);
  });
});

describe('a payroll run (US-HR-payroll)', () => {
  let runId = 0;

  it('waits for a branch that has not caught up, and for a period that has not finished', async () => {
    const made = await post('/payroll/runs', { fromDay: D1, toDay: D2 });
    expect(made.status).toBe(201);
    runId = made.body.id;
    expect(made.body.status).toBe('draft');
    // the branch's own agent may already have sent a control; take it away so the branch has not yet proved the last day
    await hqDb().run('DELETE FROM reconciliations WHERE branch_id = ?', [branchId]);
    const behind = await post(`/payroll/runs/${runId}/calculate`);
    expect(behind.status).toBe(409);
    expect(behind.body.code).toBe('BRANCH_BEHIND');
    expect(behind.body.detail).toContain('Payroll Branch');
    const today = await post('/payroll/runs', { fromDay: D1, toDay: dayOffset(0) });
    expect((await post(`/payroll/runs/${today.body.id}/calculate`)).body.code).toBe('PERIOD_NOT_FINISHED');
    expect((await post('/payroll/runs', { fromDay: D2, toDay: D1 })).status).toBe(422);
  });

  it('once the branch has proved it holds the same attendance, the slips are worked out and kept with their snapshots', async () => {
    // the punches reach HQ, then the branch's daily control for the last day agrees with HQ's copy
    expect(await until(async () => (await br.http.get(`${api}/sync/verify`).set(auth(admin))).body.inSync === true)).toBe(true);
    const link = (await getLink(br.app.database))!;
    expect(await runControl(br.app.database, link, { today: dayOffset(1) })).toMatchObject({ mismatched: 0 });

    // a bonus for Lina before calculating
    expect(
      (await post(`/payroll/runs/${runId}/inputs`, { employeeId: lina, kind: 'earning', label: 'Eid bonus', amountMinor: 10_000 })).status,
    ).toBe(201);
    const calc = await post(`/payroll/runs/${runId}/calculate`);
    expect(calc.status).toBe(200);
    expect(calc.body.payslips).toBe(2);
    expect(calc.body.skipped.map((w: { code: string }) => w.code)).toEqual(['NO_PAY_PROFILE']);
    const r = calc.body.run;
    expect(r).toMatchObject({ status: 'calculated', rateLbpPerUsd: 90_000 });

    // Sami: 960 regular minutes (16 h) + 120 overtime (2 h at 1.5): 1,600,000 + 300,000 = 1,900,000. Social security 2% = 38,000; under the taxable threshold.
    const s = slipOf(r, sami);
    expect(s).toMatchObject({
      currency: 'LBP',
      grossMinor: 1_900_000,
      deductionsMinor: 38_000,
      netMinor: 1_862_000,
      daysWorked: 2,
      regularMinutes: 960,
      overtimeMinutes: 120,
    });
    expect(s.lines.filter((l) => l.side === 'deduction').map((l) => [l.code, l.amountMinor])).toEqual([['NSSF', 38_000]]);
    expect(s.rules.map((x) => x.code).sort()).toEqual(['NSSF', 'TAX']); // the version of each rule used is kept
    // Lina: $1,000 + $100 bonus; social security worked out in lira (capped) and brought back: 360,000 LBP = 400 cents; the loan installment $50
    const l = slipOf(r, lina);
    expect(l).toMatchObject({ currency: 'USD', grossMinor: 110_000, deductionsMinor: 5_400, netMinor: 104_600 });
    expect(l.lines.filter((x) => x.side === 'deduction').map((x) => [x.code, x.amountMinor])).toEqual([
      ['NSSF', 400],
      [`loan:${(await get('/loans')).body.data[0].id}`, 5_000],
    ]);

    // the invariant, for every slip in the database: net = gross - deductions = the lines
    const all = await hqDb().all<{ id: number; gross_minor: number; deductions_minor: number; net_minor: number }>(
      'SELECT * FROM payslips',
    );
    for (const p of all) {
      const lines = await hqDb().all<{ side: string; amount_minor: number }>(
        'SELECT side, amount_minor FROM payslip_lines WHERE payslip_id = ?',
        [p.id],
      );
      const earn = lines.filter((x) => x.side === 'earning').reduce((n, x) => n + x.amount_minor, 0);
      const ded = lines.filter((x) => x.side === 'deduction').reduce((n, x) => n + x.amount_minor, 0);
      expect(p.gross_minor).toBe(earn);
      expect(p.deductions_minor).toBe(ded);
      expect(p.net_minor).toBe(earn - ded);
    }
  });

  it('can be worked out again until it is approved; a new rule from a later day does not change an old period', async () => {
    // a rule change from tomorrow on: this period still uses the rule that was in force
    expect(
      (
        await post('/payroll/rules', {
          code: 'nssf',
          name: 'Social security',
          kind: 'percent',
          reducesTax: true,
          rateBp: 900,
          capBaseMinor: 18_000_000,
          effectiveFrom: dayOffset(1),
        })
      ).status,
    ).toBe(201);
    // a manual deduction added and removed
    const input = (
      await post(`/payroll/runs/${runId}/inputs`, { employeeId: sami, kind: 'deduction', label: 'Absent a day', amountMinor: 100_000 })
    ).body.id;
    let r = (await post(`/payroll/runs/${runId}/calculate`)).body.run;
    expect(slipOf(r, sami)).toMatchObject({ deductionsMinor: 138_000, netMinor: 1_762_000 });
    expect((await hq.http.delete(`${api}/payroll/runs/${runId}/inputs/${input}`).set(adminAuth)).status).toBe(204);
    r = (await post(`/payroll/runs/${runId}/calculate`)).body.run;
    expect(slipOf(r, sami)).toMatchObject({ deductionsMinor: 38_000, netMinor: 1_862_000 }); // 2%, not the new 9%
  });

  it('approving freezes it: the slips, their lines and the inputs refuse every change, and it cannot be calculated again', async () => {
    expect((await post(`/payroll/runs/${runId}/pay`)).body.code).toBe('RUN_NOT_APPROVED');
    expect((await post(`/payroll/runs/${runId}/approve`)).status).toBe(200);
    expect((await post(`/payroll/runs/${runId}/calculate`)).body.code).toBe('RUN_FROZEN');
    expect((await post(`/payroll/runs/${runId}/inputs`, { employeeId: sami, kind: 'earning', label: 'x', amountMinor: 1 })).body.code).toBe(
      'RUN_FROZEN',
    );
    await expect(hqDb().run('UPDATE payslips SET net_minor = net_minor + 1 WHERE run_id = ?', [runId])).rejects.toThrow(/cannot change/);
    await expect(hqDb().run('DELETE FROM payslips WHERE run_id = ?', [runId])).rejects.toThrow(/cannot change/);
    await expect(hqDb().run('UPDATE payslip_lines SET amount_minor = 1')).rejects.toThrow(/cannot change/);
    await expect(hqDb().run('DELETE FROM payroll_inputs WHERE run_id = ?', [runId])).rejects.toThrow(/cannot change/);
    await expect(hqDb().run('UPDATE payroll_runs SET to_day = ? WHERE id = ?', [dayOffset(-1), runId])).rejects.toThrow(/fixed/);
    await expect(hqDb().run("UPDATE payroll_runs SET status = 'calculated' WHERE id = ?", [runId])).rejects.toThrow(/forward/);
    // a second run over the same days is refused
    expect((await post('/payroll/runs', { fromDay: D2, toDay: D2 })).body.code).toBe('PERIOD_ALREADY_PAID');
  });

  it('paying takes the loan installment off what is owed, once; locking makes the run final', async () => {
    expect((await get('/loans')).body.data[0]).toMatchObject({ principalMinor: 20_000, repaidMinor: 0, remainingMinor: 20_000 });
    const paid = await post(`/payroll/runs/${runId}/pay`);
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe('paid');
    expect((await get('/loans')).body.data[0]).toMatchObject({ repaidMinor: 5_000, remainingMinor: 15_000 });
    expect((await post(`/payroll/runs/${runId}/pay`)).body.code).toBe('RUN_NOT_APPROVED'); // not twice
    expect((await get('/loans')).body.data[0].repaidMinor).toBe(5_000);
    await expect(hqDb().run('UPDATE loan_repayments SET amount_minor = 1')).rejects.toThrow(/append-only/);

    const locked = await post(`/payroll/runs/${runId}/lock`);
    expect(locked.body).toMatchObject({ status: 'locked' });
    expect(locked.body.totals.map((t: { currency: string; netMinor: number }) => [t.currency, t.netMinor]).sort()).toEqual([
      ['LBP', 1_862_000],
      ['USD', 104_600],
    ]);
    await expect(hqDb().run("UPDATE payroll_runs SET note = 'x' WHERE id = ?", [runId])).rejects.toThrow(/locked/);
    await expect(hqDb().run('DELETE FROM payroll_runs WHERE id = ?', [runId])).rejects.toThrow(/never deleted/);
  });

  it('the audit says who did what and never what was paid', async () => {
    const audit = JSON.stringify(await hqDb().all("SELECT action, detail_json FROM hq_audit WHERE action LIKE 'payroll.%'"));
    for (const action of [
      'payroll.profile',
      'payroll.rule',
      'payroll.loan',
      'payroll.run.calculate',
      'payroll.run.approve',
      'payroll.run.pay',
      'payroll.run.lock',
    ])
      expect(audit).toContain(action);
    for (const amount of ['1862000', '1900000', '104600', '100000', '110000']) expect(audit).not.toContain(amount);
  });
});
