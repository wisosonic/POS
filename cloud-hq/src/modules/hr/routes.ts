import { parse } from '@pos/core/validate';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashPassword } from '../../auth/password';
import { localDay } from '../../util/time';
import { addAdjustment, attendanceDays, createEmployee, employeeJson, listEmployees, setBranches, setPin, updateEmployee } from './service';

const idParam = z.object({ id: z.coerce.number().int().min(1) });
const code = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._-]{1,20}$/, 'The code has 1 to 20 letters, digits, dot, dash or underscore')
  .transform((v) => v.toUpperCase());
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a day such as 2026-11-30');
const iso = z
  .string()
  .max(40)
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Use a date and time such as 2026-11-30T08:00:00Z');

/** HR at HQ (docs/16, P6a-1). Anyone on HQ's staff reads; changing employees and correcting attendance is for an admin (the HR roles come in 6c). */
export default async function hrRoutes(app: FastifyInstance) {
  const db = app.database;
  const view = { preHandler: app.requireStaff('viewer') };
  const admin = { preHandler: app.requireStaff('admin') };

  app.get('/employees', view, async (req) => {
    const q = parse(
      z.object({
        branchId: z.coerce.number().int().positive().optional(),
        active: z.enum(['true', 'false']).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      }),
      req.query,
    );
    return {
      data: await listEmployees(db, {
        branchId: q.branchId,
        active: q.active === undefined ? undefined : q.active === 'true',
        limit: q.limit,
      }),
    };
  });

  app.get('/employees/:id', view, async (req) => employeeJson(db, parse(idParam, req.params).id));

  app.post('/employees', admin, async (req, reply) => {
    const b = parse(
      z.object({ code, name: z.string().trim().min(1).max(120), branchIds: z.array(z.number().int().positive()).max(50).default([]) }),
      req.body,
    );
    const id = await app.staffTx(req, (tx) => createEmployee(tx, b));
    return reply.status(201).send(await employeeJson(db, id));
  });

  app.patch('/employees/:id', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ name: z.string().trim().min(1).max(120), active: z.boolean() }).partial(), req.body);
    await app.staffTx(req, (tx) => updateEmployee(tx, id, b));
    return employeeJson(db, id);
  });

  app.put('/employees/:id/branches', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ branchIds: z.array(z.number().int().positive()).max(50) }), req.body);
    await employeeJson(db, id); // 404 first
    await app.staffTx(req, (tx) => setBranches(tx, id, b.branchIds));
    return employeeJson(db, id);
  });

  // The attendance PIN: 4 to 8 digits, hashed here (slowly, before the transaction), never returned, never logged. It can only clock in and out.
  app.post('/employees/:id/pin', admin, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ pin: z.string().regex(/^\d{4,8}$/, 'The PIN is 4 to 8 digits') }), req.body);
    await employeeJson(db, id);
    const hash = await hashPassword(b.pin);
    await app.staffTx(req, (tx) => setPin(tx, id, hash));
    return reply.status(204).send();
  });

  app.post('/attendance/adjustments', admin, async (req, reply) => {
    const b = parse(
      z.discriminatedUnion('action', [
        z.object({
          action: z.literal('add'),
          employeeId: z.number().int().positive(),
          kind: z.enum(['in', 'out']),
          at: iso,
          branchId: z.number().int().positive(),
          reason: z.string().trim().min(3).max(300),
        }),
        z.object({
          action: z.literal('cancel'),
          employeeId: z.number().int().positive(),
          branchId: z.number().int().positive(),
          punchId: z.number().int().positive(),
          reason: z.string().trim().min(3).max(300),
        }),
      ]),
      req.body,
    );
    const id = await app.staffTx(req, (tx) => addAdjustment(tx, b));
    return reply.status(201).send({ id });
  });

  app.get('/attendance/days', view, async (req) => {
    const q = parse(
      z.object({
        from: day.optional(),
        to: day.optional(),
        employeeId: z.coerce.number().int().positive().optional(),
        branchId: z.coerce.number().int().positive().optional(),
      }),
      req.query,
    );
    const to = q.to ?? localDay(new Date());
    const from = q.from ?? localDay(new Date(Date.parse(`${to}T12:00:00Z`) - 13 * 86_400_000));
    return { from, to, data: await attendanceDays(db, { from, to, employeeId: q.employeeId, branchId: q.branchId }) };
  });
}
