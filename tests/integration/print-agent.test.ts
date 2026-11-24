import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startCtx, type TestCtx } from '../helpers/app';
import { runAgent } from '../../apps/till-agent/src/agent';
import type { ReceiptPrinter } from '../../apps/api/src/modules/printing/driver';

// The print agent (docs/11-multi-branch.md §3.4, US-06): when the server is not on the till PC, receipts are queued for a small program on
// the till PC. The server still decides duplicate and drawer; only a print the agent confirms is audited as `sale.print`.
const serverPrints: Uint8Array[] = [];
const serverPrinter: ReceiptPrinter = {
  async print(bytes) {
    serverPrints.push(bytes);
  },
};

let c: TestCtx;
let cashier: string;
let admin: string;
let agentToken = '';
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const agentHeader = () => ({ 'X-Agent-Token': agentToken });
const hasDrawerPulse = (b: Buffer) => b.some((v, i) => v === 0x1b && b[i + 1] === 0x70);

const sell = () => c.http.post(`${api}/sales`).set(auth(cashier)).set('Idempotency-Key', randomUUID()).send(c.newSaleBody());
const print = (saleId: number, body: Record<string, unknown> = {}) =>
  c.http.post(`${api}/sales/${saleId}/print`).set(auth(cashier)).send(body);
const jobs = (wait = 0) => c.http.get(`${api}/agent/jobs?wait=${wait}`).set(agentHeader());
const result = (id: number, ok: boolean, error?: string) =>
  c.http.post(`${api}/agent/jobs/${id}/result`).set(agentHeader()).send({ ok, error });
const printAudits = async (saleId: number) =>
  (await c.http.get(`${api}/audit?entity=sale&entityId=${saleId}&action=sale.print`).set(auth(admin))).body.data as {
    after: Record<string, unknown>;
  }[];

beforeAll(async () => {
  c = await startCtx({ printer: serverPrinter });
  cashier = await c.login('cashier');
  admin = await c.login('admin');
  await c.openRegister(cashier);
});
afterAll(() => c.close());

describe('setting the agent up', () => {
  it('without a token the agent routes answer 401, and a wrong one too', async () => {
    expect((await c.http.get(`${api}/agent/jobs`)).status).toBe(401);
    const wrong = await c.http.get(`${api}/agent/jobs`).set({ 'X-Agent-Token': 'nope' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('AGENT_UNKNOWN');
    // a user's sign-in is not an agent's: it opens nothing here
    expect((await c.http.get(`${api}/agent/jobs`).set(auth(admin))).status).toBe(401);
  });

  it('only an admin asks for an agent code; a wrong code is refused', async () => {
    expect((await c.http.post(`${api}/terminals/1/agent-code`).set(auth(cashier))).status).toBe(403);
    const bad = await c.http.post(`${api}/agent/enrol`).send({ code: 'AAAAA-BBBBB' });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('ENROL_CODE_INVALID');
  });

  it('trades a one-time code for the agent token, once; a till code cannot enrol an agent', async () => {
    const tillCode = (await c.http.post(`${api}/terminals/1/enrol-code`).set(auth(admin))).body.enrolCode as string;
    expect((await c.http.post(`${api}/agent/enrol`).send({ code: tillCode })).status).toBe(422); // separate credentials

    const code = await c.http.post(`${api}/terminals/1/agent-code`).set(auth(admin));
    expect(code.status).toBe(200);
    expect(code.body.agentCode).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    const done = await c.http.post(`${api}/agent/enrol`).send({ code: code.body.agentCode });
    expect(done.status).toBe(200);
    expect(done.body.terminal).toEqual({ code: 'T1', name: 'Till 1' });
    agentToken = done.body.token;
    expect(agentToken.length).toBeGreaterThan(30);
    expect((await c.http.post(`${api}/agent/enrol`).send({ code: code.body.agentCode })).status).toBe(422); // single use
    expect((await jobs()).status).toBe(200);
  });

  it('the terminal list shows the print mode and whether the agent is there, never a code or token', async () => {
    const list = (await c.http.get(`${api}/terminals`).set(auth(admin))).body.data[0];
    expect(list.printMode).toBe('server');
    expect(list.agent).toMatchObject({ enrolled: true, pending: false, online: true });
    expect(JSON.stringify(list)).not.toContain(agentToken);
  });

  it('switching the till to the agent: only an admin, only a real mode', async () => {
    expect((await c.http.patch(`${api}/terminals/1`).set(auth(cashier)).send({ printMode: 'agent' })).status).toBe(403);
    expect((await c.http.patch(`${api}/terminals/1`).set(auth(admin)).send({ printMode: 'laser' })).status).toBe(400);
    const ok = await c.http.patch(`${api}/terminals/1`).set(auth(admin)).send({ printMode: 'agent' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.printMode).toBe('agent');
    expect((await c.http.get(`${api}/terminals/me`).set(auth(cashier))).body.printMode).toBe('agent');
  });
});

describe('printing through the agent', () => {
  it('queues the receipt (202) instead of printing on the server, and the agent receives its bytes', async () => {
    serverPrints.length = 0;
    const s = await sell();
    const res = await print(s.body.id);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ queued: true, copies: 1, duplicate: false });
    expect(serverPrints).toHaveLength(0); // the server's own printer was not used

    const got = (await jobs()).body.jobs as { id: number; saleId: number; duplicate: boolean; drawer: boolean; bytes: string }[];
    expect(got).toHaveLength(1);
    const bytes = Buffer.from(got[0]!.bytes, 'base64');
    expect([bytes[0], bytes[1]]).toEqual([0x1b, 0x40]); // ESC @: a real ESC/POS receipt
    expect(bytes.toString('latin1')).toContain(`Receipt #${s.body.ref}`);
    expect(got[0]).toMatchObject({ saleId: s.body.id, duplicate: false, drawer: true });
    expect(hasDrawerPulse(bytes)).toBe(true);
  });

  it('is audited only when the agent says it printed, and then a second print is a duplicate that never opens the drawer', async () => {
    const s = await sell();
    const queued = await print(s.body.id);
    const job = ((await jobs()).body.jobs as { id: number }[])[0]!;
    expect(await printAudits(s.body.id)).toHaveLength(0); // queued is not printed

    expect((await result(job.id, true)).body.status).toBe('printed');
    const audits = await printAudits(s.body.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.after).toMatchObject({ duplicate: false, drawer: true, via: 'agent' });
    expect((await result(job.id, true)).body.status).toBe('printed'); // saying it twice changes nothing
    expect(await printAudits(s.body.id)).toHaveLength(1);
    expect((await c.http.get(`${api}/print-jobs/${queued.body.jobId}`).set(auth(cashier))).body.status).toBe('printed');

    const again = await print(s.body.id);
    expect(again.body.duplicate).toBe(true);
    const dup = ((await jobs()).body.jobs as { duplicate: boolean; drawer: boolean; bytes: string }[])[0]!;
    expect(dup).toMatchObject({ duplicate: true, drawer: false });
    expect(hasDrawerPulse(Buffer.from(dup.bytes, 'base64'))).toBe(false);
  });

  it('a second click while the first is still queued is a duplicate, not a second original that opens the drawer again', async () => {
    const s = await sell();
    await print(s.body.id);
    const second = await print(s.body.id);
    expect(second.body.duplicate).toBe(true);
    const got = (await jobs()).body.jobs as { id: number; duplicate: boolean; drawer: boolean }[];
    expect(got.map((j) => [j.duplicate, j.drawer])).toEqual([
      [false, true],
      [true, false],
    ]);
    for (const j of got) await result(j.id, true);
  });

  it('copies are separate jobs in order; only the first may open the drawer', async () => {
    const s = await sell();
    const res = await print(s.body.id, { copies: 3 });
    expect(res.body.jobIds).toHaveLength(3);
    const got = (await jobs()).body.jobs as { id: number; drawer: boolean }[];
    expect(got.map((j) => j.drawer)).toEqual([true, false, false]);
    for (const j of got) await result(j.id, true);
  });

  it('a failed print is reported, is not audited, and the next print of that sale is still the original', async () => {
    const s = await sell();
    const queued = await print(s.body.id);
    const job = ((await jobs()).body.jobs as { id: number }[])[0]!;
    expect((await result(job.id, false, 'Printer is out of paper')).body.status).toBe('failed');
    const status = (await c.http.get(`${api}/print-jobs/${queued.body.jobId}`).set(auth(cashier))).body;
    expect(status).toEqual({ status: 'failed', error: 'Printer is out of paper' });
    expect(await printAudits(s.body.id)).toHaveLength(0);

    const retry = await print(s.body.id);
    expect(retry.body.duplicate).toBe(false); // nothing reached the printer yet
    const next = ((await jobs()).body.jobs as { id: number; drawer: boolean }[])[0]!;
    expect(next.drawer).toBe(true);
    await result(next.id, true);
  });

  it('the till can cancel a job nobody picked up, so it cannot print later on top of a browser print', async () => {
    const s = await sell();
    const queued = await print(s.body.id);
    const cancelled = await c.http.post(`${api}/print-jobs/${queued.body.jobId}/cancel`).set(auth(cashier));
    expect(cancelled.body.status).toBe('cancelled');
    expect((await jobs()).body.jobs).toEqual([]);
  });

  it('a job already handed to the agent cannot be cancelled any more', async () => {
    const s = await sell();
    const queued = await print(s.body.id);
    const job = ((await jobs()).body.jobs as { id: number }[])[0]!;
    expect((await c.http.post(`${api}/print-jobs/${queued.body.jobId}/cancel`).set(auth(cashier))).body.status).toBe('sent');
    await result(job.id, true);
  });

  it('long poll: a request waiting for work is answered the moment a receipt is queued', async () => {
    const s = await sell();
    const started = Date.now();
    const waiting = jobs(10);
    const pending = new Promise<void>((r) => setTimeout(r, 300)).then(() => print(s.body.id));
    const [answer] = await Promise.all([waiting, pending]);
    expect((answer.body.jobs as unknown[]).length).toBe(1);
    expect(Date.now() - started).toBeLessThan(5000); // not the full 10 seconds
    await result((answer.body.jobs as { id: number }[])[0]!.id, true);
  });

  it('a long poll with nothing to do ends empty when its time is up', async () => {
    const started = Date.now();
    const res = await jobs(1);
    expect(res.body.jobs).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('REGRESSION: an agent that hangs up while waiting does not take the next receipt with it', async () => {
    // A wait that outlived its client used to wake on the next job, claim it and write to a closed socket: the receipt vanished
    // until its lease ran out. The server must notice the hang-up and let the next (live) request have the job.
    const hangUp = new AbortController();
    const gone = fetch(`${c.url}${api}/agent/jobs?wait=20`, { headers: agentHeader(), signal: hangUp.signal }).catch(() => null);
    await new Promise((r) => setTimeout(r, 200));
    hangUp.abort();
    await gone;
    await new Promise((r) => setTimeout(r, 200));

    const s = await sell();
    await print(s.body.id);
    const got = (await jobs()).body.jobs as { id: number }[];
    expect(got).toHaveLength(1);
    await result(got[0]!.id, true);
  });

  it('refuses a wait longer than the server allows', async () => {
    expect((await jobs(999)).status).toBe(400);
  });
});

describe('a real agent against the server', () => {
  const run = (printer: ReceiptPrinter, signal: AbortSignal) =>
    runAgent({ server: c.url, token: agentToken, printerName: 'Test printer', printer, waitSeconds: 2, backoffMs: [50, 200] }, signal);
  const until = async (check: () => Promise<boolean>, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };

  it('prints what the server queues and reports it: the till sees "printed" and the audit row appears', async () => {
    const got: Buffer[] = [];
    const stop = new AbortController();
    const running = run({ print: async (b) => void got.push(Buffer.from(b)) }, stop.signal);
    const s = await sell();
    const queued = await print(s.body.id);
    const printed = await until(
      async () => (await c.http.get(`${api}/print-jobs/${queued.body.jobId}`).set(auth(cashier))).body.status === 'printed',
    );
    stop.abort();
    await running;
    expect(printed).toBe(true);
    expect(got).toHaveLength(1);
    expect(got[0]!.toString('latin1')).toContain(`Receipt #${s.body.ref}`);
    expect(hasDrawerPulse(got[0]!)).toBe(true);
    expect(await printAudits(s.body.id)).toHaveLength(1);
  });

  it('reports a printer that fails, with the reason, and keeps going', async () => {
    const stop = new AbortController();
    const running = run(
      {
        print: async () => {
          throw new Error('Printer is offline');
        },
      },
      stop.signal,
    );
    const s = await sell();
    const queued = await print(s.body.id);
    const failed = await until(
      async () => (await c.http.get(`${api}/print-jobs/${queued.body.jobId}`).set(auth(cashier))).body.status === 'failed',
    );
    stop.abort();
    await running;
    expect(failed).toBe(true);
    expect((await c.http.get(`${api}/print-jobs/${queued.body.jobId}`).set(auth(cashier))).body.error).toBe('Printer is offline');
  });

  it('stops with a clear error when the server no longer accepts it (revoked), instead of retrying for ever', async () => {
    expect((await c.http.post(`${api}/terminals/1/agent-revoke`).set(auth(admin))).status).toBe(204);
    expect((await jobs()).status).toBe(401);
    await expect(run({ print: async () => undefined }, new AbortController().signal)).rejects.toThrow(/does not accept this print agent/);
  });
});

describe('shutting the server down', () => {
  it('does not wait out a print agent that is holding a long poll open', async () => {
    const own = await startCtx();
    const owner = await own.login('admin');
    const code = (await own.http.post(`${api}/terminals/1/agent-code`).set(auth(owner))).body.agentCode as string;
    const token = (await own.http.post(`${api}/agent/enrol`).send({ code })).body.token as string;
    const waiting = fetch(`${own.url}${api}/agent/jobs?wait=25`, { headers: { 'X-Agent-Token': token } }).catch(() => null);
    await new Promise((r) => setTimeout(r, 300)); // the agent is now waiting for work
    const started = Date.now();
    await own.close();
    expect(Date.now() - started).toBeLessThan(3000); // not the 25 seconds the agent asked to wait
    await waiting;
  }, 15_000);
});
