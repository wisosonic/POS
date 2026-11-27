import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCatalogCopy, type CatalogCopy } from '../src/catalogCopy';
import { createTillServer } from '../src/tillServer';

// docs/14 §4: the till's copy of the catalog on its own disk, against a made-up branch server that serves the same paged feed as
// GET /api/v1/terminal/catalog. The copy is read-only, resumable, and only answers the screens when it is whole.

type Prod = { id: number; name: string; priceMinor: number; active: boolean; updatedAt: string };
const TOKEN = 'device-token-for-tests';

let tick = 0;
const stamp = () => new Date(Date.UTC(2026, 5, 1) + ++tick * 1000).toISOString();

type Branch = {
  url: string;
  products: Prod[];
  version: number;
  asked: { since: string; afterId: string | null; token: string | undefined }[];
  /** Answer 500 once this many catalog pages have been served (undefined: never). */
  failAfterPages: number | undefined;
  pagesServed: number;
  edit(id: number, patch: Partial<Prod>): void;
  close(): Promise<void>;
};

async function makeBranch(count: number): Promise<Branch> {
  const b: Branch = {
    url: '',
    products: Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      name: `Item ${i + 1}`,
      priceMinor: 1000 + i,
      active: true,
      updatedAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
    })),
    version: 1,
    asked: [],
    failAfterPages: undefined,
    pagesServed: 0,
    edit(id, patch) {
      const p = b.products.find((x) => x.id === id)!;
      Object.assign(p, patch, { updatedAt: stamp() });
      b.version++;
    },
    close: () => Promise.resolve(),
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const token = req.headers['x-terminal-token'];
    const send = (status: number, body: unknown) =>
      void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (url.pathname === '/api/v1/healthz') return send(200, { status: 'ok' });
    if (token !== TOKEN) return send(401, { code: 'TERMINAL_UNKNOWN' });
    if (url.pathname === '/api/v1/ping')
      return send(200, { ok: true, serverTime: stamp(), epoch: 'epoch-1', versions: { catalog: b.version } });
    if (url.pathname === '/api/v1/terminal/catalog') {
      if (b.failAfterPages !== undefined && b.pagesServed >= b.failAfterPages) return send(500, { code: 'INTERNAL' });
      const since = url.searchParams.get('since') ?? '';
      const afterRaw = url.searchParams.get('afterId');
      const limit = Number(url.searchParams.get('limit') ?? 500);
      b.asked.push({ since, afterId: afterRaw, token: typeof token === 'string' ? token : undefined });
      const after = afterRaw === null ? undefined : Number(afterRaw);
      const rows = b.products
        .filter((p) => (after === undefined ? p.updatedAt > since : p.updatedAt > since || (p.updatedAt === since && p.id > after)))
        .sort((x, y) => (x.updatedAt < y.updatedAt ? -1 : x.updatedAt > y.updatedAt ? 1 : x.id - y.id));
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      b.pagesServed++;
      return send(200, {
        data: page,
        serverTime: stamp(),
        next: rows.length > limit && last ? { since: last.updatedAt, afterId: last.id } : null,
      });
    }
    return send(404, { code: 'NOT_FOUND' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  b.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  b.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return b;
}

let dir = '';
let branch: Branch;
const copies: CatalogCopy[] = [];
const open = (over: { pageSize?: number; url?: () => string | null } = {}) => {
  const c = createCatalogCopy({
    dataDir: dir,
    branchServer: over.url ?? (() => branch.url),
    pageSize: over.pageSize ?? 500,
    safetyMs: 10 * 60_000,
  });
  copies.push(c);
  return c;
};
const ping = (c: CatalogCopy) => c.onPing({ token: TOKEN, epoch: 'epoch-1', versions: { catalog: branch.version } });
/** Wait until a pull has ended (it starts at the ping). */
const settled = async (c: CatalogCopy) => {
  for (let i = 0; i < 400; i++) {
    if (!c.status().pulling) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('the pull did not end');
};
const filled = async (c: CatalogCopy) => {
  ping(c);
  await new Promise((r) => setTimeout(r, 5));
  await settled(c);
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'till-catalog-'));
  branch = await makeBranch(8000);
});
afterEach(async () => {
  for (const c of copies.splice(0)) await c.close().catch(() => undefined);
  await branch.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('filling the copy (US-26)', () => {
  it('starts empty and not ready, so the screens are still sent to the branch server', () => {
    const c = open();
    expect(c.status()).toMatchObject({ ready: false, products: 0 });
    expect(c.canServe(TOKEN)).toBe(false);
  });

  it('copies 8,000 products in pages of 500 and then says it is ready', async () => {
    const c = open();
    await filled(c);
    expect(c.status()).toMatchObject({ ready: true, products: 8000, lastError: null });
    expect(branch.asked).toHaveLength(16);
    expect(branch.asked.every((a) => a.token === TOKEN)).toBe(true);
  });

  it('reads back through the same paged feed: every product once, in order, the last page says there is no next', async () => {
    const c = open();
    await filled(c);
    const seen: number[] = [];
    let since = '';
    let afterId: number | undefined;
    for (let pages = 0; pages < 100; pages++) {
      const page = c.store.readFeed(since, afterId, 500) as { data: { id: number }[]; next: { since: string; afterId: number } | null };
      seen.push(...page.data.map((p) => p.id));
      if (!page.next) break;
      since = page.next.since;
      afterId = page.next.afterId;
    }
    expect(seen).toHaveLength(8000);
    expect(new Set(seen).size).toBe(8000);
  });

  it('without a limit it answers everything at once, like the branch server does for an older till', async () => {
    const c = open();
    await filled(c);
    const all = c.store.readFeed('', undefined, undefined);
    expect(all.data).toHaveLength(8000);
    expect(all.next).toBeNull();
  });

  it('only answers a screen that presents the token of the till that filled it', async () => {
    const c = open();
    await filled(c);
    expect(c.canServe(TOKEN)).toBe(true);
    expect(c.canServe('some-other-token')).toBe(false);
    expect(c.canServe(undefined)).toBe(false);
  });

  it('does not hold the token itself on disk, only a hash of it', async () => {
    const c = open();
    await filled(c);
    await c.close();
    for (const f of readdirSync(dir)) expect(readFileSync(join(dir, f)).includes(Buffer.from(TOKEN))).toBe(false);
  });
});

describe('a restart in the middle of the first fill', () => {
  it('keeps the pages it had, is not served while incomplete, and continues from where it stopped', async () => {
    const c = open();
    branch.failAfterPages = 3;
    await filled(c);
    expect(c.status()).toMatchObject({ ready: false, products: 1500 });
    expect(c.status().lastError).toMatch(/500/);
    expect(c.canServe(TOKEN)).toBe(false);
    await c.close();

    branch.failAfterPages = undefined;
    branch.asked.length = 0;
    const again = open(); // a new run of the till program, same disk
    expect(again.status()).toMatchObject({ ready: false, products: 1500 });
    await filled(again);
    expect(again.status()).toMatchObject({ ready: true, products: 8000 });
    expect(branch.asked).toHaveLength(13); // 16 pages in all, 3 were already stored
    expect(branch.asked[0]!.since).not.toBe(''); // it did not start over
  });

  it('a pull that fails changes nothing it already stored, and the next ping tries again', async () => {
    const c = open();
    await filled(c);
    const before = c.status().products;
    branch.edit(5, { priceMinor: 9999 });
    branch.failAfterPages = branch.pagesServed; // fail at once
    await filled(c);
    expect(c.status().lastError).not.toBeNull();
    expect(c.status().products).toBe(before);
    branch.failAfterPages = undefined;
    await filled(c);
    expect(c.status().lastError).toBeNull();
  });
});

describe('keeping it up to date', () => {
  it('a changed price is fetched alone, from where the last pull ended', async () => {
    const c = open();
    await filled(c);
    branch.asked.length = 0;
    branch.edit(7, { priceMinor: 55500 });
    await filled(c);
    expect(branch.asked).toHaveLength(1);
    const feed = c.store.readFeed(c.status().watermark!, undefined, 500);
    expect(feed.data).toEqual([]); // nothing newer than the new watermark
    const changed = c.store.readFeed(new Date(Date.UTC(2026, 4, 1)).toISOString(), undefined, 500) as { data: Prod[] };
    expect(changed.data.find((p) => p.id === 7)?.priceMinor).toBe(55500);
    expect(c.status().products).toBe(8000);
  });

  it('a deactivated product stays in the feed as inactive, so a screen can drop it', async () => {
    const c = open();
    await filled(c);
    branch.edit(9, { active: false });
    await filled(c);
    const delta = c.store.readFeed(new Date(Date.UTC(2026, 4, 1)).toISOString(), undefined, 500) as { data: Prod[] };
    expect(delta.data.find((p) => p.id === 9)).toMatchObject({ active: false });
  });

  it('does not ask again while the version has not changed', async () => {
    const c = open();
    await filled(c);
    branch.asked.length = 0;
    for (let i = 0; i < 5; i++) ping(c);
    await settled(c);
    expect(branch.asked).toHaveLength(0);
  });

  it('never has two pulls at once, however many pings arrive', async () => {
    const c = open();
    for (let i = 0; i < 5; i++) ping(c);
    await settled(c);
    expect(branch.asked).toHaveLength(16);
  });

  it('a different branch server address empties the copy and fills it again from the new one', async () => {
    let url: string | null = branch.url;
    const c = open({ url: () => url });
    await filled(c);
    const other = await makeBranch(30);
    try {
      url = other.url;
      await filled(c);
      expect(c.status()).toMatchObject({ ready: true, products: 30 });
    } finally {
      await other.close();
    }
  });

  it('with no branch server address it does nothing', async () => {
    const c = open({ url: () => null });
    await filled(c);
    expect(c.status()).toMatchObject({ ready: false, products: 0 });
  });
});

describe('a damaged file', () => {
  it('is put aside and a new copy is started, never a crash', async () => {
    writeFileSync(join(dir, 'catalog.db'), 'this is not a database file '.repeat(200));
    const c = open();
    expect(c.status()).toMatchObject({ ready: false, products: 0 });
    expect(readdirSync(dir).some((f) => f.startsWith('catalog.db.broken-'))).toBe(true);
    await filled(c);
    expect(c.status().ready).toBe(true);
  });
});

describe('the till server answers the catalog from the copy (GET /api/v1/products/sync)', () => {
  let till: ReturnType<typeof createTillServer>;
  let port = 0;
  const feed = async (token: string | undefined, query = 'limit=500') => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/products/sync?${query}`, {
      headers: token ? { 'X-Terminal-Token': token } : {},
    });
    return { res, body: (await res.json()) as { data: Prod[]; serverTime: string; next: unknown } };
  };
  const until = async (fn: () => boolean) => {
    for (let i = 0; i < 400 && !fn(); i++) await new Promise((r) => setTimeout(r, 25));
    return fn();
  };

  beforeEach(async () => {
    till = createTillServer({
      dataDir: join(dir, 'till'),
      port: 0,
      defaultBranchServer: branch.url,
      link: { intervalMs: 30, timeoutMs: 300 },
      catalog: { pageSize: 500 },
    });
    port = await till.listen('127.0.0.1');
  });
  afterEach(async () => {
    await till.close();
  });
  const wake = () => fetch(`http://127.0.0.1:${port}/till/link`, { headers: { 'X-Terminal-Token': TOKEN } }); // the screen hands over its token

  it('is filled by the heartbeat, with no one asking for it', async () => {
    await wake();
    expect(await until(() => branch.asked.length >= 16)).toBe(true);
    expect(existsSync(join(dir, 'till', 'catalog.db'))).toBe(true);
    let status = { ready: false, products: 0 };
    for (let i = 0; i < 200 && !status.ready; i++) {
      status = (await (await fetch(`http://127.0.0.1:${port}/till/catalog`)).json()) as typeof status;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(status).toMatchObject({ ready: true, products: 8000 });
  });

  it('answers from disk, so it keeps answering when the branch server is gone', async () => {
    await wake();
    for (let i = 0; i < 200; i++) {
      const s = (await (await fetch(`http://127.0.0.1:${port}/till/catalog`)).json()) as { ready: boolean };
      if (s.ready) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    await branch.close();
    const first = await feed(TOKEN);
    expect(first.res.status).toBe(200);
    expect(first.res.headers.get('x-till-proxy-error')).toBeNull();
    expect(first.body.data).toHaveLength(500);
    expect(first.body.next).not.toBeNull();
    branch = await makeBranch(1); // so afterEach has something to close
  });

  it('a screen without the till’s token, or with another one, is passed to the branch server (here: gone, so refused as before)', async () => {
    await wake();
    for (let i = 0; i < 200; i++) {
      const s = (await (await fetch(`http://127.0.0.1:${port}/till/catalog`)).json()) as { ready: boolean };
      if (s.ready) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    await branch.close();
    expect((await feed(undefined)).res.headers.get('x-till-proxy-error')).toBe('BRANCH_UNREACHABLE');
    expect((await feed('another-token')).res.headers.get('x-till-proxy-error')).toBe('BRANCH_UNREACHABLE');
    branch = await makeBranch(1);
  });

  it('before the first fill is whole, the call goes through to the branch server', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/products/sync?limit=5`, { headers: { 'X-Terminal-Token': TOKEN } });
    expect(res.status).toBe(404); // the made-up branch server has no such route: it was passed on, not answered from an empty copy
  });
});
