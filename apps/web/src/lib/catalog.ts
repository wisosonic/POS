import { normalizeBarcode } from '@pos/shared';
import { get } from './api';
import { indexedDbKV, type KV } from './kv';
import type { Product } from './types';

// The till keeps its own copy of the catalog, so a scan is a map lookup (instant) and still works if the server is briefly
// unreachable. It is refreshed with the server's delta feed (/products/sync), which also delivers deactivated products.

type Feed = { data: Product[]; serverTime: string };
type Saved = { since: string; products: Product[] };

export class Catalog {
  private byId = new Map<number, Product>();
  private byBarcode = new Map<string, Product[]>();
  private list: Product[] = [];
  private haystack = new Map<number, string>();
  private since = '';

  constructor(
    private readonly kv: KV,
    private readonly fetchDelta: (since: string) => Promise<Feed>,
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
    if (!saved?.products?.length) return false;
    this.since = saved.since;
    for (const p of saved.products) this.byId.set(p.id, p);
    this.reindex();
    return true;
  }

  /** Fetch what changed since the last sync and merge it in. Returns how many products changed. */
  async sync(): Promise<number> {
    const feed = await this.fetchDelta(this.since);
    for (const p of feed.data) {
      if (p.active) this.byId.set(p.id, p);
      else this.byId.delete(p.id);
    }
    this.since = feed.serverTime;
    this.reindex();
    await this.kv.set('catalog', { since: this.since, products: [...this.byId.values()] } satisfies Saved);
    return feed.data.length;
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

/** The till's catalog, kept on this computer. */
export const catalog = new Catalog(indexedDbKV('till'), (since) => get<Feed>(`/products/sync?since=${encodeURIComponent(since)}`));
