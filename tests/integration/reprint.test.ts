import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCtx, type TestCtx } from '../helpers/app';
import { PrinterError, type ReceiptPrinter } from '../../apps/api/src/modules/printing/driver';

// US-06 / US-35: finding a sale again and reprinting it. A reprint says DUPLICATE, never opens the cash drawer, and is recorded.
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
let manager: string;
let admin: string;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const text = (b: Uint8Array) => Buffer.from(b).toString('latin1');
const hasDrawerPulse = (b: Uint8Array) => b.some((v, i) => v === 0x1b && b[i + 1] === 0x70);

const sell = (token = cashier, over: Record<string, unknown> = {}) =>
  c.http.post(`${api}/sales`).set(auth(token)).set('Idempotency-Key', randomUUID()).send(c.newSaleBody(over));
const print = (id: number, body: Record<string, unknown> = {}, token = cashier) =>
  c.http.post(`${api}/sales/${id}/print`).set(auth(token)).send(body);
const audited = (id: number) => {
  const db = new Database(c.databasePath, { readonly: true });
  try {
    return db
      .prepare(`SELECT user_id, after_json FROM audit_log WHERE action = 'sale.print' AND entity_id = ? ORDER BY id`)
      .all(String(id)) as {
      user_id: number;
      after_json: string;
    }[];
  } finally {
    db.close();
  }
};

beforeAll(async () => {
  c = await startCtx({ printer: fake });
  cashier = await c.login('cashier');
  manager = await c.login('manager');
  admin = await c.login('admin');
  await c.openRegister(cashier);
  await c.http.patch(`${api}/settings`).set(auth(admin)).send({ printerName: 'POS-80 Receipt' });
});
afterAll(() => c.close());

describe('the first print and a reprint', () => {
  it('the first print is the original: no mark, and the drawer opens for a cash sale', async () => {
    jobs.length = 0;
    const s = await sell();
    const res = await print(s.body.id);
    expect(res.body.duplicate).toBe(false);
    expect(text(jobs[0]!.bytes)).not.toContain('DUPLICATE');
    expect(hasDrawerPulse(jobs[0]!.bytes)).toBe(true);
  });

  it('printing the same sale again is a DUPLICATE and never opens the drawer, even if the till asks it to', async () => {
    jobs.length = 0;
    const s = await sell();
    await print(s.body.id);
    const again = await print(s.body.id, { openDrawer: true }); // asking for the drawer on a reprint does nothing
    expect(again.body.duplicate).toBe(true);
    const copy = jobs[1]!;
    expect(text(copy.bytes)).toContain('*** DUPLICATE ***');
    expect(hasDrawerPulse(copy.bytes)).toBe(false);
    const third = await print(s.body.id);
    expect(third.body.duplicate).toBe(true);
    expect(text(jobs[2]!.bytes)).toContain('*** DUPLICATE ***');
  });

  it('the till can say a print is a reprint even if the server never saw the first (the first went to the browser)', async () => {
    jobs.length = 0;
    const s = await sell();
    const res = await print(s.body.id, { duplicate: true });
    expect(res.body.duplicate).toBe(true);
    expect(text(jobs[0]!.bytes)).toContain('*** DUPLICATE ***');
    expect(hasDrawerPulse(jobs[0]!.bytes)).toBe(false);
  });

  it('a first print that failed is still the first: the next one is the original, with the drawer', async () => {
    jobs.length = 0;
    const s = await sell();
    failWith = new PrinterError('PRINTER_OFFLINE', 'The printer is switched off');
    expect((await print(s.body.id)).status).toBe(503);
    failWith = null;
    const retry = await print(s.body.id);
    expect(retry.body.duplicate).toBe(false);
    expect(text(jobs[0]!.bytes)).not.toContain('DUPLICATE');
    expect(hasDrawerPulse(jobs[0]!.bytes)).toBe(true);
    expect(audited(s.body.id)).toHaveLength(1); // only the print that reached the printer is recorded
  });

  it('every print that reached the printer is recorded: who, how many copies, whether a duplicate, whether the drawer opened', async () => {
    const s = await sell();
    await print(s.body.id, { copies: 2 });
    await print(s.body.id, {}, manager);
    const rows = audited(s.body.id);
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0]!.after_json)).toEqual({ copies: 2, duplicate: false, drawer: true });
    expect(JSON.parse(rows[1]!.after_json)).toEqual({ copies: 1, duplicate: true, drawer: false });
    expect(rows[0]!.user_id).not.toBe(rows[1]!.user_id); // the manager's reprint is attributed to the manager
  });

  it('a sale paid only by wallet does not open the drawer on its first print either', async () => {
    jobs.length = 0;
    const s = await sell(cashier, { payments: [{ method: 'whish', currency: 'LBP', amount: 75000 }] });
    await print(s.body.id);
    expect(hasDrawerPulse(jobs[0]!.bytes)).toBe(false);
  });
});

describe('the receipt text and model', () => {
  it('can be fetched as a duplicate, for the browser print', async () => {
    const s = await sell();
    const original = await c.http.get(`${api}/sales/${s.body.id}/receipt?format=text`).set(auth(cashier));
    const copy = await c.http.get(`${api}/sales/${s.body.id}/receipt?format=text&duplicate=true`).set(auth(cashier));
    expect(original.text).not.toContain('DUPLICATE');
    expect(copy.text).toContain('*** DUPLICATE ***');
    expect(copy.text.split('\n').length).toBeGreaterThan(original.text.split('\n').length);
    const model = await c.http.get(`${api}/sales/${s.body.id}/receipt?duplicate=true`).set(auth(cashier));
    expect(model.body.duplicate).toBe(true);
    expect((await c.http.get(`${api}/sales/${s.body.id}/receipt`).set(auth(cashier))).body.duplicate).toBe(false);
  });

  it('refuses an unknown value for the flag', async () => {
    const s = await sell();
    expect((await c.http.get(`${api}/sales/${s.body.id}/receipt?duplicate=maybe`).set(auth(cashier))).status).toBe(400);
  });
});

describe('finding a sale again (the recent-sales list)', () => {
  it('shows who bought and who sold, so a list needs no lookup per row', async () => {
    const s = await sell(cashier, { customerId: 2 });
    const list = await c.http.get(`${api}/sales?limit=5`).set(auth(cashier));
    const row = list.body.data.find((r: { id: number }) => r.id === s.body.id);
    expect(row).toMatchObject({ ref: s.body.ref, customerName: 'Test Customer', totalLbp: 75000, status: 'paid' });
    expect(row.userName).toBeTruthy();
  });

  it('a cashier finds their own sale by its receipt number, and cannot find anyone else’s', async () => {
    const mine = await sell(cashier);
    const theirs = await sell(manager);
    const found = await c.http.get(`${api}/sales?ref=${mine.body.ref}`).set(auth(cashier));
    expect(found.body.data.map((r: { id: number }) => r.id)).toEqual([mine.body.id]);
    const notMine = await c.http.get(`${api}/sales?ref=${theirs.body.ref}`).set(auth(cashier));
    expect(notMine.body.data).toEqual([]);
    // a cashier cannot widen it by asking for another user
    const widened = await c.http.get(`${api}/sales?limit=200&userId=${c.seed.users.manager.id}`).set(auth(cashier));
    expect(widened.body.data.some((r: { id: number }) => r.id === theirs.body.id)).toBe(false);
  });

  it('a manager finds anyone’s sale, and sees the cashier’s name', async () => {
    const theirs = await sell(cashier);
    const found = await c.http.get(`${api}/sales?ref=${theirs.body.ref}`).set(auth(manager));
    expect(found.body.data).toHaveLength(1);
    expect(found.body.data[0].userName).toBeTruthy();
  });

  it('pages newest first with a cursor', async () => {
    const page1 = await c.http.get(`${api}/sales?limit=3`).set(auth(manager));
    expect(page1.body.data).toHaveLength(3);
    expect(page1.body.nextCursor).not.toBeNull();
    const page2 = await c.http.get(`${api}/sales?limit=3&cursor=${page1.body.nextCursor}`).set(auth(manager));
    const ids = [...page1.body.data, ...page2.body.data].map((r: { id: number }) => r.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('discarding a sale that never reached the server (US-10)', () => {
  const discard = (body: Record<string, unknown>, token = manager) =>
    c.http.post(`${api}/sales/queued-discard`).set(auth(token)).send(body);
  const noteFor = (clientSaleId: string) => {
    const db = new Database(c.databasePath, { readonly: true });
    try {
      return db
        .prepare(`SELECT user_id, after_json FROM audit_log WHERE action = 'sale.queued.discard' AND entity_id = ?`)
        .all(clientSaleId) as {
        user_id: number;
        after_json: string;
      }[];
    } finally {
      db.close();
    }
  };

  it('a manager discards it, and the server keeps a note of who, what and why', async () => {
    const id = randomUUID();
    const res = await discard({
      clientSaleId: id,
      reason: 'The customer left without paying',
      summary: '14:02 · 2 items · Cash 150,000 LL',
    });
    expect(res.status).toBe(204);
    const [note] = noteFor(id);
    expect(note!.user_id).toBe(c.seed.users.manager.id);
    expect(JSON.parse(note!.after_json)).toEqual({
      reason: 'The customer left without paying',
      summary: '14:02 · 2 items · Cash 150,000 LL',
    });
  });

  it('only a manager: not a cashier, not nobody', async () => {
    const id = randomUUID();
    expect((await discard({ clientSaleId: id, reason: 'x', summary: 'y' }, cashier)).status).toBe(403);
    expect((await c.http.post(`${api}/sales/queued-discard`).send({ clientSaleId: id, reason: 'x', summary: 'y' })).status).toBe(401);
    expect(noteFor(id)).toEqual([]);
  });

  it('asks for a reason', async () => {
    const id = randomUUID();
    expect((await discard({ clientSaleId: id, reason: '   ', summary: 'y' })).status).toBe(400);
    expect((await discard({ clientSaleId: id, summary: 'y' })).status).toBe(400);
    expect((await discard({ clientSaleId: id, reason: 'x', summary: 'y'.repeat(1001) })).status).toBe(400);
    expect(noteFor(id)).toEqual([]);
  });

  it('refuses when the server DID record the sale (the answer was lost on the way back), and says which receipt', async () => {
    const clientSaleId = randomUUID();
    const made = await sell(cashier, { clientSaleId });
    expect(made.status).toBe(201);
    const res = await discard({ clientSaleId, reason: 'It looked lost', summary: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SALE_ALREADY_RECORDED');
    expect(res.body.detail).toContain(String(made.body.ref));
    expect(noteFor(clientSaleId)).toEqual([]); // nothing was thrown away, so nothing is noted
  });

  it('nothing is deleted: discarding changes no sale, and a sale that never existed stays that way', async () => {
    const before = (await c.http.get(`${api}/sales?limit=200`).set(auth(manager))).body.data.length;
    await discard({ clientSaleId: randomUUID(), reason: 'x', summary: 'y' });
    expect((await c.http.get(`${api}/sales?limit=200`).set(auth(manager))).body.data.length).toBe(before);
  });
});
