import type { FastifyInstance } from 'fastify';
import { buildEscPos, renderReceiptText } from '@pos/shared';
import { z } from 'zod';
import { hasRole } from '../../auth/permissions';
import { AppError, E } from '../../errors';
import { writeAudit } from '../audit/service';
import { PrinterError } from '../printing/driver';
import { hashRequest, requireIdempotencyKey } from '../../util/idempotency';
import { parse } from '../../util/validate';
import { createSale, getSale, receiptFor, saleBody, saleJson, saleSummaryJson } from './service';
import { voidBody, voidSale } from './void';

const listQuery = z.object({
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  customerId: z.coerce.number().int().positive().optional(),
  userId: z.coerce.number().int().positive().optional(),
  ref: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.coerce.number().int().positive().optional(),
});

export default async function saleRoutes(app: FastifyInstance) {
  const db = app.db;
  const user = { preHandler: app.authenticate };

  app.post('/sales', user, async (req, reply) => {
    const key = requireIdempotencyKey(req);
    const body = parse(saleBody, req.body);
    const result = createSale(db, req.auth, body, { key, hash: hashRequest(req.body) });
    if (result.replay) void reply.header('Idempotent-Replay', 'true');
    return reply.status(result.replay ? 200 : result.statusCode).send(result.body);
  });

  // Cashiers see their own sales; managers see everyone's.
  app.get('/sales', user, async (req) => {
    const q = parse(listQuery, req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      if (v === undefined) return;
      where.push(sql);
      params.push(v);
    };
    add('s.created_at >= ?', q.from);
    add('s.created_at <= ?', q.to);
    add('s.customer_id = ?', q.customerId);
    add('s.ref = ?', q.ref);
    add('s.id < ?', q.cursor);
    add('s.user_id = ?', hasRole(req.auth.role, 'manager') ? q.userId : req.auth.id);

    // With the customer's and the cashier's names, so a list can say who bought and who sold without a lookup for each row.
    const rows = db
      .prepare(
        `SELECT s.*, c.name AS customer_name, u.name AS user_name
         FROM sales s JOIN customers c ON c.id = s.customer_id LEFT JOIN users u ON u.id = s.user_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY s.id DESC LIMIT ?`,
      )
      .all(...params, q.limit + 1) as (Parameters<typeof saleSummaryJson>[0] & { customer_name: string; user_name: string | null })[];
    const page = rows.slice(0, q.limit);
    return {
      data: page.map((s) => ({ ...saleSummaryJson(s), customerName: s.customer_name, userName: s.user_name })),
      nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  });

  // A manager throws away a sale that waited on a till and was refused (so it never reached the server). Nothing is deleted
  // here: the sale was never recorded. This only leaves a trace of who discarded what and why, so a sale cannot vanish silently.
  app.post('/sales/queued-discard', { preHandler: app.requireRole('manager') }, async (req, reply) => {
    const b = parse(
      z.object({
        clientSaleId: z.string().min(1).max(64),
        reason: z.string().trim().min(1, 'Say why the sale is being discarded').max(200),
        /** What the sale was, in words, as the till showed it. */
        summary: z.string().max(1000),
      }),
      req.body,
    );
    // If the server DID record it (the answer was lost on the way back), discarding is wrong: sending it again just returns it.
    const recorded = db.prepare('SELECT ref FROM sales WHERE client_sale_id = ?').get(b.clientSaleId) as { ref: number } | undefined;
    if (recorded)
      throw E.conflict(
        'SALE_ALREADY_RECORDED',
        `That sale was recorded after all, as receipt ${recorded.ref}. It does not need to be discarded.`,
      );
    writeAudit(db, {
      userId: req.auth.id,
      action: 'sale.queued.discard',
      entity: 'sale',
      entityId: b.clientSaleId,
      after: { reason: b.reason, summary: b.summary },
    });
    return reply.status(204).send();
  });

  // Cancel a sale while its register is still open. A cashier needs a manager's approval (VOID_NEEDS_APPROVAL).
  app.post('/sales/:id/void', user, async (req, reply) => {
    const key = requireIdempotencyKey(req);
    const id = Number((req.params as { id: string }).id);
    const body = parse(voidBody, req.body);
    const result = voidSale(db, req.auth, id, body, { key, hash: hashRequest({ id, ...body }) });
    if (result.replay) void reply.header('Idempotent-Replay', 'true');
    return reply.status(result.replay ? 200 : result.statusCode).send(result.body);
  });

  // Look a sale up by its receipt number (returns, reprints).
  app.get('/sales/by-ref/:ref', user, async (req) => {
    const s = db.prepare('SELECT * FROM sales WHERE ref = ?').get(Number((req.params as { ref: string }).ref)) as
      Parameters<typeof saleJson>[1] | undefined;
    if (!s) throw E.notFound('Sale');
    return saleJson(db, s);
  });

  app.get('/sales/:id', user, async (req) => {
    const s = getSale(db, Number((req.params as { id: string }).id));
    if (!s) throw E.notFound('Sale');
    return saleJson(db, s);
  });

  // Print on the USB receipt printer. The sale is already saved, so a failure here is only a 503 for the till to show
  // ("Retry" / "Use browser print"); it never touches the sale.
  app.post('/sales/:id/print', user, async (req) => {
    const s = getSale(db, Number((req.params as { id: string }).id));
    if (!s) throw E.notFound('Sale');
    const body = parse(
      z.object({
        copies: z.number().int().min(1).max(3).default(1),
        /** Only honoured for the first print of a sale. A reprint never opens the drawer. */
        openDrawer: z.boolean().optional(),
        /** The till says this is a reprint (for instance from the recent-sales screen). The server also works it out. */
        duplicate: z.boolean().optional(),
      }),
      req.body ?? {},
    );

    const store = db.prepare('SELECT printer_name, receipt_width FROM store_settings WHERE id = 1').get() as {
      printer_name: string | null;
      receipt_width: number;
    };
    if (!store.printer_name?.trim()) throw new AppError(503, 'PRINTER_NOT_CONFIGURED', 'No receipt printer is set up. Use browser print.');

    // A sale that has already been printed once, or that the till says is a reprint, prints as a DUPLICATE. Only prints that
    // actually reached the printer count, so a first print that failed is still the first.
    const printedBefore = (
      db.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'sale.print' AND entity_id = ?").get(String(s.id)) as { n: number }
    ).n;
    const duplicate = body.duplicate === true || printedBefore > 0;

    // The drawer opens on the first print of a sale that took cash, and never on a reprint: a reprint is not a sale, so it must
    // not be a way to open the drawer.
    const tookCash =
      (db.prepare("SELECT count(*) AS n FROM payments WHERE sale_id = ? AND method = 'cash'").get(s.id) as { n: number }).n > 0;
    const openDrawer = !duplicate && (body.openDrawer ?? tookCash);
    const receipt = { ...receiptFor(db, s), duplicate };
    const first = buildEscPos(receipt, { width: store.receipt_width, openDrawer });
    const rest = buildEscPos(receipt, { width: store.receipt_width });
    try {
      for (let i = 0; i < body.copies; i++) await app.printer.print(i === 0 ? first : rest, store.printer_name);
    } catch (e) {
      if (e instanceof PrinterError) throw new AppError(503, e.code, e.message);
      throw e;
    }
    writeAudit(db, {
      userId: req.auth.id,
      action: 'sale.print',
      entity: 'sale',
      entityId: s.id,
      after: { copies: body.copies, duplicate, drawer: openDrawer },
    });
    return { printed: true, copies: body.copies, duplicate };
  });

  app.get('/sales/:id/receipt', user, async (req, reply) => {
    const s = getSale(db, Number((req.params as { id: string }).id));
    if (!s) throw E.notFound('Sale');
    const { format, duplicate } = parse(
      z.object({ format: z.enum(['json', 'text']).default('json'), duplicate: z.enum(['true', 'false']).default('false') }),
      req.query,
    );
    const receipt = { ...receiptFor(db, s), duplicate: duplicate === 'true' };
    if (format === 'text') {
      const width = (db.prepare('SELECT receipt_width w FROM store_settings WHERE id = 1').get() as { w: number }).w;
      return reply.type('text/plain; charset=utf-8').send(renderReceiptText(receipt, { width }));
    }
    return receipt;
  });
}
