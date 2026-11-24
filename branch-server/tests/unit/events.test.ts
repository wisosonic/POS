import { describe, it, expect } from 'vitest';
import { EventBus, eventsFor } from '../../src/events/bus';

// Live updates (docs/06 `GET /events`): which finished requests tell the tills, and how the bus behaves.
describe('which requests cause which events', () => {
  it('a completed sale tells everyone about the sale and the stock; a replay or a refusal tells nobody', () => {
    expect(eventsFor('POST', '/sales', 201)).toEqual(['sale.completed', 'stock.changed']);
    expect(eventsFor('POST', '/sales', 200)).toEqual([]); // an Idempotent-Replay: nothing new happened
    expect(eventsFor('POST', '/sales', 422)).toEqual([]);
    expect(eventsFor('POST', '/sales', 409)).toEqual([]);
  });

  it('a void, a delete and a return move stock and a register', () => {
    expect(eventsFor('POST', '/sales/:id/void', 200)).toEqual(['stock.changed', 'register.updated']);
    expect(eventsFor('POST', '/sales/:id/delete', 200)).toEqual(['stock.changed', 'register.updated']);
    expect(eventsFor('POST', '/returns', 201)).toEqual(['stock.changed', 'register.updated']);
    expect(eventsFor('POST', '/returns', 200)).toEqual([]);
  });

  it('stock changes: purchases (and the cost they may move), adjustments, a finished stocktake', () => {
    expect(eventsFor('POST', '/purchases/:id/receive', 200)).toEqual(['stock.changed', 'catalog.changed']);
    expect(eventsFor('POST', '/stock/adjustments', 201)).toEqual(['stock.changed']);
    expect(eventsFor('POST', '/stocktakes/:id/commit', 200)).toEqual(['stock.changed']);
  });

  it('the catalog changes when a product is added, edited, merged, imported or given a picture', () => {
    for (const [m, r, s] of [
      ['POST', '/products', 201],
      ['PATCH', '/products/:id', 200],
      ['POST', '/products/merge', 200],
      ['POST', '/products/import', 200],
      ['POST', '/products/:id/image', 200],
      ['DELETE', '/products/:id/image', 204],
    ] as const)
      expect(eventsFor(m, r, s), `${m} ${r}`).toEqual(['catalog.changed']);
  });

  it('the rate, the shop settings and the registers have their own events', () => {
    expect(eventsFor('POST', '/exchange-rates', 201)).toEqual(['rate.changed']);
    expect(eventsFor('PATCH', '/settings', 200)).toEqual(['settings.changed']);
    for (const [r, s] of [
      ['/registers/open', 201],
      ['/registers/:id/close', 200],
      ['/registers/:id/cash-movements', 201],
      ['/customers/:id/payments', 201],
      ['/expenses', 201],
      ['/services', 201],
    ] as const)
      expect(eventsFor('POST', r, s), r).toEqual(['register.updated']);
  });

  it('reading changes nothing, and neither does anything unknown', () => {
    for (const [m, r] of [
      ['GET', '/sales'],
      ['GET', '/products/sync'],
      ['GET', '/events'],
      ['GET', '/products/:id/image'],
      ['POST', '/auth/login'],
      ['POST', '/something-new'],
    ] as const)
      expect(eventsFor(m, r, 200), `${m} ${r}`).toEqual([]);
  });
});

describe('the event bus', () => {
  it('tells every listener, with the type and a time and nothing else', () => {
    const bus = new EventBus();
    const a: unknown[] = [];
    const b: unknown[] = [];
    bus.subscribe((e) => a.push(e));
    bus.subscribe((e) => b.push(e));
    bus.publish('rate.changed');
    expect(a).toHaveLength(1);
    expect(a[0]).toEqual(b[0]);
    expect(Object.keys(a[0] as object).sort()).toEqual(['at', 'type']);
  });

  it('stops telling a listener that has unsubscribed', () => {
    const bus = new EventBus();
    const seen: unknown[] = [];
    const stop = bus.subscribe((e) => seen.push(e));
    bus.publish('stock.changed');
    stop();
    bus.publish('stock.changed');
    expect(seen).toHaveLength(1);
    expect(bus.size).toBe(0);
  });

  it('a listener that throws (a dead connection) is dropped and never stops the others or the caller', () => {
    const bus = new EventBus();
    const seen: unknown[] = [];
    bus.subscribe(() => {
      throw new Error('socket closed');
    });
    bus.subscribe((e) => seen.push(e));
    expect(() => bus.publish('catalog.changed')).not.toThrow();
    expect(seen).toHaveLength(1);
    expect(bus.size).toBe(1);
  });
});
