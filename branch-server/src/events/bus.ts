// What changed, inside the server (docs/14-connection-and-till-backend.md §3). When something changes that other screens show (a price, the
// stock, the exchange rate, a register), the server publishes an event here. Nothing streams to a screen any more: the till's ping reads
// the per-topic counters that `TopicVersions` keeps from these events, and the sync loop watches them to send a sale up. An event is a
// HINT ("the catalog changed"), never data.

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
  /** Server-side watchers (the ping's counters, the sync loop). Returns the function that stops watching. */
  private readonly taps = new Set<(e: PosEvent) => void>();
  tap(fn: (e: PosEvent) => void): () => void {
    this.taps.add(fn);
    return () => void this.taps.delete(fn);
  }

  /** Tell every watcher. A watcher that throws never stops the others, and never affects the request that caused it. */
  publish(type: EventType): void {
    const event: PosEvent = { type, at: new Date().toISOString() };
    for (const fn of [...this.taps]) {
      try {
        fn(event);
      } catch {
        /* a watcher must never affect the request */
      }
    }
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
