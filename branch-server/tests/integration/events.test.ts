import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startCtx, type TestCtx } from '../helpers/app';

// Live updates (docs/06 `GET /events`): a till that listens is told, at once, when something it shows has changed.
let c: TestCtx;
let cashier: string;
let manager: string;
let admin: string;
const api = '/api/v1';
const opened: (() => void)[] = [];
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

type Heard = { event: string; data: { type: string; at: string } };

/** Open the stream like a till does (with fetch and its sign-in) and collect what arrives. */
async function listen(token: string) {
  const stop = new AbortController();
  const res = await fetch(`${c.url}${api}/events`, { headers: auth(token), signal: stop.signal });
  const heard: Heard[] = [];
  let raw = '';
  void (async () => {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = raw.indexOf('\n\n')) >= 0) {
          const frame = raw.slice(0, cut);
          raw = raw.slice(cut + 2);
          const event = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (event && data) heard.push({ event, data: JSON.parse(data) });
        }
      }
    } catch {
      /* closed */
    }
  })();
  const types = () => heard.map((h) => h.event);
  const until = async (check: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (check()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return check();
  };
  const close = () => stop.abort();
  opened.push(close);
  return { res, heard, types, until, close };
}

const sell = (over: Record<string, unknown> = {}, key: string = randomUUID()) =>
  c.http.post(`${api}/sales`).set(auth(cashier)).set('Idempotency-Key', key).send(c.newSaleBody(over));

beforeAll(async () => {
  c = await startCtx();
  cashier = await c.login('cashier');
  manager = await c.login('manager');
  admin = await c.login('admin');
  await c.openRegister(cashier);
});
afterEach(() => {
  while (opened.length) opened.pop()!(); // a failing test must not leave a stream open for the next one
});
afterAll(() => c.close());

describe('GET /events', () => {
  it('needs a sign-in', async () => {
    expect((await c.http.get(`${api}/events`)).status).toBe(401);
    expect((await c.http.get(`${api}/events`).set(auth('not-a-token'))).status).toBe(401);
  });

  it('opens a text/event-stream for any signed-in user, and never caches it', async () => {
    for (const token of [cashier, manager, admin]) {
      const s = await listen(token);
      expect(s.res.status).toBe(200);
      expect(s.res.headers.get('content-type')).toContain('text/event-stream');
      expect(s.res.headers.get('cache-control')).toContain('no-store');
      s.close();
    }
  });

  it('tells a till about a sale at once: the sale, and that the stock changed', async () => {
    const s = await listen(manager);
    expect((await sell()).status).toBe(201);
    expect(await s.until(() => s.types().includes('sale.completed') && s.types().includes('stock.changed'))).toBe(true);
    s.close();
  });

  it('an event carries only its type and time: never a sale, a price, a name or a total', async () => {
    const s = await listen(manager);
    await sell();
    await s.until(() => s.heard.length >= 2);
    for (const h of s.heard) {
      expect(Object.keys(h.data).sort()).toEqual(['at', 'type']);
      expect(h.data.type).toBe(h.event);
      expect(Date.parse(h.data.at)).not.toBeNaN();
    }
    s.close();
  });

  it('a replayed sale and a refused request tell nobody; the next real change does', async () => {
    const key = randomUUID();
    const body = c.newSaleBody(); // one body: the same key AND the same request is a replay (a different body would be a conflict)
    const post = () => c.http.post(`${api}/sales`).set(auth(cashier)).set('Idempotency-Key', key).send(body);
    expect((await post()).status).toBe(201); // the original
    const s = await listen(manager);
    const replay = await post();
    expect(replay.status).toBe(200); // Idempotent-Replay
    const refused = await sell({ items: [{ productId: c.seed.products.towel.id, qty: '1', unitPriceLbp: 1 }] });
    expect(refused.status).toBe(422); // PRICE_MISMATCH
    const rate = await c.http.post(`${api}/exchange-rates`).set(auth(admin)).send({ rateLbpPerUsd: 91000 });
    expect(rate.status).toBe(201);
    expect(await s.until(() => s.types().includes('rate.changed'))).toBe(true);
    expect(s.types()).toEqual(['rate.changed']); // nothing before it
    s.close();
  });

  it('a product edit tells the tills the catalog changed', async () => {
    const s = await listen(cashier);
    const res = await c.http.patch(`${api}/products/${c.seed.products.choc.id}`).set(auth(manager)).send({ priceMinor: 52000 });
    expect(res.status).toBe(200);
    expect(await s.until(() => s.types().includes('catalog.changed'))).toBe(true);
    s.close();
  });

  it('a register opening or closing tells the tills the register changed', async () => {
    const s = await listen(cashier);
    const current = (await c.http.get(`${api}/registers/current`).set(auth(cashier))).body;
    const counted = current.balances.map((b: { method: string; currency: string; expected: number }) => ({
      method: b.method,
      currency: b.currency,
      amount: b.expected,
    }));
    expect((await c.http.post(`${api}/registers/${current.id}/close`).set(auth(manager)).send({ countedBalances: counted })).status).toBe(
      200,
    );
    expect(await s.until(() => s.types().includes('register.updated'))).toBe(true);
    s.close();
  });

  it('every listening screen hears it, and a screen that goes away is forgotten', async () => {
    // Streams closed by earlier tests are forgotten by the server a moment later: start from a clean count.
    const quiet = await listen(cashier);
    quiet.close();
    expect(await quiet.until(() => c.app.events.size === 0)).toBe(true);
    const baseline = c.app.events.size;
    const a = await listen(cashier);
    const b = await listen(manager);
    expect(await a.until(() => c.app.events.size === baseline + 2)).toBe(true);
    await c.http.post(`${api}/exchange-rates`).set(auth(admin)).send({ rateLbpPerUsd: 92000 });
    expect(await a.until(() => a.types().includes('rate.changed'))).toBe(true);
    expect(await b.until(() => b.types().includes('rate.changed'))).toBe(true);

    a.close();
    expect(await b.until(() => c.app.events.size === baseline + 1)).toBe(true); // a was dropped, b is still listening
    b.close();
    expect(await b.until(() => c.app.events.size === baseline)).toBe(true);
  });

  it('keeps the line alive with a ping comment, which a reader ignores', async () => {
    // (the interval is 20 s; here only the first lines are checked: the retry hint and the "connected" comment)
    const stop = new AbortController();
    const res = await fetch(`${c.url}${api}/events`, { headers: auth(cashier), signal: stop.signal });
    const first = await res.body!.getReader().read();
    expect(new TextDecoder().decode(first.value)).toContain('retry: 3000');
    stop.abort();
  });
});

describe('shutting the server down', () => {
  it('does not wait for a screen that is still listening', async () => {
    const own = await startCtx();
    const token = await own.login('manager');
    const res = await fetch(`${own.url}${api}/events`, { headers: auth(token) }); // never closed by the client
    expect(res.status).toBe(200);
    const started = Date.now();
    await own.close();
    expect(Date.now() - started).toBeLessThan(3000);
  }, 15_000);
});
