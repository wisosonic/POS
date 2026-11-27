import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminAuth, branchAuth, startHq, type Hq } from '../helpers';
import { startCtx } from '../../../branch-server/tests/helpers/app';
import { api, auth, startFreshBranch, until, type FreshBranch } from './freshBranch';

// A branch has a kind (docs/15 §3, P5a): a sale branch has tills and sells, a stock branch is a warehouse with no tills. HQ decides when the branch is
// added; the branch learns it when it connects and refuses everything that needs a till, while stock work stays open.
let hq: Hq;
let warehouse: FreshBranch;
let shop: FreshBranch;

const openBody = {
  terminalId: 'T1',
  openingBalances: [
    { method: 'cash', currency: 'USD', amount: 0 },
    { method: 'cash', currency: 'LBP', amount: 0 },
  ],
};

beforeAll(async () => {
  hq = await startHq();
  warehouse = await startFreshBranch();
  shop = await startFreshBranch();
});
afterAll(async () => {
  await warehouse.close();
  await shop.close();
  await hq.close();
});

describe('the kind at HQ (US-HQ-kind)', () => {
  it('a branch is a sale branch unless it is added as a stock branch; the list and the overview say which', async () => {
    const plain = await hq.http.post(`${api}/branches`).set(adminAuth).send({ code: 'K1', name: 'Plain' });
    expect(plain.body.branch.kind).toBe('sale');
    const ware = await hq.http.post(`${api}/branches`).set(adminAuth).send({ code: 'K2', name: 'Warehouse', kind: 'stock' });
    expect(ware.status).toBe(201);
    expect(ware.body.branch.kind).toBe('stock');
    expect((await hq.http.post(`${api}/branches`).set(adminAuth).send({ code: 'K3', name: 'x', kind: 'depot' })).status).toBe(400);
    const list = (await hq.http.get(`${api}/branches`).set(adminAuth)).body.data as { code: string; kind: string }[];
    expect(list.filter((b) => ['K1', 'K2'].includes(b.code)).map((b) => [b.code, b.kind])).toEqual([
      ['K1', 'sale'],
      ['K2', 'stock'],
    ]);
    const overview = (await hq.http.get(`${api}/reports/overview`).set(adminAuth)).body.branches as { code: string; kind: string }[];
    expect(overview.find((b) => b.code === 'K2')?.kind).toBe('stock');
  });

  it('the kind can be changed until the branch has connected, and never after', async () => {
    const made = await hq.http.post(`${api}/branches`).set(adminAuth).send({ code: 'K4', name: 'Changeable' });
    const id = (await hq.app.database.one<{ id: number }>("SELECT id FROM branches WHERE code = 'K4'"))!.id;
    expect((await hq.http.patch(`${api}/branches/${id}`).set(adminAuth).send({ kind: 'stock' })).body.data.kind).toBe('stock');
    const enrolled = await hq.http.post(`${api}/sync/enrol`).send({ code: made.body.enrolCode });
    expect(enrolled.status).toBe(200);
    expect(enrolled.body.branch.kind).toBe('stock'); // the branch is told its kind when it enrols
    const locked = await hq.http.patch(`${api}/branches/${id}`).set(adminAuth).send({ kind: 'sale' });
    expect([locked.status, locked.body.code]).toEqual([409, 'BRANCH_KIND_LOCKED']);
    expect((await hq.http.patch(`${api}/branches/${id}`).set(adminAuth).send({ kind: 'stock', name: 'Renamed' })).status).toBe(200); // the same kind is fine
    const ping = await hq.http.get(`${api}/sync/ping`).set(branchAuth(enrolled.body.token));
    expect(ping.body.branch.kind).toBe('stock');
  });
});

describe('a stock branch has no tills', () => {
  it('connects as a stock branch, learns its kind, and says so to the screens', async () => {
    expect((await warehouse.connect(hq, 'WH1', 'stock')).status).toBe(200);
    expect(
      await until(async () => (await warehouse.http.get(`${api}/sync/status`).set(auth(warehouse.admin))).body.state === 'online'),
    ).toBe(true);
    expect((await warehouse.http.get(`${api}/settings/public`).set(auth(warehouse.cashier))).body.branchKind).toBe('stock');
    expect((await shop.connect(hq, 'SH1', 'sale')).status).toBe(200);
    expect((await shop.http.get(`${api}/settings/public`).set(auth(shop.cashier))).body.branchKind).toBe('sale');
  });

  it('refuses to add or enrol a till, to open a register and to sell: NOT_A_SALE_BRANCH', async () => {
    const w = warehouse;
    const attempts = [
      w.http.post(`${api}/terminals`).set(auth(w.admin)).send({ name: 'Till 2', code: 'T2' }),
      w.http.post(`${api}/terminals/enrol`).set(auth(w.admin)).send({ code: 'ABCDE-FGHIJ' }),
      w.http.post(`${api}/registers/open`).set(auth(w.cashier)).send(openBody),
      w.http.get(`${api}/registers/current`).set(auth(w.cashier)),
      w.http
        .post(`${api}/sales`)
        .set(auth(w.cashier))
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ clientSaleId: crypto.randomUUID(), customerId: 1, items: [], payments: [] }),
      w.http.post(`${api}/expenses`).set(auth(w.admin)).send({ title: 'x', amountMinor: 1000, currency: 'LBP' }),
    ];
    for (const r of await Promise.all(attempts)) expect([r.status, r.body.code]).toEqual([409, 'NOT_A_SALE_BRANCH']);
  });

  it('stock work is still open: a product from HQ arrives and the manager can count and adjust it', async () => {
    const p = (await hq.http.post(`${api}/products`).set(adminAuth).send({ name: 'Palletised rice', priceMinor: 100000, costMinor: 60000 }))
      .body.id as number;
    expect(await until(async () => (await warehouse.http.get(`${api}/products/${p}`).set(auth(warehouse.admin))).status === 200)).toBe(
      true,
    );
    const adj = await warehouse.http
      .post(`${api}/stock/adjustments`)
      .set(auth(warehouse.admin))
      .send({ productId: p, qtyDelta: '40', reason: 'opening count' });
    expect(adj.status, JSON.stringify(adj.body)).toBe(201);
    const moved = await warehouse.app.database.one<{ qty_milli_delta: number }>(
      'SELECT qty_milli_delta FROM stock_movements WHERE product_id = ?',
      [p],
    );
    expect(moved?.qty_milli_delta).toBe(40000);
    // and what it did goes up to HQ like any branch's records
    expect(
      await until(
        async () =>
          (await hq.app.database.one<{ n: number }>('SELECT COUNT(*) AS n FROM stock_movements WHERE product_id = ?', [p]))!.n === 1,
      ),
    ).toBe(true);
  });

  it('a sale branch is not affected: it still opens a register and sells', async () => {
    const p = (await hq.http.post(`${api}/products`).set(adminAuth).send({ name: 'Shop item', priceMinor: 100000 })).body.id as number;
    expect(await until(async () => (await shop.http.get(`${api}/products/${p}`).set(auth(shop.admin))).status === 200)).toBe(true);
    const open = await shop.http.post(`${api}/registers/open`).set(auth(shop.cashier)).send(openBody);
    expect(open.status, JSON.stringify(open.body)).toBeLessThan(300);
    const sale = await shop.http
      .post(`${api}/sales`)
      .set(auth(shop.cashier))
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        clientSaleId: crypto.randomUUID(),
        customerId: 1,
        items: [{ productId: p, qty: '1', unitPriceLbp: 100000 }],
        payments: [{ method: 'cash', currency: 'LBP', amount: 100000 }],
      });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
  });
});

describe('only a fresh install can become a stock branch', () => {
  it('a branch that has already sold is refused, and keeps working as a sale branch', async () => {
    const used = await startCtx({ sync: { intervalMs: 60, backoffMs: [60, 200], idleMs: 40 } });
    try {
      const admin = await used.login('admin');
      const cashier = await used.login('cashier');
      await used.openRegister(cashier);
      expect(
        (await used.http.post(`${api}/sales`).set(auth(cashier)).set('Idempotency-Key', crypto.randomUUID()).send(used.newSaleBody()))
          .status,
      ).toBe(201);
      const code = (await hq.http.post(`${api}/branches`).set(adminAuth).send({ code: 'WH2', name: 'Late warehouse', kind: 'stock' })).body
        .enrolCode as string;
      const refused = await used.http.post(`${api}/sync/connect`).set(auth(admin)).send({ url: hq.url, code });
      expect([refused.status, refused.body.code]).toEqual([409, 'BRANCH_HAS_SALES']);
      expect((await used.http.get(`${api}/sync/status`).set(auth(admin))).body.linked).toBe(false); // not connected, nothing changed
      expect((await used.http.get(`${api}/settings/public`).set(auth(cashier))).body.branchKind).toBe('sale');
    } finally {
      await used.close();
    }
  });
});
