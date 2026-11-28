import type { Queryable } from '@pos/core/adapter';
import { AppError } from '@pos/core/errors';
import { localDay } from '../../util/time';
import { writeAudit } from '../staff/context';

// HR at HQ (docs/16, P6a-1): the employee list, who works where, and the attendance a branch records, turned into worked time. HQ's employee row is what
// a branch is sent (code, name, active, PIN hash: never pay data), to each branch the employee is assigned to and to no other.

const nowIso = () => new Date().toISOString();
const logTo = (q: Queryable, pk: number, branchId: number, op: 'u' | 'd') =>
  q.run('INSERT INTO change_log (tbl, pk, op, created_at, branch_id) VALUES (?, ?, ?, ?, ?)', ['employees', pk, op, nowIso(), branchId]);

type EmployeeRow = { id: number; code: string; name: string; active: number; pin_hash: string | null; created_at: string };

export type EmployeeJson = {
  id: number;
  code: string;
  name: string;
  active: boolean;
  hasPin: boolean;
  branchIds: number[];
  createdAt: string;
};

async function branchIdsOf(q: Queryable, id: number): Promise<number[]> {
  return (await q.all<{ branch_id: number }>('SELECT branch_id FROM employee_branches WHERE employee_id = ? ORDER BY branch_id', [id])).map(
    (r) => r.branch_id,
  );
}

async function json(q: Queryable, e: EmployeeRow): Promise<EmployeeJson> {
  return {
    id: e.id,
    code: e.code,
    name: e.name,
    active: e.active === 1,
    hasPin: e.pin_hash !== null,
    branchIds: await branchIdsOf(q, e.id),
    createdAt: e.created_at,
  };
}

const get = (q: Queryable, id: number) => q.one<EmployeeRow>('SELECT * FROM employees WHERE id = ?', [id]);

export async function listEmployees(q: Queryable, opts: { branchId?: number; active?: boolean; limit: number }): Promise<EmployeeJson[]> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.branchId !== undefined) {
    where.push('id IN (SELECT employee_id FROM employee_branches WHERE branch_id = ?)');
    params.push(opts.branchId);
  }
  if (opts.active !== undefined) {
    where.push('active = ?');
    params.push(opts.active ? 1 : 0);
  }
  const rows = await q.all<EmployeeRow>(
    `SELECT * FROM employees ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY name, id LIMIT ?`,
    [...params, opts.limit],
  );
  return Promise.all(rows.map((r) => json(q, r)));
}

export async function employeeJson(q: Queryable, id: number): Promise<EmployeeJson> {
  const e = await get(q, id);
  if (!e) throw new AppError(404, 'NOT_FOUND', 'Employee not found');
  return json(q, e);
}

/** Tell every assigned branch the employee's current row. */
async function publish(q: Queryable, id: number): Promise<void> {
  for (const b of await branchIdsOf(q, id)) await logTo(q, id, b, 'u');
}

export async function createEmployee(q: Queryable, input: { code: string; name: string; branchIds: number[] }): Promise<number> {
  if (await q.one('SELECT 1 AS x FROM employees WHERE code = ?', [input.code]))
    throw new AppError(409, 'DUPLICATE_CODE', 'Another employee already has that code');
  const now = nowIso();
  const made = await q.one<{ id: number }>(
    'INSERT INTO employees (code, name, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?) RETURNING id',
    [input.code, input.name, now, now],
  );
  const id = made!.id;
  await setBranches(q, id, input.branchIds, true);
  await writeAudit(q, 'employee.create', 'employee', id, { code: input.code, name: input.name, branchIds: input.branchIds });
  return id;
}

export async function updateEmployee(q: Queryable, id: number, patch: { name?: string; active?: boolean }): Promise<void> {
  const before = await get(q, id);
  if (!before) throw new AppError(404, 'NOT_FOUND', 'Employee not found');
  await q.run('UPDATE employees SET name = ?, active = ?, updated_at = ? WHERE id = ?', [
    patch.name ?? before.name,
    patch.active === undefined ? before.active : patch.active ? 1 : 0,
    nowIso(),
    id,
  ]);
  await publish(q, id);
  await writeAudit(q, 'employee.update', 'employee', id, patch);
}

/** The whole set of branches the employee works at. A branch that is taken off is told to drop them; a branch added is told to add them. */
export async function setBranches(q: Queryable, id: number, branchIds: number[], isNew = false): Promise<void> {
  const wanted = [...new Set(branchIds)];
  for (const b of wanted) {
    if (!(await q.one('SELECT 1 AS x FROM branches WHERE id = ? AND active = 1', [b])))
      throw new AppError(422, 'UNKNOWN_BRANCH', `Branch ${b} does not exist or is not active`);
  }
  const have = await branchIdsOf(q, id);
  for (const b of have.filter((x) => !wanted.includes(x))) {
    await q.run('DELETE FROM employee_branches WHERE employee_id = ? AND branch_id = ?', [id, b]);
    await logTo(q, id, b, 'd');
  }
  for (const b of wanted.filter((x) => !have.includes(x))) {
    await q.run('INSERT INTO employee_branches (employee_id, branch_id) VALUES (?, ?)', [id, b]);
    await logTo(q, id, b, 'u');
  }
  if (!isNew) await writeAudit(q, 'employee.branches', 'employee', id, { branchIds: wanted });
}

/** Set the attendance PIN (already hashed). The audit says a PIN was set, never what it is. */
export async function setPin(q: Queryable, id: number, pinHash: string): Promise<void> {
  if (!(await get(q, id))) throw new AppError(404, 'NOT_FOUND', 'Employee not found');
  await q.run('UPDATE employees SET pin_hash = ?, updated_at = ? WHERE id = ?', [pinHash, nowIso(), id]);
  await publish(q, id);
  await writeAudit(q, 'employee.pin', 'employee', id);
}

// ------------------------------------------------------------------ adjustments

export type AdjustmentInput =
  | { action: 'add'; employeeId: number; kind: 'in' | 'out'; at: string; branchId: number; reason: string }
  | { action: 'cancel'; employeeId: number; branchId: number; punchId: number; reason: string };

/** A correction over the facts. Append-only: a wrong adjustment is corrected by another. */
export async function addAdjustment(q: Queryable, input: AdjustmentInput): Promise<number> {
  if (!(await get(q, input.employeeId))) throw new AppError(404, 'NOT_FOUND', 'Employee not found');
  if (input.action === 'cancel') {
    const punch = await q.one('SELECT 1 AS x FROM attendance_punches WHERE branch_id = ? AND id = ? AND employee_id = ?', [
      input.branchId,
      input.punchId,
      input.employeeId,
    ]);
    if (!punch) throw new AppError(422, 'UNKNOWN_PUNCH', 'That employee has no such punch at that branch');
    if (
      await q.one("SELECT 1 AS x FROM attendance_adjustments WHERE action = 'cancel' AND branch_id = ? AND punch_id = ?", [
        input.branchId,
        input.punchId,
      ])
    )
      throw new AppError(409, 'ALREADY_CANCELLED', 'That punch is already cancelled');
  } else if (!(await q.one('SELECT 1 AS x FROM branches WHERE id = ?', [input.branchId]))) {
    throw new AppError(422, 'UNKNOWN_BRANCH', 'That branch does not exist');
  }
  const made = await q.one<{ id: number }>(
    `INSERT INTO attendance_adjustments (employee_id, action, kind, at, branch_id, punch_id, reason, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT actor FROM hq_context WHERE id = 1), ?) RETURNING id`,
    [
      input.employeeId,
      input.action,
      input.action === 'add' ? input.kind : null,
      input.action === 'add' ? new Date(input.at).toISOString() : null,
      input.branchId,
      input.action === 'cancel' ? input.punchId : null,
      input.reason,
      nowIso(),
    ],
  );
  await writeAudit(q, `attendance.${input.action}`, 'employee', input.employeeId, { adjustmentId: made!.id, reason: input.reason });
  return made!.id;
}

// ------------------------------------------------------------------ the daily view

export type DayPunch = { at: string; kind: 'in' | 'out'; branchId: number; source: 'punch' | 'adjustment'; id: number };
export type AttendanceDay = {
  employeeId: number;
  code: string;
  name: string;
  /** The shop day of the clock-in. */
  day: string;
  minutes: number;
  punches: DayPunch[];
  /** `double_in`, `out_without_in`, `open`: what is wrong and needs an adjustment. They add no minutes. */
  flags: string[];
};

/**
 * Worked time per employee per shop day. The events of an employee (punches without the cancelled ones, plus added adjustments) are taken in time order:
 * an in followed by an out is a span of worked minutes, and the span belongs to the shop day of its in (a night shift is one day's work). Two ins in a
 * row, an out with no in, or an in with nothing after it are flagged and add no minutes. A day shows if it falls inside from..to (both shop days).
 */
export async function attendanceDays(
  q: Queryable,
  opts: { from: string; to: string; employeeId?: number; branchId?: number; now?: Date },
): Promise<AttendanceDay[]> {
  // A span can start the day before `from` or end the day after `to`, so look a day either side.
  const lo = new Date(Date.parse(`${opts.from}T00:00:00Z`) - 2 * 86_400_000).toISOString();
  const hi = new Date(Date.parse(`${opts.to}T00:00:00Z`) + 3 * 86_400_000).toISOString();
  const who = opts.employeeId === undefined ? '' : ' AND p.employee_id = ?';
  const params: (string | number)[] = [lo, hi, ...(opts.employeeId === undefined ? [] : [opts.employeeId])];
  const punches = await q.all<{ branch_id: number; id: number; employee_id: number; kind: 'in' | 'out'; created_at: string }>(
    `SELECT p.branch_id, p.id, p.employee_id, p.kind, p.created_at FROM attendance_punches p
      WHERE p.created_at >= ? AND p.created_at < ?${who}
        AND NOT EXISTS (SELECT 1 FROM attendance_adjustments a WHERE a.action = 'cancel' AND a.branch_id = p.branch_id AND a.punch_id = p.id)`,
    params,
  );
  const added = await q.all<{ id: number; employee_id: number; kind: 'in' | 'out'; at: string; branch_id: number }>(
    `SELECT a.id, a.employee_id, a.kind, a.at, a.branch_id FROM attendance_adjustments a
      WHERE a.action = 'add' AND a.at >= ? AND a.at < ?${opts.employeeId === undefined ? '' : ' AND a.employee_id = ?'}`,
    params,
  );
  const byEmployee = new Map<number, (DayPunch & { order: number })[]>();
  const push = (employeeId: number, e: DayPunch & { order: number }) =>
    (byEmployee.get(employeeId) ?? byEmployee.set(employeeId, []).get(employeeId)!).push(e);
  for (const p of punches)
    push(p.employee_id, { at: p.created_at, kind: p.kind, branchId: p.branch_id, source: 'punch', id: p.id, order: 0 });
  for (const a of added) push(a.employee_id, { at: a.at, kind: a.kind, branchId: a.branch_id, source: 'adjustment', id: a.id, order: 1 });

  const names = new Map(
    (await q.all<{ id: number; code: string; name: string }>('SELECT id, code, name FROM employees')).map((e) => [e.id, e] as const),
  );
  const days = new Map<string, AttendanceDay>();
  const dayOf = (employeeId: number, day: string): AttendanceDay => {
    const key = `${employeeId}|${day}`;
    let d = days.get(key);
    if (!d) {
      const e = names.get(employeeId);
      d = { employeeId, code: e?.code ?? '?', name: e?.name ?? `Employee ${employeeId}`, day, minutes: 0, punches: [], flags: [] };
      days.set(key, d);
    }
    return d;
  };
  for (const [employeeId, events] of byEmployee) {
    events.sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order || a.id - b.id);
    let open: (DayPunch & { order: number }) | null = null;
    const strip = ({ order: _o, ...rest }: DayPunch & { order: number }): DayPunch => rest;
    for (const e of events) {
      const day = dayOf(employeeId, localDay(e.at));
      if (e.kind === 'in') {
        if (open) dayOf(employeeId, localDay(open.at)).flags.push('double_in');
        open = e;
        day.punches.push(strip(e));
      } else if (open) {
        const start = dayOf(employeeId, localDay(open.at));
        start.minutes += Math.max(0, Math.round((Date.parse(e.at) - Date.parse(open.at)) / 60_000));
        if (day !== start)
          start.punches.push(strip(e)); // a night shift's out is shown on the day it began
        else day.punches.push(strip(e));
        open = null;
      } else {
        day.flags.push('out_without_in');
        day.punches.push(strip(e));
      }
    }
    if (open) dayOf(employeeId, localDay(open.at)).flags.push('open');
  }
  let out = [...days.values()].filter((d) => d.day >= opts.from && d.day <= opts.to && (d.punches.length > 0 || d.flags.length > 0));
  if (opts.branchId !== undefined) out = out.filter((d) => d.punches.some((p) => p.branchId === opts.branchId));
  for (const d of out) d.punches.sort((a, b) => a.at.localeCompare(b.at));
  return out.sort((a, b) => a.day.localeCompare(b.day) || a.name.localeCompare(b.name) || a.employeeId - b.employeeId);
}
