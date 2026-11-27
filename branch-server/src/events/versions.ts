import { randomUUID } from 'node:crypto';
import type { EventBus, EventType } from './bus';

// What the till's ping reports (docs/14-connection-and-till-backend.md §3): one number per topic that only ever goes up, raised
// every time the live-update bus publishes the matching event. A till compares each number with the one it last saw and, when
// they differ, fetches that topic. A number, not a timestamp: two edits in one millisecond, or a clock that moves, would fool a
// timestamp. The numbers live in memory: after a restart they start again from 0, which is why the answer also carries `epoch`, a
// random id made when the server starts. A till that sees a new epoch fetches every topic, whatever the numbers say (a restored
// backup is applied at a restart, so a restore changes the epoch too).

export const TOPICS = ['catalog', 'stock', 'rate', 'settings', 'register', 'wallets', 'sync'] as const;
export type Topic = (typeof TOPICS)[number];

/** Which topic an event raises. A completed sale has none of its own: the stock and register events that come with it do the work. */
const TOPIC_OF: Partial<Record<EventType, Topic>> = {
  'catalog.changed': 'catalog',
  'stock.changed': 'stock',
  'rate.changed': 'rate',
  'settings.changed': 'settings',
  'register.updated': 'register',
  'wallet.updated': 'wallets',
  'sync.changed': 'sync',
};

export class TopicVersions {
  readonly epoch = randomUUID();
  private readonly counts: Record<Topic, number> = Object.fromEntries(TOPICS.map((t) => [t, 0])) as Record<Topic, number>;

  /** Count every event the bus publishes, from every source (a request, the sync loop). Uses `tap`: this is not a listening screen. */
  constructor(bus: EventBus) {
    bus.tap((e) => {
      const topic = TOPIC_OF[e.type];
      if (topic) this.counts[topic] += 1;
    });
  }

  snapshot(): Record<Topic, number> {
    return { ...this.counts };
  }
}
