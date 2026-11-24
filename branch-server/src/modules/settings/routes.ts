import { buildEscPos, type Receipt } from '@pos/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { inWriteTransaction } from '../../db/open';
import { AppError } from '../../errors';
import { parse } from '../../util/validate';
import { writeAudit } from '../audit/service';
import { PrinterError } from '../printing/driver';

type Row = {
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  lbp_rounding: number;
  receipt_footer: string;
  receipt_width: number;
  printer_name: string | null;
  cashier_discount_limit_pct: number;
};

const toJson = (r: Row) => ({
  name: r.name,
  address: r.address,
  phone: r.phone,
  email: r.email,
  lbpRounding: r.lbp_rounding,
  receiptFooter: r.receipt_footer,
  receiptWidth: r.receipt_width,
  printerName: r.printer_name,
  cashierDiscountLimitPct: r.cashier_discount_limit_pct,
});

const patchBody = z
  .object({
    name: z.string().min(1).max(100),
    address: z.string().max(200).nullable(),
    phone: z.string().max(50).nullable(),
    email: z.string().max(100).nullable(),
    lbpRounding: z.number().int().min(1).max(1_000_000),
    receiptFooter: z.string().max(200),
    receiptWidth: z.number().int().min(20).max(80),
    printerName: z.string().max(200).nullable(),
    cashierDiscountLimitPct: z.number().int().min(0).max(100),
  })
  .partial();

const COLUMN: Record<keyof z.infer<typeof patchBody>, string> = {
  name: 'name',
  address: 'address',
  phone: 'phone',
  email: 'email',
  lbpRounding: 'lbp_rounding',
  receiptFooter: 'receipt_footer',
  receiptWidth: 'receipt_width',
  printerName: 'printer_name',
  cashierDiscountLimitPct: 'cashier_discount_limit_pct',
};

export default async function settingsRoutes(app: FastifyInstance) {
  const db = app.db;
  const read = () => toJson(db.prepare('SELECT * FROM store_settings WHERE id = 1').get() as Row);

  // The till needs the shop name, rounding and receipt layout. Nothing here is secret.
  app.get('/settings/public', { preHandler: app.authenticate }, async () => {
    const { name, address, phone, lbpRounding, receiptFooter, receiptWidth, cashierDiscountLimitPct, printerName } = read();
    // Only whether a printer is configured, never its name: the till uses it to choose between the USB printer and browser print.
    return {
      name,
      address,
      phone,
      lbpRounding,
      receiptFooter,
      receiptWidth,
      cashierDiscountLimitPct,
      printerConfigured: !!printerName?.trim(),
    };
  });

  app.get('/settings', { preHandler: app.requireRole('admin') }, async () => read());

  // A short slip to check the printer on the day it is set up: the shop's header, a name long enough to wrap, an Arabic
  // name (it must come out as readable Latin letters), a ruler as wide as the receipt, and optionally the cash drawer.
  app.post('/settings/printer-test', { preHandler: app.requireRole('admin') }, async (req) => {
    const b = parse(z.object({ openDrawer: z.boolean().default(false) }), req.body ?? {});
    const s = read();
    if (!s.printerName?.trim()) throw new AppError(503, 'PRINTER_NOT_CONFIGURED', 'No receipt printer name is set yet. Save it first.');
    const receipt: Receipt = {
      storeName: s.name,
      address: s.address ?? undefined,
      phone: s.phone ?? undefined,
      ref: 0,
      createdAt: new Date().toISOString(),
      cashier: req.auth.name,
      items: [
        { name: 'Test item with a rather long name to show the line wrapping', qty: '2', unitPriceLbp: 25_000, totalLbp: 50_000 },
        { name: 'حليب كامل الدسم', qty: '1', unitPriceLbp: 50_000, totalLbp: 50_000 },
      ],
      subtotalLbp: 100_000,
      totalLbp: 100_000,
      rateLbpPerUsd: 90_000,
      payments: [{ label: 'Cash', amountLbp: 100_000 }],
      changeLbp: 0,
      footer: `*** TEST PRINT, width ${s.receiptWidth} ***\n${'1234567890'.repeat(8).slice(0, s.receiptWidth)}`,
    };
    try {
      await app.printer.print(buildEscPos(receipt, { width: s.receiptWidth, openDrawer: b.openDrawer, barcode: false }), s.printerName);
    } catch (e) {
      if (e instanceof PrinterError) throw new AppError(503, e.code, e.message);
      throw e;
    }
    return { printed: true };
  });

  app.patch('/settings', { preHandler: app.requireRole('admin') }, async (req) => {
    const b = parse(patchBody, req.body);
    const before = read();
    inWriteTransaction(db, () => {
      const entries = Object.entries(b) as [keyof typeof COLUMN, unknown][];
      if (entries.length) {
        db.prepare(`UPDATE store_settings SET ${entries.map(([k]) => `${COLUMN[k]} = ?`).join(', ')} WHERE id = 1`).run(
          ...entries.map(([, v]) => v),
        );
      }
      writeAudit(db, { userId: req.auth.id, action: 'settings.update', entity: 'settings', entityId: 1, before, after: b });
    });
    return read();
  });
}
