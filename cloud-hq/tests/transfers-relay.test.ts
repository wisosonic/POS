import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminAuth, branchAuth, startHq, type Hq } from './helpers';

// How HQ relays a shipment to its receiver (docs/15 §4, P5b), with facts posted by hand: a shipment is relayed only when ALL its lines are here, only
// the receiver is told, and one HQ cannot deliver is recorded (so it is not tried again), audited once, and shown as undeliverable.
let hq: Hq;
let sender = '';
let receiver = '';
let bystander = '';
let ids = { sender: 0, receiver: 0, bystander: 0 };
const api = '/api/v1';
const at = '2026-11-28T10:00:00.000Z';

const enrol = async (code: string) => {
  const made = await hq.http.post(`${api}/branches`).set(adminAuth).send({ code, name: code });
  return (await hq.http.post(`${api}/sync/enrol`).send({ code: made.body.enrolCode })).body.token as string;
};
const idOf = async (code: string) => (await hq.app.database.one<{ id: number }>('SELECT id FROM branches WHERE code = ?', [code]))!.id;
const facts = (token: string, rows: unknown[]) => hq.http.post(`${api}/sync/facts`).set(branchAuth(token)).send({ rows });
const header = (id: number, to: number, itemCount: number) => ({
  tbl: 'shipments',
  pk: id,
  op: 'u',
  row: { id, to_branch_id: to, reason: 'supply', note: null, item_count: itemCount, user_id: null, created_at: at },
});
const line = (id: number, shipmentId: number, qty: number) => ({
  tbl: 'shipment_items',
  pk: id,
  op: 'u',
  row: { id, shipment_id: shipmentId, product_id: 7, qty_milli: qty, unit_cost: 5000 },
});
const count = async (sql: string, p: (number | string)[] = []) => (await hq.app.database.one<{ n: number }>(sql, p))!.n;
const changesFor = async (token: string) =>
  (
    (await hq.http.get(`${api}/sync/changes?cursor=0&limit=500`).set(branchAuth(token))).body.changes as {
      tbl: string;
      row?: Record<string, unknown>;
    }[]
  ).filter((c) => c.tbl.startsWith('incoming_'));

beforeAll(async () => {
  hq = await startHq();
  [sender, receiver, bystander] = [await enrol('SND'), await enrol('RCV'), await enrol('BYS')];
  ids = { sender: await idOf('SND'), receiver: await idOf('RCV'), bystander: await idOf('BYS') };
});
afterAll(() => hq.close());

describe('the relay of a shipment (US-HQ-transfers)', () => {
  it('waits until every line is here, then tells the receiver and nobody else', async () => {
    expect((await facts(sender, [header(1, ids.receiver, 2), line(1, 1, 10_000)])).status).toBe(200); // the header and one of two lines
    expect(await count('SELECT COUNT(*) AS n FROM incoming_shipments')).toBe(0);
    expect(await changesFor(receiver)).toEqual([]);
    expect((await facts(sender, [line(2, 1, 5_000)])).status).toBe(200); // the second line, in the next batch
    expect(await count('SELECT COUNT(*) AS n FROM incoming_shipments')).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM incoming_shipment_items')).toBe(2);
    const seen = await changesFor(receiver);
    expect(seen.map((c) => c.tbl)).toEqual(['incoming_shipments', 'incoming_shipment_items', 'incoming_shipment_items']); // the header first
    expect(seen[0]!.row).toMatchObject({ from_branch_id: ids.sender, to_branch_id: ids.receiver, shipment_id: 1, reason: 'supply' });
    expect(await changesFor(bystander)).toEqual([]); // another branch is not told
    expect(await changesFor(sender)).toEqual([]); // nor the sender
  });

  it('sending the same facts again relays nothing twice', async () => {
    await facts(sender, [header(1, ids.receiver, 2), line(1, 1, 10_000), line(2, 1, 5_000)]);
    expect(await count('SELECT COUNT(*) AS n FROM incoming_shipments')).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM change_log WHERE tbl = 'incoming_shipments'")).toBe(1);
  });

  it('a shipment HQ cannot deliver (an unknown branch, or the sender itself) is recorded, not sent to anyone, audited once, and shown as undeliverable', async () => {
    await facts(sender, [header(2, 99_999, 1), line(3, 2, 1_000), header(3, ids.sender, 1), line(4, 3, 1_000)]);
    expect(await count('SELECT COUNT(*) AS n FROM incoming_shipments')).toBe(3); // recorded, so not tried again
    expect(await changesFor(receiver)).toHaveLength(3); // still only the first shipment's lines
    expect(await changesFor(bystander)).toEqual([]);
    await facts(sender, [header(2, 99_999, 1), line(3, 2, 1_000)]); // again
    expect(await count("SELECT COUNT(*) AS n FROM hq_audit WHERE action = 'shipment.undeliverable'")).toBe(2); // once each
    const report = (await hq.http.get(`${api}/reports/transfers?from=2026-11-28T00:00:00Z&to=2026-11-29T00:00:00Z`).set(adminAuth)).body
      .data as { status: string; shipmentId: number }[];
    expect(report.map((t) => [t.shipmentId, t.status]).sort()).toEqual([
      [1, 'in_transit'],
      [2, 'undeliverable'],
      [3, 'undeliverable'],
    ]);
    // nobody is waiting for the undeliverable ones: only the first shipment counts as on the way
    const waiting = (await hq.http.get(`${api}/reports/stock`).set(adminAuth)).body.data;
    expect(waiting).toEqual([]); // product 7 is not in HQ's catalog here, so the stock report lists nothing
  });

  it('a receipt written by the receiver closes it at HQ, with its difference', async () => {
    const receipt = {
      tbl: 'receipts',
      pk: 1,
      op: 'u',
      row: { id: 1, incoming_id: 1, from_branch_id: ids.sender, user_id: null, note: null, created_at: '2026-11-28T12:00:00.000Z' },
    };
    const item = (id: number, expected: number, counted: number) => ({
      tbl: 'receipt_items',
      pk: id,
      op: 'u',
      row: {
        id,
        receipt_id: 1,
        product_id: 7,
        qty_expected_milli: expected,
        qty_counted_milli: counted,
        reason: expected === counted ? null : 'torn',
      },
    });
    expect((await facts(receiver, [receipt, item(1, 10_000, 10_000), item(2, 5_000, 4_000)])).status).toBe(200);
    const report = (
      await hq.http.get(`${api}/reports/transfers?from=2026-11-28T00:00:00Z&to=2026-11-29T00:00:00Z&status=received`).set(adminAuth)
    ).body.data;
    expect(report).toEqual([
      expect.objectContaining({ shipmentId: 1, status: 'received', differenceMilli: -1000, receivedAt: '2026-11-28T12:00:00.000Z' }),
    ]);
  });
});
