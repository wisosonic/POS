import { ApiError, post } from './api';
import { indexedDbKV, type KV } from './kv';

// Sales that could not reach the server wait here, on this computer, and are sent when it answers again (US-10).
// A sale carries its own Idempotency-Key, so sending it twice (a flaky connection, a retry after a crash) is harmless:
// the server recognises it and records it once.

export type Queued = {
  /** Also the clientSaleId and the Idempotency-Key. */
  id: string;
  body: unknown;
  createdAt: string;
  attempts: number;
  /** Set when the server refused the sale (a price changed, the register closed). It stays until a person deals with it. */
  blocked?: { code: string; detail: string };
};

export type FlushResult = { sent: number; blocked: number; waiting: number };

export class Outbox {
  private items: Queued[] | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();

  constructor(
    private readonly kv: KV,
    private readonly send: (item: Queued) => Promise<void>,
  ) {}

  /** Run `fn` after everything queued before it, so reads and writes never interleave. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => undefined);
    return next;
  }

  private async load(): Promise<Queued[]> {
    return (this.items ??= (await this.kv.get<Queued[]>('outbox')) ?? []);
  }
  private async save(items: Queued[]) {
    this.items = items;
    await this.kv.set('outbox', items);
    this.listeners.forEach((l) => l());
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  list(): Promise<Queued[]> {
    return this.exclusive(async () => [...(await this.load())]);
  }

  /** How many are still waiting to be sent, and how many the server refused. */
  async counts(): Promise<{ waiting: number; blocked: number }> {
    const all = await this.list();
    return { waiting: all.filter((i) => !i.blocked).length, blocked: all.filter((i) => i.blocked).length };
  }

  add(id: string, body: unknown): Promise<void> {
    return this.exclusive(async () => {
      const items = await this.load();
      if (items.some((i) => i.id === id)) return; // already queued
      await this.save([...items, { id, body, createdAt: new Date().toISOString(), attempts: 0 }]);
    });
  }

  /**
   * Put a refused sale back in the queue, once a person has dealt with the reason (reopened the register, say). The next flush
   * sends it. If the server still refuses it, it is blocked again with the new reason.
   */
  retry(id: string): Promise<void> {
    return this.exclusive(async () =>
      this.save(
        (await this.load()).map((i) =>
          i.id === id && i.blocked ? { id: i.id, body: i.body, createdAt: i.createdAt, attempts: i.attempts } : i,
        ),
      ),
    );
  }

  /** Throw away a sale the server refused, once a person has looked at it. */
  discard(id: string): Promise<void> {
    return this.exclusive(async () => this.save((await this.load()).filter((i) => i.id !== id)));
  }

  /**
   * Send everything waiting, oldest first. A network failure or a server error stops the run (still offline: try again
   * later). A refusal marks that one sale as blocked and carries on with the rest.
   */
  flush(): Promise<FlushResult> {
    return this.exclusive(async () => {
      let sent = 0;
      let blocked = 0;
      let items = [...(await this.load())];
      for (const item of items.filter((i) => !i.blocked)) {
        try {
          await this.send(item);
          items = items.filter((i) => i.id !== item.id);
          sent++;
          await this.save(items);
        } catch (e) {
          if (!(e instanceof ApiError) || e.isNetwork || e.status >= 500) {
            items = items.map((i) => (i.id === item.id ? { ...i, attempts: i.attempts + 1 } : i));
            await this.save(items);
            break;
          }
          items = items.map((i) =>
            i.id === item.id ? { ...i, attempts: i.attempts + 1, blocked: { code: e.code, detail: e.message } } : i,
          );
          blocked++;
          await this.save(items);
        }
      }
      return { sent, blocked, waiting: items.filter((i) => !i.blocked).length };
    });
  }
}

/** The till's outbox: kept on this computer, sending to POST /sales. */
export const outbox = new Outbox(indexedDbKV('till-outbox'), (item) =>
  post('/sales', item.body, { idempotencyKey: item.id }).then(() => undefined),
);
