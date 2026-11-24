import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startCtx, type TestCtx } from '../helpers/app';

// The till's catalog feed (US-04, docs/11-multi-branch.md P1): the whole catalog (8,000+ products) arrives in pages, and a page boundary
// must never skip or repeat a product, even when several products changed in the same millisecond.
let c: TestCtx;
let cashier: string;
let manager: string;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

type Feed = { data: { id: number; name: string; active: boolean }[]; serverTime: string; next: { since: string; afterId: number } | null };
const page = (qs: string) => c.http.get(`${api}/products/sync?${qs}`).set(auth(cashier));

/** Walk every page the way the till does. */
async function walk(limit: number, since = '') {
  const pages: Feed[] = [];
  let cursor: Feed['next'] = { since, afterId: undefined as unknown as number };
  let first = true;
  while (cursor) {
    const qs: string =
      first && !since
        ? `limit=${limit}`
        : `since=${encodeURIComponent(cursor.since)}&limit=${limit}${first ? '' : `&afterId=${cursor.afterId}`}`;
    const res = await page(qs);
    expect(res.status).toBe(200);
    pages.push(res.body as Feed);
    cursor = (res.body as Feed).next;
    first = false;
  }
  return pages;
}

beforeAll(async () => {
  c = await startCtx();
  cashier = await c.login('cashier');
  manager = await c.login('manager');
  // 40 more products created one after another: many share a millisecond, and the cursor has to cope.
  for (let i = 0; i < 40; i++) {
    const res = await c.http
      .post(`${api}/products`)
      .set(auth(manager))
      .send({ name: `Sync item ${i}`, barcode: `7770000${String(i).padStart(5, '0')}`, priceMinor: 1000 + i });
    expect(res.status).toBe(201);
  }
});
afterAll(() => c.close());

describe('the catalog feed in pages', () => {
  it('without a limit the whole feed comes at once, as it always did (older tills)', async () => {
    const res = await page('');
    expect(res.status).toBe(200);
    expect(res.body.next).toBeNull();
    expect(res.body.data.length).toBeGreaterThanOrEqual(45);
  });

  it('pages of any size add up to exactly the whole feed: nothing skipped, nothing repeated', async () => {
    const whole = (await page('')).body.data.map((p: { id: number }) => p.id).sort((a: number, b: number) => a - b);
    for (const limit of [1, 2, 7, 10, 44, 1000]) {
      const ids = (await walk(limit)).flatMap((p) => p.data.map((x) => x.id));
      expect(
        [...ids].sort((a, b) => a - b),
        `limit ${limit}`,
      ).toEqual(whole);
      expect(new Set(ids).size, `limit ${limit}: no product twice`).toBe(ids.length);
    }
  });

  it('each page has at most `limit` products, and only the last has no next page', async () => {
    const pages = await walk(7);
    expect(pages.length).toBeGreaterThan(5);
    expect(pages.every((p) => p.data.length <= 7)).toBe(true);
    expect(pages.slice(0, -1).every((p) => p.next !== null && p.data.length === 7)).toBe(true);
    expect(pages[pages.length - 1]!.next).toBeNull();
  });

  it('with a since, only what changed after it comes back, in pages', async () => {
    const mark = (await page('limit=1000')).body.serverTime as string;
    await new Promise((r) => setTimeout(r, 5));
    for (const name of ['After A', 'After B', 'After C'])
      await c.http
        .post(`${api}/products`)
        .set(auth(manager))
        .send({ name, barcode: `88${Math.random().toString().slice(2, 12)}`, priceMinor: 500 });
    const pages = await walk(2, mark);
    expect(pages.flatMap((p) => p.data.map((x) => x.name)).sort()).toEqual(['After A', 'After B', 'After C']);
  });

  it('refuses a limit that is not a sensible number', async () => {
    expect((await page('limit=0')).status).toBe(400);
    expect((await page('limit=999999')).status).toBe(400);
    expect((await page('limit=2&afterId=-5')).status).toBe(400);
  });
});
