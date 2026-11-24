import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCtx, type TestCtx } from '../helpers/app';

// US-18: counting the shelf. Only the real difference is posted, as adjustments in the ledger; selling goes on meanwhile;
// products that were not counted are left alone; a finished count cannot be changed.
let c: TestCtx;
let cashier: string;
let manager: string;
let admin: string;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

const start = async (name = '') => (await c.http.post(`${api}/stocktakes`).set(auth(manager)).send({ name })).body as { id: number };
const count = (id: number, productId: number, qty: string | number, mode: 'set' | 'add' = 'set', token = manager) =>
  c.http.put(`${api}/stocktakes/${id}/lines`).set(auth(token)).send({ productId, qty, mode });
const commit = (id: number, key = randomUUID(), token = manager) =>
  c.http.post(`${api}/stocktakes/${id}/commit`).set(auth(token)).set('Idempotency-Key', key).send({});
const qtyOf = async (productId: number) =>
  Number((await c.http.get(`${api}/stock?productId=${productId}`).set(auth(manager))).body.data[0].qty);
const ledger = async (productId: number) =>
  (await c.http.get(`${api}/stock/${productId}/movements`).set(auth(manager))).body.data as {
    reason: string;
    qtyDelta: string;
    note: string | null;
  }[];

beforeAll(async () => {
  c = await startCtx();
  cashier = await c.login('cashier');
  manager = await c.login('manager');
  admin = await c.login('admin');
  await c.openRegister(cashier);
});
afterAll(() => c.close());

describe('a count, start to finish', () => {
  it('counts products, shows the differences, and on finishing posts only those as adjustments', async () => {
    const towel = c.seed.products.towel.id; // 10 on hand
    const choc = c.seed.products.choc.id; // 100
    const rare = c.seed.products.rare.id; // 1
    const t = await start('Aisle 1');
    expect(t).toMatchObject({ status: 'open', name: 'Aisle 1', lineCount: 0 });

    const a = await count(t.id, towel, '8');
    expect(a.status).toBe(200);
    expect(a.body.line).toMatchObject({ systemQty: '10', countedQty: '8', differenceQty: '-2' });
    for (let i = 0; i < 3; i++) await count(t.id, choc, '1', 'add'); // three scans
    await count(t.id, rare, '1'); // matches: no difference

    const open = await c.http.get(`${api}/stocktakes/${t.id}`).set(auth(manager));
    expect(open.body).toMatchObject({ lineCount: 3, differenceCount: 2, surplusQty: '0', shortageQty: '99' });
    expect(open.body.lines.find((l: { productId: number }) => l.productId === choc)).toMatchObject({
      countedQty: '3',
      differenceQty: '-97',
    });
    expect(await qtyOf(towel)).toBe(10); // counting changes nothing until it is finished

    const done = await commit(t.id);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'committed', adjusted: 2 });
    expect(await qtyOf(towel)).toBe(8);
    expect(await qtyOf(choc)).toBe(3);
    expect(await qtyOf(rare)).toBe(1);
    expect((await ledger(rare)).filter((m) => m.note?.startsWith('Stocktake'))).toHaveLength(0); // nothing posted for no difference
    expect((await ledger(towel))[0]).toMatchObject({ reason: 'adjustment', qtyDelta: '-2', note: 'Stocktake ' + t.id + ': Aisle 1' });

    const log = await c.http.get(`${api}/audit?action=stocktake.commit&entityId=${t.id}`).set(auth(admin));
    expect(log.body.data[0].after).toMatchObject({ counted: 3, adjusted: 2, shortageQty: '99' });
  });

  it('selling goes on while counting: only the difference seen at the count is posted, on top of what was sold since', async () => {
    const kg = c.seed.products.usd.id; // 10 on hand
    const t = await start();
    await count(t.id, kg, '8'); // system said 10 when counted
    const sold = await c.http
      .post(`${api}/sales`)
      .set(auth(cashier))
      .set('Idempotency-Key', randomUUID())
      .send(
        c.newSaleBody({
          items: [{ productId: kg, qty: '1', unitPriceLbp: 225000 }],
          payments: [{ method: 'cash', currency: 'LBP', amount: 225000 }],
        }),
      );
    expect(sold.status).toBe(201);
    expect(await qtyOf(kg)).toBe(9);
    await commit(t.id);
    expect(await qtyOf(kg)).toBe(7); // 9 now, less the 2 that were missing at the count: not forced to 8
  });

  it('a product that was not counted is left alone', async () => {
    const before = await qtyOf(c.seed.products.kg.id);
    const t = await start();
    await count(t.id, c.seed.products.towel.id, '8');
    await commit(t.id);
    expect(await qtyOf(c.seed.products.kg.id)).toBe(before);
  });

  it('counting a product again replaces the count; a line can be removed', async () => {
    const t = await start();
    await count(t.id, c.seed.products.choc.id, '5');
    await count(t.id, c.seed.products.choc.id, '7');
    let detail = (await c.http.get(`${api}/stocktakes/${t.id}`).set(auth(manager))).body;
    expect(detail.lines).toHaveLength(1);
    expect(detail.lines[0].countedQty).toBe('7');
    expect((await c.http.delete(`${api}/stocktakes/${t.id}/lines/${c.seed.products.choc.id}`).set(auth(manager))).status).toBe(204);
    detail = (await c.http.get(`${api}/stocktakes/${t.id}`).set(auth(manager))).body;
    expect(detail.lines).toHaveLength(0);
    await c.http.post(`${api}/stocktakes/${t.id}/cancel`).set(auth(manager));
  });

  it('weighed goods can be counted to the gram; pieces cannot be split', async () => {
    const t = await start();
    const kg = await count(t.id, c.seed.products.kg.id, '2.5');
    expect(kg.status).toBe(200);
    expect(kg.body.line.countedQty).toBe('2.5');
    const piece = await count(t.id, c.seed.products.towel.id, '2.5');
    expect(piece.status).toBe(422);
    expect(piece.body.code).toBe('FRACTIONAL_NOT_ALLOWED');
    expect((await count(t.id, c.seed.products.towel.id, '-1')).status).toBe(400);
    expect((await count(t.id, c.seed.products.towel.id, '1.2345')).status).toBe(400);
    expect((await count(t.id, 999999, '1')).status).toBe(404);
    await c.http.post(`${api}/stocktakes/${t.id}/cancel`).set(auth(manager));
  });
});

describe('a finished or cancelled count is history', () => {
  it('finishing twice, counting after, or cancelling after is refused; a replay answers with the first result', async () => {
    const t = await start();
    await count(t.id, c.seed.products.choc.id, '4');
    const key = randomUUID();
    const first = await commit(t.id, key);
    const replay = await commit(t.id, key);
    expect(replay.status).toBe(200);
    expect(replay.header['idempotent-replay']).toBe('true');
    expect(replay.body.id).toBe(first.body.id);

    const again = await commit(t.id);
    expect(again.status).toBe(422);
    expect(again.body.code).toBe('STOCKTAKE_NOT_OPEN');
    expect((await count(t.id, c.seed.products.choc.id, '9')).body.code).toBe('STOCKTAKE_NOT_OPEN');
    expect((await c.http.post(`${api}/stocktakes/${t.id}/cancel`).set(auth(manager))).body.code).toBe('STOCKTAKE_NOT_OPEN');
  });

  it('a cancelled count posts nothing', async () => {
    const t = await start();
    await count(t.id, c.seed.products.rare.id, '0');
    const before = await qtyOf(c.seed.products.rare.id);
    expect((await c.http.post(`${api}/stocktakes/${t.id}/cancel`).set(auth(manager))).body.status).toBe('cancelled');
    expect(await qtyOf(c.seed.products.rare.id)).toBe(before);
    expect((await commit(t.id)).body.code).toBe('STOCKTAKE_NOT_OPEN');
  });

  it('the database itself refuses to change a finished count', async () => {
    const t = await start();
    await count(t.id, c.seed.products.choc.id, '2');
    await commit(t.id);
    const db = new Database(c.databasePath);
    try {
      expect(() => db.prepare('UPDATE stocktake_lines SET counted_milli = 1 WHERE stocktake_id = ?').run(t.id)).toThrow(
        /finished stocktake/,
      );
      expect(() => db.prepare('DELETE FROM stocktake_lines WHERE stocktake_id = ?').run(t.id)).toThrow(/finished stocktake/);
      expect(() =>
        db.prepare('INSERT INTO stocktake_lines (stocktake_id, product_id, system_milli, counted_milli) VALUES (?, 1, 0, 1)').run(t.id),
      ).toThrow(/finished stocktake/);
      expect(() => db.prepare(`UPDATE stocktakes SET name = 'x' WHERE id = ?`).run(t.id)).toThrow(/finished stocktake/);
      expect(() => db.prepare('DELETE FROM stocktakes WHERE id = ?').run(t.id)).toThrow(/append-only/);
    } finally {
      db.close();
    }
  });

  it('the key is required to finish', async () => {
    const t = await start();
    expect((await c.http.post(`${api}/stocktakes/${t.id}/commit`).set(auth(manager)).send({})).status).toBe(400);
    expect((await c.http.get(`${api}/stocktakes/999999`).set(auth(manager))).status).toBe(404);
  });
});

describe('who may count', () => {
  it('managers and admins only', async () => {
    expect((await c.http.get(`${api}/stocktakes`).set(auth(cashier))).status).toBe(403);
    expect((await c.http.post(`${api}/stocktakes`).set(auth(cashier)).send({})).status).toBe(403);
    expect((await c.http.get(`${api}/stocktakes`)).status).toBe(401);
    expect((await c.http.post(`${api}/stocktakes`).set(auth(admin)).send({})).status).toBe(201);
    const list = await c.http.get(`${api}/stocktakes`).set(auth(manager));
    expect(list.body.data.length).toBeGreaterThan(3);
    expect(list.body.data[0].id).toBeGreaterThan(list.body.data[1].id); // newest first
  });
});

describe('deleting a count from the list (US-18)', () => {
  const del = (id: number, token = manager) => c.http.delete(`${api}/stocktakes/${id}`).set(auth(token));
  const listed = async () => ((await c.http.get(`${api}/stocktakes`).set(auth(manager))).body.data as { id: number }[]).map((x) => x.id);

  it('only a manager may; a finished count leaves the list but its adjustments stay in the ledger', async () => {
    const towel = c.seed.products.towel.id;
    const before = await qtyOf(towel);
    const id = (await start('To delete after finishing')).id;
    await count(id, towel, before + 4);
    expect((await commit(id)).status).toBe(200);
    const ledgerBefore = (await ledger(towel)).length;

    expect((await del(id, cashier)).status).toBe(403);
    expect((await del(id)).status).toBe(204);
    expect(await listed()).not.toContain(id);
    expect((await c.http.get(`${api}/stocktakes/${id}`).set(auth(manager))).status).toBe(404);
    expect((await del(id)).status).toBe(404); // already gone
    // nothing posted to the ledger is touched, and the stock is as the count left it
    expect((await ledger(towel)).length).toBe(ledgerBefore);
    expect(await qtyOf(towel)).toBe(before + 4);

    const log = await c.http.get(`${api}/audit?entity=stocktake&entityId=${id}&action=stocktake.delete`).set(auth(admin));
    expect(log.body.data[0].before).toMatchObject({ name: 'To delete after finishing', status: 'committed' });
  });

  it('a count still being made is cancelled and hidden in one step, and posts nothing', async () => {
    const choc = c.seed.products.choc.id;
    const before = await qtyOf(choc);
    const id = (await start('Abandoned')).id;
    await count(id, choc, before + 50);
    expect((await del(id)).status).toBe(204);
    expect(await listed()).not.toContain(id);
    expect(await qtyOf(choc)).toBe(before); // it was never finished
  });

  it('a cancelled count can be deleted too, and a deleted count can no longer be counted into or finished', async () => {
    const id = (await start('Cancelled then deleted')).id;
    await c.http.post(`${api}/stocktakes/${id}/cancel`).set(auth(manager));
    expect((await del(id)).status).toBe(204);
    expect(await listed()).not.toContain(id);
    expect((await count(id, c.seed.products.choc.id, 1)).status).toBe(404);
    expect((await commit(id)).status).toBe(404);
  });

  it('the database still refuses every other change to a finished count: only gaining deleted_at is allowed', async () => {
    const id = (await start('Frozen')).id;
    await count(id, c.seed.products.choc.id, 1);
    await commit(id);
    const db = new Database(c.databasePath);
    try {
      expect(() => db.prepare("UPDATE stocktakes SET name = 'changed' WHERE id = ?").run(id)).toThrow(
        /finished stocktake cannot be changed/,
      );
      expect(() => db.prepare("UPDATE stocktakes SET status = 'open', finished_at = NULL WHERE id = ?").run(id)).toThrow();
      expect(() => db.prepare("UPDATE stocktakes SET name = 'changed', deleted_at = 'x' WHERE id = ?").run(id)).toThrow(); // not both at once
      expect(() => db.prepare('DELETE FROM stocktakes WHERE id = ?').run(id)).toThrow(/append-only/); // the row itself is never removed
      expect(() => db.prepare("UPDATE stocktakes SET deleted_at = '2026-01-01' WHERE id = ?").run(id)).not.toThrow();
      expect(() => db.prepare("UPDATE stocktakes SET deleted_at = '2027-01-01' WHERE id = ?").run(id)).toThrow(); // and it cannot be moved again
    } finally {
      db.close();
    }
  });
});
