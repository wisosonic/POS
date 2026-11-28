import type { Queryable } from '@pos/core/adapter';
import { AppError } from '@pos/core/errors';
import { calculatePayslip, type PayProfile, type PayRule, type PayType } from '@pos/shared/payroll';
import type { Currency } from '@pos/shared/money';
import { attendanceDays } from '../hr/service';
import { absenceSummary } from '../hr/schedule';
import { writeAudit } from '../staff/context';

// Payroll at HQ (docs/16 §5, P6b). Salary data lives here and nowhere else. The arithmetic is `calculatePayslip` in `shared` (pure, integer, tested with
// golden cases); this file gathers its inputs (the profile and rules in force for the period, the attendance, manual lines, loans), refuses to run on
// a branch that has not caught up, and walks a run through draft -> calculated -> approved -> paid -> locked. Money never goes into a log line.

const nowIso = () => new Date().toISOString();
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// ------------------------------------------------------------------ profiles

export type ProfileInput = {
  effectiveFrom: string;
  type: PayType;
  baseMinor: number;
  currency: Currency;
  overtimeAfterMinutes: number | null;
  overtimeBp: number;
  standardDayMinutes: number;
  workDaysPerMonth: number;
  dailyMinMinutes: number;
  ruleCodes: string[];
};

type ProfileRow = {
  id: number;
  employee_id: number;
  effective_from: string;
  type: PayType;
  base_minor: number;
  currency: Currency;
  overtime_after_minutes: number | null;
  overtime_bp: number;
  standard_day_minutes: number;
  work_days_per_month: number;
  daily_min_minutes: number;
  rule_codes: string;
  created_at: string;
};

const profileJson = (r: ProfileRow) => ({
  id: r.id,
  employeeId: r.employee_id,
  effectiveFrom: r.effective_from,
  type: r.type,
  baseMinor: r.base_minor,
  currency: r.currency,
  overtimeAfterMinutes: r.overtime_after_minutes,
  overtimeBp: r.overtime_bp,
  standardDayMinutes: r.standard_day_minutes,
  workDaysPerMonth: r.work_days_per_month,
  dailyMinMinutes: r.daily_min_minutes,
  ruleCodes: r.rule_codes === '' ? [] : r.rule_codes.split(','),
  createdAt: r.created_at,
});

const toProfile = (r: ProfileRow): PayProfile => ({
  type: r.type,
  baseMinor: r.base_minor,
  currency: r.currency,
  overtimeAfterMinutes: r.overtime_after_minutes,
  overtimeBp: r.overtime_bp,
  standardDayMinutes: r.standard_day_minutes,
  workDaysPerMonth: r.work_days_per_month,
  dailyMinMinutes: r.daily_min_minutes,
  ruleCodes: r.rule_codes === '' ? [] : r.rule_codes.split(','),
});

/** A new profile for an employee from a day on. Profiles are never edited: the latest one that has begun is the one in force. */
export async function setProfile(q: Queryable, employeeId: number, p: ProfileInput): Promise<number> {
  if (!DAY.test(p.effectiveFrom)) throw new AppError(422, 'VALIDATION', 'The day must look like 2026-11-30');
  if (!(await q.one('SELECT 1 AS x FROM employees WHERE id = ?', [employeeId]))) throw new AppError(404, 'NOT_FOUND', 'Employee not found');
  for (const code of p.ruleCodes)
    if (!(await q.one('SELECT 1 AS x FROM payroll_rules WHERE code = ?', [code])))
      throw new AppError(422, 'UNKNOWN_RULE', `There is no payroll rule "${code}"`);
  const made = await q.one<{ id: number }>(
    `INSERT INTO pay_profiles (employee_id, effective_from, type, base_minor, currency, overtime_after_minutes, overtime_bp, standard_day_minutes,
                               work_days_per_month, daily_min_minutes, rule_codes, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT actor FROM hq_context WHERE id = 1), ?) RETURNING id`,
    [
      employeeId,
      p.effectiveFrom,
      p.type,
      p.baseMinor,
      p.currency,
      p.overtimeAfterMinutes,
      p.overtimeBp,
      p.standardDayMinutes,
      p.workDaysPerMonth,
      p.dailyMinMinutes,
      p.ruleCodes.join(','),
      nowIso(),
    ],
  );
  await writeAudit(q, 'payroll.profile', 'employee', employeeId, { profileId: made!.id, effectiveFrom: p.effectiveFrom, type: p.type }); // never the amount
  return made!.id;
}

export async function listProfiles(q: Queryable, employeeId: number) {
  return (
    await q.all<ProfileRow>('SELECT * FROM pay_profiles WHERE employee_id = ? ORDER BY effective_from DESC, id DESC', [employeeId])
  ).map(profileJson);
}

// ------------------------------------------------------------------ rules

export type RuleInput = {
  code: string;
  name: string;
  kind: 'percent' | 'brackets';
  side: 'employee' | 'employer';
  base: 'gross' | 'taxable';
  reducesTax: boolean;
  currency: Currency;
  rateBp: number;
  capBaseMinor: number | null;
  brackets: { fromMinor: number; rateBp: number }[];
  effectiveFrom: string;
};

export async function addRule(q: Queryable, r: RuleInput): Promise<number> {
  if (!DAY.test(r.effectiveFrom)) throw new AppError(422, 'VALIDATION', 'The day must look like 2026-11-30');
  if (r.kind === 'brackets' && r.brackets.length === 0) throw new AppError(422, 'VALIDATION', 'A scale needs at least one bracket');
  if (r.kind === 'brackets' && new Set(r.brackets.map((b) => b.fromMinor)).size !== r.brackets.length)
    throw new AppError(422, 'VALIDATION', 'Two brackets start at the same amount');
  if (r.side === 'employer' && r.base === 'taxable') throw new AppError(422, 'VALIDATION', 'An employer cost is worked out on the gross');
  const made = await q.one<{ id: number }>(
    `INSERT INTO payroll_rules (code, name, kind, side, base, reduces_tax, currency, rate_bp, cap_base_minor, effective_from, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT actor FROM hq_context WHERE id = 1), ?) RETURNING id`,
    [r.code, r.name, r.kind, r.side, r.base, r.reducesTax ? 1 : 0, r.currency, r.rateBp, r.capBaseMinor, r.effectiveFrom, nowIso()],
  );
  for (const b of r.brackets)
    await q.run('INSERT INTO payroll_rule_brackets (rule_id, from_minor, rate_bp) VALUES (?, ?, ?)', [made!.id, b.fromMinor, b.rateBp]);
  await writeAudit(q, 'payroll.rule', 'payroll-rule', made!.id, { code: r.code, effectiveFrom: r.effectiveFrom });
  return made!.id;
}

type RuleRow = {
  id: number;
  code: string;
  name: string;
  kind: 'percent' | 'brackets';
  side: 'employee' | 'employer';
  base: 'gross' | 'taxable';
  reduces_tax: number;
  currency: Currency;
  rate_bp: number;
  cap_base_minor: number | null;
  effective_from: string;
};

async function bracketsOf(q: Queryable, ruleId: number) {
  return (
    await q.all<{ from_minor: number; rate_bp: number }>(
      'SELECT from_minor, rate_bp FROM payroll_rule_brackets WHERE rule_id = ? ORDER BY from_minor',
      [ruleId],
    )
  ).map((b) => ({ fromMinor: b.from_minor, rateBp: b.rate_bp }));
}

export async function listRules(q: Queryable) {
  const rows = await q.all<RuleRow>('SELECT * FROM payroll_rules ORDER BY code, effective_from DESC, id DESC');
  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      kind: r.kind,
      side: r.side,
      base: r.base,
      reducesTax: r.reduces_tax === 1,
      currency: r.currency,
      rateBp: r.rate_bp,
      capBaseMinor: r.cap_base_minor,
      brackets: await bracketsOf(q, r.id),
      effectiveFrom: r.effective_from,
    })),
  );
}

/** The rule in force for each code on a day: the latest that has begun. */
async function rulesInForce(
  q: Queryable,
  day: string,
): Promise<{ rules: PayRule[]; versions: { code: string; ruleId: number; effectiveFrom: string }[] }> {
  const rows = await q.all<RuleRow>(
    `SELECT r.* FROM payroll_rules r
      WHERE r.effective_from <= ? AND r.id = (SELECT r2.id FROM payroll_rules r2 WHERE r2.code = r.code AND r2.effective_from <= ?
                                               ORDER BY r2.effective_from DESC, r2.id DESC LIMIT 1)
      ORDER BY r.code`,
    [day, day],
  );
  const rules: PayRule[] = [];
  for (const r of rows)
    rules.push({
      code: r.code,
      name: r.name,
      kind: r.kind,
      side: r.side,
      base: r.base,
      reducesTax: r.reduces_tax === 1,
      currency: r.currency,
      rateBp: r.rate_bp,
      capBaseMinor: r.cap_base_minor,
      brackets: await bracketsOf(q, r.id),
    });
  return { rules, versions: rows.map((r) => ({ code: r.code, ruleId: r.id, effectiveFrom: r.effective_from })) };
}

// ------------------------------------------------------------------ loans

export async function createLoan(
  q: Queryable,
  l: { employeeId: number; principalMinor: number; currency: Currency; installmentMinor: number; note: string | null },
): Promise<number> {
  if (!(await q.one('SELECT 1 AS x FROM employees WHERE id = ?', [l.employeeId])))
    throw new AppError(404, 'NOT_FOUND', 'Employee not found');
  if (l.installmentMinor > l.principalMinor) throw new AppError(422, 'VALIDATION', 'An installment cannot be more than the loan');
  const made = await q.one<{ id: number }>(
    `INSERT INTO loans (employee_id, principal_minor, currency, installment_minor, note, actor, created_at)
     VALUES (?, ?, ?, ?, ?, (SELECT actor FROM hq_context WHERE id = 1), ?) RETURNING id`,
    [l.employeeId, l.principalMinor, l.currency, l.installmentMinor, l.note, nowIso()],
  );
  await writeAudit(q, 'payroll.loan', 'employee', l.employeeId, { loanId: made!.id });
  return made!.id;
}

export async function listLoans(q: Queryable, employeeId?: number) {
  const rows = await q.all<{
    id: number;
    employee_id: number;
    principal_minor: number;
    currency: Currency;
    installment_minor: number;
    note: string | null;
    created_at: string;
    repaid: number;
  }>(
    `SELECT l.*, COALESCE((SELECT SUM(amount_minor) FROM loan_repayments r WHERE r.loan_id = l.id), 0) AS repaid
       FROM loans l ${employeeId === undefined ? '' : 'WHERE l.employee_id = ?'} ORDER BY l.id DESC`,
    employeeId === undefined ? [] : [employeeId],
  );
  return rows.map((l) => ({
    id: l.id,
    employeeId: l.employee_id,
    principalMinor: l.principal_minor,
    currency: l.currency,
    installmentMinor: l.installment_minor,
    note: l.note,
    repaidMinor: l.repaid,
    remainingMinor: l.principal_minor - l.repaid,
    createdAt: l.created_at,
  }));
}

// ------------------------------------------------------------------ runs

type RunRow = {
  id: number;
  from_day: string;
  to_day: string;
  status: 'draft' | 'calculated' | 'approved' | 'paid' | 'locked';
  note: string | null;
  rate_lbp_per_usd: number | null;
  warnings_json: string | null;
  created_at: string;
  calculated_at: string | null;
  approved_at: string | null;
  paid_at: string | null;
  locked_at: string | null;
};

const getRun = async (q: Queryable, id: number): Promise<RunRow> => {
  const r = await q.one<RunRow>('SELECT * FROM payroll_runs WHERE id = ?', [id]);
  if (!r) throw new AppError(404, 'NOT_FOUND', 'Payroll run not found');
  return r;
};

export async function createRun(q: Queryable, r: { fromDay: string; toDay: string; note: string | null }): Promise<number> {
  if (!DAY.test(r.fromDay) || !DAY.test(r.toDay)) throw new AppError(422, 'VALIDATION', 'The days must look like 2026-11-30');
  if (r.fromDay > r.toDay) throw new AppError(422, 'VALIDATION', 'The period starts after it ends');
  const overlap = await q.one<{ id: number }>(
    `SELECT id FROM payroll_runs WHERE from_day <= ? AND to_day >= ? AND status IN ('approved', 'paid', 'locked') LIMIT 1`,
    [r.toDay, r.fromDay],
  );
  if (overlap) throw new AppError(409, 'PERIOD_ALREADY_PAID', `Run ${overlap.id} already covers part of that period and is approved`);
  const made = await q.one<{ id: number }>(
    `INSERT INTO payroll_runs (from_day, to_day, status, note, actor, created_at)
     VALUES (?, ?, 'draft', ?, (SELECT actor FROM hq_context WHERE id = 1), ?) RETURNING id`,
    [r.fromDay, r.toDay, r.note, nowIso()],
  );
  await writeAudit(q, 'payroll.run.create', 'payroll-run', made!.id, { fromDay: r.fromDay, toDay: r.toDay });
  return made!.id;
}

export async function addInput(
  q: Queryable,
  runId: number,
  i: { employeeId: number; kind: 'earning' | 'deduction'; label: string; amountMinor: number },
): Promise<number> {
  const run = await getRun(q, runId);
  if (run.status !== 'draft' && run.status !== 'calculated')
    throw new AppError(409, 'RUN_FROZEN', 'This payroll run is approved: add the line to the next run');
  if (!(await q.one('SELECT 1 AS x FROM employees WHERE id = ?', [i.employeeId])))
    throw new AppError(404, 'NOT_FOUND', 'Employee not found');
  const made = await q.one<{ id: number }>(
    'INSERT INTO payroll_inputs (run_id, employee_id, kind, label, amount_minor, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
    [runId, i.employeeId, i.kind, i.label, i.amountMinor, nowIso()],
  );
  await writeAudit(q, 'payroll.input.add', 'payroll-run', runId, { inputId: made!.id, employeeId: i.employeeId, kind: i.kind });
  return made!.id;
}

export async function removeInput(q: Queryable, runId: number, inputId: number): Promise<void> {
  const run = await getRun(q, runId);
  if (run.status !== 'draft' && run.status !== 'calculated') throw new AppError(409, 'RUN_FROZEN', 'This payroll run is approved');
  const gone = await q.run('DELETE FROM payroll_inputs WHERE id = ? AND run_id = ?', [inputId, runId]);
  if (!gone.changes) throw new AppError(404, 'NOT_FOUND', 'Input not found');
  await writeAudit(q, 'payroll.input.remove', 'payroll-run', runId, { inputId });
}

type Warning = { employeeId: number | null; code: string; message: string };

/**
 * The gate (docs/16 §5): payroll is worked out from attendance, so it refuses while a connected branch has not caught up to the period's last day. "Caught
 * up" is what the daily control already proves (docs/12 §24): the branch compared what it holds with HQ's copy for that day and they agree.
 */
async function behindBranches(q: Queryable, toDay: string, employeeIds: number[]): Promise<string[]> {
  if (employeeIds.length === 0) return [];
  const rows = await q.all<{ id: number; name: string; ok: number | null }>(
    `SELECT b.id, b.name, (SELECT COUNT(*) FROM reconciliations c WHERE c.branch_id = b.id AND c.day = ? AND c.status = 'ok') AS ok
       FROM branches b
      WHERE b.active = 1 AND b.enrolled_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM employee_branches eb JOIN employees e ON e.id = eb.employee_id
                     WHERE eb.branch_id = b.id AND e.active = 1 AND e.id IN (${employeeIds.map(() => '?').join(',')}))`,
    [toDay, ...employeeIds],
  );
  return rows.filter((r) => !r.ok).map((r) => r.name);
}

/** Work out every payslip of a run from the attendance, the profiles and rules in force, the manual lines and the loans. Can be repeated until the run is approved. */
export async function calculateRun(
  q: Queryable,
  runId: number,
  now = new Date(),
): Promise<{ payslips: number; skipped: Warning[]; warnings: Warning[] }> {
  const run = await getRun(q, runId);
  if (run.status !== 'draft' && run.status !== 'calculated') throw new AppError(409, 'RUN_FROZEN', 'This payroll run is already approved');
  if (run.to_day >= now.toISOString().slice(0, 10))
    throw new AppError(409, 'PERIOD_NOT_FINISHED', 'The last day of the period has not finished yet');

  const profiles = await q.all<ProfileRow & { code: string; name: string }>(
    `SELECT p.*, e.code, e.name FROM pay_profiles p JOIN employees e ON e.id = p.employee_id
      WHERE e.active = 1 AND p.effective_from <= ?
        AND p.id = (SELECT p2.id FROM pay_profiles p2 WHERE p2.employee_id = p.employee_id AND p2.effective_from <= ? ORDER BY p2.effective_from DESC, p2.id DESC LIMIT 1)
      ORDER BY e.name, e.id`,
    [run.to_day, run.to_day],
  );
  const late = await behindBranches(
    q,
    run.to_day,
    profiles.map((p) => p.employee_id),
  );
  if (late.length > 0)
    throw new AppError(
      409,
      'BRANCH_BEHIND',
      `Payroll waits for the attendance of: ${late.join(', ')}. Their last day of the period has not been confirmed yet.`,
    );

  const skipped: Warning[] = [];
  for (const e of await q.all<{ id: number; name: string }>(
    `SELECT id, name FROM employees WHERE active = 1 AND id NOT IN (${profiles.length ? profiles.map(() => '?').join(',') : 'NULL'})`,
    profiles.map((p) => p.employee_id),
  ))
    skipped.push({ employeeId: e.id, code: 'NO_PAY_PROFILE', message: `${e.name} has no pay profile in force on ${run.to_day}` });

  const rate = (
    await q.one<{ r: number }>(
      'SELECT rate_lbp_per_usd AS r FROM exchange_rates WHERE effective_from <= ? ORDER BY effective_from DESC, id DESC LIMIT 1',
      [now.toISOString()],
    )
  )?.r;
  if (!rate) throw new AppError(409, 'NO_EXCHANGE_RATE', 'Set the exchange rate first: payroll records the rate it used');

  const { rules, versions } = await rulesInForce(q, run.to_day);
  const attendance = await attendanceDays(q, { from: run.from_day, to: run.to_day });
  const warnings: Warning[] = [];
  // The roster knows who should have worked: absence and unpaid leave are listed so HR can enter a deduction (a manual line); pay is not changed by them.
  const absences = await absenceSummary(q, run.from_day, run.to_day, now.toISOString().slice(0, 10));
  const inputs = await q.all<{ employee_id: number; kind: 'earning' | 'deduction'; label: string; amount_minor: number }>(
    'SELECT employee_id, kind, label, amount_minor FROM payroll_inputs WHERE run_id = ? ORDER BY id',
    [runId],
  );

  // Redo the slips: the run is not approved, so the triggers allow it.
  await q.run('DELETE FROM payslip_lines WHERE payslip_id IN (SELECT id FROM payslips WHERE run_id = ?)', [runId]);
  await q.run('DELETE FROM payslips WHERE run_id = ?', [runId]);

  const loansAll = await listLoans(q);
  let made = 0;
  for (const row of profiles) {
    const mine = attendance.filter((d) => d.employeeId === row.employee_id);
    for (const d of mine.filter((x) => x.flags.length > 0))
      warnings.push({ employeeId: row.employee_id, code: 'ATTENDANCE_FLAGS', message: `${row.name}: ${d.day} is ${d.flags.join(', ')}` });
    const gone = absences.get(row.employee_id);
    if (gone && (gone.absent > 0 || gone.unpaidLeave > 0))
      warnings.push({
        employeeId: row.employee_id,
        code: 'ABSENCE',
        message: `${row.name}: ${gone.absent} day(s) absent and ${gone.unpaidLeave} day(s) of unpaid leave on the roster: add a deduction if it applies`,
      });
    const loans = loansAll.filter((l) => l.employeeId === row.employee_id && l.remainingMinor > 0);
    for (const l of loans.filter((x) => x.currency !== row.currency))
      warnings.push({
        employeeId: row.employee_id,
        code: 'LOAN_CURRENCY',
        message: `${row.name}: loan ${l.id} is in ${l.currency} but pay is in ${row.currency}: not deducted`,
      });
    const profile = toProfile(row);
    const slip = calculatePayslip({
      profile,
      days: mine.map((d) => ({ day: d.day, minutes: d.minutes })),
      rules,
      rate,
      manual: inputs
        .filter((i) => i.employee_id === row.employee_id)
        .map((i) => ({ kind: i.kind, label: i.label, amountMinor: i.amount_minor })),
      loans: loans
        .filter((l) => l.currency === row.currency)
        .map((l) => ({ id: l.id, label: `Loan ${l.id}`, remainingMinor: l.remainingMinor, installmentMinor: l.installmentMinor })),
    });
    if (slip.netMinor < 0)
      warnings.push({ employeeId: row.employee_id, code: 'NEGATIVE_NET', message: `${row.name}: the deductions are more than the pay` });
    const employerCost = slip.employerCosts.reduce((s, l) => s + l.amountMinor, 0);
    const usedRules = versions.filter((v) => profile.ruleCodes.includes(v.code));
    const slipRow = await q.one<{ id: number }>(
      `INSERT INTO payslips (run_id, employee_id, employee_code, employee_name, currency, days_worked, regular_minutes, overtime_minutes, gross_minor,
                             deductions_minor, net_minor, employer_cost_minor, profile_json, rules_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [
        runId,
        row.employee_id,
        row.code,
        row.name,
        slip.currency,
        slip.daysWorked,
        slip.regularMinutes,
        slip.overtimeMinutes,
        slip.grossMinor,
        slip.deductionsMinor,
        slip.netMinor,
        employerCost,
        JSON.stringify({ ...profileJson(row), rateLbpPerUsd: rate }),
        JSON.stringify(usedRules),
        nowIso(),
      ],
    );
    let position = 0;
    for (const [side, lines] of [
      ['earning', slip.earnings],
      ['deduction', slip.deductions],
      ['employer', slip.employerCosts],
    ] as const)
      for (const l of lines)
        await q.run('INSERT INTO payslip_lines (payslip_id, side, code, label, amount_minor, position) VALUES (?, ?, ?, ?, ?, ?)', [
          slipRow!.id,
          side,
          l.code,
          l.label,
          l.amountMinor,
          position++,
        ]);
    made += 1;
  }
  await q.run('UPDATE payroll_runs SET status = ?, rate_lbp_per_usd = ?, warnings_json = ?, calculated_at = ? WHERE id = ?', [
    'calculated',
    rate,
    JSON.stringify([...skipped, ...warnings]),
    nowIso(),
    runId,
  ]);
  await writeAudit(q, 'payroll.run.calculate', 'payroll-run', runId, {
    payslips: made,
    skipped: skipped.length,
    warnings: warnings.length,
  });
  return { payslips: made, skipped, warnings };
}

export async function approveRun(q: Queryable, runId: number): Promise<void> {
  const run = await getRun(q, runId);
  if (run.status !== 'calculated')
    throw new AppError(409, 'RUN_NOT_CALCULATED', 'Calculate the run first (a run is approved only once calculated)');
  await q.run('UPDATE payroll_runs SET status = ?, approved_at = ? WHERE id = ?', ['approved', nowIso(), runId]);
  await writeAudit(q, 'payroll.run.approve', 'payroll-run', runId);
}

/** Mark the run paid: each loan installment taken on a slip becomes a repayment, so what is owed goes down exactly once. */
export async function payRun(q: Queryable, runId: number): Promise<void> {
  const run = await getRun(q, runId);
  if (run.status !== 'approved') throw new AppError(409, 'RUN_NOT_APPROVED', 'Approve the run before it is paid');
  const lines = await q.all<{ slip: number; code: string; amount_minor: number }>(
    `SELECT s.id AS slip, l.code, l.amount_minor FROM payslip_lines l JOIN payslips s ON s.id = l.payslip_id
      WHERE s.run_id = ? AND l.side = 'deduction' AND l.code LIKE 'loan:%'`,
    [runId],
  );
  const now = nowIso();
  for (const l of lines)
    await q.run('INSERT INTO loan_repayments (loan_id, payslip_id, amount_minor, created_at) VALUES (?, ?, ?, ?)', [
      Number(l.code.slice(5)),
      l.slip,
      l.amount_minor,
      now,
    ]);
  await q.run('UPDATE payroll_runs SET status = ?, paid_at = ? WHERE id = ?', ['paid', now, runId]);
  await writeAudit(q, 'payroll.run.pay', 'payroll-run', runId, { repayments: lines.length });
}

export async function lockRun(q: Queryable, runId: number): Promise<void> {
  const run = await getRun(q, runId);
  if (run.status !== 'paid') throw new AppError(409, 'RUN_NOT_PAID', 'Only a paid run can be locked');
  await q.run('UPDATE payroll_runs SET status = ?, locked_at = ? WHERE id = ?', ['locked', nowIso(), runId]);
  await writeAudit(q, 'payroll.run.lock', 'payroll-run', runId);
}

export type Line = { side: string; code: string; label: string; amountMinor: number };

export async function runJson(q: Queryable, id: number, withSlips = true) {
  const r = await getRun(q, id);
  const totals = await q.all<{ currency: Currency; gross: number; deductions: number; net: number; employer: number; n: number }>(
    `SELECT currency, SUM(gross_minor) AS gross, SUM(deductions_minor) AS deductions, SUM(net_minor) AS net, SUM(employer_cost_minor) AS employer, COUNT(*) AS n
       FROM payslips WHERE run_id = ? GROUP BY currency`,
    [id],
  );
  const slips = withSlips
    ? await Promise.all(
        (
          await q.all<{
            id: number;
            employee_id: number;
            employee_code: string;
            employee_name: string;
            currency: Currency;
            days_worked: number;
            regular_minutes: number;
            overtime_minutes: number;
            gross_minor: number;
            deductions_minor: number;
            net_minor: number;
            employer_cost_minor: number;
            rules_json: string;
          }>('SELECT * FROM payslips WHERE run_id = ? ORDER BY employee_name, id', [id])
        ).map(async (s) => ({
          id: s.id,
          employeeId: s.employee_id,
          employeeCode: s.employee_code,
          employeeName: s.employee_name,
          currency: s.currency,
          daysWorked: s.days_worked,
          regularMinutes: s.regular_minutes,
          overtimeMinutes: s.overtime_minutes,
          grossMinor: s.gross_minor,
          deductionsMinor: s.deductions_minor,
          netMinor: s.net_minor,
          employerCostMinor: s.employer_cost_minor,
          rules: JSON.parse(s.rules_json) as unknown,
          lines: (
            await q.all<{ side: string; code: string; label: string; amount_minor: number }>(
              'SELECT side, code, label, amount_minor FROM payslip_lines WHERE payslip_id = ? ORDER BY position',
              [s.id],
            )
          ).map((l): Line => ({ side: l.side, code: l.code, label: l.label, amountMinor: l.amount_minor })),
        })),
      )
    : undefined;
  return {
    id: r.id,
    fromDay: r.from_day,
    toDay: r.to_day,
    status: r.status,
    note: r.note,
    rateLbpPerUsd: r.rate_lbp_per_usd,
    warnings: r.warnings_json ? (JSON.parse(r.warnings_json) as Warning[]) : [],
    createdAt: r.created_at,
    calculatedAt: r.calculated_at,
    approvedAt: r.approved_at,
    paidAt: r.paid_at,
    lockedAt: r.locked_at,
    totals: totals.map((t) => ({
      currency: t.currency,
      payslips: t.n,
      grossMinor: t.gross,
      deductionsMinor: t.deductions,
      netMinor: t.net,
      employerCostMinor: t.employer,
    })),
    ...(slips ? { payslips: slips } : {}),
  };
}

export async function listRuns(q: Queryable) {
  const ids = await q.all<{ id: number }>('SELECT id FROM payroll_runs ORDER BY id DESC LIMIT 100');
  return Promise.all(ids.map((r) => runJson(q, r.id, false)));
}
