import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminAuth, startHq, type Hq } from './helpers';
import { absenceSummary } from '../src/modules/hr/schedule';

// Shifts, rosters, holidays and leave (docs/16 §6, P6a-2) over punches made by hand, so every figure can be worked out on paper. Beirut is UTC+2 in
// November: a shift at 08:00 starts at 06:00Z.
let hq: Hq;
let branch = 0;
let sami = 0;
let morning = 0;
let night = 0;
let paid = 0;
let unpaid = 0;
const api = '/api/v1';
const get = async (path: string) => (await hq.http.get(`${api}${path}`).set(adminAuth)).body;
const post = (path: string, body: object = {}) => hq.http.post(`${api}${path}`).set(adminAuth).send(body);
const run = (sql: string, params: (string | number | null)[] = []) => hq.app.database.run(sql, params);
let punchId = 0;
const punch = (kind: 'in' | 'out', iso: string) =>
  run(
    `INSERT INTO attendance_punches (branch_id, id, employee_id, kind, user_id, created_at, hq_received_at) VALUES (?, ?, ?, ?, NULL, ?, 'x')`,
    [branch, ++punchId, sami, kind, iso],
  );
const RANGE = 'from=2026-11-09&to=2026-11-15';
const dayRow = async (d: string) =>
  ((await get(`/attendance/schedule?${RANGE}&employeeId=${sami}`)).data as Record<string, unknown>[]).find((x) => x.day === d)!;

beforeAll(async () => {
  hq = await startHq();
  expect((await post('/branches', { code: 'B1', name: 'Hamra' })).status).toBe(201);
  branch = (await hq.app.database.one<{ id: number }>("SELECT id FROM branches WHERE code = 'B1'"))!.id;
  sami = (await post('/employees', { code: 'SAMI', name: 'Sami Khoury', branchIds: [branch] })).body.id;
  morning = (await post('/shifts', { name: 'Morning', startMinute: 480, lengthMinutes: 480 })).body.id;
  night = (await post('/shifts', { name: 'Night', startMinute: 1260, lengthMinutes: 480 })).body.id;
  paid = (await post('/leave-types', { code: 'ann', name: 'Annual leave', paid: true })).body.id;
  unpaid = (await post('/leave-types', { code: 'unp', name: 'Unpaid leave', paid: false })).body.id;
});
afterAll(async () => {
  await hq.close();
});

describe('shifts and rosters (US-HR-roster)', () => {
  it('a roster needs an active shift and an assigned branch; a null shift clears the day', async () => {
    const entry = (day: string, shiftId: number | null, branchId = branch) => ({ employeeId: sami, day, shiftId, branchId });
    expect(
      (
        await hq.http
          .put(`${api}/roster`)
          .set(adminAuth)
          .send({ entries: [entry('2026-11-09', 999)] })
      ).body.code,
    ).toBe('UNKNOWN_SHIFT');
    expect(
      (
        await hq.http
          .put(`${api}/roster`)
          .set(adminAuth)
          .send({ entries: [entry('2026-11-09', morning, branch + 50)] })
      ).body.code,
    ).toBe('NOT_ASSIGNED');
    expect((await post('/shifts', { name: 'Morning', startMinute: 1, lengthMinutes: 60 })).status).toBe(409);
    const days = ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'].map((d) => entry(d, morning));
    expect(
      (
        await hq.http
          .put(`${api}/roster`)
          .set(adminAuth)
          .send({ entries: [...days, entry('2026-11-14', night), entry('2026-11-20', morning)] })
      ).status,
    ).toBe(200);
    expect(((await get(`/roster?${RANGE}`)).data as unknown[]).length).toBe(6);
    expect(
      (
        await hq.http
          .put(`${api}/roster`)
          .set(adminAuth)
          .send({ entries: [entry('2026-11-20', null)] })
      ).status,
    ).toBe(200); // cleared
    expect(((await get('/roster?from=2026-11-15&to=2026-11-30')).data as unknown[]).length).toBe(0);
  });

  it('a long range is refused and every route is closed to anonymous callers', async () => {
    expect((await hq.http.get(`${api}/roster?from=2026-01-01&to=2026-12-31`).set(adminAuth)).status).toBe(400);
    for (const p of ['/shifts', '/roster', '/holidays', '/leave-types', '/leave-requests', '/attendance/schedule'])
      expect((await hq.http.get(`${api}${p}`)).status).toBe(401);
  });
});

describe('holidays and leave (US-HR-roster)', () => {
  it('a holiday is once; leave is decided once, and approved leave does not overlap', async () => {
    expect((await post('/holidays', { day: '2026-11-12', name: 'Independence Day' })).status).toBe(201);
    expect((await post('/holidays', { day: '2026-11-12', name: 'Again' })).status).toBe(409);
    const ask = (typeId: number, fromDay: string, toDay: string) => post('/leave-requests', { employeeId: sami, typeId, fromDay, toDay });
    expect((await ask(paid, '2026-11-14', '2026-11-13')).status).toBe(422); // backwards
    const a = (await ask(paid, '2026-11-13', '2026-11-13')).body.id;
    const b = (await ask(unpaid, '2026-11-13', '2026-11-13')).body.id;
    expect((await post(`/leave-requests/${a}/approve`)).status).toBe(200);
    expect((await post(`/leave-requests/${b}/approve`)).body.code).toBe('LEAVE_OVERLAP');
    expect((await post(`/leave-requests/${a}/approve`)).body.code).toBe('LEAVE_DECIDED'); // once
    expect((await post(`/leave-requests/${b}/reject`)).status).toBe(200);
    expect((await post(`/leave-requests/${b}/approve`)).body.code).toBe('LEAVE_DECIDED'); // a rejection is final
    await expect(run('UPDATE leave_requests SET to_day = ? WHERE id = ?', ['2026-11-30', a])).rejects.toThrow(/fixed once decided/);
    await expect(run('DELETE FROM leave_requests WHERE id = ?', [a])).rejects.toThrow(/never deleted/);
    const audit = JSON.stringify(await hq.app.database.all("SELECT action FROM hq_audit WHERE action LIKE 'leave.%'"));
    expect(audit).toContain('leave.approved');
    expect(audit).toContain('leave.rejected');
  });
});

describe('the plan beside what happened (US-HR-roster)', () => {
  beforeAll(async () => {
    // 9th: on time, a full 8 hours. 10th: 20 minutes late and 10 minutes early. 11th: nothing. 12th: a holiday. 13th: on approved paid leave.
    await punch('in', '2026-11-09T06:00:00.000Z');
    await punch('out', '2026-11-09T14:00:00.000Z');
    await punch('in', '2026-11-10T06:20:00.000Z');
    await punch('out', '2026-11-10T13:50:00.000Z');
    // 14th: a night shift from 21:00 to 05:00 the next morning
    await punch('in', '2026-11-14T19:00:00.000Z');
    await punch('out', '2026-11-15T03:00:00.000Z');
    // 15th: no roster, but worked 4 hours
    await punch('in', '2026-11-15T06:00:00.000Z');
    await punch('out', '2026-11-15T10:00:00.000Z');
  });

  it('shows each day as worked, late, early, absent, a holiday, on leave or unscheduled', async () => {
    expect(await dayRow('2026-11-09')).toMatchObject({
      status: 'worked',
      shift: 'Morning',
      scheduledMinutes: 480,
      workedMinutes: 480,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      overMinutes: 0,
    });
    expect(await dayRow('2026-11-10')).toMatchObject({ status: 'worked', workedMinutes: 450, lateMinutes: 20, earlyLeaveMinutes: 10 });
    expect(await dayRow('2026-11-11')).toMatchObject({ status: 'absent', workedMinutes: 0 });
    expect(await dayRow('2026-11-12')).toMatchObject({ status: 'holiday' });
    expect(await dayRow('2026-11-13')).toMatchObject({ status: 'on_leave', leave: { type: 'Annual leave', paid: true } });
    // the night shift: on time, and its out is on the day it began
    expect(await dayRow('2026-11-14')).toMatchObject({
      status: 'worked',
      shift: 'Night',
      workedMinutes: 480,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
    });
    expect(await dayRow('2026-11-15')).toMatchObject({ status: 'unscheduled', shift: null, workedMinutes: 240, scheduledMinutes: 0 });
  });

  it('adds up, and a person within the grace is neither late nor early', async () => {
    const r = await get(`/attendance/schedule?${RANGE}&employeeId=${sami}`);
    // six rostered days of 480 minutes; worked 480 + 450 + 480 + 240 (the unrostered day)
    expect(r.totals).toEqual({
      scheduledMinutes: 2880,
      workedMinutes: 1650,
      lateMinutes: 20,
      earlyLeaveMinutes: 10,
      absentDays: 1,
      leaveDays: 1,
    });
    // five minutes late is inside the 5 minutes of grace: not late
    await run('DELETE FROM attendance_punches WHERE created_at LIKE ?', ['2026-11-09%']);
    await punch('in', '2026-11-09T06:05:00.000Z');
    await punch('out', '2026-11-09T14:00:00.000Z');
    expect(await dayRow('2026-11-09')).toMatchObject({ workedMinutes: 475, lateMinutes: 0 });
    await run('DELETE FROM attendance_punches WHERE created_at LIKE ?', ['2026-11-09%']);
    await punch('in', '2026-11-09T06:06:00.000Z');
    await punch('out', '2026-11-09T14:00:00.000Z');
    expect(await dayRow('2026-11-09')).toMatchObject({ lateMinutes: 6 });
  });

  it('a day not yet over is not an absence, and the payroll check counts absence and unpaid leave', async () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect((await post('/roster', {})).status).toBeGreaterThanOrEqual(400); // POST is not a route
    expect(
      (
        await hq.http
          .put(`${api}/roster`)
          .set(adminAuth)
          .send({ entries: [{ employeeId: sami, day: tomorrow, shiftId: morning, branchId: branch }] })
      ).status,
    ).toBe(200);
    const future = ((await get(`/attendance/schedule?from=${tomorrow}&to=${tomorrow}&employeeId=${sami}`)).data as { status: string }[])[0];
    expect(future?.status).toBe('scheduled');
    const per = await absenceSummary(hq.app.database, '2026-11-09', '2026-11-15');
    expect(per.get(sami)).toMatchObject({ absent: 1, unpaidLeave: 0 });
  });
});
