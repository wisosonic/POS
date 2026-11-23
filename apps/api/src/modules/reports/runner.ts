import { Worker } from 'node:worker_threads';
import { AppError } from '../../errors';
import type { Db } from '../../db/open';
import { runReport, type ReportJob } from './compute';

export type ReportRunnerOptions = {
  databasePath: string;
  /** The server's own connection, used when `worker` is false. */
  db: Db;
  /** Run reports in a worker thread with a read-only connection (default). False runs them on the server's own thread. */
  worker?: boolean;
  /** Flags for the worker. By default it inherits the parent's, which is what lets it load TypeScript under `tsx`. */
  execArgv?: string[];
  /** A report that runs longer than this is abandoned (the worker is replaced). */
  timeoutMs?: number;
};

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout };

/**
 * Runs the heavy reports away from the thread that sells. SQLite is synchronous, so a report that reads five years of sales holds
 * the whole server for as long as it takes (over half a second on a busy shop): every till waits. In a worker with its own read-only
 * connection (WAL lets readers and the writer work at once) the till's thread stays free. The worker starts on first use, is replaced
 * if it crashes or a report overruns, and never writes.
 */
export class ReportRunner {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;

  constructor(private readonly opts: ReportRunnerOptions) {}

  get usesWorker(): boolean {
    return this.opts.worker !== false;
  }

  run<T>(job: ReportJob): Promise<T> {
    if (!this.usesWorker) {
      // Small shops and tests: same code on the server's own connection.
      return Promise.resolve().then(() => runReport(this.opts.db, job) as T);
    }
    if (this.closed) return Promise.reject(new AppError(503, 'REPORTS_UNAVAILABLE', 'The server is shutting down'));
    const worker = this.start();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new AppError(503, 'REPORT_TIMEOUT', 'That report took too long. Try a shorter period.'), worker);
      }, this.opts.timeoutMs ?? 60_000);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      worker.postMessage({ id, job });
    });
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      workerData: { databasePath: this.opts.databasePath },
      ...(this.opts.execArgv ? { execArgv: this.opts.execArgv } : {}),
    });
    worker.on('message', (msg: { id: number; ok: boolean; result?: unknown; error?: string }) => {
      const p = this.pending.get(msg.id);
      if (!p) return; // answered too late: it was already given up on
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new AppError(500, 'REPORT_FAILED', 'The report could not be made'));
    });
    worker.on('error', () => this.fail(new AppError(503, 'REPORT_FAILED', 'The report could not be made. Try again.'), worker));
    worker.on('exit', () => {
      if (this.worker !== worker) return; // one we replaced or closed on purpose: nothing is waiting on it
      // It died with reports waiting (ran out of memory, say): say so now instead of leaving them until the timeout.
      this.fail(new AppError(503, 'REPORT_FAILED', 'The report could not be made. Try again.'), worker);
    });
    this.worker = worker;
    return worker;
  }

  /** Give up on everything waiting on this worker and replace it. */
  private fail(reason: unknown, worker: Worker): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(reason);
      this.pending.delete(id);
    }
    if (this.worker === worker) this.worker = null;
    void worker.terminate();
  }

  async close(): Promise<void> {
    this.closed = true;
    const worker = this.worker;
    this.worker = null;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new AppError(503, 'REPORTS_UNAVAILABLE', 'The server is shutting down'));
      this.pending.delete(id);
    }
    if (worker) await worker.terminate();
  }
}
