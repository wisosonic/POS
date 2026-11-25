// Live updates for the tills (docs/04-architecture.md, docs/06-api-spec.md `GET /events`). When something changes that other screens show
// (a price, the stock, the exchange rate, a register), the server says so over a stream the tills keep open, so they refresh at once
// instead of on a timer. The events are HINTS ("the catalog changed"), never data: a till that hears one asks the server for the real
// thing through the normal, authorised calls, and a till that missed any (it was offline) simply refreshes everything when it reconnects.

export type EventType =
  | 'catalog.changed'
  | 'stock.changed'
  | 'rate.changed'
  | 'settings.changed'
  | 'register.updated'
  | 'sale.completed'
  | 'sync.changed'
  | 'wallet.updated';

export type PosEvent = { type: EventType; at: string };

export class EventBus {
  private readonly listeners = new Set<(e: PosEvent) => void>();

  /** Listen to every event. Returns the function that stops listening. */
  subscribe(fn: (e: PosEvent) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** Server-side watchers (the sync loop): like `subscribe`, but not a screen, so `size` (the listening screens) does not count them. */
  private readonly taps = new Set<(e: PosEvent) => void>();
  tap(fn: (e: PosEvent) => void): () => void {
    this.taps.add(fn);
    return () => void this.taps.delete(fn);
  }

  /** Tell everyone. A listener that throws (a dead connection) never stops the others, and never affects the request that caused it. */
  publish(type: EventType): void {
    const event: PosEvent = { type, at: new Date().toISOString() };
    for (const fn of [...this.taps]) {
      try {
        fn(event);
      } catch {
        /* a watcher must never affect the request */
      }
    }
    for (const fn of [...this.listeners]) {
      try {
        fn(event);
      } catch {
        this.listeners.delete(fn);
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}

/**
 * Which events a finished request causes. `route` is the route pattern without the API prefix (`/sales/:id/void`), `status` the answer.
 * Only a request that really changed something counts: a replayed sale (200) or a refused one (4xx) changes nothing.
 */
export function eventsFor(method: string, route: string, status: number): EventType[] {
  const ok = status >= 200 && status < 300;
  if (!ok) return [];
  const is = (m: string, r: string | RegExp) => method === m && (typeof r === 'string' ? route === r : r.test(route));

  if (is('POST', '/sales')) return status === 201 ? ['sale.completed', 'stock.changed'] : []; // 200 is a replay: nothing new happened
  if (is('POST', /^\/sales\/:id\/(void|delete)$/)) return ['stock.changed', 'register.updated'];
  if (is('POST', '/returns')) return status === 201 ? ['stock.changed', 'register.updated'] : [];
  if (is('POST', '/purchases/:id/receive')) return ['stock.changed', 'catalog.changed']; // receiving can move a product's cost
  if (is('POST', '/stock/adjustments') || is('POST', '/stocktakes/:id/commit')) return ['stock.changed'];
  if (is('POST', '/products') || is('PATCH', '/products/:id') || is('POST', '/products/merge') || is('POST', '/products/import'))
    return ['catalog.changed'];
  if (method !== 'GET' && /^\/products\/:id\/image$/.test(route)) return ['catalog.changed'];
  if (is('POST', '/exchange-rates')) return ['rate.changed'];
  if (is('POST', '/wallets/counts') || is('POST', '/wallets/movements')) return ['wallet.updated'];
  if (is('PATCH', '/settings')) return ['settings.changed'];
  if (
    is('POST', '/registers/open') ||
    is('POST', /^\/registers\/:id\/(close|cash-movements)$/) ||
    is('POST', '/customers/:id/payments') ||
    is('POST', '/expenses') ||
    is('POST', '/services')
  )
    return ['register.updated'];
  return [];
}
