import { parse } from '@pos/core/validate';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { localDay } from '../../util/time';
import {
  addDays,
  addHoliday,
  addLeaveType,
  createShift,
  decideLeave,
  listHolidays,
  listLeave,
  listLeaveTypes,
  listRoster,
  listShifts,
  removeHoliday,
  requestLeave,
  scheduleView,
  setRoster,
  setShiftActive,
} from './schedule';

const idParam = z.object({ id: z.coerce.number().int().min(1) });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a day such as 2026-11-30');
const MAX_RANGE_DAYS = 62;

const range = z
  .object({
    from: day.optional(),
    to: day.optional(),
    employeeId: z.coerce.number().int().positive().optional(),
    branchId: z.coerce.number().int().positive().optional(),
  })
  .transform((q) => {
    const to = q.to ?? localDay(new Date());
    return { ...q, to, from: q.from ?? addDays(to, -13) };
  })
  .refine((q) => q.from <= q.to, 'The start is after the end')
  .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= MAX_RANGE_DAYS * 86_400_000, `At most ${MAX_RANGE_DAYS} days at a time`);

/** Shifts, rosters, holidays, leave and the plan-against-attendance view (docs/16 §6, P6a-2). Staff read; an admin changes (the HR roles come in 6c). */
export default async function scheduleRoutes(app: FastifyInstance) {
  const db = app.database;
  const view = { preHandler: app.requireStaff('viewer') };
  const admin = { preHandler: app.requireStaff('hr') }; // HR changes (an admin can too)

  app.get('/shifts', view, async () => ({ data: await listShifts(db) }));
  app.post('/shifts', admin, async (req, reply) => {
    const b = parse(
      z.object({
        name: z.string().trim().min(1).max(60),
        startMinute: z.number().int().min(0).max(1439),
        lengthMinutes: z.number().int().min(1).max(1440),
        graceMinutes: z.number().int().min(0).max(240).default(5),
      }),
      req.body,
    );
    const id = await app.staffTx(req, (tx) => createShift(tx, b));
    return reply.status(201).send({ id });
  });
  app.patch('/shifts/:id', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ active: z.boolean() }), req.body);
    await app.staffTx(req, (tx) => setShiftActive(tx, id, b.active));
    return { data: await listShifts(db) };
  });

  app.get('/roster', view, async (req) => {
    const q = parse(range, req.query);
    return { from: q.from, to: q.to, data: await listRoster(db, q) };
  });
  app.put('/roster', admin, async (req) => {
    const b = parse(
      z.object({
        entries: z
          .array(
            z.object({
              employeeId: z.number().int().positive(),
              day,
              shiftId: z.number().int().positive().nullable(),
              branchId: z.number().int().positive(),
            }),
          )
          .min(1)
          .max(500),
      }),
      req.body,
    );
    await app.staffTx(req, (tx) => setRoster(tx, b.entries));
    return { updated: b.entries.length };
  });

  app.get('/holidays', view, async () => ({ data: await listHolidays(db) }));
  app.post('/holidays', admin, async (req, reply) => {
    const b = parse(z.object({ day, name: z.string().trim().min(1).max(80) }), req.body);
    await app.staffTx(req, (tx) => addHoliday(tx, b.day, b.name));
    return reply.status(201).send({ data: await listHolidays(db) });
  });
  app.delete('/holidays/:day', admin, async (req, reply) => {
    const p = parse(z.object({ day }), req.params);
    await app.staffTx(req, (tx) => removeHoliday(tx, p.day));
    return reply.status(204).send();
  });

  app.get('/leave-types', view, async () => ({ data: await listLeaveTypes(db) }));
  app.post('/leave-types', admin, async (req, reply) => {
    const b = parse(
      z.object({
        code: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9_]{1,20}$/)
          .transform((v) => v.toUpperCase()),
        name: z.string().trim().min(1).max(60),
        paid: z.boolean(),
      }),
      req.body,
    );
    const id = await app.staffTx(req, (tx) => addLeaveType(tx, b));
    return reply.status(201).send({ id });
  });

  app.get('/leave-requests', view, async (req) => {
    const q = parse(
      z.object({
        employeeId: z.coerce.number().int().positive().optional(),
        status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
      }),
      req.query,
    );
    return { data: await listLeave(db, q) };
  });
  app.post('/leave-requests', admin, async (req, reply) => {
    const b = parse(
      z.object({
        employeeId: z.number().int().positive(),
        typeId: z.number().int().positive(),
        fromDay: day,
        toDay: day,
        reason: z.string().trim().max(300).nullish(),
      }),
      req.body,
    );
    const id = await app.staffTx(req, (tx) => requestLeave(tx, { ...b, reason: b.reason ?? null }));
    return reply.status(201).send({ id });
  });
  for (const [path, to] of [
    ['approve', 'approved'],
    ['reject', 'rejected'],
    ['cancel', 'cancelled'],
  ] as const) {
    app.post(`/leave-requests/:id/${path}`, admin, async (req) => {
      const { id } = parse(idParam, req.params);
      await app.staffTx(req, (tx) => decideLeave(tx, id, to));
      return { data: await listLeave(db, {}) };
    });
  }

  // The plan beside what happened: per rostered day worked, late, early, absent, on leave or a holiday; attendance with no roster is `unscheduled`.
  app.get('/attendance/schedule', view, async (req) => {
    const q = parse(range, req.query);
    const data = await scheduleView(db, q);
    const sum = (f: (d: (typeof data)[number]) => number) => data.reduce((n, d) => n + f(d), 0);
    return {
      from: q.from,
      to: q.to,
      data,
      totals: {
        scheduledMinutes: sum((d) => d.scheduledMinutes),
        workedMinutes: sum((d) => d.workedMinutes),
        lateMinutes: sum((d) => d.lateMinutes),
        earlyLeaveMinutes: sum((d) => d.earlyLeaveMinutes),
        absentDays: data.filter((d) => d.status === 'absent').length,
        leaveDays: data.filter((d) => d.status === 'on_leave').length,
      },
    };
  });
}
