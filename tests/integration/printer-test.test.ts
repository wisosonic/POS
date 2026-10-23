import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCtx, type TestCtx } from '../helpers/app';
import { PrinterError, type ReceiptPrinter } from '../../apps/api/src/modules/printing/driver';

// US-06 / R4: the admin can print a test slip to check the printer, its width and the cash drawer on install day.
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
let admin: string;
let manager: string;
let cashier: string;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const text = (b: Uint8Array) => Buffer.from(b).toString('latin1');
const hasDrawerPulse = (b: Uint8Array) => b.some((v, i) => v === 0x1b && b[i + 1] === 0x70);
const test = (body: Record<string, unknown> = {}, token = admin) => c.http.post(`${api}/settings/printer-test`).set(auth(token)).send(body);

beforeAll(async () => {
  c = await startCtx({ printer: fake });
  admin = await c.login('admin');
  manager = await c.login('manager');
  cashier = await c.login('cashier');
});
afterAll(() => c.close());

describe('printer test slip', () => {
  it('says the printer is not set up yet, and prints nothing', async () => {
    const res = await test();
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('PRINTER_NOT_CONFIGURED');
    expect(jobs).toHaveLength(0);
  });

  it('prints to the configured printer: shop header, wrapped name, readable Arabic, a ruler as wide as the receipt', async () => {
    await c.http
      .patch(`${api}/settings`)
      .set(auth(admin))
      .send({ printerName: 'POS-80 Receipt', receiptWidth: 32, name: 'Darwish Market' });
    const res = await test();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ printed: true });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.printer).toBe('POS-80 Receipt');

    const slip = text(jobs[0]!.bytes);
    expect(slip).toContain('DARWISH MARKET'); // the header is printed in capitals
    expect(slip).toContain('TEST PRINT');
    // the long item name wraps: no line is wider than the receipt
    expect(slip).toContain('Test item with a rather');
    // Keep only the characters a person could read; the printer commands in between are not text.
    const readable = (line: string) => [...line].filter((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) < 0x7f).join('');
    const printable = slip.split('\n').map(readable);
    expect(Math.max(...printable.map((l) => l.length))).toBeLessThanOrEqual(32);
    // the ruler is exactly as wide as the receipt, so the owner can see whether the printer cuts it off
    expect(printable.some((l) => l.trim() === '12345678901234567890123456789012')).toBe(true);
    // Arabic never reaches the printer as bytes it cannot show (UTF-8 Arabic starts with 0xD8 or 0xD9)
    expect(jobs[0]!.bytes.some((v) => v === 0xd8 || v === 0xd9)).toBe(false);
    expect(slip).not.toContain('?'); // and it was transliterated, not replaced by question marks
  });

  it('opens the cash drawer only when asked to', async () => {
    jobs.length = 0;
    await test();
    await test({ openDrawer: true });
    expect(hasDrawerPulse(jobs[0]!.bytes)).toBe(false);
    expect(hasDrawerPulse(jobs[1]!.bytes)).toBe(true);
  });

  it('tells the admin what went wrong when the printer cannot be reached', async () => {
    failWith = new PrinterError('PRINTER_OFFLINE', 'The printer is switched off or unplugged');
    const res = await test();
    failWith = null;
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('PRINTER_OFFLINE');
    expect(res.body.detail).toMatch(/unplugged/);
  });

  it('is for the admin only', async () => {
    expect((await test({}, manager)).status).toBe(403);
    expect((await test({}, cashier)).status).toBe(403);
  });
});
