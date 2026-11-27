import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCtx, type TestCtx } from '../helpers/app';

// docs/14 §4: the feed the till's own server copies onto its disk. A till holds prices, not costs or stock.
let c: TestCtx;
let admin: string;
let manager: string;
let device = '';
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
/** `null` sends no device token at all. */
const feed = (query = '', token: string | null = device) => {
  const req = c.http.get(`${api}/terminal/catalog${query}`);
  return token === null ? req : req.set({ 'X-Terminal-Token': token });
};

beforeAll(async () => {
  c = await startCtx();
  admin = await c.login('admin');
  manager = await c.login('manager');
  const code = await c.http.post(`${api}/terminals/1/enrol-code`).set(auth(admin));
  const done = await c.http.post(`${api}/terminals/enrol`).set(auth(admin)).send({ code: code.body.enrolCode });
  device = done.body.token as string;
});
afterAll(() => c.close());

describe('who may read the till catalog feed (US-26)', () => {
  it('needs a device token; a signed-in person without one, and an unknown token, are refused', async () => {
    const none = await feed('', null);
    expect(none.status).toBe(401);
    expect(none.body.code).toBe('TERMINAL_REQUIRED');
    expect((await c.http.get(`${api}/terminal/catalog`).set(auth(manager))).status).toBe(401);
    expect((await feed('', 'nobody-has-this')).body.code).toBe('TERMINAL_UNKNOWN');
  });

  it('needs no signed-in person', async () => {
    expect((await feed()).status).toBe(200);
  });
});

describe('what the feed holds', () => {
  it('has every product with its price, and withholds cost, stock, supplier and alert', async () => {
    const res = await feed('?limit=2000');
    expect(res.status).toBe(200);
    expect(res.body.next).toBeNull();
    expect(res.body.data.length).toBeGreaterThanOrEqual(3);
    const choc = res.body.data.find((p: { id: number }) => p.id === c.seed.products.choc.id);
    expect(choc).toMatchObject({ name: expect.any(String), priceMinor: expect.any(Number), active: true });
    for (const p of res.body.data) {
      expect(p.costMinor).toBe(0);
      expect(p.qty).toBe('0');
      expect(p.supplierId).toBeNull();
      expect(p.stockAlert).toBeNull();
    }
  });

  it('has the same fields the screens read from /products/sync', async () => {
    const full = await c.http.get(`${api}/products/sync?limit=1`).set(auth(manager));
    const slim = await feed('?limit=1');
    expect(Object.keys(slim.body.data[0]).sort()).toEqual(Object.keys(full.body.data[0]).sort());
  });

  it('comes in pages in (updated_at, id) order, each says where the next starts, and the pages add up to the whole', async () => {
    const whole = (await feed('?limit=2000')).body.data as { id: number; updatedAt: string }[];
    const seen: number[] = [];
    let query = '?limit=2';
    for (let i = 0; i < 100; i++) {
      const page = await feed(query);
      expect(page.body.data.length).toBeLessThanOrEqual(2);
      seen.push(...page.body.data.map((p: { id: number }) => p.id));
      if (!page.body.next) break;
      query = `?limit=2&since=${encodeURIComponent(page.body.next.since)}&afterId=${page.body.next.afterId}`;
    }
    expect(seen).toEqual(whole.map((p) => p.id));
  });

  it('a later ask returns only what changed, and a deactivated product comes with active false', async () => {
    const first = await feed('?limit=2000');
    const watermark = first.body.serverTime as string;
    await new Promise((r) => setTimeout(r, 5));
    expect((await c.http.patch(`${api}/products/${c.seed.products.choc.id}`).set(auth(manager)).send({ priceMinor: 61000 })).status).toBe(
      200,
    );
    const delta = await feed(`?since=${encodeURIComponent(watermark)}`);
    expect(delta.body.data.map((p: { id: number }) => p.id)).toEqual([c.seed.products.choc.id]);
    expect(delta.body.data[0].priceMinor).toBe(61000);
    expect((await c.http.patch(`${api}/products/${c.seed.products.choc.id}`).set(auth(manager)).send({ active: false })).status).toBe(200);
    const gone = await feed(`?since=${encodeURIComponent(delta.body.serverTime)}`);
    expect(gone.body.data[0]).toMatchObject({ id: c.seed.products.choc.id, active: false });
  });

  it('refuses a limit that is not a sensible number', async () => {
    expect((await feed('?limit=0')).status).toBe(400);
    expect((await feed('?limit=99999')).status).toBe(400);
  });
});
