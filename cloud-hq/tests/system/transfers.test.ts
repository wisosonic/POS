import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminAuth, startHq, type Hq } from '../helpers';
import { runControl } from '../../../branch-server/src/modules/sync/control';
import { getLink } from '../../../branch-server/src/modules/sync/service';
import { api, auth, startFreshBranch, until, type FreshBranch } from './freshBranch';

// Moving stock between branches (docs/15 §4, P5b): a warehouse (stock branch) and two shops (sale branches). The sender writes a shipment (stock
// leaves at once), HQ relays it to the receiver, the receiver writes a receipt (stock enters; a different count becomes an adjustment with its
// reason; the cost is blended). Never sale to sale; a sale branch can send surplus back to a stock branch; HQ sees what is on the way.
let hq: Hq;
let w: FreshBranch; // warehouse (stock branch)
let a: FreshBranch; // shop A
let b: FreshBranch; // shop B
let product = 0;
const idsOf: Record<string, number> = {};

const key = () => crypto.randomUUID();
const onHand = async (br: FreshBranch, p = product) =>
  (await br.app.database.one<{ n: number }>('SELECT COALESCE(SUM(qty_milli), 0) AS n FROM stock_levels WHERE product_id = ?', [p]))!.n;
const costAt = async (br: FreshBranch) =>
  (await br.app.database.one<{ c: number }>('SELECT cost_minor AS c FROM products WHERE id = ?', [product]))!.c;
const destinations = async (br: FreshBranch) => (await br.http.get(`${api}/transfers/destinations`).set(auth(br.admin))).body;
const ship = (from: FreshBranch, toBranchId: number, items: { productId: number; qty: string }[], note?: string, k = key()) =>
  from.http.post(`${api}/shipments`).set(auth(from.admin)).set('Idempotency-Key', k).send({ toBranchId, items, note });
const incoming = async (br: FreshBranch, status = 'on_the_way') =>
  (await br.http.get(`${api}/incoming?status=${status}`).set(auth(br.admin))).body.data as {
    id: number;
    status: string;
    fromBranch: string;
    items: { productId: number; name: string; qty: string; counted: string | null }[];
  }[];
const confirm = (br: FreshBranch, incomingId: number, items: { productId: number; counted: string; reason?: string }[] = [], k = key()) =>
  br.http.post(`${api}/receipts`).set(auth(br.admin)).set('Idempotency-Key', k).send({ incomingId, items });
const transfers = async (extra = '') =>
  (await hq.http.get(`${api}/reports/transfers?${extra}`).set(adminAuth)).body.data as {
    status: string;
    differenceMilli: number | null;
    from: string;
    to: string;
    qtyMilli: number;
  }[];

beforeAll(async () => {
  hq = await startHq();
  [w, a, b] = [await startFreshBranch(), await startFreshBranch(), await startFreshBranch()];
  product = (await hq.http.post(`${api}/products`).set(adminAuth).send({ name: 'Palletised rice', priceMinor: 100000, costMinor: 60000 }))
    .body.id;
  expect((await w.connect(hq, 'WH', 'stock')).status).toBe(200);
  expect((await a.connect(hq, 'SA', 'sale')).status).toBe(200);
  expect((await b.connect(hq, 'SB', 'sale')).status).toBe(200);
  for (const br of [w, a, b])
    expect(await until(async () => (await br.http.get(`${api}/products/${product}`).set(auth(br.admin))).status === 200)).toBe(true);
  for (const code of ['WH', 'SA', 'SB'])
    idsOf[code] = (await hq.app.database.one<{ id: number }>('SELECT id FROM branches WHERE code = ?', [code]))!.id;
  for (const br of [w, a, b]) expect(await until(async () => (await destinations(br)).data.length === 2)).toBe(true); // the directory arrived
  // the warehouse counts what is on its shelves
  expect(
    (
      await w.http
        .post(`${api}/stock/adjustments`)
        .set(auth(w.admin))
        .send({ productId: product, qtyDelta: '100', reason: 'opening count' })
    ).status,
  ).toBe(201);
});
afterAll(async () => {
  await w.close();
  await a.close();
  await b.close();
  await hq.close();
});

describe('who can send to whom (US-HQ-transfers)', () => {
  it('every branch is told who the others are, and whether the direction is allowed', async () => {
    expect((await destinations(w)).data.map((d: { code: string; allowed: boolean }) => [d.code, d.allowed]).sort()).toEqual([
      ['SA', true],
      ['SB', true],
    ]);
    expect((await destinations(a)).data.map((d: { code: string; allowed: boolean }) => [d.code, d.allowed]).sort()).toEqual([
      ['SB', false],
      ['WH', true],
    ]); // never sale to sale
    expect((await destinations(a)).kind).toBe('sale');
  });

  it('refuses sale to sale, sending to oneself, an unknown branch, a return without a reason, a cashier, and a duplicate product', async () => {
    const item = [{ productId: product, qty: '1' }];
    const r1 = await ship(a, idsOf.SB!, item, 'x');
    expect([r1.status, r1.body.code]).toEqual([422, 'DIRECTION_NOT_ALLOWED']);
    expect((await ship(w, idsOf.WH!, item)).body.code).toBe('SAME_BRANCH');
    expect((await ship(w, 99999, item)).body.code).toBe('UNKNOWN_BRANCH');
    expect((await ship(a, idsOf.WH!, item)).body.code).toBe('RETURN_NEEDS_REASON');
    expect((await ship(w, idsOf.SA!, [...item, ...item])).body.code).toBe('DUPLICATE_PRODUCT');
    expect((await ship(w, idsOf.SA!, [{ productId: 987654, qty: '1' }])).status).toBe(404);
    const cashier = await w.http
      .post(`${api}/shipments`)
      .set(auth(w.cashier))
      .set('Idempotency-Key', key())
      .send({ toBranchId: idsOf.SA, items: item });
    expect(cashier.status).toBe(403);
    expect((await w.http.post(`${api}/shipments`).set(auth(w.admin)).send({ toBranchId: idsOf.SA, items: item })).status).toBe(400); // no Idempotency-Key
    expect(await onHand(w)).toBe(100000); // nothing left the warehouse
  });
});

describe('a shipment from the warehouse to a shop', () => {
  let incomingId = 0;

  it('stock leaves the warehouse at once, with its cost; HQ relays it to the shop only; HQ shows it on the way', async () => {
    await w.app.database.run('UPDATE products SET cost_minor = 80000 WHERE id = ?', [product]); // what a purchase at the warehouse set
    const k = key();
    const sent = await ship(w, idsOf.SA!, [{ productId: product, qty: '30' }], undefined, k);
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(sent.body).toMatchObject({ toBranch: 'SA', reason: 'supply', items: [{ productId: product, qty: '30', unitCost: 80000 }] });
    expect(await onHand(w)).toBe(70000);
    const again = await ship(w, idsOf.SA!, [{ productId: product, qty: '30' }], undefined, k); // the same request again
    expect([again.status, again.headers['idempotent-replay']]).toEqual([201, 'true']);
    expect(await onHand(w)).toBe(70000); // not twice
    // the shop sees it, the other shop and the warehouse itself do not
    expect(await until(async () => (await incoming(a)).length === 1)).toBe(true);
    const list = await incoming(a);
    expect(list[0]).toMatchObject({
      status: 'on_the_way',
      fromBranch: 'WH',
      items: [{ productId: product, name: 'Palletised rice', qty: '30' }],
    });
    incomingId = list[0]!.id;
    expect(await incoming(b)).toEqual([]);
    expect(await incoming(w)).toEqual([]);
    // HQ: in transit, and the stock report counts it as on the way, not on a shelf
    expect(await transfers()).toEqual([
      expect.objectContaining({ status: 'in_transit', from: 'WH', to: 'SA', qtyMilli: 30000, differenceMilli: null }),
    ]);
    const stock = (await hq.http.get(`${api}/reports/stock?productId=${product}`).set(adminAuth)).body.data[0];
    expect(stock.byBranch.find((x: { branchId: number }) => x.branchId === idsOf.SA)).toMatchObject({ qtyMilli: 0, inTransitMilli: 30000 });
    expect(stock.byBranch.find((x: { branchId: number }) => x.branchId === idsOf.WH)).toMatchObject({ qtyMilli: 70000, inTransitMilli: 0 });
    expect(stock.inTransitMilli).toBe(30000);
  });

  it('the shop confirms with a different count: the stock comes in as shipped and the difference is an adjustment with its reason; the cost comes with it', async () => {
    const noReason = await confirm(a, incomingId, [{ productId: product, counted: '28' }]);
    expect([noReason.status, noReason.body.code]).toEqual([422, 'DIFFERENCE_NEEDS_REASON']);
    expect(await onHand(a)).toBe(0); // nothing happened
    expect((await confirm(a, incomingId, [{ productId: 424242, counted: '1' }])).body.code).toBe('NOT_IN_SHIPMENT');
    const k = key();
    const done = await confirm(a, incomingId, [{ productId: product, counted: '28', reason: '2 bags torn in the lorry' }], k);
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body.incoming).toMatchObject({
      status: 'received',
      items: [{ qty: '30', counted: '28', reason: '2 bags torn in the lorry' }],
    });
    expect(await onHand(a)).toBe(28000);
    expect(await costAt(a)).toBe(80000); // an empty shelf takes the sender's cost
    const moves = await a.app.database.all<{ qty_milli_delta: number; reason: string; ref_type: string; note: string | null }>(
      'SELECT qty_milli_delta, reason, ref_type, note FROM stock_movements WHERE product_id = ? ORDER BY id',
      [product],
    );
    expect(moves).toEqual([
      { qty_milli_delta: 30000, reason: 'transfer', ref_type: 'receipt', note: 'from WH' },
      { qty_milli_delta: -2000, reason: 'adjustment', ref_type: 'receipt', note: '2 bags torn in the lorry' },
    ]);
    expect((await confirm(a, incomingId, [], key())).body.code).toBe('ALREADY_RECEIVED'); // a different request: refused
    const replay = await confirm(a, incomingId, [{ productId: product, counted: '28', reason: '2 bags torn in the lorry' }], k); // the same request: the same answer
    expect([replay.status, replay.headers['idempotent-replay']]).toEqual([201, 'true']);
    expect(await onHand(a)).toBe(28000);
    expect(await incoming(a)).toEqual([]); // nothing left to confirm
  });

  it('HQ then shows it received, with the shortfall, and nothing on the way', async () => {
    expect(await until(async () => (await transfers())[0]?.status === 'received')).toBe(true);
    expect(await transfers()).toEqual([expect.objectContaining({ status: 'received', differenceMilli: -2000 })]);
    expect(await transfers('status=in_transit')).toEqual([]);
    const stock = (await hq.http.get(`${api}/reports/stock?productId=${product}`).set(adminAuth)).body.data[0];
    expect(stock.inTransitMilli).toBe(0);
    expect(stock.byBranch.find((x: { branchId: number }) => x.branchId === idsOf.SA).qtyMilli).toBe(28000); // 30 in, 2 short
  });

  it('a second shipment blends its cost into the shop’s by quantity', async () => {
    await w.app.database.run('UPDATE products SET cost_minor = 100000 WHERE id = ?', [product]);
    expect((await ship(w, idsOf.SA!, [{ productId: product, qty: '30' }])).status).toBe(201);
    expect(await until(async () => (await incoming(a)).length === 1)).toBe(true);
    expect((await confirm(a, (await incoming(a))[0]!.id)).status).toBe(201); // arrived as shipped
    expect(await onHand(a)).toBe(58000);
    expect(await costAt(a)).toBe(Math.round((28 * 80000 + 30 * 100000) / 58)); // 90,345
  });
});

describe('a shop sends surplus back, and two warehouses rebalance', () => {
  it('a sale branch returns stock to a stock branch with a reason; the warehouse confirms what arrived', async () => {
    const sent = await ship(a, idsOf.WH!, [{ productId: product, qty: '8' }], 'slow here, busy at Verdun');
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(sent.body.reason).toBe('return');
    expect(await onHand(a)).toBe(50000);
    expect(await until(async () => (await incoming(w)).length === 1)).toBe(true);
    const list = await incoming(w);
    expect(list[0]).toMatchObject({ fromBranch: 'SA', items: [{ qty: '8' }] });
    expect((await confirm(w, list[0]!.id)).status).toBe(201);
    expect(await onHand(w)).toBe(48000); // 100 - 30 - 30 + 8
    // and the busy shop's next shipment comes from the warehouse: the hub does the rebalancing
    expect((await ship(w, idsOf.SB!, [{ productId: product, qty: '10' }])).status).toBe(201);
    expect(await until(async () => (await incoming(b)).length === 1)).toBe(true);
  });

  it('a stock branch can send to another stock branch (rebalance)', async () => {
    const w2 = await startFreshBranch();
    try {
      expect((await w2.connect(hq, 'WH2', 'stock')).status).toBe(200);
      const id2 = (await hq.app.database.one<{ id: number }>("SELECT id FROM branches WHERE code = 'WH2'"))!.id;
      expect(await until(async () => (await destinations(w)).data.some((d: { code: string }) => d.code === 'WH2'))).toBe(true); // told when a branch is added
      const sent = await ship(w, id2, [{ productId: product, qty: '5' }]);
      expect([sent.status, sent.body.reason]).toEqual([201, 'rebalance']);
    } finally {
      await w2.close();
    }
  });
});

describe('what is written is proved at HQ', () => {
  it('HQ holds exactly what the warehouse and the shop hold, table by table, and the daily control agrees', async () => {
    for (const br of [w, a]) {
      expect(await until(async () => (await br.http.get(`${api}/sync/verify`).set(auth(br.admin))).body.inSync === true)).toBe(true);
      const link = (await getLink(br.app.database))!;
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      expect(await runControl(br.app.database, link, { today: tomorrow })).toMatchObject({ mismatched: 0 });
    }
    const n = async (t: string) => (await hq.app.database.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`))!.n;
    for (const t of ['shipments', 'shipment_items', 'receipts', 'receipt_items', 'incoming_shipments', 'incoming_shipment_items'])
      expect(await n(t), t).toBeGreaterThan(0);
  });
});
