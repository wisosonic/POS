import { join } from 'node:path';
import { openCatalogStore, type CatalogStore, type FeedPage } from './catalogStore';

// Keeps the till's catalog copy (catalogStore.ts) up to date (docs/14 §3 and §4). It is driven by the heartbeat: each good ping says
// which version of the catalog the branch server has, and when that is different from the one the copy was last filled for, the copy
// pulls what changed through the paged feed. It also pulls on its first ping, and once in a while whatever the numbers say (a safety net).
//
//  - It never decides anything and never writes a price of its own: it only copies what the branch server's feed says.
//  - It uses the till's device token, which it is handed with each ping and keeps in memory only; the disk holds only a hash of it.
//  - One pull at a time. A failed pull is simply tried again at the next ping; it never throws out of the loop, never stops selling.

export type CatalogCopyOptions = {
  dataDir: string;
  /** The branch server's address now, or null when none is set. */
  branchServer: () => string | null;
  pageSize?: number;
  /** Pull at least this often even when the ping says nothing changed (default one minute). */
  safetyMs?: number;
  /** How long one page may take before it counts as failed. */
  pageTimeoutMs?: number;
  log?: (message: string) => void;
};

export type CatalogStatus = {
  /** The copy holds a whole catalog and may answer the screens. */
  ready: boolean;
  products: number;
  watermark: string | null;
  pulling: boolean;
  lastPullAt: string | null;
  lastError: string | null;
};

export type PingInfo = { token: string; epoch: string | null; versions: Record<string, number> | null };

export type CatalogCopy = {
  store: CatalogStore;
  /** Called with every good ping: starts a pull when the catalog changed. */
  onPing(info: PingInfo): void;
  /** Pull now (the heartbeat does this by itself); resolves when that pull has ended, well or not. */
  pull(token: string): Promise<void>;
  /** May the screens be answered from the copy for this request? */
  canServe(deviceToken: string | undefined): boolean;
  status(): CatalogStatus;
  /** Stop pulling and close the file (waits for a page already on its way). */
  close(): Promise<void>;
};

export function createCatalogCopy(opts: CatalogCopyOptions): CatalogCopy {
  const log = opts.log ?? (() => undefined);
  const pageSize = opts.pageSize ?? 500;
  const safetyMs = opts.safetyMs ?? 60_000;
  const pageTimeoutMs = opts.pageTimeoutMs ?? 10_000;
  // Opened the first time it is needed, so a till server that is made and never used does not hold a file open.
  let opened: CatalogStore | null = null;
  const db = (): CatalogStore => (opened ??= openCatalogStore(join(opts.dataDir, 'catalog.db'), log));

  let seenKey: string | null = null; // the epoch and catalog version the copy was last filled for
  let lastPullMs = 0;
  let lastPullAt: string | null = null;
  let lastError: string | null = null;
  let inFlight: Promise<void> | null = null;
  let closed = false;

  async function fetchPage(base: string, token: string, since: string, afterId: number | null): Promise<FeedPage> {
    const q = new URLSearchParams({ since, limit: String(pageSize) });
    if (afterId !== null) q.set('afterId', String(afterId));
    const res = await fetch(`${base}/api/v1/terminal/catalog?${q}`, {
      headers: { 'X-Terminal-Token': token, Accept: 'application/json' },
      signal: AbortSignal.timeout(pageTimeoutMs),
    });
    if (!res.ok) throw new Error(`the branch server answered ${res.status}`);
    const body = (await res.json()) as Partial<FeedPage>;
    if (!Array.isArray(body.data) || typeof body.serverTime !== 'string') throw new Error('the catalog feed answered something unexpected');
    return { data: body.data, serverTime: body.serverTime, next: body.next ?? null };
  }

  async function run(token: string, key: string | null): Promise<void> {
    const base = opts.branchServer();
    if (!base) return;
    // A copy made from another branch server is not this branch's catalog: forget it and fill again.
    const had = db().state();
    if (had.source && had.source !== base) {
      log('The branch server address changed: the catalog copy is filled again from the new one');
      db().reset();
    }
    const st = db().state();
    let since = st.cursor?.since ?? st.watermark;
    let afterId = st.cursor?.afterId ?? null;
    let startedAt = st.cursor?.startedAt ?? '';
    const wasComplete = st.complete;
    try {
      for (;;) {
        if (closed) return;
        const page = await fetchPage(base, token, since, afterId);
        startedAt ||= page.serverTime; // the next pull starts from the moment the FIRST page was asked for
        db().applyPage(page, startedAt, base);
        const next = page.next;
        if (!next) break;
        if (next.since === since && next.afterId === afterId) break; // a server that points at the same place would loop for ever
        since = next.since;
        afterId = next.afterId;
      }
      db().setTokenHash(token);
      seenKey = key;
      lastPullMs = Date.now();
      lastPullAt = new Date().toISOString();
      if (lastError) log('The catalog copy is being kept up to date again');
      lastError = null;
      if (!wasComplete) log(`The catalog copy is complete: ${db().count()} products`);
    } catch (e) {
      const message = (e as Error).message;
      if (message !== lastError) log(`The catalog copy could not be updated: ${message}`);
      lastError = message; // tried again at the next ping
    }
  }

  function pull(token: string, key: string | null = null): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = run(token, key)
      .catch((e: unknown) => log(`Unexpected error while copying the catalog: ${(e as Error).message}`))
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return {
    get store() {
      return db();
    },
    pull: (token) => pull(token),
    onPing({ token, epoch, versions }) {
      if (closed) return;
      const key = `${epoch ?? ''}:${versions?.catalog ?? ''}`;
      const st = db().state();
      const stale = Date.now() - lastPullMs > safetyMs;
      const otherServer = st.source !== null && st.source !== opts.branchServer();
      if (key !== seenKey || !st.complete || st.cursor || stale || otherServer || !db().tokenMatches(token)) void pull(token, key);
    },
    canServe(deviceToken) {
      const st = db().state();
      const base = opts.branchServer();
      return st.complete && !!base && st.source === base && db().tokenMatches(deviceToken);
    },
    status() {
      const st = db().state();
      return {
        ready: st.complete,
        products: db().count(),
        watermark: st.watermark || null,
        pulling: inFlight !== null,
        lastPullAt,
        lastError,
      };
    },
    async close() {
      closed = true;
      // A pull still running ends at its next page (it checks `closed`); the database closes after it.
      await inFlight;
      opened?.close();
      opened = null;
    },
  };
}
