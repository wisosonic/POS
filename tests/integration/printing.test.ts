import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startCtx, type TestCtx } from '../helpers/app';
import { PrinterError, windowsSpoolerPrinter, type ReceiptPrinter } from '../../apps/api/src/modules/printing/driver';

// Receipt printing (US-06, decision Q2): the server sends raw ESC/POS bytes to the USB printer. The sale is already
// saved by then, so a printer problem is a 503 for the till to show and never changes the sale.
type Job = { bytes: Uint8Array; printer: string };
const jobs: Job[] = [];
let failWith: PrinterError | null = null;
const fake: ReceiptPrinter = {
  async print(bytes, printer) {
    if (failWith) throw failWith;
    jobs.push({ bytes, printer });
  },
};

let c: TestCtx;
let cashier: string;
let admin: string;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const text = (b: Uint8Array) => Buffer.from(b).toString('latin1');
const hasDrawerPulse = (b: Uint8Array) => b.some((v, i) => v === 0x1b && b[i + 1] === 0x70);

const sell = (over: Record<string, unknown> = {}) =>
  c.http.post(`${api}/sales`).set(auth(cashier)).set('Idempotency-Key', randomUUID()).send(c.newSaleBody(over));
const print = (saleId: number, body: Record<string, unknown> = {}, token = cashier) =>
  c.http.post(`${api}/sales/${saleId}/print`).set(auth(token)).send(body);

beforeAll(async () => {
  c = await startCtx({ printer: fake });
  cashier = await c.login('cashier');
  admin = await c.login('admin');
  await c.openRegister(cashier);
});
afterAll(() => c.close());

describe('before a printer is set up', () => {
  it('answers 503 PRINTER_NOT_CONFIGURED so the till falls back to browser print', async () => {
    const s = await sell();
    const res = await print(s.body.id);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('PRINTER_NOT_CONFIGURED');
    expect(jobs).toHaveLength(0);
  });

  it('tells the till whether a printer is configured, without revealing its name', async () => {
    const pub = await c.http.get(`${api}/settings/public`).set(auth(cashier));
    expect(pub.body.printerConfigured).toBe(false);
    expect(JSON.stringify(pub.body)).not.toMatch(/printerName/);
  });
});

describe('with a printer', () => {
  beforeAll(async () => {
    await c.http.patch(`${api}/settings`).set(auth(admin)).send({ printerName: 'POS-80 Receipt' });
  });

  it('is now reported as configured, and still without the name', async () => {
    const pub = await c.http.get(`${api}/settings/public`).set(auth(cashier));
    expect(pub.body.printerConfigured).toBe(true);
    expect(JSON.stringify(pub.body)).not.toContain('POS-80');
  });

  it('prints a receipt to the configured printer', async () => {
    jobs.length = 0;
    const s = await sell();
    const res = await print(s.body.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ printed: true, copies: 1, duplicate: false });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.printer).toBe('POS-80 Receipt');
  });

  it('sends an ESC/POS receipt: initialise first, cut last, receipt number and total in the text', async () => {
    jobs.length = 0;
    const s = await sell();
    await print(s.body.id);
    const bytes = jobs[0]!.bytes;
    expect([bytes[0], bytes[1]]).toEqual([0x1b, 0x40]); // ESC @
    expect(Array.from(bytes.slice(-4))).toEqual([0x1d, 0x56, 0x42, 0x00]); // GS V B 0: cut
    expect(text(bytes)).toContain(`Receipt #${s.body.ref}`);
    expect(text(bytes)).toMatch(/TOTAL \(LL\)\s+75,000/);
  });

  it('is plain ASCII: an Arabic product name is transliterated, never sent as bytes the printer cannot show', async () => {
    jobs.length = 0;
    const manager = await c.login('manager');
    const p = await c.http
      .post(`${api}/products`)
      .set(auth(manager))
      .send({ name: 'خبز كبير', barcode: '7200000000001', priceMinor: 20000, currency: 'LBP', unitId: c.seed.units.piece.id });
    const s = await sell({
      items: [{ productId: p.body.id, qty: '1', unitPriceLbp: 20000 }],
      payments: [{ method: 'cash', currency: 'LBP', amount: 20000 }],
    });
    await print(s.body.id);
    const bytes = jobs[0]!.bytes;
    expect(Array.from(bytes).every((b) => b < 0x80)).toBe(true);
    expect(text(bytes)).toContain('khbz kbyr');
  });

  it('opens the cash drawer for a sale that took cash, but not for a wallet-only sale', async () => {
    jobs.length = 0;
    const cashSale = await sell();
    const walletSale = await sell({ payments: [{ method: 'whish', currency: 'LBP', amount: 75000 }] });
    await print(cashSale.body.id);
    await print(walletSale.body.id);
    expect(hasDrawerPulse(jobs[0]!.bytes)).toBe(true);
    expect(hasDrawerPulse(jobs[1]!.bytes)).toBe(false);
  });

  it('the drawer can be forced off or on for the first print of a sale (a reprint never opens it: see reprint.test.ts)', async () => {
    jobs.length = 0;
    await print((await sell()).body.id, { openDrawer: false });
    await print((await sell()).body.id, { openDrawer: true });
    expect([hasDrawerPulse(jobs[0]!.bytes), hasDrawerPulse(jobs[1]!.bytes)]).toEqual([false, true]);
  });

  it('prints several copies, and the drawer opens only once', async () => {
    jobs.length = 0;
    const s = await sell();
    const res = await print(s.body.id, { copies: 3 });
    expect(res.body.copies).toBe(3);
    expect(jobs).toHaveLength(3);
    expect(jobs.map((j) => hasDrawerPulse(j.bytes))).toEqual([true, false, false]);
  });

  it('can reprint an old sale', async () => {
    jobs.length = 0;
    const s = await sell();
    await print(s.body.id);
    await print(s.body.id);
    expect(jobs).toHaveLength(2);
  });

  it('a credit sale prints what remains and the account balance', async () => {
    jobs.length = 0;
    const s = await sell({ customerId: c.seed.customers.registered.id, payments: [{ method: 'cash', currency: 'LBP', amount: 25000 }] });
    await print(s.body.id);
    expect(text(jobs[0]!.bytes)).toMatch(/Remaining\s+50,000/);
  });

  it.each([
    ['zero copies', { copies: 0 }],
    ['too many copies', { copies: 4 }],
    ['a fractional number of copies', { copies: 1.5 }],
    ['copies as text', { copies: 'two' }],
  ])('refuses %s', async (_n, body) => {
    const s = await sell();
    jobs.length = 0;
    expect((await print(s.body.id, body)).status).toBe(400);
    expect(jobs).toHaveLength(0);
  });

  it('404 for an unknown sale, 401 without a token; any signed-in cashier may print', async () => {
    expect((await print(99999999)).status).toBe(404);
    expect((await c.http.post(`${api}/sales/1/print`).send({})).status).toBe(401);
  });
});

describe('when the printer is off or missing', () => {
  it('answers 503 with the printer’s own code and message, and the sale is untouched', async () => {
    const s = await sell();
    const stock = async () =>
      Number((await c.http.get(`${api}/stock?productId=${c.seed.products.towel.id}`).set(auth(cashier))).body.data[0].qty);
    const before = await stock();
    failWith = new PrinterError('PRINTER_OFFLINE', "Cannot open printer 'POS-80 Receipt' (error 1801)");
    try {
      const res = await print(s.body.id);
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ code: 'PRINTER_OFFLINE' });
      expect(res.body.detail).toContain('Cannot open printer');
    } finally {
      failWith = null;
    }
    const after = await c.http.get(`${api}/sales/${s.body.id}`).set(auth(cashier));
    expect(after.status).toBe(200);
    expect(after.body).toMatchObject({ totalLbp: 75000, status: 'paid' });
    expect(await stock()).toBe(before);
  });

  it('a retry works once the printer is back', async () => {
    const s = await sell();
    failWith = new PrinterError('PRINTER_OFFLINE', 'paper out');
    expect((await print(s.body.id)).status).toBe(503);
    failWith = null;
    jobs.length = 0;
    expect((await print(s.body.id)).status).toBe(200);
    expect(jobs).toHaveLength(1);
  });

  it('an unexpected driver error is a 500, never leaking its details', async () => {
    const s = await sell();
    const original = fake.print;
    fake.print = async () => {
      throw new Error('secret internal path C:\\Windows\\system32');
    };
    try {
      const res = await print(s.body.id);
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('system32');
    } finally {
      fake.print = original;
    }
  });
});

describe.runIf(process.platform === 'win32')('the real Windows spooler driver', () => {
  it('fails cleanly for a printer that is not installed, with the Windows reason', async () => {
    await expect(windowsSpoolerPrinter.print(Uint8Array.from([0x1b, 0x40]), 'No Such Printer 7431')).rejects.toMatchObject({
      name: 'PrinterError',
      code: 'PRINTER_OFFLINE',
      message: expect.stringContaining('Cannot open printer'),
    });
  }, 30_000);

  it('refuses an empty printer name', async () => {
    await expect(windowsSpoolerPrinter.print(Uint8Array.from([0x1b, 0x40]), '  ')).rejects.toMatchObject({
      code: 'PRINTER_NOT_CONFIGURED',
    });
  });

  it('leaves no temporary file behind', async () => {
    const { readdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const count = () => readdirSync(tmpdir()).filter((f) => f.startsWith('pos-print-')).length;
    const before = count();
    await windowsSpoolerPrinter.print(Uint8Array.from([0x1b, 0x40]), 'No Such Printer 7431').catch(() => undefined);
    expect(count()).toBe(before);
  }, 30_000);
});
