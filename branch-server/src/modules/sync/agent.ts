import type { Database } from '../../db/adapter';
import { nowIso } from '../../util/time';
import { pingHq } from './hqClient';
import type { PullOutcome } from './down';
import type { PushOutcome } from './up';
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
  /** Send the next batch of this branch's records to HQ (modules/sync/up.ts). Called again and again while it says there is more. */
  push?: (link: Link, signal: AbortSignal) => Promise<PushOutcome>;
  /** Fetch and apply the next page of what HQ owns (modules/sync/down.ts). Called again and again while it says there is more. */
  pull?: (link: Link, signal: AbortSignal) => Promise<PullOutcome>;
  /** HQ's changes were applied: which tables changed (so the screens can be told). */
  onPulled?: (tables: string[]) => void;
  /** How often to ask while HQ is answering (docs/14 §6: 5 s). */
  intervalMs?: number;
  /** Pull HQ's changes even when the ping says nothing is new, this often (the safety net; 60 s). */
  safetyPullMs?: number;
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
  private nudged = false;
  private moreWaiting = false;
  private lastPull = 0;

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

  /** Something worth sending happened (a sale): look soon, after a short pause so a burst of sales travels together. */
  nudgeSoon(): void {
    this.nudged = true;
    this.wake?.();
  }

  private set(state: SyncState, lastError: string | null = null): boolean {
    const changed = this.current.state !== state || this.current.lastError !== lastError;
    if (this.current.state !== state) this.current = { state, since: nowIso(), lastError };
    else this.current = { ...this.current, lastError };
    if (changed) this.opts.onChange?.();
    return changed;
  }

  /**
   * Send batches until nothing is left, or a fair number (so a long backlog does not starve the "are you there?"). Returns what went wrong,
   * or null. A failure is NOT cleared from the outbox: the same batch is simply tried again.
   */
  private async drain(link: Link, changeSeq: number | undefined): Promise<{ error: string; refused?: boolean } | null> {
    // First what HQ has for us (a new exchange rate matters before the next sale), then what we have for HQ.
    // HQ's ping says how far its change log is: ask for changes only when it is ahead of what was applied (or HQ did not say, or the
    // safety interval has passed, or the last round left more).
    let pull = this.opts.pull;
    if (pull) {
      const cursor =
        (await this.opts.db.one<{ down_cursor: number }>('SELECT down_cursor FROM sync_control WHERE id = 1'))?.down_cursor ?? 0;
      const due = Date.now() - this.lastPull >= (this.opts.safetyPullMs ?? 60_000);
      if (changeSeq !== undefined && changeSeq <= cursor && !due) pull = undefined;
      else this.lastPull = Date.now();
    }
    for (let i = 0; pull && i < 40; i++) {
      if (this.abort.signal.aborted) return null;
      const r = await pull(link, this.abort.signal);
      if ('error' in r) return r;
      if (r.changed.length > 0) this.opts.onPulled?.(r.changed);
      if (!r.more) break;
      if (i === 39) this.moreWaiting = true;
    }
    const push = this.opts.push;
    if (!push) return null;
    for (let i = 0; i < 40; i++) {
      if (this.abort.signal.aborted) return null;
      const r = await push(link, this.abort.signal);
      if ('error' in r) return r;
      if (!r.more) return null;
    }
    this.moreWaiting = true;
    return null;
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
    const interval = this.opts.intervalMs ?? 5_000;
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
          if (!wasOnline) {
            this.lastPull = 0; // a first or renewed connection always pulls
            await this.opts.onReconnect?.(link);
          }
          // Send what is waiting: first what changed, then the history from before this branch connected.
          const failed = await this.drain(link, result.changeSeq);
          if (failed?.refused) {
            this.set('refused', failed.error);
            await db.tx((tx) => recordError(tx, failed.error));
            await this.sleep(this.opts.refusedRetryMs ?? 60_000);
          } else if (failed) {
            this.set('offline', failed.error);
            await db.tx((tx) => recordError(tx, failed.error));
            await this.sleep(delay);
            delay = Math.min(delay * 2, maxDelay);
          } else if (this.moreWaiting) {
            this.moreWaiting = false; // plenty left: take a breath (so a ping and a sale can get in) and carry on at once
            await this.sleep(0);
          } else {
            await this.sleep(interval);
            // Woken early by a sale: give a burst of them a moment, so they travel together.
            if (this.nudged) {
              this.nudged = false;
              await this.sleep(250);
            }
          }
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
