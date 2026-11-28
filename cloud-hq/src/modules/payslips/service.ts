import type { Queryable } from '@pos/core/adapter';
import { newToken, sha256 } from '@pos/core/credentials';
import { AppError } from '@pos/core/errors';
import { writeAudit } from '../staff/context';
import { createUser } from '../staff/users';
import type { SlipView } from './render';

// Payslip viewing, print links and employee self-service (docs/16 §7, P6c). Pay data stays at HQ and is read by payroll (and admin) or, for their OWN paid
// slips only, by the employee. Every view, print link and print is audited (who and which slip, never an amount).

const nowIso = () => new Date().toISOString();
const PRINT_LINK_SECONDS = 120;

type SlipRow = {
  id: number;
  run_id: number;
  employee_id: number;
  employee_code: string;
  employee_name: string;
  currency: 'LBP' | 'USD';
  days_worked: number;
  regular_minutes: number;
  overtime_minutes: number;
  gross_minor: number;
  deductions_minor: number;
  net_minor: number;
  employer_cost_minor: number;
  from_day: string;
  to_day: string;
  status: string;
};

async function slipRow(q: Queryable, id: number): Promise<SlipRow> {
  const r = await q.one<SlipRow>(
    `SELECT s.*, r.from_day, r.to_day, r.status FROM payslips s JOIN payroll_runs r ON r.id = s.run_id WHERE s.id = ?`,
    [id],
  );
  if (!r) throw new AppError(404, 'NOT_FOUND', 'Payslip not found');
  return r;
}

const linesOf = (q: Queryable, id: number) =>
  q.all<{ side: string; code: string; label: string; amount_minor: number }>(
    'SELECT side, code, label, amount_minor FROM payslip_lines WHERE payslip_id = ? ORDER BY position',
    [id],
  );

/** What an employee (and the printed page) shows: earnings and deductions, never the employer's costs, the rules or the pay profile. */
export async function slipView(q: Queryable, id: number): Promise<SlipView> {
  const s = await slipRow(q, id);
  const lines = await linesOf(q, id);
  return {
    employeeName: s.employee_name,
    employeeCode: s.employee_code,
    fromDay: s.from_day,
    toDay: s.to_day,
    currency: s.currency,
    daysWorked: s.days_worked,
    regularMinutes: s.regular_minutes,
    overtimeMinutes: s.overtime_minutes,
    grossMinor: s.gross_minor,
    deductionsMinor: s.deductions_minor,
    netMinor: s.net_minor,
    earnings: lines.filter((l) => l.side === 'earning').map((l) => ({ label: l.label, amountMinor: l.amount_minor })),
    deductions: lines.filter((l) => l.side === 'deduction').map((l) => ({ label: l.label, amountMinor: l.amount_minor })),
  };
}

/** The payroll staff's view of one slip: the employee's view plus the run it belongs to and what it cost the company. */
export async function slipForPayroll(q: Queryable, id: number) {
  const s = await slipRow(q, id);
  return {
    id: s.id,
    runId: s.run_id,
    runStatus: s.status,
    employeeId: s.employee_id,
    employerCostMinor: s.employer_cost_minor,
    ...(await slipView(q, id)),
  };
}

/** The employee a signed-in self-service account belongs to. */
export async function employeeOfUser(q: Queryable, userId: number | null): Promise<number> {
  const r =
    userId === null
      ? undefined
      : await q.one<{ employee_id: number }>('SELECT employee_id FROM employee_accounts WHERE user_id = ?', [userId]);
  if (!r) throw new AppError(403, 'NOT_AN_EMPLOYEE', 'This account is not linked to an employee');
  return r.employee_id;
}

/** An employee's own slips: only those of a run that has been paid. */
export async function ownSlips(q: Queryable, employeeId: number) {
  return (
    await q.all<{ id: number; from_day: string; to_day: string; currency: 'LBP' | 'USD'; net_minor: number; status: string }>(
      `SELECT s.id, r.from_day, r.to_day, s.currency, s.net_minor, r.status FROM payslips s JOIN payroll_runs r ON r.id = s.run_id
        WHERE s.employee_id = ? AND r.status IN ('paid', 'locked') ORDER BY r.to_day DESC, s.id DESC LIMIT 60`,
      [employeeId],
    )
  ).map((s) => ({ id: s.id, fromDay: s.from_day, toDay: s.to_day, currency: s.currency, netMinor: s.net_minor }));
}

/** One of an employee's OWN paid slips. Anyone else's, or one not yet paid, is "not found" (it does not say it exists). */
export async function ownSlipId(q: Queryable, employeeId: number, slipId: number): Promise<number> {
  const r = await q.one<{ id: number }>(
    `SELECT s.id FROM payslips s JOIN payroll_runs r ON r.id = s.run_id WHERE s.id = ? AND s.employee_id = ? AND r.status IN ('paid', 'locked')`,
    [slipId, employeeId],
  );
  if (!r) throw new AppError(404, 'NOT_FOUND', 'Payslip not found');
  return r.id;
}

export async function auditSlip(q: Queryable, action: string, slipId: number): Promise<void> {
  const s = await q.one<{ employee_id: number; run_id: number }>('SELECT employee_id, run_id FROM payslips WHERE id = ?', [slipId]);
  await writeAudit(q, action, 'payslip', slipId, { employeeId: s?.employee_id, runId: s?.run_id });
}

// ------------------------------------------------------------------ print links

/** A one-use link good for two minutes: the browser opens it without a header, so the link itself is the credential. Only its hash is kept. */
export async function createPrintLink(q: Queryable, slipId: number, lang: 'en' | 'ar'): Promise<{ token: string; expiresAt: string }> {
  await slipRow(q, slipId);
  const token = newToken();
  const expiresAt = new Date(Date.now() + PRINT_LINK_SECONDS * 1000).toISOString();
  await q.run(
    `INSERT INTO print_tokens (token_hash, payslip_id, lang, actor, expires_at, created_at)
     VALUES (?, ?, ?, (SELECT actor FROM hq_context WHERE id = 1), ?, ?)`,
    [sha256(token), slipId, lang, expiresAt, nowIso()],
  );
  await auditSlip(q, 'payslip.print_link', slipId);
  return { token, expiresAt };
}

/** Use a link once. A wrong, used or expired link all answer the same, and a used link stays used. */
export async function usePrintLink(q: Queryable, token: string): Promise<{ slipId: number; lang: 'en' | 'ar' }> {
  const row = await q.one<{ id: number; payslip_id: number; lang: 'en' | 'ar'; actor: string | null }>(
    'SELECT id, payslip_id, lang, actor FROM print_tokens WHERE token_hash = ?',
    [sha256(token)],
  );
  const taken = row
    ? await q.run('UPDATE print_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?', [nowIso(), row.id, nowIso()])
    : null;
  if (!row || !taken || taken.changes === 0) throw new AppError(404, 'NOT_FOUND', 'This link is not valid any more');
  const s = await q.one<{ employee_id: number; run_id: number }>('SELECT employee_id, run_id FROM payslips WHERE id = ?', [row.payslip_id]);
  await q.run('INSERT INTO hq_audit (action, entity, entity_id, detail_json, created_at, actor) VALUES (?, ?, ?, ?, ?, ?)', [
    'payslip.print',
    'payslip',
    String(row.payslip_id),
    JSON.stringify({ employeeId: s?.employee_id, runId: s?.run_id }),
    nowIso(),
    row.actor,
  ]);
  return { slipId: row.payslip_id, lang: row.lang };
}

// ------------------------------------------------------------------ employee accounts

/** An account for an employee to see their own attendance and payslips. The first password is the admin's; the person must choose their own (the server enforces it). */
export async function createEmployeeAccount(
  q: Queryable,
  employeeId: number,
  username: string,
  name: string,
  passwordHash: string,
): Promise<number> {
  if (!(await q.one('SELECT 1 AS x FROM employees WHERE id = ?', [employeeId]))) throw new AppError(404, 'NOT_FOUND', 'Employee not found');
  if (await q.one('SELECT 1 AS x FROM employee_accounts WHERE employee_id = ?', [employeeId]))
    throw new AppError(409, 'ACCOUNT_EXISTS', 'This employee already has an account');
  const user = await createUser(q, { username, name, role: 'employee', passwordHash, mustReset: true });
  await q.run('INSERT INTO employee_accounts (employee_id, user_id) VALUES (?, ?)', [employeeId, user.id]);
  await writeAudit(q, 'employee.account', 'employee', employeeId, { username });
  return user.id;
}
