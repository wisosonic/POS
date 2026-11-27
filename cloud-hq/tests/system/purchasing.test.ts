import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminAuth, startHq, type Hq } from '../helpers';
import { runControl } from '../../../branch-server/src/modules/sync/control';
import { getLink } from '../../../branch-server/src/modules/sync/service';
import { api, auth, startFreshBranch, until, type FreshBranch } from './freshBranch';

// Central purchasing (docs/15 §6, P5d): HQ orders from a supplier and the goods are delivered to STOCK branches only. A stock branch receives against what
// it expects, in parts if the goods come in parts; the order closes by itself when everything has arrived; HQ pays the supplier. A connected branch makes no
// purchases of its own.
let hq: Hq;
let w1: FreshBranch;
let w2: FreshBranch;
let shop: FreshBranch;
let supplier = 0;
let rice = 0;
let sugar = 0;
const ids: Record<string, number> = {};
const key = () => crypto.randomUUID();

type Line = { stockBranchId: number; productId: number; qty: string; unitCostMinor: number };
const order = (lines: Line[], extra: Record<string, unknown> = {}) =>
  hq.http
    .post(`${api}/purchase-orders`)
    .set(adminAuth)
    .send({ supplierId: supplier, currency: 'LBP', lines, ...extra });
const act = (id: number, what: string) => hq.http.post(`${api}/purchase-orders/${id}/${what}`).set(adminAuth).send({});
const get = async (id: number) => (await hq.http.get(`${api}/purchase-orders/${id}`).set(adminAuth)).body;
const pay = (id: number, amountMinor: number, k = key()) =>
  hq.http.post(`${api}/purchase-orders/${id}/payments`).set(adminAuth).set('Idempotency-Key', k).send({ amountMinor });
const deliveries = async (br: FreshBranch, status = 'open') =>
  (await br.http.get(`${api}/deliveries?status=${status}`).set(auth(br.admin))).body.data as {
    id: number;
    orderId: number;
    status: string;
    complete: boolean;
    items: { itemId: number; productId: number; ordered: string; received: string; outstanding: string }[];
  }[];
const receive = (br: FreshBranch, id: number, items?: { itemId: number; qty: string }[], k = key()) =>
  br.http
    .post(`${api}/deliveries/${id}/receive`)
    .set(auth(br.admin))
    .set('Idempotency-Key', k)
    .send(items ? { items } : {});
const onHand = async (br: FreshBranch, p: number) =>
  (await br.app.database.one<{ n: number }>('SELECT COALESCE(SUM(qty_milli), 0) AS n FROM stock_levels WHERE product_id = ?', [p]))!.n;
const costAt = async (br: FreshBranch, p: number) =>
  (await br.app.database.one<{ c: number }>('SELECT cost_minor AS c FROM products WHERE id = ?', [p]))!.c;

beforeAll(async () => {
  hq = await startHq();
  [w1, w2, shop] = [await startFreshBranch(), await startFreshBranch(), await startFreshBranch()];
  supplier = (await hq.http.post(`${api}/suppliers`).set(adminAuth).send({ name: 'Almarai Co' })).body.id;
  rice = (await hq.http.post(`${api}/products`).set(adminAuth).send({ name: 'Rice', priceMinor: 100000, costMinor: 60000 })).body.id;
  sugar = (await hq.http.post(`${api}/products`).set(adminAuth).send({ name: 'Sugar', priceMinor: 50000, costMinor: 30000 })).body.id;
  expect((await w1.connect(hq, 'W1', 'stock')).status).toBe(200);
  expect((await w2.connect(hq, 'W2', 'stock')).status).toBe(200);
  expect((await shop.connect(hq, 'S1', 'sale')).status).toBe(200);
  for (const code of ['W1', 'W2', 'S1'])
    ids[code] = (await hq.app.database.one<{ id: number }>('SELECT id FROM branches WHERE code = ?', [code]))!.id;
  for (const br of [w1, w2, shop]) {
    expect(await until(async () => (await br.http.get(`${api}/products/${sugar}`).set(auth(br.admin))).status === 200)).toBe(true);
    expect(await until(async () => (await br.http.get(`${api}/transfers/destinations`).set(auth(br.admin))).body.data.length === 2)).toBe(
      true,
    );
  }
});
afterAll(async () => {
  await w1.close();
  await w2.close();
  await shop.close();
  await hq.close();
});

describe('making an order at HQ (US-HQ-purchasing)', () => {
  it('goods are delivered to stock branches only; a line is checked before anything is saved', async () => {
    const line = (stockBranchId: number, productId: number, qty = '10', unitCostMinor = 1000): Line => ({
      stockBranchId,
      productId,
      qty,
      unitCostMinor,
    });
    const toShop = await order([line(ids.S1!, rice)]);
    expect([toShop.status, toShop.body.code]).toEqual([422, 'NOT_A_STOCK_BRANCH']);
    expect((await order([line(ids.W1!, rice), line(ids.W1!, rice)])).body.code).toBe('DUPLICATE_LINE');
    expect((await order([line(ids.W1!, 999999)])).status).toBe(422);
    expect((await order([line(999, rice)])).body.code).toBe('UNKNOWN_BRANCH');
    expect((await order([line(ids.W1!, rice)], { supplierId: 424242 })).status).toBe(422);
    expect((await order([])).status).toBe(400);
    expect((await order([line(ids.W1!, rice, '0')])).status).toBe(400);
    expect((await hq.http.get(`${api}/purchase-orders`).set(adminAuth)).body.data).toEqual([]); // none of that saved anything
  });

  it('a draft is made and changed freely, totals are exact, and only a placed order reaches the stock branches', async () => {
    const made = await order(
      [
        { stockBranchId: ids.W1!, productId: rice, qty: '100', unitCostMinor: 40000 },
        { stockBranchId: ids.W2!, productId: rice, qty: '50', unitCostMinor: 40000 }, // the same product split between two stock branches
        { stockBranchId: ids.W1!, productId: sugar, qty: '20.5', unitCostMinor: 25000 },
      ],
      { note: 'weekly' },
    );
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({ status: 'draft', supplier: 'Almarai Co', orderedMinor: 6_512_500, paidMinor: 0 }); // 4,000,000 + 2,000,000 + 512,500
    const id = made.body.id as number;
    // a draft is replaced as a whole
    const changed = await hq.http
      .patch(`${api}/purchase-orders/${id}`)
      .set(adminAuth)
      .send({
        supplierId: supplier,
        currency: 'LBP',
        note: 'weekly',
        lines: [
          { stockBranchId: ids.W1!, productId: rice, qty: '100', unitCostMinor: 40000 },
          { stockBranchId: ids.W2!, productId: rice, qty: '50', unitCostMinor: 40000 },
          { stockBranchId: ids.W1!, productId: sugar, qty: '20', unitCostMinor: 25000 },
        ],
      });
    expect(changed.body.orderedMinor).toBe(6_500_000);
    expect(await deliveries(w1)).toEqual([]); // nothing is expected until the order is placed
    const placed = await act(id, 'order');
    expect(placed.body.status).toBe('ordered');
    expect(
      (
        await hq.http
          .patch(`${api}/purchase-orders/${id}`)
          .set(adminAuth)
          .send({ supplierId: supplier, currency: 'LBP', lines: [{ stockBranchId: ids.W1!, productId: rice, qty: '1', unitCostMinor: 1 }] })
      ).body.code,
    ).toBe('ORDER_PLACED');
    expect((await act(id, 'order')).status).toBe(409); // not twice
    // each stock branch is sent only what it expects; the shop is sent nothing
    expect(await until(async () => (await deliveries(w1)).length === 1 && (await deliveries(w2)).length === 1)).toBe(true);
    expect((await deliveries(w1))[0]!.items.map((i) => [i.productId, i.ordered])).toEqual([
      [rice, '100'],
      [sugar, '20'],
    ]);
    expect((await deliveries(w2))[0]!.items.map((i) => [i.productId, i.ordered])).toEqual([[rice, '50']]);
    expect(await deliveries(shop)).toEqual([]);
    const refused = await receive(shop, (await deliveries(w1))[0]!.id);
    expect([refused.status, refused.body.code]).toEqual([409, 'ONLY_A_STOCK_BRANCH_RECEIVES']);
  });

  it('a connected branch makes no purchases of its own; reading its history stays open', async () => {
    for (const br of [w1, shop]) {
      const tries = [
        br.http
          .post(`${api}/purchases`)
          .set(auth(br.admin))
          .send({ supplierId: supplier, currency: 'LBP', items: [{ productId: rice, qty: '1', costMinor: 1 }] }),
        br.http.patch(`${api}/purchases/1`).set(auth(br.admin)).send({ currency: 'LBP' }),
        br.http.delete(`${api}/purchases/1`).set(auth(br.admin)),
        br.http.post(`${api}/purchases/1/receive`).set(auth(br.admin)).set('Idempotency-Key', key()).send({}),
        br.http.post(`${api}/purchases/1/payments`).set(auth(br.admin)).set('Idempotency-Key', key()).send({ amountMinor: 1 }),
      ];
      for (const r of await Promise.all(tries)) expect([r.status, r.body.code]).toEqual([409, 'HQ_OWNS_PURCHASING']);
      expect((await br.http.get(`${api}/purchases`).set(auth(br.admin))).status).toBe(200);
    }
    expect((await w1.http.get(`${api}/settings/public`).set(auth(w1.cashier))).body.hqOwnsPurchasing).toBe(true);
  });
});

describe('receiving against what HQ ordered', () => {
  let orderId = 0;
  let d1 = 0;
  let d2 = 0;

  it('a stock branch receives in parts: stock enters, the cost follows the price paid, and it cannot receive more than is outstanding', async () => {
    orderId = (await hq.http.get(`${api}/purchase-orders?status=ordered`).set(adminAuth)).body.data[0].id;
    const mine = (await deliveries(w1))[0]!;
    d1 = mine.id;
    d2 = (await deliveries(w2))[0]!.id;
    const riceItem = mine.items.find((i) => i.productId === rice)!;
    const over = await receive(w1, d1, [{ itemId: riceItem.itemId, qty: '101' }]);
    expect([over.status, over.body.code]).toEqual([422, 'RECEIVE_EXCEEDS_ORDERED']);
    expect((await receive(w1, d1, [{ itemId: 424242, qty: '1' }])).body.code).toBe('NOT_IN_DELIVERY');
    expect(await onHand(w1, rice)).toBe(0);
    const k = key();
    const part = await receive(w1, d1, [{ itemId: riceItem.itemId, qty: '60' }], k);
    expect(part.status, JSON.stringify(part.body)).toBe(201);
    expect(part.body.costUpdates).toEqual([{ productId: rice, before: 60000, after: 40000 }]);
    expect(await onHand(w1, rice)).toBe(60000);
    expect(await costAt(w1, rice)).toBe(40000);
    expect((await receive(w1, d1, [{ itemId: riceItem.itemId, qty: '60' }], k)).headers['idempotent-replay']).toBe('true'); // a repeat is not a second receipt
    expect(await onHand(w1, rice)).toBe(60000);
    const now = (await deliveries(w1))[0]!;
    expect(now.complete).toBe(false);
    expect(now.items.find((i) => i.productId === rice)).toMatchObject({ ordered: '100', received: '60', outstanding: '40' });
    // HQ sees the part that has arrived, and the order stays open
    expect(
      await until(
        async () =>
          (await get(orderId)).lines.find(
            (l: { productId: number; stockBranchId: number }) => l.productId === rice && l.stockBranchId === ids.W1,
          ).receivedMilli === 60000,
      ),
    ).toBe(true);
    expect((await get(orderId)).status).toBe('ordered');
  });

  it('receiving the rest (no lines named) completes that delivery; when every stock branch has everything, HQ closes the order by itself', async () => {
    expect((await receive(w1, d1)).status).toBe(201); // everything still to arrive
    expect(await onHand(w1, rice)).toBe(100000);
    expect(await onHand(w1, sugar)).toBe(20000);
    expect((await receive(w1, d1)).body.code).toBe('NOTHING_TO_RECEIVE'); // nothing is left
    expect((await get(orderId)).status).toBe('ordered'); // W2 has not received yet
    expect((await receive(w2, d2)).status).toBe(201);
    expect(await until(async () => (await get(orderId)).status === 'closed')).toBe(true);
    expect((await get(orderId)).receivedMinor).toBe(6_500_000);
    // the stock branches are told it is over: nothing more can be received on it
    expect(await until(async () => (await deliveries(w2, 'all'))[0]?.status === 'closed')).toBe(true);
    expect((await receive(w2, d2)).body.code).toBe('DELIVERY_ENDED');
    expect(await deliveries(w2)).toEqual([]); // no longer open
  });

  it('HQ pays the supplier in parts, never more than is owed, a repeat is one payment, and only an admin pays', async () => {
    expect((await get(orderId)).outstandingMinor).toBe(6_500_000);
    const k = key();
    const first = await pay(orderId, 2_000_000, k);
    expect([first.status, first.body.paidMinor, first.body.outstandingMinor]).toEqual([201, 2_000_000, 4_500_000]);
    const again = await pay(orderId, 2_000_000, k);
    expect([again.status, again.headers['idempotent-replay'], again.body.paidMinor]).toEqual([200, 'true', 2_000_000]); // not twice
    expect((await pay(orderId, 4_500_001)).body.code).toBe('PAYMENT_EXCEEDS');
    expect((await hq.http.post(`${api}/purchase-orders/${orderId}/payments`).set(adminAuth).send({ amountMinor: 1 })).status).toBe(400); // a key is needed
    const owed = (await hq.http.get(`${api}/reports/payables`).set(adminAuth)).body;
    expect(owed.data).toEqual([{ supplierId: supplier, supplier: 'Almarai Co', currency: 'LBP', outstandingMinor: 4_500_000, orders: 1 }]);
    expect((await pay(orderId, 4_500_000)).body.outstandingMinor).toBe(0);
    expect((await hq.http.get(`${api}/reports/payables`).set(adminAuth)).body.data).toEqual([]);
  });
});

describe('cancelling and closing short', () => {
  it('an order nothing has arrived on can be cancelled: its deliveries end, nothing is owed', async () => {
    const made = await order([{ stockBranchId: ids.W1!, productId: sugar, qty: '5', unitCostMinor: 25000 }]);
    const id = made.body.id as number;
    expect((await act(id, 'order')).status).toBe(200);
    expect(await until(async () => (await deliveries(w1)).length === 1)).toBe(true);
    const mine = (await deliveries(w1))[0]!;
    expect((await act(id, 'cancel')).body).toMatchObject({ status: 'cancelled', payableMinor: 0 });
    expect(await until(async () => (await deliveries(w1)).length === 0)).toBe(true);
    expect((await receive(w1, mine.id)).body.code).toBe('DELIVERY_ENDED');
    expect((await pay(id, 1)).body.code).toBe('ORDER_NOT_OPEN');
    expect((await act(id, 'cancel')).body.code).toBe('ORDER_ENDED');
  });

  it('once goods have arrived an order is closed, not cancelled; closing short accepts what came, and only that is owed', async () => {
    const made = await order([{ stockBranchId: ids.W2!, productId: sugar, qty: '10', unitCostMinor: 20000 }]);
    const id = made.body.id as number;
    await act(id, 'order');
    expect(await until(async () => (await deliveries(w2)).length === 1)).toBe(true);
    const d = (await deliveries(w2))[0]!;
    expect((await receive(w2, d.id, [{ itemId: d.items[0]!.itemId, qty: '4' }])).status).toBe(201);
    expect(await until(async () => (await get(id)).receivedMinor === 80_000)).toBe(true);
    expect((await act(id, 'cancel')).body.code).toBe('ORDER_RECEIVING');
    const closed = await act(id, 'close');
    expect(closed.body).toMatchObject({
      status: 'closed',
      orderedMinor: 200_000,
      receivedMinor: 80_000,
      payableMinor: 80_000,
      outstandingMinor: 80_000,
    }); // 4 of 10 arrived
    // HQ's closing reaches the branch a moment later; from then on nothing more can be received
    expect(await until(async () => (await deliveries(w2, 'all')).find((x) => x.id === d.id)?.status === 'closed')).toBe(true);
    expect((await receive(w2, d.id, [{ itemId: d.items[0]!.itemId, qty: '1' }])).body.code).toBe('DELIVERY_ENDED');
    expect((await act(id, 'close')).body.code).toBe('ORDER_NOT_OPEN');
  });

  it('a price in another currency becomes the product’s cost in its own currency', async () => {
    const made = await order([{ stockBranchId: ids.W1!, productId: rice, qty: '2', unitCostMinor: 200 }], { currency: 'USD' }); // $2.00 each
    const id = made.body.id as number;
    await act(id, 'order');
    expect(await until(async () => (await deliveries(w1)).length === 1)).toBe(true);
    const r = await receive(w1, (await deliveries(w1))[0]!.id);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await costAt(w1, rice)).toBe(180000); // $2.00 at 90,000 lira to the dollar
    expect((await get(id)).orderedMinor).toBe(400); // $4.00 for two
  });
});

describe('what is written is proved at HQ', () => {
  it('HQ holds exactly what each stock branch holds, and the daily control agrees', async () => {
    for (const br of [w1, w2]) {
      expect(await until(async () => (await br.http.get(`${api}/sync/verify`).set(auth(br.admin))).body.inSync === true)).toBe(true);
      const link = (await getLink(br.app.database))!;
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      expect(await runControl(br.app.database, link, { today: tomorrow })).toMatchObject({ mismatched: 0 });
    }
    const n = async (t: string) => (await hq.app.database.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`))!.n;
    for (const t of [
      'purchase_orders',
      'purchase_order_lines',
      'supplier_payments',
      'expected_deliveries',
      'expected_delivery_items',
      'po_receipts',
      'po_receipt_items',
    ])
      expect(await n(t), t).toBeGreaterThan(0);
  });
});
