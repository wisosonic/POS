import { AppError } from '@pos/core/errors';
import { parse } from '@pos/core/validate';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashPassword } from '../../auth/password';
import { localDay } from '../../util/time';
import { attendanceDays } from '../hr/service';
import { checkPassword, MAX_PASSWORD, normaliseUsername, USERNAME } from '../staff/users';
import { renderPayslip } from './render';
import {
  auditSlip,
  createEmployeeAccount,
  createPrintLink,
  employeeOfUser,
  ownSlipId,
  ownSlips,
  slipForPayroll,
  slipView,
  usePrintLink,
} from './service';

const idParam = z.object({ id: z.coerce.number().int().min(1) });
const lang = z.object({ lang: z.enum(['en', 'ar']).default('en') });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a day such as 2026-11-30');

/**
 * Payslips for people to read and print, and employee self-service (docs/16 §7, P6c). Payroll (and admin) read any slip; an employee account reads only
 * its OWN paid slips and attendance. Every view and print is audited. The one open door here is the print page: its credential is a one-use link.
 */
export default async function payslipRoutes(app: FastifyInstance) {
  const db = app.database;
  const payroll = { preHandler: app.requireStaff('payroll') };
  const hr = { preHandler: app.requireStaff('hr') };
  const self = { preHandler: app.requireStaff('self') };

  // ---- payroll staff
  app.get('/payroll/payslips/:id', payroll, async (req) => {
    const { id } = parse(idParam, req.params);
    const slip = await slipForPayroll(db, id);
    await app.staffTx(req, (tx) => auditSlip(tx, 'payslip.view', id));
    return slip;
  });
  app.post('/payroll/payslips/:id/print-link', payroll, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const { lang: l } = parse(lang, req.body ?? {});
    const link = await app.staffTx(req, (tx) => createPrintLink(tx, id, l));
    return reply.status(201).send({ url: `/api/v1/print/payslips/${link.token}`, expiresAt: link.expiresAt });
  });

  // ---- HR makes an employee's account
  app.post('/employees/:id/account', hr, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ username: z.string().max(80), password: z.string().max(MAX_PASSWORD) }), req.body);
    const username = normaliseUsername(b.username);
    if (!USERNAME.test(username))
      throw new AppError(422, 'VALIDATION', 'The user name has 3 to 40 characters: letters, digits, dot, dash and underscore');
    checkPassword(b.password);
    const hash = await hashPassword(b.password); // slow: before the transaction
    const emp = await db.one<{ name: string }>('SELECT name FROM employees WHERE id = ?', [id]);
    if (!emp) throw new AppError(404, 'NOT_FOUND', 'Employee not found');
    const userId = await app.staffTx(req, (tx) => createEmployeeAccount(tx, id, username, emp.name, hash));
    return reply.status(201).send({ userId });
  });

  // ---- an employee, about themselves
  app.get('/me/employee', self, async (req) => {
    const employeeId = await employeeOfUser(db, req.staff.id);
    const e = await db.one<{ id: number; code: string; name: string }>('SELECT id, code, name FROM employees WHERE id = ?', [employeeId]);
    return e;
  });
  app.get('/me/payslips', self, async (req) => ({ data: await ownSlips(db, await employeeOfUser(db, req.staff.id)) }));
  app.get('/me/payslips/:id', self, async (req) => {
    const { id } = parse(idParam, req.params);
    const slipId = await ownSlipId(db, await employeeOfUser(db, req.staff.id), id);
    const view = await slipView(db, slipId);
    await app.staffTx(req, (tx) => auditSlip(tx, 'payslip.view', slipId));
    return view;
  });
  app.post('/me/payslips/:id/print-link', self, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const { lang: l } = parse(lang, req.body ?? {});
    const slipId = await ownSlipId(db, await employeeOfUser(db, req.staff.id), id);
    const link = await app.staffTx(req, (tx) => createPrintLink(tx, slipId, l));
    return reply.status(201).send({ url: `/api/v1/print/payslips/${link.token}`, expiresAt: link.expiresAt });
  });
  app.get('/me/attendance', self, async (req) => {
    const q = parse(z.object({ from: day.optional(), to: day.optional() }), req.query);
    const employeeId = await employeeOfUser(db, req.staff.id);
    const to = q.to ?? localDay(new Date());
    const from = q.from ?? localDay(new Date(Date.parse(`${to}T12:00:00Z`) - 13 * 86_400_000));
    if (from > to || Date.parse(to) - Date.parse(from) > 62 * 86_400_000)
      throw new AppError(400, 'VALIDATION', 'Ask for at most 62 days, in order');
    const days = await attendanceDays(db, { from, to, employeeId });
    return {
      from,
      to,
      data: days.map((d) => ({
        day: d.day,
        minutes: d.minutes,
        punches: d.punches.map((p) => ({ at: p.at, kind: p.kind })),
        flags: d.flags,
      })),
    };
  });

  // ---- the print page: the one open door of this module. The link is the credential: one use, two minutes, one payslip.
  app.get('/print/payslips/:token', async (req, reply) => {
    const { token } = parse(z.object({ token: z.string().min(20).max(100) }), req.params);
    const { slipId, lang: l } = await db.tx((tx) => usePrintLink(tx, token));
    const view = await slipView(db, slipId);
    return reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Robots-Tag', 'noindex')
      .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'")
      .send(renderPayslip(view, l, new Date().toISOString()));
  });
}
