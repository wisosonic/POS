import { normalizeBarcode } from '@pos/shared';
import { get } from './api';
import { memoryKV, type KV } from './kv';
import type { Product } from './types';

// The till screen holds the catalog in memory, so a scan is a map lookup (instant). It is filled and refreshed with the delta feed
// (/products/sync), which also delivers deactivated products. On a till PC that feed comes from the till's own disk copy (docs/14 §4).

/** One page of the feed. `next` says where the following page starts; it is null (or missing, for an older server) on the last. */
type Feed = { data: Product[]; serverTime: string; next?: { since: string; afterId: number } | null };
/** How many products to ask for at a time. A first sync of 8,000+ products is then about 16 small answers, not one huge one. */
const PAGE_SIZE = 500;
/** Bump when the saved copy gains a field the till needs: an older copy is dropped and fetched whole again. */
const CACHE_VERSION = 2;
type Saved = { since: string; products: Product[]; v?: number };

export class Catalog {
  private byId = new Map<number, Product>();
  private byBarcode = new Map<string, Product[]>();
  private list: Product[] = [];
  private haystack = new Map<number, string>();
  private since = '';

  constructor(
    private readonly kv: KV,
    private readonly fetchDelta: (since: string, afterId?: number) => Promise<Feed>,
  ) {}

  get size() {
    return this.byId.size;
  }
  get lastSync() {
    return this.since;
  }

  /** Load the copy saved on this computer, so the till is usable before the first network round trip. */
  async loadFromCache(): Promise<boolean> {
    const saved = await this.kv.get<Saved>('catalog');
    if (!saved?.products?.length || saved.v !== CACHE_VERSION) return false;
    this.since = saved.since;
    for (const p of saved.products) this.byId.set(p.id, p);
    this.reindex();
    return true;
  }

  /**
   * Fetch what changed since the last sync, page by page, and merge it in. Returns how many products changed.
   * The next sync starts from the moment the FIRST page was asked for, so a product edited while the pages were arriving is
   * simply fetched again next time. The search index is rebuilt once at the end, and the saved copy is rewritten only if
   * something changed (rewriting the whole catalog every few seconds for nothing is what a big catalog cannot afford).
   */
  async sync(): Promise<number> {
    let since = this.since;
    let afterId: number | undefined;
    let startedAt = '';
    let changed = 0;
    for (;;) {
      const feed = await this.fetchDelta(since, afterId);
      startedAt ||= feed.serverTime;
      for (const p of feed.data) {
        if (p.active) this.byId.set(p.id, p);
        else this.byId.delete(p.id);
      }
      changed += feed.data.length;
      const next = feed.next;
      if (!next) break;
      // A server that keeps pointing at the same place would loop for ever: stop instead.
      if (next.since === since && next.afterId === afterId) break;
      since = next.since;
      afterId = next.afterId;
    }
    this.since = startedAt;
    this.reindex();
    if (changed > 0)
      await this.kv.set('catalog', { since: this.since, products: [...this.byId.values()], v: CACHE_VERSION } satisfies Saved);
    return changed;
  }

  /** Forget everything (used when switching to a different server). */
  async clear() {
    this.byId.clear();
    this.since = '';
    this.reindex();
    await this.kv.delete('catalog');
  }

  private reindex() {
    this.list = [...this.byId.values()].sort((a, b) => a.name.localeCompare(b.name));
    this.byBarcode = new Map();
    this.haystack = new Map();
    for (const p of this.list) {
      if (p.barcode) (this.byBarcode.get(p.barcode) ?? this.byBarcode.set(p.barcode, []).get(p.barcode)!).push(p);
      this.haystack.set(p.id, `${p.name} ${p.receiptName ?? ''} ${p.barcode}`.toLowerCase());
    }
  }

  /** Every active product, sorted by name, for browsing. */
  all(): Product[] {
    return this.list;
  }

  get(id: number): Product | undefined {
    return this.byId.get(id);
  }

  /** Products with exactly this barcode. More than one means the code is shared (legacy duplicates). */
  byCode(code: string): Product[] {
    return this.byBarcode.get(normalizeBarcode(code)) ?? [];
  }

  /**
   * Find products by part of a name (Latin or Arabic), receipt name or barcode. Every word must appear. Names that start
   * with the first word come first, then names that contain it, then the rest.
   */
  search(text: string, limit = 12): Product[] {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    const hits: { p: Product; rank: number }[] = [];
    for (const p of this.list) {
      const h = this.haystack.get(p.id)!;
      if (!words.every((w) => h.includes(w))) continue;
      const name = p.name.toLowerCase();
      const rank = p.barcode === text.trim() ? 0 : name.startsWith(words[0]!) ? 1 : name.includes(words[0]!) ? 2 : 3;
      hits.push({ p, rank });
    }
    hits.sort((a, b) => a.rank - b.rank);
    return hits.slice(0, limit).map((h) => h.p);
  }
}

/**
 * The till screen's working catalog, in memory only. The copy that survives a restart is on the till PC's disk, kept by the till's own
 * server, which answers this same feed from it (docs/14 §4); a screen served straight by the branch server asks the branch server. Either
 * way a reload costs a few small local answers, not a copy in the browser to keep in step.
 */
export const catalog = new Catalog(memoryKV(), (since, afterId) =>
  get<Feed>(`/products/sync?since=${encodeURIComponent(since)}&limit=${PAGE_SIZE}${afterId === undefined ? '' : `&afterId=${afterId}`}`),
);

// Older versions of the till kept the catalog in the browser (IndexedDB database "till"). It is not used any more: remove it once.
try {
  if (typeof indexedDB !== 'undefined') indexedDB.deleteDatabase('till');
} catch {
  /* storage blocked: nothing to remove */
}
