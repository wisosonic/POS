import { createHash } from 'node:crypto';
import { mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

// The till's copy of the catalog, on this PC's disk (docs/14-connection-and-till-backend.md §4). One SQLite file with every product and
// its price, filled page by page from the branch server and read back through the same paged feed the screens already know.
//
//  - It is a COPY: read-only for the screens, it never changes a price and never prices a sale (rule 2). Cost, stock and supplier are
//    not in it at all (the branch server withholds them from the feed).
//  - It is disposable. If the file is damaged it is put aside and filled again; nothing is lost that the branch server does not hold.
//  - A page and the place to continue from are written in ONE transaction, so a restart in the middle of the first fill resumes at the
//    next page instead of starting over, and a half-filled copy is never served (`complete` stays 0 until the last page is in).

/** One product as the feed carries it. The store only needs these three; the rest is kept as it came. */
export type FeedProduct = { id: number; updatedAt: string; active: boolean };
export type FeedPage = { data: FeedProduct[]; serverTime: string; next: { since: string; afterId: number } | null };

export type CatalogState = {
  /** True once a whole first fill has been stored: only then may the copy answer the screens. */
  complete: boolean;
  /** Everything the branch server changed up to this moment is in the copy (the first page's `serverTime` of the last finished pull). */
  watermark: string;
  /** Where a pull that was cut short continues, or null. */
  cursor: { since: string; afterId: number | null; startedAt: string } | null;
  /** The branch server this copy came from. A copy of another branch server's catalog must never be served. */
  source: string | null;
  /** SHA-256 of the device token that filled the copy: a screen must present the same till's token to read it. Never the token itself. */
  tokenHash: string | null;
};

export type CatalogStore = {
  state(): CatalogState;
  count(): number;
  /** Store one page and, in the same transaction, where to continue (or, for the last page, mark the pull finished). */
  applyPage(page: FeedPage, startedAt: string, source: string): void;
  setTokenHash(token: string): void;
  tokenMatches(token: string | undefined): boolean;
  /** The feed the screens read: same order, same paging and same answer as the branch server's `/products/sync`. */
  readFeed(
    since: string,
    afterId: number | undefined,
    limit: number | undefined,
  ): { data: unknown[]; serverTime: string; next: FeedPage['next'] };
  /** Forget everything (a different branch server). */
  reset(): void;
  close(): void;
};

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY,
    updated_at TEXT NOT NULL,
    active INTEGER NOT NULL,
    json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS products_updated ON products (updated_at, id);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

function open(file: string): Database.Database {
  const db = new Database(file);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.exec(SCHEMA);
    if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('catalog copy is damaged');
    return db;
  } catch (e) {
    db.close(); // the damaged file must be free to be renamed (Windows keeps it locked while open)
    throw e;
  }
}

/** Open the copy at `file`. A damaged file is renamed aside (`.broken-<time>`) and a fresh, empty copy is made. */
export function openCatalogStore(file: string, log: (message: string) => void = () => undefined): CatalogStore {
  mkdirSync(dirname(file), { recursive: true });
  let db: Database.Database;
  try {
    db = open(file);
  } catch (e) {
    log(`The catalog copy could not be opened (${(e as Error).message}); starting a new one`);
    try {
      renameSync(file, `${file}.broken-${Date.now()}`);
    } catch {
      /* already gone */
    }
    db = open(file);
  }

  const getMeta = (key: string): string | null =>
    (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  const setMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
  const delMeta = db.prepare('DELETE FROM meta WHERE key = ?');
  const upsert = db.prepare(
    'INSERT INTO products (id, updated_at, active, json) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at, active = excluded.active, json = excluded.json',
  );

  const applyPage = db.transaction((page: FeedPage, startedAt: string, source: string) => {
    for (const p of page.data) upsert.run(p.id, p.updatedAt, p.active ? 1 : 0, JSON.stringify(p));
    setMeta.run('source', source);
    if (page.next) {
      setMeta.run('cursor', JSON.stringify({ since: page.next.since, afterId: page.next.afterId, startedAt }));
    } else {
      setMeta.run('watermark', startedAt);
      setMeta.run('complete', '1');
      delMeta.run('cursor');
    }
  });

  return {
    state() {
      const raw = getMeta('cursor');
      return {
        complete: getMeta('complete') === '1',
        watermark: getMeta('watermark') ?? '',
        cursor: raw ? (JSON.parse(raw) as CatalogState['cursor']) : null,
        source: getMeta('source'),
        tokenHash: getMeta('token_hash'),
      };
    },
    count: () => (db.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number }).n,
    applyPage: (page, startedAt, source) => applyPage(page, startedAt, source),
    setTokenHash: (token) => void setMeta.run('token_hash', sha256(token)),
    tokenMatches(token) {
      const saved = getMeta('token_hash');
      return !!token && !!saved && sha256(token) === saved;
    },
    readFeed(since, afterId, limit) {
      const cond = afterId === undefined ? 'updated_at > ?' : '(updated_at, id) > (?, ?)';
      const params: (string | number)[] = afterId === undefined ? [since] : [since, afterId];
      const rows = db
        .prepare(`SELECT id, updated_at, json FROM products WHERE ${cond} ORDER BY updated_at, id ${limit ? 'LIMIT ?' : ''}`)
        .all(...params, ...(limit ? [limit + 1] : [])) as { id: number; updated_at: string; json: string }[];
      const page = limit ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      const next = limit && rows.length > limit && last ? { since: last.updated_at, afterId: last.id } : null;
      return { data: page.map((r) => JSON.parse(r.json) as unknown), serverTime: getMeta('watermark') ?? '', next };
    },
    reset() {
      db.transaction(() => {
        db.exec('DELETE FROM products; DELETE FROM meta;');
      })();
    },
    close: () => void db.close(),
  };
}
