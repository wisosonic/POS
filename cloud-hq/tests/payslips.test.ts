import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminAuth, startHq, type Hq } from './helpers';
import { hashPassword } from '../src/auth/password';
import { createUser } from '../src/modules/staff/users';

// Payslip viewing, printing and employee self-service (docs/16 §7, P6c): who may read pay, that an employee sees only their own paid slips, that the
// print page is a one-use link, and that every view and print is audited (who and which slip, never an amount).
let hq: Hq;
let branch = 0;
let sami = 0;
let lina = 0;
let samiPaid = 0; // Sami's slip in a paid run
let samiOpen = 0; // Sami's slip in a run that is only calculated
let linaPaid = 0;
const api = '/api/v1';
const PASSWORD = 'a-long-first-password';
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const run = (sql: string, params: (string | number | null)[] = []) => hq.app.database.run(sql, params);
const login = async (username: string, password = PASSWORD) =>
  (await hq.http.post(`${api}/auth/login`).send({ username, password })).body.token as string;
const NAME = 'Sami <b>"Khoury"</b> & Sons';

async function makeSlip(runId: number, employeeId: number, name: string, code: string, net: number) {
  const slip = (await hq.app.database.one<{ id: number }>(
    `INSERT INTO payslips (run_id, employee_id, employee_code, employee_name, currency, days_worked, regular_minutes, overtime_minutes, gross_minor, deductions_minor, net_minor,
       employer_cost_minor, profile_json, rules_json, created_at) VALUES (?, ?, ?, ?, 'LBP', 2, 960, 120, ?, 38000, ?, 190000, '{}', '[]', 'x') RETURNING id`,
    [runId, employeeId, code, name, net + 38_000, net],
  ))!.id;
  const lines: [string, string, string, number][] = [
    ['earning', 'base', 'Hours worked', net - 300_000 + 38_000],
    ['earning', 'overtime', 'Overtime', 300_000],
    ['deduction', 'NSSF', 'Social security', 38_000],
    ['employer', 'NSSF_ER', 'Social security (employer)', 190_000],
  ];
  let i = 0;
  for (const [side, c, label, amount] of lines)
    await run('INSERT INTO payslip_lines (payslip_id, side, code, label, amount_minor, position) VALUES (?, ?, ?, ?, ?, ?)', [
      slip,
      side,
      c,
      label,
      amount,
      i++,
    ]);
  return slip;
}
async function makeRun(from: string, to: string): Promise<number> {
  return (await hq.app.database.one<{ id: number }>(
    `INSERT INTO payroll_runs (from_day, to_day, status, created_at) VALUES (?, ?, 'draft', 'x') RETURNING id`,
    [from, to],
  ))!.id;
}

beforeAll(async () => {
  hq = await startHq();
  const db = hq.app.database;
  const hash = await hashPassword(PASSWORD);
  for (const [username, role] of [
    ['hrperson', 'hr'],
    ['payperson', 'payroll'],
    ['looker', 'viewer'],
  ] as const)
    await db.tx((tx) => createUser(tx, { username, name: username, role, passwordHash: hash, mustReset: false }));
  expect((await hq.http.post(`${api}/branches`).set(adminAuth).send({ code: 'B1', name: 'Hamra' })).status).toBe(201);
  branch = (await db.one<{ id: number }>("SELECT id FROM branches WHERE code = 'B1'"))!.id;
  sami = (
    await hq.http
      .post(`${api}/employees`)
      .set(adminAuth)
      .send({ code: 'SAMI', name: NAME, branchIds: [branch] })
  ).body.id;
  lina = (
    await hq.http
      .post(`${api}/employees`)
      .set(adminAuth)
      .send({ code: 'LINA', name: 'Lina Haddad', branchIds: [branch] })
  ).body.id;
  const paidRun = await makeRun('2026-10-01', '2026-10-31');
  samiPaid = await makeSlip(paidRun, sami, NAME, 'SAMI', 1_862_000);
  linaPaid = await makeSlip(paidRun, lina, 'Lina Haddad', 'LINA', 2_000_000);
  const openRun = await makeRun('2026-11-01', '2026-11-30');
  samiOpen = await makeSlip(openRun, sami, NAME, 'SAMI', 1_900_000);
  await run("UPDATE payroll_runs SET status = 'calculated' WHERE id = ?", [openRun]);
  await run("UPDATE payroll_runs SET status = 'paid' WHERE id = ?", [paidRun]);
});
afterAll(async () => {
  await hq.close();
});

describe('who may read pay (US-HR-payslips)', () => {
  it('payroll and admin read any slip, with what it cost the company; HR, viewers and anonymous callers cannot', async () => {
    const pay = await login('payperson');
    const slip = await hq.http.get(`${api}/payroll/payslips/${samiPaid}`).set(bearer(pay));
    expect(slip.status).toBe(200);
    expect(slip.body).toMatchObject({ netMinor: 1_862_000, employerCostMinor: 190_000, runStatus: 'paid' });
    expect((await hq.http.get(`${api}/payroll/payslips/${samiPaid}`).set(adminAuth)).status).toBe(200);
    for (const who of ['hrperson', 'looker'])
      expect((await hq.http.get(`${api}/payroll/payslips/${samiPaid}`).set(bearer(await login(who)))).status).toBe(403);
    expect((await hq.http.get(`${api}/payroll/payslips/${samiPaid}`)).status).toBe(401);
    // pay profiles, rules and runs are payroll's too
    for (const p of ['/payroll/runs', '/payroll/rules', '/loans'])
      expect((await hq.http.get(`${api}${p}`).set(bearer(await login('hrperson')))).status).toBe(403);
    expect((await hq.http.get(`${api}/payroll/runs`).set(bearer(pay))).status).toBe(200);
  });

  it('HR changes people and rosters, payroll does not, and neither can make the other', async () => {
    const hr = await login('hrperson');
    const pay = await login('payperson');
    const make = (t: string, code: string) => hq.http.post(`${api}/employees`).set(bearer(t)).send({ code, name: code, branchIds: [] });
    expect((await make(pay, 'PX')).status).toBe(403);
    expect((await make(hr, 'HX')).status).toBe(201);
    expect((await hq.http.get(`${api}/employees`).set(bearer(pay))).status).toBe(200); // reading people is for everyone on staff
    expect(
      (
        await hq.http
          .post(`${api}/employees/${sami}/pay-profiles`)
          .set(bearer(hr))
          .send({ effectiveFrom: '2026-01-01', type: 'monthly', baseMinor: 1, currency: 'LBP' })
      ).status,
    ).toBe(403);
  });

  it('an employee account cannot be made from the people screen, and the new roles are accepted there', async () => {
    const made = (role: string) =>
      hq.http
        .post(`${api}/users`)
        .set(adminAuth)
        .send({ username: `u-${role}`, name: role, role, password: PASSWORD });
    expect((await made('employee')).status).toBe(400);
    expect((await made('hr')).status).toBe(201);
    expect((await made('payroll')).status).toBe(201);
  });
});

describe('an employee sees only their own (US-HR-payslips)', () => {
  let token = '';

  it('HR makes the account; the person must choose their own password first', async () => {
    const hr = await login('hrperson');
    const made = await hq.http.post(`${api}/employees/${sami}/account`).set(bearer(hr)).send({ username: 'sami', password: PASSWORD });
    expect(made.status).toBe(201);
    expect(
      (await hq.http.post(`${api}/employees/${sami}/account`).set(bearer(hr)).send({ username: 'sami2', password: PASSWORD })).body.code,
    ).toBe('ACCOUNT_EXISTS');
    token = await login('sami');
    expect((await hq.http.get(`${api}/me/payslips`).set(bearer(token))).body.code).toBe('PASSWORD_RESET_REQUIRED');
    expect(
      (await hq.http.post(`${api}/auth/password`).set(bearer(token)).send({ current: PASSWORD, password: 'my-own-long-password' })).status,
    ).toBe(200);
    token = await login('sami', 'my-own-long-password');
    expect((await hq.http.get(`${api}/me/employee`).set(bearer(token))).body).toMatchObject({ code: 'SAMI' });
  });

  it('lists only their own PAID slips, shows no employer cost or rules, and another slip is "not found"', async () => {
    const list = (await hq.http.get(`${api}/me/payslips`).set(bearer(token))).body.data as { id: number; netMinor: number }[];
    expect(list.map((s) => s.id)).toEqual([samiPaid]); // not the calculated run's slip, not Lina's
    const own = await hq.http.get(`${api}/me/payslips/${samiPaid}`).set(bearer(token));
    expect(own.status).toBe(200);
    expect(own.body.netMinor).toBe(1_862_000);
    expect(own.body.earnings.map((l: { label: string }) => l.label)).toEqual(['Hours worked', 'Overtime']);
    expect(JSON.stringify(own.body)).not.toMatch(/employer|"rules"|profile|:190000[,}]/i);
    expect((await hq.http.get(`${api}/me/payslips/${samiOpen}`).set(bearer(token))).status).toBe(404); // not paid yet
    expect((await hq.http.get(`${api}/me/payslips/${linaPaid}`).set(bearer(token))).status).toBe(404); // someone else's
    expect((await hq.http.post(`${api}/me/payslips/${linaPaid}/print-link`).set(bearer(token)).send({})).status).toBe(404);
  });

  it('their attendance is theirs alone', async () => {
    const punch = (id: number, employeeId: number, kind: string, at: string) =>
      run(
        `INSERT INTO attendance_punches (branch_id, id, employee_id, kind, user_id, created_at, hq_received_at) VALUES (?, ?, ?, ?, NULL, ?, 'x')`,
        [branch, id, employeeId, kind, at],
      );
    await punch(1, sami, 'in', '2026-11-10T06:00:00.000Z');
    await punch(2, sami, 'out', '2026-11-10T14:00:00.000Z');
    await punch(3, lina, 'in', '2026-11-10T06:00:00.000Z');
    await punch(4, lina, 'out', '2026-11-10T12:00:00.000Z');
    const r = (await hq.http.get(`${api}/me/attendance?from=2026-11-09&to=2026-11-12`).set(bearer(token))).body;
    expect(r.data).toHaveLength(1);
    expect(r.data[0]).toMatchObject({ day: '2026-11-10', minutes: 480 });
    expect(JSON.stringify(r)).not.toContain('branch');
    // and nothing outside self-service: not the people list, not the reports, not pay
    for (const p of ['/employees', '/reports/overview', '/payroll/runs', '/attendance/days', '/branches'])
      expect((await hq.http.get(`${api}${p}`).set(bearer(token))).status).toBe(403);
    // the other way round: HQ staff have no "self"
    expect((await hq.http.get(`${api}/me/payslips`).set(adminAuth)).status).toBe(403);
    expect((await hq.http.get(`${api}/me/payslips`).set(bearer(await login('payperson')))).status).toBe(403);
  });

  it('an employee can print their own payslip, once, from a link', async () => {
    const link = await hq.http.post(`${api}/me/payslips/${samiPaid}/print-link`).set(bearer(token)).send({ lang: 'en' });
    expect(link.status).toBe(201);
    expect((await hq.http.get(link.body.url)).status).toBe(200);
    expect((await hq.http.get(link.body.url)).status).toBe(404); // used
  });
});

describe('the print page (US-HR-payslips)', () => {
  it('is Arabic or English, escapes everything, carries no script, and works once', async () => {
    const pay = await login('payperson');
    const link = (await hq.http.post(`${api}/payroll/payslips/${samiPaid}/print-link`).set(bearer(pay)).send({ lang: 'ar' })).body as {
      url: string;
    };
    const page = await hq.http.get(link.url);
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.headers['cache-control']).toContain('no-store');
    expect(page.text).toContain('dir="rtl"');
    expect(page.text).toContain('قسيمة الراتب');
    expect(page.text).toContain('الراتب الإجمالي');
    expect(page.text).toContain('1,862,000 L.L.');
    expect(page.text).toContain('Sami &lt;b&gt;&quot;Khoury&quot;&lt;/b&gt; &amp; Sons'); // the name, escaped
    expect(page.text).not.toContain('<b>');
    expect(page.text).not.toMatch(/<script/i);
    expect(page.text).not.toContain('190,000'); // the employer's cost is not on the employee's page
    expect((await hq.http.get(link.url)).status).toBe(404);
    const en = await hq.http.get(
      ((await hq.http.post(`${api}/payroll/payslips/${samiPaid}/print-link`).set(bearer(pay)).send({})).body as { url: string }).url,
    );
    expect(en.text).toContain('dir="ltr"');
    expect(en.text).toContain('Net pay');
  });

  it('refuses a made-up, a used and an expired link the same way', async () => {
    expect((await hq.http.get(`${api}/print/payslips/${'x'.repeat(43)}`)).status).toBe(404);
    expect((await hq.http.get(`${api}/print/payslips/short`)).status).toBe(400);
    const pay = await login('payperson');
    const url = ((await hq.http.post(`${api}/payroll/payslips/${linaPaid}/print-link`).set(bearer(pay)).send({})).body as { url: string })
      .url;
    await run("UPDATE print_tokens SET expires_at = '2000-01-01T00:00:00.000Z'");
    expect((await hq.http.get(url)).status).toBe(404);
    // only a hash of the link is kept
    const stored = JSON.stringify(await hq.app.database.all('SELECT token_hash FROM print_tokens'));
    expect(stored).not.toContain(url.split('/').pop()!);
  });
});

describe('every view and print is audited (US-HR-payslips)', () => {
  it('says who and which slip, never an amount', async () => {
    const rows = await hq.app.database.all<{ action: string; actor: string | null; detail_json: string | null }>(
      "SELECT action, actor, detail_json FROM hq_audit WHERE action LIKE 'payslip.%' ORDER BY id",
    );
    const actions = new Set(rows.map((r) => r.action));
    for (const a of ['payslip.view', 'payslip.print_link', 'payslip.print']) expect(actions.has(a)).toBe(true);
    expect(rows.some((r) => r.action === 'payslip.view' && r.actor?.includes('sami'))).toBe(true); // an employee viewing their own
    expect(rows.some((r) => r.action === 'payslip.print' && r.actor?.includes('payperson'))).toBe(true); // the printer is whoever made the link
    const text = JSON.stringify(rows);
    for (const amount of ['1862000', '2000000', '190000', '38000', '1900000']) expect(text).not.toContain(amount);
  });
});
