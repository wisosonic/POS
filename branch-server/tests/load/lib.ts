import http from 'node:http';
import { performance } from 'node:perf_hooks';

// Building blocks for the load test (tests/load/run.ts). Plain Node, nothing to install.

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ http

const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });

export type Reply = { status: number; headers: http.IncomingHttpHeaders; json: any; text: string }; // eslint-disable-line @typescript-eslint/no-explicit-any -- answers are checked by the caller

export type Target = { host: string; port: number };

/** One request. Never rejects for an HTTP error status: the caller decides what counts as a failure. */
export function call(
  target: Target,
  method: string,
  path: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = http.request(
      {
        agent,
        host: target.host,
        port: target.port,
        method,
        path,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown = null;
          if ((res.headers['content-type'] ?? '').includes('json') && text) {
            try {
              json = JSON.parse(text);
            } catch {
              /* leave null */
            }
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, json, text });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ------------------------------------------------------------------ numbers

/** A small seeded random generator, so two runs with the same seed make the same sales. */
export function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
  };
}

export class Series {
  private readonly samples: number[] = [];
  readonly statuses = new Map<string, number>();
  failures = 0;

  constructor(readonly label: string) {}

  add(ms: number, status: string, ok: boolean) {
    this.samples.push(ms);
    this.statuses.set(status, (this.statuses.get(status) ?? 0) + 1);
    if (!ok) this.failures++;
  }

  get count() {
    return this.samples.length;
  }

  percentile(p: number): number {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
  }

  summary() {
    const sorted = [...this.samples].sort((a, b) => a - b);
    return {
      label: this.label,
      count: this.count,
      failures: this.failures,
      p50: this.percentile(50),
      p95: this.percentile(95),
      p99: this.percentile(99),
      max: sorted[sorted.length - 1] ?? 0,
      statuses: Object.fromEntries(this.statuses),
    };
  }
}

// ------------------------------------------------------------------ load generator

/**
 * Fire requests at a fixed rate whether or not earlier ones have come back (an "open loop"), the way real customers
 * arrive. Each call gets the moment it SHOULD have started, and latency is measured from that moment: if the server
 * falls behind, the queueing shows up in the numbers instead of quietly slowing the test down.
 */
export async function openLoop(rate: number, seconds: number, fire: (index: number, intendedAt: number) => Promise<void>): Promise<void> {
  const interval = 1000 / rate;
  const start = performance.now();
  const pending = new Set<Promise<void>>();
  for (let i = 0; i * interval < seconds * 1000; i++) {
    const intended = start + i * interval;
    const wait = intended - performance.now();
    if (wait > 1) await sleep(wait);
    const p: Promise<void> = fire(i, intended)
      .catch(() => undefined)
      .finally(() => pending.delete(p));
    pending.add(p);
  }
  await Promise.all(pending);
}

/** Time one call from the moment it was due, and record it. */
export async function timed(
  series: Series,
  intendedAt: number,
  run: () => Promise<Reply>,
  ok: (r: Reply) => boolean,
): Promise<Reply | null> {
  try {
    const reply = await run();
    series.add(performance.now() - intendedAt, String(reply.status), ok(reply));
    return reply;
  } catch (err) {
    series.add(performance.now() - intendedAt, `error:${(err as NodeJS.ErrnoException).code ?? 'unknown'}`, false);
    return null;
  }
}
