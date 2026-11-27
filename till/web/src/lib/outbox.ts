import { ApiError, post } from './api';
import { indexedDbKV, type KV } from './kv';
import { tillJournalKV, usesTillJournal } from './journal';

// The sale in doubt (US-10, docs/14 §4.3). A sale is written down BEFORE it is sent and removed when the server has answered, so one
// that never got an answer (the link dropped, the page closed, the PC restarted) is still here and is sent again by itself.
// A sale carries its own Idempotency-Key, so sending it twice (a flaky connection, a retry after a crash) is harmless:
// the server recognises it and records it once. This is not an offline queue: selling stops while the server is away, and a new
// sale is not taken while one is still unconfirmed.

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
  /** Sales the screen is sending itself at this moment (memory only, on purpose: see `add`). */
  private active = new Set<string>();

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

  /**
   * Write a sale down. With `active` the screen is sending it right now and will say how it went (`release`): the re-send loop leaves it
   * alone until then, so the same sale is not sent twice at once. After a restart nothing is active, so an entry that was never settled
   * is picked up and sent again with its own key.
   */
  add(id: string, body: unknown, opts: { active?: boolean } = {}): Promise<void> {
    return this.exclusive(async () => {
      if (opts.active) this.active.add(id);
      const items = await this.load();
      if (items.some((i) => i.id === id)) return; // already queued
      await this.save([...items, { id, body, createdAt: new Date().toISOString(), attempts: 0 }]);
    });
  }

  /** The screen has its answer for this sale (or gave up waiting): the re-send loop may take it from here. */
  release(id: string): void {
    this.active.delete(id);
  }

  /** Take in entries kept somewhere else (the old browser queue), keeping their time, tries and reason. Ones already here are left. */
  adopt(entries: Queued[]): Promise<number> {
    return this.exclusive(async () => {
      const items = await this.load();
      const fresh = entries.filter((e) => e && typeof e.id === 'string' && !items.some((i) => i.id === e.id));
      if (fresh.length) await this.save([...items, ...fresh]);
      return fresh.length;
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
      for (const item of items.filter((i) => !i.blocked && !this.active.has(i.id))) {
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

/** The till's sale journal (the sales in doubt): kept on the till PC's disk when there is a till program, sending to POST /sales. */
export const outbox = new Outbox(tillJournalKV(), (item) => post('/sales', item.body, { idempotencyKey: item.id }).then(() => undefined));

/**
 * The first time a till starts after the upgrade, sales left in the browser's old queue (IndexedDB `till-outbox`) are taken into the
 * journal and only then removed from the old place: they are never dropped, and each still goes with its own key. Returns how many.
 */
export async function adoptOldBrowserQueue(
  target: Outbox = outbox,
  old: KV = indexedDbKV('till-outbox'),
  usesTill: () => Promise<boolean> = usesTillJournal,
): Promise<number> {
  if (!(await usesTill())) return 0;
  const items = (await old.get<Queued[]>('outbox')) ?? [];
  if (items.length === 0) return 0;
  const adopted = await target.adopt(items);
  await old.delete('outbox'); // after they are safely in the journal
  return adopted;
}
