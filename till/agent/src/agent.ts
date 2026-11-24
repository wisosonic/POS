import type { ReceiptPrinter } from './printer';

// The print agent (docs/11-multi-branch.md §3.4): a small program on the till PC that connects OUT to the branch server, asks for this
// terminal's print jobs, prints them on the local USB printer, and says whether each reached the printer. Nothing listens on the
// till PC, the browser needs no special permission, and the server stays in charge of what a receipt says and whether the drawer
// opens. This file has no database and no server code: it only speaks the three agent calls (docs/06-api-spec.md).

export type AgentOptions = {
  /** The branch server, e.g. http://192.168.1.10:3000 */
  server: string;
  /** The agent's own token (from `enrol`). Never logged. */
  token: string;
  /** The printer's Windows queue name on this PC. */
  printerName: string;
  printer: ReceiptPrinter;
  /** Seconds the server may hold a request open waiting for work. */
  waitSeconds?: number;
  /** The wait before telling the server about a job again, doubled each time (default 1000). Short in tests. */
  reportRetryMs?: number;
  /** Wait between retries after the server cannot be reached: starts at the first, doubles up to the second. */
  backoffMs?: [number, number];
  log?: (message: string) => void;
  fetchImpl?: typeof fetch;
};

type Job = { id: number; kind: string; saleId: number | null; duplicate: boolean; drawer: boolean; bytes: string };

/** The server no longer accepts this agent: retrying will not help, someone has to enrol it again. */
export class AgentRefusedError extends Error {
  constructor() {
    super('The server does not accept this print agent any more (revoked or switched off). Ask the admin for a new code and enrol again.');
    this.name = 'AgentRefusedError';
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done);
  });

export async function runAgent(opts: AgentOptions, signal: AbortSignal): Promise<void> {
  const base = opts.server.replace(/\/+$/, '');
  const doFetch = opts.fetchImpl ?? fetch;
  const wait = opts.waitSeconds ?? 25;
  const [minDelay, maxDelay] = opts.backoffMs ?? [2_000, 30_000];
  const log = opts.log ?? (() => undefined);
  const retryBase = opts.reportRetryMs ?? 1_000;
  const headers = { 'X-Agent-Token': opts.token, Accept: 'application/json' };
  // Jobs this agent has printed. If the server never heard the answer it offers the job again; printing it twice would be a second
  // receipt (and a second drawer pulse), so it is only reported again.
  const printed = new Set<number>();
  const remember = (id: number) => {
    printed.add(id);
    if (printed.size > 200) printed.delete(printed.values().next().value as number);
  };

  async function report(id: number, ok: boolean, error?: string): Promise<boolean> {
    for (let attempt = 0; attempt < 3 && !signal.aborted; attempt++) {
      try {
        const res = await doFetch(`${base}/api/v1/agent/jobs/${id}/result`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ok, ...(error ? { error } : {}) }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        });
        if (res.status === 401) throw new AgentRefusedError();
        if (res.ok || res.status === 404) return true; // 404: the job is gone (cleared), nothing more to say
      } catch (e) {
        if (e instanceof AgentRefusedError) throw e;
      }
      await sleep(retryBase * (attempt + 1), signal);
    }
    return false;
  }

  async function handle(job: Job): Promise<void> {
    if (printed.has(job.id)) {
      log(`Job ${job.id} was already printed here; telling the server again.`);
      await report(job.id, true);
      return;
    }
    let ok = true;
    let error: string | undefined;
    try {
      await opts.printer.print(Buffer.from(job.bytes, 'base64'), opts.printerName);
      remember(job.id);
      log(`Printed job ${job.id}${job.drawer ? ' (drawer)' : ''}${job.duplicate ? ' (duplicate)' : ''}.`);
    } catch (e) {
      ok = false;
      error = e instanceof Error ? e.message : String(e);
      log(`Job ${job.id} did not print: ${error}`);
    }
    if (!(await report(job.id, ok, error))) log(`Could not tell the server about job ${job.id}; it will be offered again.`);
  }

  let delay = minDelay;
  while (!signal.aborted) {
    try {
      const res = await doFetch(`${base}/api/v1/agent/jobs?wait=${wait}`, {
        headers,
        signal: AbortSignal.any([signal, AbortSignal.timeout((wait + 15) * 1000)]),
      });
      if (res.status === 401) throw new AgentRefusedError();
      if (!res.ok) throw new Error(`The server answered ${res.status}`);
      const { jobs } = (await res.json()) as { jobs: Job[] };
      delay = minDelay;
      for (const job of jobs) await handle(job); // in order: the first copy (the one that may open the drawer) comes first
    } catch (e) {
      if (signal.aborted) break;
      if (e instanceof AgentRefusedError) throw e;
      log(`Cannot reach the server (${e instanceof Error ? e.message : String(e)}). Trying again in ${Math.round(delay / 1000)} s.`);
      await sleep(delay, signal);
      delay = Math.min(delay * 2, maxDelay);
    }
  }
}
