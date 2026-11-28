import { parse } from '@pos/core/validate';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  addInput,
  addRule,
  approveRun,
  calculateRun,
  createLoan,
  createRun,
  listLoans,
  listProfiles,
  listRuns,
  listRules,
  lockRun,
  payRun,
  removeInput,
  runJson,
  setProfile,
} from './service';

const idParam = z.object({ id: z.coerce.number().int().min(1) });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a day such as 2026-11-30');
const money = z.number().int().min(0).max(1_000_000_000_000);
const positive = money.min(1);
const currency = z.enum(['USD', 'LBP']);
const ruleCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_]{1,20}$/, 'A rule code has 1 to 20 letters, digits or underscores')
  .transform((v) => v.toUpperCase());

/**
 * Payroll (docs/16 §5, P6b). Salary data is the most sensitive in the system, so EVERY route here is for an admin, reading included (the HR and payroll
 * roles come in 6c). Nothing here is ever sent to a branch.
 */
export default async function payrollRoutes(app: FastifyInstance) {
  const db = app.database;
  const admin = { preHandler: app.requireStaff('payroll') }; // pay is for payroll (an admin can too)

  // ---- pay profiles (dated, never edited)
  app.get('/employees/:id/pay-profiles', admin, async (req) => ({ data: await listProfiles(db, parse(idParam, req.params).id) }));
  app.post('/employees/:id/pay-profiles', admin, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const b = parse(
      z.object({
        effectiveFrom: day,
        type: z.enum(['monthly', 'daily', 'hourly']),
        baseMinor: money,
        currency,
        overtimeAfterMinutes: z.number().int().min(0).max(1440).nullable().default(null),
        overtimeBp: z.number().int().min(0).max(100_000).default(15_000),
        standardDayMinutes: z.number().int().min(1).max(1440).default(480),
        workDaysPerMonth: z.number().int().min(1).max(31).default(26),
        dailyMinMinutes: z.number().int().min(0).max(1440).default(240),
        ruleCodes: z.array(ruleCode).max(20).default([]),
      }),
      req.body,
    );
    const profileId = await app.staffTx(req, (tx) => setProfile(tx, id, b));
    return reply.status(201).send({ id: profileId, data: await listProfiles(db, id) });
  });

  // ---- rules (dated, never edited: a new row from a day on)
  app.get('/payroll/rules', admin, async () => ({ data: await listRules(db) }));
  app.post('/payroll/rules', admin, async (req, reply) => {
    const b = parse(
      z.object({
        code: ruleCode,
        name: z.string().trim().min(1).max(80),
        kind: z.enum(['percent', 'brackets']),
        side: z.enum(['employee', 'employer']).default('employee'),
        base: z.enum(['gross', 'taxable']).default('gross'),
        reducesTax: z.boolean().default(false),
        currency: currency.default('LBP'),
        rateBp: z.number().int().min(0).max(10_000).default(0),
        capBaseMinor: money.nullable().default(null),
        brackets: z
          .array(z.object({ fromMinor: money, rateBp: z.number().int().min(0).max(10_000) }))
          .max(30)
          .default([]),
        effectiveFrom: day,
      }),
      req.body,
    );
    const id = await app.staffTx(req, (tx) => addRule(tx, b));
    return reply.status(201).send({ id });
  });

  // ---- loans
  app.get('/loans', admin, async (req) => {
    const q = parse(z.object({ employeeId: z.coerce.number().int().positive().optional() }), req.query);
    return { data: await listLoans(db, q.employeeId) };
  });
  app.post('/loans', admin, async (req, reply) => {
    const b = parse(
      z.object({
        employeeId: z.number().int().positive(),
        principalMinor: positive,
        currency,
        installmentMinor: positive,
        note: z.string().trim().max(200).nullish(),
      }),
      req.body,
    );
    const id = await app.staffTx(req, (tx) => createLoan(tx, { ...b, note: b.note ?? null }));
    return reply.status(201).send({ id });
  });

  // ---- runs
  app.get('/payroll/runs', admin, async () => ({ data: await listRuns(db) }));
  app.get('/payroll/runs/:id', admin, async (req) => runJson(db, parse(idParam, req.params).id));
  app.post('/payroll/runs', admin, async (req, reply) => {
    const b = parse(z.object({ fromDay: day, toDay: day, note: z.string().trim().max(200).nullish() }), req.body);
    const id = await app.staffTx(req, (tx) => createRun(tx, { ...b, note: b.note ?? null }));
    return reply.status(201).send(await runJson(db, id));
  });
  app.post('/payroll/runs/:id/inputs', admin, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const b = parse(
      z.object({
        employeeId: z.number().int().positive(),
        kind: z.enum(['earning', 'deduction']),
        label: z.string().trim().min(1).max(80),
        amountMinor: positive,
      }),
      req.body,
    );
    const inputId = await app.staffTx(req, (tx) => addInput(tx, id, b));
    return reply.status(201).send({ id: inputId });
  });
  app.delete('/payroll/runs/:id/inputs/:inputId', admin, async (req, reply) => {
    const p = parse(z.object({ id: z.coerce.number().int().min(1), inputId: z.coerce.number().int().min(1) }), req.params);
    await app.staffTx(req, (tx) => removeInput(tx, p.id, p.inputId));
    return reply.status(204).send();
  });
  app.post('/payroll/runs/:id/calculate', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const result = await app.staffTx(req, (tx) => calculateRun(tx, id));
    return { ...result, run: await runJson(db, id) };
  });
  app.post('/payroll/runs/:id/approve', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    await app.staffTx(req, (tx) => approveRun(tx, id));
    return runJson(db, id);
  });
  app.post('/payroll/runs/:id/pay', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    await app.staffTx(req, (tx) => payRun(tx, id));
    return runJson(db, id);
  });
  app.post('/payroll/runs/:id/lock', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    await app.staffTx(req, (tx) => lockRun(tx, id));
    return runJson(db, id);
  });
}
