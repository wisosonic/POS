import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminAuth, startHq, type Hq } from '../helpers';
import { runControl } from '../../../branch-server/src/modules/sync/control';
import { getLink } from '../../../branch-server/src/modules/sync/service';
import { api, auth, startFreshBranch, until, type FreshBranch } from './freshBranch';

// Requests and routing (docs/15 §5, P5c): a shop asks, HQ sends the request down the shop's ordered list of stock branches, a stock branch ships what it
// has and says what it cannot supply, HQ asks the next one, and a line nobody can supply is closed as not available.
let hq: Hq;
let w1: FreshBranch; // first choice
let w2: FreshBranch; // second choice
let shop: FreshBranch;
let p = 0; // rice
let q = 0; // sugar
const ids: Record<string, number> = {};
const key = () => crypto.randomUUID();

const adjust = (br: FreshBranch, productId: number, qtyDelta: string) =>
  br.http.post(`${api}/stock/adjustments`).set(auth(br.admin)).send({ productId, qtyDelta, reason: 'opening count' });
const request = (br: FreshBranch, items: { productId: number; qty: string }[], note?: string, k = key()) =>
  br.http.post(`${api}/stock-requests`).set(auth(br.admin)).set('Idempotency-Key', k).send({ items, note });
const requestOf = async (br: FreshBranch, id: number) => (await br.http.get(`${api}/stock-requests/${id}`).set(auth(br.admin))).body;
const lists = async (br: FreshBranch, status = 'open') =>
  (await br.http.get(`${api}/pick-lists?status=${status}`).set(auth(br.admin))).body.data as {
    id: number;
    forBranch: string;
    requestId: number;
    status: string;
    items: { productId: number; asked: string; onHand: string; shipped: string | null }[];
  }[];
const fill = (br: FreshBranch, id: number, items: { productId: number; shipped: string }[], k = key()) =>
  br.http.post(`${api}/pick-lists/${id}/fill`).set(auth(br.admin)).set('Idempotency-Key', k).send({ items });
const setRoutes = (shopId: number, stock: number[]) =>
  hq.http.put(`${api}/branches/${shopId}/supply-routes`).set(adminAuth).send({ stockBranchIds: stock });
const onHand = async (br: FreshBranch, productId: number) =>
  (await br.app.database.one<{ n: number }>('SELECT COALESCE(SUM(qty_milli), 0) AS n FROM stock_levels WHERE product_id = ?', [productId]))!
    .n;
type ProgressLine = { productId: number; wanted: string; shipped: string; unavailable: string; status: string };
const lineOf = (r: { items: ProgressLine[] }, productId: number): ProgressLine => r.items.find((i) => i.productId === productId)!;
const incoming = async (br: FreshBranch) =>
  (await br.http.get(`${api}/incoming?status=on_the_way`).set(auth(br.admin))).body.data as {
    fromBranch: string;
    items: { productId: number; qty: string }[];
  }[];

beforeAll(async () => {
  hq = await startHq();
  [w1, w2, shop] = [await startFreshBranch(), await startFreshBranch(), await startFreshBranch()];
  const products = await Promise.all([
    hq.http.post(`${api}/products`).set(adminAuth).send({ name: 'Rice', priceMinor: 100000, costMinor: 60000 }),
    hq.http.post(`${api}/products`).set(adminAuth).send({ name: 'Sugar', priceMinor: 50000, costMinor: 30000 }),
  ]);
  [p, q] = [products[0].body.id, products[1].body.id];
  expect((await w1.connect(hq, 'W1', 'stock')).status).toBe(200);
  expect((await w2.connect(hq, 'W2', 'stock')).status).toBe(200);
  expect((await shop.connect(hq, 'S1', 'sale')).status).toBe(200);
  for (const code of ['W1', 'W2', 'S1'])
    ids[code] = (await hq.app.database.one<{ id: number }>('SELECT id FROM branches WHERE code = ?', [code]))!.id;
  for (const br of [w1, w2, shop]) {
    expect(await until(async () => (await br.http.get(`${api}/products/${q}`).set(auth(br.admin))).status === 200)).toBe(true);
    expect(await until(async () => (await br.http.get(`${api}/transfers/destinations`).set(auth(br.admin))).body.data.length === 2)).toBe(
      true,
    );
  }
  // the warehouses count: W1 has 20 rice and no sugar, W2 has 100 rice and 40 sugar
  for (const [br, prod, n] of [
    [w1, p, '20'],
    [w2, p, '100'],
    [w2, q, '40'],
  ] as const)
    expect((await adjust(br, prod, n)).status).toBe(201);
});
afterAll(async () => {
  await w1.close();
  await w2.close();
  await shop.close();
  await hq.close();
});

describe('the list of stock branches per shop (US-HQ-requests)', () => {
  it('an admin sets it in order; it must be a sale branch and stock branches, each once', async () => {
    expect((await setRoutes(ids.S1!, [ids.W1!, ids.W2!])).body.data.map((r: { code: string; rank: number }) => [r.rank, r.code])).toEqual([
      [1, 'W1'],
      [2, 'W2'],
    ]);
    expect((await setRoutes(ids.S1!, [ids.S1!])).body.code).toBe('NOT_A_STOCK_BRANCH');
    expect((await setRoutes(ids.S1!, [ids.W1!, ids.W1!])).body.code).toBe('DUPLICATE_BRANCH');
    expect((await setRoutes(ids.W1!, [ids.W2!])).body.code).toBe('NOT_A_SALE_BRANCH');
    expect((await setRoutes(999, [])).status).toBe(404);
    expect((await hq.http.get(`${api}/branches/${ids.S1}/supply-routes`).set(adminAuth)).body.data).toHaveLength(2); // the refusals changed nothing
    expect((await hq.http.put(`${api}/branches/${ids.S1}/supply-routes`).send({ stockBranchIds: [] })).status).toBe(401);
  });
});

describe('a request goes to the first stock branch, and the shortfall to the next', () => {
  let requestId = 0;
  let list1 = 0;

  it('only a shop asks, with a valid request; nothing moves when it does', async () => {
    const bad = [
      await request(w1, [{ productId: p, qty: '1' }]),
      await request(shop, [
        { productId: p, qty: '1' },
        { productId: p, qty: '2' },
      ]),
      await request(shop, [{ productId: 424242, qty: '1' }]),
    ];
    expect([bad[0]!.status, bad[0]!.body.code]).toEqual([409, 'ONLY_A_SHOP_REQUESTS']);
    expect(bad[1]!.body.code).toBe('DUPLICATE_PRODUCT');
    expect(bad[2]!.status).toBe(404);
    const k = key();
    const made = await request(
      shop,
      [
        { productId: p, qty: '30' },
        { productId: q, qty: '10' },
      ],
      'weekend rush',
      k,
    );
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    requestId = made.body.id;
    expect(
      (
        await request(
          shop,
          [
            { productId: p, qty: '30' },
            { productId: q, qty: '10' },
          ],
          'weekend rush',
          k,
        )
      ).headers['idempotent-replay'],
    ).toBe('true');
    expect((await shop.http.get(`${api}/stock-requests`).set(auth(shop.admin))).body.data).toHaveLength(1); // not twice
    expect(await onHand(shop, p)).toBe(0);
  });

  it('HQ sends the whole request to the FIRST stock branch only, and the shop sees it being picked', async () => {
    expect(await until(async () => (await lists(w1)).length === 1)).toBe(true);
    const list = (await lists(w1))[0]!;
    expect(list).toMatchObject({ forBranch: 'S1', requestId, status: 'open' });
    expect(list.items.map((i) => [i.productId, i.asked, i.onHand])).toEqual([
      [p, '30', '20'], // the warehouse sees what it has against what is asked
      [q, '10', '0'],
    ]);
    list1 = list.id;
    expect(await lists(w2)).toEqual([]); // the second choice is not asked yet
    expect(await until(async () => lineOf(await requestOf(shop, requestId), p).status === 'picking')).toBe(true);
  });

  it('a pick list must be answered in full, within what was asked, by a stock branch, once', async () => {
    expect((await fill(w1, list1, [{ productId: p, shipped: '5' }])).body.code).toBe('ANSWER_EVERY_LINE');
    expect(
      (
        await fill(w1, list1, [
          { productId: p, shipped: '31' },
          { productId: q, shipped: '0' },
        ])
      ).body.code,
    ).toBe('SHIPPED_EXCEEDS_ASKED');
    expect(
      (
        await fill(shop, list1, [
          { productId: p, shipped: '1' },
          { productId: q, shipped: '0' },
        ])
      ).body.code,
    ).toBe('ONLY_A_STOCK_BRANCH_FILLS');
    expect(await onHand(w1, p)).toBe(20000); // none of that moved anything
  });

  it('the first branch ships what it has; HQ sends the rest to the next, and the shop sees every step', async () => {
    const k = key();
    const done = await fill(
      w1,
      list1,
      [
        { productId: p, shipped: '20' },
        { productId: q, shipped: '0' },
      ],
      k,
    );
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body.shipmentId).toBeGreaterThan(0);
    expect(await onHand(w1, p)).toBe(0); // the shipment took it out
    expect(
      (
        await fill(
          w1,
          list1,
          [
            { productId: p, shipped: '20' },
            { productId: q, shipped: '0' },
          ],
          k,
        )
      ).headers['idempotent-replay'],
    ).toBe('true');
    expect(
      (
        await fill(w1, list1, [
          { productId: p, shipped: '20' },
          { productId: q, shipped: '0' },
        ])
      ).body.code,
    ).toBe('ALREADY_ANSWERED');
    // HQ asks the second choice for what was not shipped: 10 rice and 10 sugar, in one pick list
    expect(await until(async () => (await lists(w2)).length === 1)).toBe(true);
    expect((await lists(w2))[0]!.items.map((i) => [i.productId, i.asked, i.onHand])).toEqual([
      [p, '10', '100'],
      [q, '10', '40'],
    ]);
    // the first branch's list is answered, and the shop sees 20 rice on the way and the rest still being picked
    expect(await until(async () => (await lists(w1)).length === 0)).toBe(true);
    expect(await until(async () => lineOf(await requestOf(shop, requestId), p).shipped === '20')).toBe(true);
    const mid = await requestOf(shop, requestId);
    expect(mid.status).toBe('open');
    expect([lineOf(mid, p).status, lineOf(mid, q).status]).toEqual(['picking', 'picking']);
    expect(await until(async () => (await incoming(shop)).length === 1)).toBe(true);
    expect((await incoming(shop))[0]).toMatchObject({ fromBranch: 'W1', items: [{ productId: p, qty: '20' }] });
  });

  it('the second branch ships the rest: the request is closed and fully shipped', async () => {
    const list = (await lists(w2))[0]!;
    expect(
      (
        await fill(w2, list.id, [
          { productId: p, shipped: '10' },
          { productId: q, shipped: '10' },
        ])
      ).status,
    ).toBe(201);
    expect(await until(async () => (await requestOf(shop, requestId)).status === 'closed')).toBe(true);
    const done = await requestOf(shop, requestId);
    expect(lineOf(done, p)).toMatchObject({ wanted: '30', shipped: '30', unavailable: '0', status: 'done' });
    expect(lineOf(done, q)).toMatchObject({ wanted: '10', shipped: '10', unavailable: '0', status: 'done' });
    expect(await until(async () => (await incoming(shop)).length === 2)).toBe(true); // one shipment from each warehouse
    expect(await onHand(w2, p)).toBe(90000);
  });
});

describe('a line nobody can supply is closed as not available', () => {
  it('every stock branch in the list is out: the line is closed, the shop sees it, and HQ keeps the unmet demand', async () => {
    const made = await request(shop, [{ productId: q, qty: '100' }]);
    expect(made.status).toBe(201);
    const id = made.body.id as number;
    expect(await until(async () => (await lists(w1)).length === 1)).toBe(true);
    expect((await fill(w1, (await lists(w1))[0]!.id, [{ productId: q, shipped: '0' }])).status).toBe(201); // none at all: no shipment
    expect(await until(async () => (await lists(w2)).length === 1)).toBe(true);
    expect((await lists(w2))[0]!.items[0]).toMatchObject({ asked: '100', onHand: '30' });
    expect((await fill(w2, (await lists(w2))[0]!.id, [{ productId: q, shipped: '30' }])).status).toBe(201);
    expect(await until(async () => (await requestOf(shop, id)).status === 'closed')).toBe(true);
    expect(lineOf(await requestOf(shop, id), q)).toMatchObject({ wanted: '100', shipped: '30', unavailable: '70', status: 'done' });
    // HQ
    const unmet = (await hq.http.get(`${api}/reports/unmet-demand`).set(adminAuth)).body.data;
    expect(unmet).toEqual([{ productId: q, name: 'Sugar', unavailableMilli: 70000, wantedMilli: 100000, lines: 1 }]);
    const reqs = (await hq.http.get(`${api}/reports/requests?status=closed`).set(adminAuth)).body.data as {
      requestId: number;
      branch: string;
      lines: unknown[];
    }[];
    expect(reqs.map((r) => [r.branch, r.requestId]).sort()).toEqual([
      ['S1', 1],
      ['S1', 2],
    ]);
    expect((await hq.http.get(`${api}/reports/requests?status=open`).set(adminAuth)).body.data).toEqual([]);
  });
});

describe('a shop with no list waits for one', () => {
  it('its request is held (open, waiting) and is routed the moment an admin sets the list', async () => {
    const lonely = await startFreshBranch();
    try {
      expect((await lonely.connect(hq, 'S2', 'sale')).status).toBe(200);
      const idS2 = (await hq.app.database.one<{ id: number }>("SELECT id FROM branches WHERE code = 'S2'"))!.id;
      expect(await until(async () => (await lonely.http.get(`${api}/products/${p}`).set(auth(lonely.admin))).status === 200)).toBe(true);
      const made = await request(lonely, [{ productId: p, qty: '5' }]);
      expect(made.status).toBe(201);
      expect(await until(async () => (await requestOf(lonely, made.body.id)).status === 'open')).toBe(true); // HQ has taken it in
      await new Promise((r) => setTimeout(r, 400));
      expect(lineOf(await requestOf(lonely, made.body.id), p).status).toBe('waiting');
      expect(await lists(w2)).toEqual([]);
      expect((await setRoutes(idS2, [ids.W2!])).status).toBe(200);
      expect(await until(async () => (await lists(w2)).length === 1)).toBe(true);
      expect((await lists(w2))[0]).toMatchObject({ forBranch: 'S2' });
      expect(await until(async () => lineOf(await requestOf(lonely, made.body.id), p).status === 'picking')).toBe(true);
    } finally {
      await lonely.close();
    }
  });
});

describe('what is written is proved at HQ', () => {
  it('HQ holds exactly what each branch holds, and the daily control agrees', async () => {
    for (const br of [w1, w2, shop]) {
      expect(await until(async () => (await br.http.get(`${api}/sync/verify`).set(auth(br.admin))).body.inSync === true)).toBe(true);
      const link = (await getLink(br.app.database))!;
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      expect(await runControl(br.app.database, link, { today: tomorrow })).toMatchObject({ mismatched: 0 });
    }
    const n = async (t: string) => (await hq.app.database.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`))!.n;
    for (const t of [
      'stock_requests',
      'stock_request_items',
      'pick_results',
      'pick_result_items',
      'pick_lists',
      'pick_list_items',
      'request_status',
    ])
      expect(await n(t), t).toBeGreaterThan(0);
  });
});
