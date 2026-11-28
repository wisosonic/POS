import type { Queryable } from '@pos/core/adapter';
import { AppError } from '@pos/core/errors';
import { shopDayStart } from '../../util/time';
import { writeAudit } from '../staff/context';
import { attendanceDays } from './service';

// Shifts, rosters, holidays and leave (docs/16 §6, P6a-2), and the view that sets the plan beside what happened. All HQ's: a roster is a plan, so it can be
// changed (every change is audited); pay history is frozen by the payroll triggers, not here. Nothing in this file writes a punch or a payslip.

const nowIso = () => new Date().toISOString();
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// ------------------------------------------------------------------ shifts

export type ShiftRow = { id: number; name: string; start_minute: number; length_minutes: number; grace_minutes: number; active: number };
const shiftJson = (s: ShiftRow) => ({
  id: s.id,
  name: s.name,
  startMinute: s.start_minute,
  lengthMinutes: s.length_minutes,
  graceMinutes: s.grace_minutes,
  active: s.active === 1,
});

export const listShifts = async (q: Queryable) =>
  (await q.all<ShiftRow>('SELECT * FROM shift_templates ORDER BY start_minute, id')).map(shiftJson);

export async function createShift(
  q: Queryable,
  s: { name: string; startMinute: number; lengthMinutes: number; graceMinutes: number },
): Promise<number> {
  if (await q.one('SELECT 1 AS x FROM shift_templates WHERE name = ?', [s.name]))
    throw new AppError(409, 'DUPLICATE_NAME', 'A shift already has that name');
  const made = await q.one<{ id: number }>(
    'INSERT INTO shift_templates (name, start_minute, length_minutes, grace_minutes, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
    [s.name, s.startMinute, s.lengthMinutes, s.graceMinutes, nowIso()],
  );
  await writeAudit(q, 'shift.create', 'shift', made!.id, s);
  return made!.id;
}

/** A shift in use is retired, not deleted: old rosters keep pointing at it. */
export async function setShiftActive(q: Queryable, id: number, active: boolean): Promise<void> {
  const r = await q.run('UPDATE shift_templates SET active = ? WHERE id = ?', [active ? 1 : 0, id]);
  if (!r.changes) throw new AppError(404, 'NOT_FOUND', 'Shift not found');
  await writeAudit(q, 'shift.active', 'shift', id, { active });
}

// ------------------------------------------------------------------ roster

export type RosterEntry = { employeeId: number; day: string; shiftId: number | null; branchId: number };

/** Set or clear many days at once. A null shift clears the day. Checked first, then written. */
export async function setRoster(q: Queryable, entries: RosterEntry[]): Promise<void> {
  for (const e of entries) {
    if (!DAY.test(e.day)) throw new AppError(422, 'VALIDATION', `"${e.day}" is not a day`);
    if (!(await q.one('SELECT 1 AS x FROM employees WHERE id = ? AND active = 1', [e.employeeId])))
      throw new AppError(422, 'UNKNOWN_EMPLOYEE', `Employee ${e.employeeId} does not exist or is not active`);
    if (e.shiftId !== null) {
      if (!(await q.one('SELECT 1 AS x FROM shift_templates WHERE id = ? AND active = 1', [e.shiftId])))
        throw new AppError(422, 'UNKNOWN_SHIFT', `Shift ${e.shiftId} does not exist or is not active`);
      if (!(await q.one('SELECT 1 AS x FROM employee_branches WHERE employee_id = ? AND branch_id = ?', [e.employeeId, e.branchId])))
        throw new AppError(422, 'NOT_ASSIGNED', `Employee ${e.employeeId} is not assigned to branch ${e.branchId}`);
    }
  }
  for (const e of entries) {
    if (e.shiftId === null) await q.run('DELETE FROM rosters WHERE employee_id = ? AND day = ?', [e.employeeId, e.day]);
    else
      await q.run(
        `INSERT INTO rosters (employee_id, day, shift_id, branch_id) VALUES (?, ?, ?, ?)
         ON CONFLICT (employee_id, day) DO UPDATE SET shift_id = excluded.shift_id, branch_id = excluded.branch_id`,
        [e.employeeId, e.day, e.shiftId, e.branchId],
      );
  }
  await writeAudit(q, 'roster.set', 'roster', null, { entries: entries.length });
}

export async function listRoster(q: Queryable, o: { from: string; to: string; employeeId?: number; branchId?: number }) {
  const where = ['r.day >= ?', 'r.day <= ?'];
  const params: (string | number)[] = [o.from, o.to];
  if (o.employeeId !== undefined) {
    where.push('r.employee_id = ?');
    params.push(o.employeeId);
  }
  if (o.branchId !== undefined) {
    where.push('r.branch_id = ?');
    params.push(o.branchId);
  }
  return (
    await q.all<{ employee_id: number; day: string; shift_id: number; branch_id: number; name: string }>(
      `SELECT r.employee_id, r.day, r.shift_id, r.branch_id, e.name FROM rosters r JOIN employees e ON e.id = r.employee_id
        WHERE ${where.join(' AND ')} ORDER BY r.day, e.name, r.employee_id`,
      params,
    )
  ).map((r) => ({ employeeId: r.employee_id, employee: r.name, day: r.day, shiftId: r.shift_id, branchId: r.branch_id }));
}

// ------------------------------------------------------------------ holidays and leave

export async function addHoliday(q: Queryable, day: string, name: string): Promise<void> {
  if (!DAY.test(day)) throw new AppError(422, 'VALIDATION', 'The day must look like 2026-12-25');
  if (await q.one('SELECT 1 AS x FROM holidays WHERE day = ?', [day]))
    throw new AppError(409, 'DUPLICATE_DAY', 'That day is already a holiday');
  await q.run('INSERT INTO holidays (day, name) VALUES (?, ?)', [day, name]);
  await writeAudit(q, 'holiday.add', 'holiday', day, { name });
}
export async function removeHoliday(q: Queryable, day: string): Promise<void> {
  const r = await q.run('DELETE FROM holidays WHERE day = ?', [day]);
  if (!r.changes) throw new AppError(404, 'NOT_FOUND', 'That day is not a holiday');
  await writeAudit(q, 'holiday.remove', 'holiday', day);
}
export const listHolidays = async (q: Queryable) => q.all<{ day: string; name: string }>('SELECT day, name FROM holidays ORDER BY day');

export async function addLeaveType(q: Queryable, t: { code: string; name: string; paid: boolean }): Promise<number> {
  if (await q.one('SELECT 1 AS x FROM leave_types WHERE code = ?', [t.code]))
    throw new AppError(409, 'DUPLICATE_CODE', 'A leave type already has that code');
  const made = await q.one<{ id: number }>('INSERT INTO leave_types (code, name, paid, created_at) VALUES (?, ?, ?, ?) RETURNING id', [
    t.code,
    t.name,
    t.paid ? 1 : 0,
    nowIso(),
  ]);
  await writeAudit(q, 'leave.type', 'leave-type', made!.id, t);
  return made!.id;
}
export const listLeaveTypes = async (q: Queryable) =>
  (await q.all<{ id: number; code: string; name: string; paid: number }>('SELECT id, code, name, paid FROM leave_types ORDER BY code')).map(
    (t) => ({
      id: t.id,
      code: t.code,
      name: t.name,
      paid: t.paid === 1,
    }),
  );

type LeaveRow = {
  id: number;
  employee_id: number;
  type_id: number;
  from_day: string;
  to_day: string;
  status: string;
  reason: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
};
const leaveJson = (l: LeaveRow & { employee: string; type: string; paid: number }) => ({
  id: l.id,
  employeeId: l.employee_id,
  employee: l.employee,
  typeId: l.type_id,
  type: l.type,
  paid: l.paid === 1,
  fromDay: l.from_day,
  toDay: l.to_day,
  status: l.status,
  reason: l.reason,
  decidedBy: l.decided_by,
  decidedAt: l.decided_at,
  createdAt: l.created_at,
});

export async function requestLeave(
  q: Queryable,
  r: { employeeId: number; typeId: number; fromDay: string; toDay: string; reason: string | null },
): Promise<number> {
  if (!DAY.test(r.fromDay) || !DAY.test(r.toDay) || r.fromDay > r.toDay)
    throw new AppError(422, 'VALIDATION', 'Give the first and last day, in order');
  if (!(await q.one('SELECT 1 AS x FROM employees WHERE id = ?', [r.employeeId])))
    throw new AppError(404, 'NOT_FOUND', 'Employee not found');
  if (!(await q.one('SELECT 1 AS x FROM leave_types WHERE id = ?', [r.typeId])))
    throw new AppError(422, 'UNKNOWN_LEAVE_TYPE', 'That leave type does not exist');
  const made = await q.one<{ id: number }>(
    `INSERT INTO leave_requests (employee_id, type_id, from_day, to_day, status, reason, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?) RETURNING id`,
    [r.employeeId, r.typeId, r.fromDay, r.toDay, r.reason, nowIso()],
  );
  await writeAudit(q, 'leave.request', 'employee', r.employeeId, { leaveId: made!.id, fromDay: r.fromDay, toDay: r.toDay });
  return made!.id;
}

/** pending -> approved or rejected; approved -> cancelled. An approved leave may not overlap another approved leave of the same person. */
export async function decideLeave(q: Queryable, id: number, to: 'approved' | 'rejected' | 'cancelled'): Promise<void> {
  const l = await q.one<LeaveRow>('SELECT * FROM leave_requests WHERE id = ?', [id]);
  if (!l) throw new AppError(404, 'NOT_FOUND', 'Leave request not found');
  const allowed = (l.status === 'pending' && (to === 'approved' || to === 'rejected')) || (l.status === 'approved' && to === 'cancelled');
  if (!allowed) throw new AppError(409, 'LEAVE_DECIDED', `A ${l.status} leave cannot become ${to}`);
  if (to === 'approved') {
    const clash = await q.one<{ id: number }>(
      `SELECT id FROM leave_requests WHERE employee_id = ? AND status = 'approved' AND from_day <= ? AND to_day >= ? LIMIT 1`,
      [l.employee_id, l.to_day, l.from_day],
    );
    if (clash) throw new AppError(409, 'LEAVE_OVERLAP', `Leave ${clash.id} is already approved over some of these days`);
  }
  await q.run(
    `UPDATE leave_requests SET status = ?, decided_by = (SELECT actor FROM hq_context WHERE id = 1), decided_at = ? WHERE id = ?`,
    [to, nowIso(), id],
  );
  await writeAudit(q, `leave.${to}`, 'employee', l.employee_id, { leaveId: id });
}

export async function listLeave(q: Queryable, o: { employeeId?: number; status?: string }) {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (o.employeeId !== undefined) {
    where.push('l.employee_id = ?');
    params.push(o.employeeId);
  }
  if (o.status) {
    where.push('l.status = ?');
    params.push(o.status);
  }
  const rows = await q.all<LeaveRow & { employee: string; type: string; paid: number }>(
    `SELECT l.*, e.name AS employee, t.name AS type, t.paid FROM leave_requests l JOIN employees e ON e.id = l.employee_id JOIN leave_types t ON t.id = l.type_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY l.from_day DESC, l.id DESC LIMIT 300`,
    params,
  );
  return rows.map(leaveJson);
}

// ------------------------------------------------------------------ the plan beside what happened

export type ScheduleStatus = 'worked' | 'absent' | 'on_leave' | 'holiday' | 'unscheduled' | 'scheduled';
export type ScheduleDay = {
  employeeId: number;
  employee: string;
  day: string;
  status: ScheduleStatus;
  branchId: number | null;
  shift: string | null;
  scheduledMinutes: number;
  workedMinutes: number;
  /** Minutes after the shift began that the first clock-in was, if more than the shift's grace. */
  lateMinutes: number;
  /** Minutes before the shift ended that the last clock-out was, if more than the shift's grace. */
  earlyLeaveMinutes: number;
  /** Worked beyond the scheduled length (information: pay overtime follows the pay profile). */
  overMinutes: number;
  /** For `on_leave`: the type, and whether it is paid. */
  leave: { type: string; paid: boolean } | null;
  flags: string[];
};

/** The shop-local midnight of a shop day, as an instant. */
const dayStart = (day: string) => shopDayStart(new Date(`${day}T12:00:00Z`)).getTime();

/**
 * For each rostered day, what happened: a holiday, an approved leave, worked (with late and early minutes) or absent. A day with attendance but no roster
 * is `unscheduled`. The shift's start is the shop's local time on that day (a clock change at midnight is not allowed for: it is off by an hour on two
 * days a year at most). A day is an absence only when it is in the past; today is still ahead.
 */
export async function scheduleView(
  q: Queryable,
  o: { from: string; to: string; employeeId?: number; branchId?: number; today?: string },
): Promise<ScheduleDay[]> {
  const today = o.today ?? new Date().toISOString().slice(0, 10);
  const roster = await q.all<{
    employee_id: number;
    day: string;
    branch_id: number;
    name: string;
    shift: string;
    start_minute: number;
    length_minutes: number;
    grace_minutes: number;
  }>(
    `SELECT r.employee_id, r.day, r.branch_id, e.name, s.name AS shift, s.start_minute, s.length_minutes, s.grace_minutes
       FROM rosters r JOIN employees e ON e.id = r.employee_id JOIN shift_templates s ON s.id = r.shift_id
      WHERE r.day >= ? AND r.day <= ?${o.employeeId === undefined ? '' : ' AND r.employee_id = ?'}`,
    [o.from, o.to, ...(o.employeeId === undefined ? [] : [o.employeeId])],
  );
  const attendance = await attendanceDays(q, { from: o.from, to: o.to, employeeId: o.employeeId });
  const holidays = new Set((await listHolidays(q)).map((h) => h.day));
  const leaves = await q.all<{ employee_id: number; from_day: string; to_day: string; type: string; paid: number }>(
    `SELECT l.employee_id, l.from_day, l.to_day, t.name AS type, t.paid FROM leave_requests l JOIN leave_types t ON t.id = l.type_id
      WHERE l.status = 'approved' AND l.from_day <= ? AND l.to_day >= ?${o.employeeId === undefined ? '' : ' AND l.employee_id = ?'}`,
    [o.to, o.from, ...(o.employeeId === undefined ? [] : [o.employeeId])],
  );
  const leaveOn = (employeeId: number, day: string) =>
    leaves.find((l) => l.employee_id === employeeId && l.from_day <= day && l.to_day >= day);
  const attOn = (employeeId: number, day: string) => attendance.find((a) => a.employeeId === employeeId && a.day === day);

  const out: ScheduleDay[] = [];
  const seen = new Set<string>();
  for (const r of roster) {
    seen.add(`${r.employee_id}|${r.day}`);
    const a = attOn(r.employee_id, r.day);
    const worked = a?.minutes ?? 0;
    const leave = leaveOn(r.employee_id, r.day);
    const start = dayStart(r.day) + r.start_minute * 60_000;
    const end = start + r.length_minutes * 60_000;
    const firstIn = a?.punches.find((p) => p.kind === 'in');
    const lastOut = [...(a?.punches ?? [])].reverse().find((p) => p.kind === 'out');
    const late = firstIn ? Math.round((Date.parse(firstIn.at) - start) / 60_000) : 0;
    const early = lastOut ? Math.round((end - Date.parse(lastOut.at)) / 60_000) : 0;
    let status: ScheduleStatus;
    if (holidays.has(r.day)) status = 'holiday';
    else if (leave) status = 'on_leave';
    else if (worked > 0) status = 'worked';
    else status = r.day < today ? 'absent' : 'scheduled'; // a day not yet over is not an absence
    const didWork = status === 'worked';
    out.push({
      employeeId: r.employee_id,
      employee: r.name,
      day: r.day,
      status,
      branchId: r.branch_id,
      shift: r.shift,
      scheduledMinutes: r.length_minutes,
      workedMinutes: worked,
      lateMinutes: didWork && late > r.grace_minutes ? late : 0,
      earlyLeaveMinutes: didWork && lastOut && early > r.grace_minutes ? early : 0,
      overMinutes: didWork ? Math.max(0, worked - r.length_minutes) : 0,
      leave: leave ? { type: leave.type, paid: leave.paid === 1 } : null,
      flags: a?.flags ?? [],
    });
  }
  // attendance on a day with no roster
  const employeesWithRoster = new Set(roster.map((r) => r.employee_id));
  for (const a of attendance) {
    if (seen.has(`${a.employeeId}|${a.day}`) || !employeesWithRoster.has(a.employeeId)) continue;
    out.push({
      employeeId: a.employeeId,
      employee: a.name,
      day: a.day,
      status: holidays.has(a.day) ? 'holiday' : 'unscheduled',
      branchId: a.punches[0]?.branchId ?? null,
      shift: null,
      scheduledMinutes: 0,
      workedMinutes: a.minutes,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      overMinutes: 0,
      leave: null,
      flags: a.flags,
    });
  }
  const rows = o.branchId === undefined ? out : out.filter((d) => d.branchId === o.branchId);
  return rows.sort((a, b) => a.day.localeCompare(b.day) || a.employee.localeCompare(b.employee) || a.employeeId - b.employeeId);
}

/** What the plan says for a person over a period, as the payroll check needs it: days absent, days of unpaid leave. */
export async function absenceSummary(q: Queryable, from: string, to: string, today?: string) {
  const rows = await scheduleView(q, { from, to, today });
  const per = new Map<number, { name: string; absent: number; unpaidLeave: number }>();
  for (const r of rows) {
    const s = per.get(r.employeeId) ?? { name: r.employee, absent: 0, unpaidLeave: 0 };
    if (r.status === 'absent') s.absent += 1;
    if (r.status === 'on_leave' && r.leave && !r.leave.paid) s.unpaidLeave += 1;
    per.set(r.employeeId, s);
  }
  return per;
}

export { addDays };
