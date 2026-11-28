import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminAuth, startHq, type Hq } from '../helpers';
import { startCtx, type TestCtx } from '../../../branch-server/tests/helpers/app';
import { punch } from '../../../branch-server/src/modules/attendance/service';

// Attendance (docs/16, P6a-1): HQ owns the employees and sends each branch only its own; a branch records clock-ins and clock-outs; HQ turns them into
// worked time and corrects mistakes with adjustments, never edits. Beirut is UTC+2 in November.
let hq: Hq;
let a: TestCtx;
let b: TestCtx;
let aCashier = '';
let idA = 0;
let idB = 0;
let sami = 0;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const opts = { sync: { intervalMs: 60, backoffMs: [60, 200], idleMs: 40 } };
const until = async (check: () => Promise<boolean>, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
};
const at = (iso: string) => new Date(iso);
const days = async (extra = '') =>
  (await hq.http.get(`${api}/attendance/days?from=2026-11-09&to=2026-11-15&employeeId=${sami}${extra}`).set(adminAuth)).body.data as {
    day: string;
    minutes: number;
    flags: string[];
    punches: { kind: string; branchId: number; source: string }[];
  }[];
const day = async (d: string) => (await days()).find((x) => x.day === d);
const employeeAt = (c: TestCtx) =>
  c.app.database.one<{ id: number; pin_hash: string | null }>('SELECT id, pin_hash FROM employees WHERE code = ?', ['S1']);
const punchHttp = (c: TestCtx, token: string, code: string, pin: string) =>
  c.http.post(`${api}/attendance/punch`).set(auth(token)).send({ code, pin });

beforeAll(async () => {
  hq = await startHq();
  a = await startCtx(opts);
  b = await startCtx(opts);
  aCashier = await a.login('cashier');
  for (const [c, code] of [
    [a, 'A'],
    [b, 'B'],
  ] as const) {
    const enrol = (
      await hq.http
        .post(`${api}/branches`)
        .set(adminAuth)
        .send({ code, name: `Branch ${code}` })
    ).body.enrolCode as string;
    expect(
      (
        await c.http
          .post(`${api}/sync/connect`)
          .set(auth(await c.login('admin')))
          .send({ url: hq.url, code: enrol })
      ).status,
    ).toBe(200);
  }
  idA = (await hq.app.database.one<{ id: number }>("SELECT id FROM branches WHERE code = 'A'"))!.id;
  idB = (await hq.app.database.one<{ id: number }>("SELECT id FROM branches WHERE code = 'B'"))!.id;
});
afterAll(async () => {
  await a.close();
  await b.close();
  await hq.close();
});

describe('employees at HQ go only to their branches (US-HR-attendance)', () => {
  it('an employee is sent to the branches assigned, with a PIN that is never shown, and removed when taken off', async () => {
    const made = await hq.http
      .post(`${api}/employees`)
      .set(adminAuth)
      .send({ code: 's1', name: 'Sami Khoury', branchIds: [idA] });
    expect(made.status).toBe(201);
    sami = made.body.id;
    expect(made.body).toMatchObject({ code: 'S1', active: true, hasPin: false, branchIds: [idA] });
    expect((await hq.http.post(`${api}/employees`).set(adminAuth).send({ code: 'S1', name: 'Other' })).status).toBe(409);
    expect((await hq.http.post(`${api}/employees/${sami}/pin`).set(adminAuth).send({ pin: '12' })).status).toBe(400);
    expect((await hq.http.post(`${api}/employees/${sami}/pin`).set(adminAuth).send({ pin: '1234' })).status).toBe(204);

    expect(await until(async () => !!(await employeeAt(a))?.pin_hash)).toBe(true);
    expect(await employeeAt(b)).toBeUndefined(); // not assigned: never sent
    const shown = JSON.stringify((await hq.http.get(`${api}/employees/${sami}`).set(adminAuth)).body);
    expect(shown).toContain('"hasPin":true');
    expect(shown).not.toContain('pin_hash');
    expect(shown).not.toContain('argon2');
    // the audit says a PIN was set, never which
    const audit = JSON.stringify(await hq.app.database.all('SELECT action, detail_json FROM hq_audit'));
    expect(audit).toContain('employee.pin');
    expect(audit).not.toContain('1234');

    // assigned to B as well: B receives them; taken off A: A drops them
    expect(
      (
        await hq.http
          .put(`${api}/employees/${sami}/branches`)
          .set(adminAuth)
          .send({ branchIds: [idA, idB] })
      ).status,
    ).toBe(200);
    expect(await until(async () => !!(await employeeAt(b)))).toBe(true);
    expect(
      (
        await hq.http
          .put(`${api}/employees/${sami}/branches`)
          .set(adminAuth)
          .send({ branchIds: [idB] })
      ).status,
    ).toBe(200);
    expect(await until(async () => (await employeeAt(a)) === undefined)).toBe(true);
    expect(
      (
        await hq.http
          .put(`${api}/employees/${sami}/branches`)
          .set(adminAuth)
          .send({ branchIds: [idA, idB] })
      ).status,
    ).toBe(200);
    expect(await until(async () => !!(await employeeAt(a)))).toBe(true);
  });

  it('only an admin changes employees', async () => {
    expect((await hq.http.get(`${api}/employees`)).status).toBe(401);
    expect((await hq.http.post(`${api}/employees`).send({ code: 'X', name: 'X' })).status).toBe(401);
  });
});

describe('clocking in and out at a branch', () => {
  it('a wrong code and a wrong PIN look the same, and five wrong tries lock the code', async () => {
    const wrongPin = await punchHttp(a, aCashier, 'S1', '9999');
    const unknown = await punchHttp(a, aCashier, 'NOBODY', '1234');
    expect(wrongPin.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrongPin.body);
    for (let i = 0; i < 5; i++) expect((await punchHttp(a, aCashier, 'LOCKME', '0000')).status).toBe(401);
    const locked = await punchHttp(a, aCashier, 'LOCKME', '0000');
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('ATTENDANCE_LOCKED');
    // the one who is not locked still clocks (and a good punch forgives the earlier wrong try)
    const first = await punchHttp(a, aCashier, 's1', '1234');
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ kind: 'in', employee: { code: 'S1', name: 'Sami Khoury' } });
    expect(JSON.stringify(first.body)).not.toContain('1234');
    // a double press is one punch
    expect((await punchHttp(a, aCashier, 'S1', '1234')).body.code).toBe('PUNCHED_JUST_NOW');
    // an unassigned branch or anonymous caller cannot
    expect((await a.http.post(`${api}/attendance/punch`).send({ code: 'S1', pin: '1234' })).status).toBe(401);
    // a cashier may punch on their till, only a manager sees who is in
    expect((await a.http.get(`${api}/attendance/today`).set(auth(aCashier))).status).toBe(403);
    const who = (await a.http.get(`${api}/attendance/today`).set(auth(await a.login('manager')))).body.data as {
      code: string;
      state: string;
    }[];
    expect(who.find((x) => x.code === 'S1')?.state).toBe('in');
  });
});

describe('worked time at HQ (US-HR-attendance)', () => {
  it('pairs ins and outs by time, puts a night shift on the day it began, and flags what is wrong', async () => {
    // Branch A already has a punch made now, and a punch must come after the last one, so the days of the past are built on branch B, which has none.
    const dbB = b.app.database;
    const userB = (await dbB.one<{ id: number }>('SELECT id FROM users LIMIT 1'))!.id;
    const pB = (iso: string) => punch(dbB, userB, { code: 'S1', pin: '1234' }, at(iso));
    // a plain day: 08:00 to 16:30 in Beirut
    await pB('2026-11-10T06:00:00Z');
    await pB('2026-11-10T14:30:00Z');
    // a night shift: 21:00 to 05:00 the next morning
    await pB('2026-11-11T19:00:00Z');
    await pB('2026-11-12T03:00:00Z');
    // a short day
    await pB('2026-11-13T06:00:00Z');
    await pB('2026-11-13T07:00:00Z'); // the server makes this an out (it alternates), so the day is an hour
    expect(await until(async () => (await day('2026-11-10'))?.minutes === 510)).toBe(true);
    expect((await day('2026-11-10'))?.flags).toEqual([]);
    expect(await until(async () => (await day('2026-11-11'))?.minutes === 480)).toBe(true);
    expect((await days()).find((d) => d.day === '2026-11-12')).toBeUndefined(); // the night's end is on the day it began
    expect((await day('2026-11-13'))?.minutes).toBe(60);
    // the branch tags every punch with where it was made
    expect((await day('2026-11-10'))?.punches.map((x) => [x.kind, x.branchId, x.source])).toEqual([
      ['in', idB, 'punch'],
      ['out', idB, 'punch'],
    ]);
  });

  it('a mistake is corrected by an adjustment, not an edit: add a missing out, or cancel a punch', async () => {
    // an in on the 14th that was never closed
    const dbB = b.app.database;
    const userB = (await dbB.one<{ id: number }>('SELECT id FROM users LIMIT 1'))!.id;
    await punch(dbB, userB, { code: 'S1', pin: '1234' }, at('2026-11-14T06:00:00Z'));
    expect(await until(async () => (await day('2026-11-14'))?.flags.includes('open') === true)).toBe(true);
    expect((await day('2026-11-14'))?.minutes).toBe(0);

    const bad = await hq.http
      .post(`${api}/attendance/adjustments`)
      .set(adminAuth)
      .send({ action: 'add', employeeId: sami, kind: 'out', at: '2026-11-14T14:00:00Z', branchId: idB, reason: 'x' });
    expect(bad.status).toBe(400); // a reason is required (3 characters at least)
    const fixed = await hq.http
      .post(`${api}/attendance/adjustments`)
      .set(adminAuth)
      .send({ action: 'add', employeeId: sami, kind: 'out', at: '2026-11-14T14:00:00Z', branchId: idB, reason: 'Forgot to clock out' });
    expect(fixed.status).toBe(201);
    const d14 = await day('2026-11-14');
    expect(d14).toMatchObject({ minutes: 480, flags: [] });
    expect(d14?.punches.map((x) => x.source)).toEqual(['punch', 'adjustment']);

    // cancel the 13th's second punch (it was a mistake): that in is never closed
    const punches = (await hq.app.database.all<{ id: number; created_at: string }>(
      "SELECT id, created_at FROM attendance_punches WHERE branch_id = ? AND created_at = '2026-11-13T07:00:00.000Z'",
      [idB],
    ))!;
    expect(punches).toHaveLength(1);
    const cancel = (reason: string) =>
      hq.http
        .post(`${api}/attendance/adjustments`)
        .set(adminAuth)
        .send({ action: 'cancel', employeeId: sami, branchId: idB, punchId: punches[0]!.id, reason });
    expect((await cancel('Pressed by mistake')).status).toBe(201);
    expect((await cancel('Again')).status).toBe(409); // once
    expect(await until(async () => (await day('2026-11-13'))?.flags.includes('double_in') === true)).toBe(true); // the 13th's in was never closed: the next in is on the 14th
    expect((await day('2026-11-13'))?.minutes).toBe(0);
    // the fact itself was never touched: it is still in HQ's mirror, and an adjustment cannot be edited or deleted
    expect(
      (await hq.app.database.one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM attendance_punches WHERE created_at = '2026-11-13T07:00:00.000Z'",
      ))!.n,
    ).toBe(1);
    await expect(hq.app.database.run('UPDATE attendance_adjustments SET reason = ?', ['changed'])).rejects.toThrow();
    await expect(hq.app.database.run('DELETE FROM attendance_adjustments')).rejects.toThrow();
  });

  it('HQ holds exactly the punches the branches hold, and the daily control agrees', async () => {
    for (const c of [a, b]) {
      const admin = await c.login('admin');
      expect(await until(async () => (await c.http.get(`${api}/sync/verify`).set(auth(admin))).body.inSync === true)).toBe(true);
      const t = (
        (await c.http.get(`${api}/sync/verify`).set(auth(admin))).body.tables as { table: string; match: boolean; hq: { count: number } }[]
      ).find((x) => x.table === 'attendance_punches')!;
      expect(t.match).toBe(true);
    }
  });
});
