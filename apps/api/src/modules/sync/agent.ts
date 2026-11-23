import type { Database } from '../../db/adapter';
import { nowIso } from '../../util/time';
import { pingHq } from './hqClient';
import { getLink, recordError, recordOk, type Link } from './service';

// The branch's sync loop (docs/12-sync-and-hq.md §7). It runs inside the branch server, needs nobody, and never touches the sale path:
// it only asks HQ "are you there?" every few seconds, tracks whether HQ is reachable, and, the moment HQ becomes reachable again after an
// outage (or the first time), calls `onReconnect`, which is where the catch-up in both directions starts (P2b, P2c, P2d).
//
//   unlinked  no HQ is set up: the shop works on its own, as before
//   online    HQ answered the last call
//   offline   HQ or the connection is down: ask again with growing waits (3 s up to 30 s), so the first success is noticed quickly
//   refused   HQ no longer accepts this branch (its token was revoked): asking harder will not help, so it only checks once a minute

export type SyncState = 'unlinked' | 'online' | 'offline' | 'refused';
export type SyncStatus = { state: SyncState; since: string; lastError: string | null };

export type SyncAgentOptions = {
  db: Database;
  /** Called whenever the state changes (so the screens can show it). */
  onChange?: () => void;
  /** HQ has just become reachable (the first time after connecting, or again after an outage). */
  onReconnect?: (link: Link) => Promise<void> | void;
  /** How often to ask while HQ is answering. */
  intervalMs?: number;
  /** The wait after a failed call: starts at the first, doubles up to the second. */
  backoffMs?: [number, number];
  refusedRetryMs?: number;
  /** How long to wait before looking again when there is no link. */
  idleMs?: number;
  fetchImpl?: typeof fetch;
};

export class SyncAgent {
  private current: SyncStatus = { state: 'unlinked', since: nowIso(), lastError: null };
  private running: Promise<void> | null = null;
  private abort = new AbortController();
  private wake: (() => void) | null = null;
  private lastWrite = 0;

  constructor(private readonly opts: SyncAgentOptions) {}

  status(): SyncStatus {
    return this.current;
  }

  start(): void {
    if (this.running) return;
    this.abort = new AbortController();
    this.running = this.loop().finally(() => (this.running = null));
  }

  async stop(): Promise<void> {
    this.abort.abort();
    this.wake?.();
    await this.running;
  }

  /** Something changed (connected, disconnected): look now instead of waiting for the next round. */
  nudge(): void {
    this.wake?.();
  }

  private set(state: SyncState, lastError: string | null = null): boolean {
    const changed = this.current.state !== state || this.current.lastError !== lastError;
    if (this.current.state !== state) this.current = { state, since: nowIso(), lastError };
    else this.current = { ...this.current, lastError };
    if (changed) this.opts.onChange?.();
    return changed;
  }

  /** Wait, but stop waiting at once if the loop is stopped or nudged. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.abort.signal.removeEventListener('abort', done);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.abort.signal.addEventListener('abort', done);
      this.wake = done;
    });
  }

  private async loop(): Promise<void> {
    const { db } = this.opts;
    const [minDelay, maxDelay] = this.opts.backoffMs ?? [3_000, 30_000];
    const interval = this.opts.intervalMs ?? 10_000;
    let delay = minDelay;
    while (!this.abort.signal.aborted) {
      try {
        const link = await getLink(db);
        if (!link) {
          this.set('unlinked');
          delay = minDelay;
          await this.sleep(this.opts.idleMs ?? 2_000);
          continue;
        }
        const result = await pingHq(link.hqUrl, link.token, this.abort.signal, this.opts.fetchImpl);
        if (this.abort.signal.aborted) break;
        if (result.ok) {
          const wasOnline = this.current.state === 'online';
          this.set('online');
          delay = minDelay;
          // Write what we know about the link now and then, not on every ask (a write each 10 seconds forever is noise).
          if (!wasOnline || Date.now() - this.lastWrite > 60_000 || link.lastError) {
            await db.tx((tx) => recordOk(tx));
            this.lastWrite = Date.now();
          }
          if (!wasOnline) await this.opts.onReconnect?.(link);
          await this.sleep(interval);
        } else if (result.refused) {
          this.set('refused', result.error);
          await db.tx((tx) => recordError(tx, result.error));
          await this.sleep(this.opts.refusedRetryMs ?? 60_000);
        } else {
          this.set('offline', result.error);
          if (link.lastError !== result.error) await db.tx((tx) => recordError(tx, result.error));
          await this.sleep(delay);
          delay = Math.min(delay * 2, maxDelay);
        }
      } catch {
        // Whatever went wrong inside the loop (a database busy, a bug), it must not end: look again shortly.
        if (this.abort.signal.aborted) break;
        await this.sleep(minDelay);
      }
    }
  }
}
