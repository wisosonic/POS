import { describe, it, expect } from 'vitest';
import { AgentRefusedError, runAgent } from '../src/agent';

// The agent's own rules, with a made-up server (no network): it never prints a job twice, it keeps trying while the server is away,
// and it gives up when the server says it is not accepted any more. (The real agent against the real server: tests/integration.)
const job = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  kind: 'receipt',
  saleId: 1,
  duplicate: false,
  drawer: true,
  bytes: Buffer.from('RECEIPT').toString('base64'),
  ...over,
});
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Call = { url: string; method: string; body?: string; token?: string };

/** A scripted server: `polls` are the answers to successive job requests, `results` to the result posts. */
function scripted(polls: (() => Response | Promise<Response>)[], results: (() => Response | Promise<Response>)[] = []) {
  const calls: Call[] = [];
  const stop = new AbortController();
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body as string | undefined,
      token: headers?.['X-Agent-Token'],
    });
    if (String(url).includes('/result')) return (results.shift() ?? (() => json(200, { status: 'printed' })))();
    const next = polls.shift();
    if (!next) {
      stop.abort(); // the script is over
      return json(200, { jobs: [] });
    }
    return next();
  }) as typeof fetch;
  return { calls, stop, fetchImpl };
}

const base = {
  server: 'http://till-server:3000/',
  token: 'secret-agent-token',
  printerName: 'POS-80',
  backoffMs: [1, 4] as [number, number],
  reportRetryMs: 1,
};

describe('the print agent', () => {
  it('prints each job it is given, in order, and reports each one', async () => {
    const printed: string[] = [];
    const s = scripted([() => json(200, { jobs: [job(1), job(2, { drawer: false })] })]);
    await runAgent(
      { ...base, printer: { print: async (b, name) => void printed.push(`${name}:${Buffer.from(b).toString()}`) }, fetchImpl: s.fetchImpl },
      s.stop.signal,
    );
    expect(printed).toEqual(['POS-80:RECEIPT', 'POS-80:RECEIPT']);
    const results = s.calls.filter((c) => c.url.includes('/result'));
    expect(results.map((r) => r.url)).toEqual([
      'http://till-server:3000/api/v1/agent/jobs/1/result',
      'http://till-server:3000/api/v1/agent/jobs/2/result',
    ]);
    expect(results.map((r) => JSON.parse(r.body!))).toEqual([{ ok: true }, { ok: true }]);
  });

  it('sends its own token (never a user sign-in) on every call', async () => {
    const s = scripted([() => json(200, { jobs: [job(1)] })]);
    await runAgent({ ...base, printer: { print: async () => undefined }, fetchImpl: s.fetchImpl }, s.stop.signal);
    expect(s.calls.length).toBeGreaterThan(1);
    expect(s.calls.every((c) => c.token === 'secret-agent-token')).toBe(true);
  });

  it('says so, with the reason, when the printer fails, and carries on with the next job', async () => {
    const printed: number[] = [];
    let n = 0;
    const s = scripted([() => json(200, { jobs: [job(1), job(2)] })]);
    const printer = {
      print: async () => {
        if (++n === 1) throw new Error('Printer is out of paper');
        printed.push(n);
      },
    };
    await runAgent({ ...base, printer, fetchImpl: s.fetchImpl }, s.stop.signal);
    const results = s.calls.filter((c) => c.url.includes('/result')).map((r) => JSON.parse(r.body!));
    expect(results).toEqual([{ ok: false, error: 'Printer is out of paper' }, { ok: true }]);
    expect(printed).toEqual([2]);
  });

  it('never prints the same job twice, even if the server did not hear the answer and offers it again', async () => {
    let prints = 0;
    const s = scripted(
      [() => json(200, { jobs: [job(7)] }), () => json(200, { jobs: [job(7)] })], // offered again
      [() => json(500, {}), () => json(500, {}), () => json(500, {})], // the first answer never gets through (3 tries)
    );
    await runAgent({ ...base, printer: { print: async () => void prints++ }, fetchImpl: s.fetchImpl }, s.stop.signal);
    expect(prints).toBe(1); // the second offer was only reported
    expect(s.calls.filter((c) => c.url.includes('/jobs/7/result')).length).toBeGreaterThanOrEqual(4);
  });

  it('keeps trying, with growing waits, while the server cannot be reached, and prints once it is back', async () => {
    const messages: string[] = [];
    let prints = 0;
    const s = scripted([
      () => {
        throw new TypeError('fetch failed');
      },
      () => json(503, {}),
      () => json(200, { jobs: [job(1)] }),
    ]);
    await runAgent(
      { ...base, printer: { print: async () => void prints++ }, fetchImpl: s.fetchImpl, log: (m) => messages.push(m) },
      s.stop.signal,
    );
    expect(prints).toBe(1);
    expect(messages.filter((m) => m.startsWith('Cannot reach the server'))).toHaveLength(2);
  });

  it('stops for good when the server says it is not accepted (401), instead of retrying', async () => {
    const s = scripted([() => json(401, { code: 'AGENT_UNKNOWN' })]);
    await expect(
      runAgent({ ...base, printer: { print: async () => undefined }, fetchImpl: s.fetchImpl }, s.stop.signal),
    ).rejects.toBeInstanceOf(AgentRefusedError);
    expect(s.calls).toHaveLength(1);
  });

  it('stops when asked to, even in the middle of a wait', async () => {
    const stop = new AbortController();
    const fetchImpl = (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
      )) as typeof fetch;
    const running = runAgent({ ...base, printer: { print: async () => undefined }, fetchImpl }, stop.signal);
    setTimeout(() => stop.abort(), 20);
    await expect(running).resolves.toBeUndefined();
  });

  it('never writes its token into a log line', async () => {
    const messages: string[] = [];
    const s = scripted([
      () => {
        throw new TypeError('fetch failed');
      },
      () => json(200, { jobs: [job(1)] }),
    ]);
    await runAgent(
      { ...base, printer: { print: async () => undefined }, fetchImpl: s.fetchImpl, log: (m) => messages.push(m) },
      s.stop.signal,
    );
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.join('\n')).not.toContain('secret-agent-token');
  });
});
