import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/lib/api';
import { adoptOldBrowserQueue, Outbox, type Queued } from '../src/lib/outbox';
import { memoryKV } from '../src/lib/kv';
import { sellingStoppedNow, useLink } from '../src/store/link';

// docs/14 §4.3: the sale in doubt. Written down before it is sent, kept on the till PC's disk, sent again with its own key, and no
// new sale is taken while one is unconfirmed.

describe('the sale in doubt in the outbox (US-10)', () => {
  let sent: string[];
  const make = (kv = memoryKV()) => new Outbox(kv, async (item) => void sent.push(item.id));
  beforeEach(() => {
    sent = [];
  });

  it('leaves a sale alone while the screen is sending it itself, so it is never sent twice at once', async () => {
    const box = make();
    await box.add('a', { n: 1 }, { active: true });
    expect(await box.flush()).toEqual({ sent: 0, blocked: 0, waiting: 1 });
    expect(sent).toEqual([]);
    box.release('a'); // no answer came: the loop takes it from here
    expect(await box.flush()).toEqual({ sent: 1, blocked: 0, waiting: 0 });
    expect(sent).toEqual(['a']);
  });

  it('counts a sale that is being sent as waiting, so selling pauses at once', async () => {
    const box = make();
    await box.add('a', 1, { active: true });
    expect(await box.counts()).toEqual({ waiting: 1, blocked: 0 });
  });

  it('after a restart nothing is active: an entry that was never settled is sent again with its own key', async () => {
    const kv = memoryKV();
    await make(kv).add('a', { n: 1 }, { active: true }); // the page closed before the answer
    const afterRestart = make(kv);
    expect(await afterRestart.flush()).toEqual({ sent: 1, blocked: 0, waiting: 0 });
    expect(sent).toEqual(['a']);
  });

  it('an answered sale is removed from the journal', async () => {
    const box = make();
    await box.add('a', 1, { active: true });
    await box.discard('a');
    box.release('a');
    expect(await box.counts()).toEqual({ waiting: 0, blocked: 0 });
  });

  it('takes in entries kept elsewhere with their time, tries and reason, and leaves the ones it already has', async () => {
    const box = make();
    await box.add('a', 1);
    const old: Queued[] = [
      { id: 'a', body: 'other', createdAt: '2026-01-01T00:00:00.000Z', attempts: 9 },
      { id: 'b', body: 2, createdAt: '2026-01-01T00:00:01.000Z', attempts: 3, blocked: { code: 'REGISTER_CLOSED', detail: 'closed' } },
    ];
    expect(await box.adopt(old)).toBe(1);
    const all = await box.list();
    expect(all.map((i) => i.id)).toEqual(['a', 'b']);
    expect(all[0]!.body).toBe(1); // the one already here is untouched
    expect(all[1]).toMatchObject({ createdAt: '2026-01-01T00:00:01.000Z', attempts: 3, blocked: { code: 'REGISTER_CLOSED' } });
  });
});

describe('where the journal is kept', () => {
  let stored: unknown[];
  let calls: { method: string; body?: string }[];
  let mode: 'till' | 'none' | 'down';

  beforeEach(() => {
    stored = [];
    calls = [];
    mode = 'till';
    vi.resetModules();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({ method, body: init?.body as string | undefined });
        if (mode === 'down') throw new TypeError('fetch failed');
        if (mode === 'none') return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
        if (method === 'PUT') stored = (JSON.parse(init!.body as string) as { items: unknown[] }).items;
        return new Response(JSON.stringify({ items: stored }), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  // Each test starts from a fresh copy of the module, so "asked once" state does not leak between them.
  const fresh = async () => (await import('../src/lib/journal')).tillJournalKV(memoryKV());

  it('with a till program it reads and writes the till PC’s file, not the browser', async () => {
    const browser = memoryKV();
    const { tillJournalKV: make } = await import('../src/lib/journal');
    const kv = make(browser);
    await kv.set('outbox', [{ id: 'a' }]);
    expect(stored).toEqual([{ id: 'a' }]);
    expect(await kv.get('outbox')).toEqual([{ id: 'a' }]);
    expect(await browser.get('outbox')).toBeUndefined();
  });

  it('delete empties the till PC’s list', async () => {
    const kv = await fresh();
    await kv.set('outbox', [{ id: 'a' }]);
    await kv.delete('outbox');
    expect(stored).toEqual([]);
  });

  it('with no till program (a page served by the branch server itself) it keeps the journal in the browser, as before', async () => {
    mode = 'none';
    const browser = memoryKV();
    const { tillJournalKV: make } = await import('../src/lib/journal');
    const kv = make(browser);
    await kv.set('outbox', [{ id: 'a' }]);
    expect(await browser.get('outbox')).toEqual([{ id: 'a' }]);
    expect(calls.every((c) => c.method === 'GET')).toBe(true); // never wrote to anything that is not a till program
  });

  it('when the till program does not answer it refuses to say the journal is empty, and asks again next time', async () => {
    mode = 'down';
    const kv = await fresh();
    await expect(kv.get('outbox')).rejects.toThrow(/did not answer/);
    await expect(kv.set('outbox', [])).rejects.toThrow();
    mode = 'till';
    stored = [{ id: 'kept' }];
    expect(await kv.get('outbox')).toEqual([{ id: 'kept' }]); // a failure to ask is not remembered as "no till program"
  });

  it('refuses a write the till program did not accept, so a sale that could not be written down is never sent', async () => {
    const kv = await fresh();
    await kv.get('outbox');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 400, headers: { 'content-type': 'application/json' } })),
    );
    await expect(kv.set('outbox', [{ id: 'a' }])).rejects.toThrow(/could not keep/);
  });

  it('sales left in the old browser queue move into the journal, and are removed from the old place only after', async () => {
    const old = memoryKV();
    await old.set('outbox', [{ id: 'x', body: 1, createdAt: '2026-01-01T00:00:00.000Z', attempts: 1 }] satisfies Queued[]);
    const journal = memoryKV();
    const target = new Outbox(journal, async () => undefined);
    expect(await adoptOldBrowserQueue(target, old, async () => true)).toBe(1);
    expect((await target.list()).map((i) => i.id)).toEqual(['x']);
    expect(await old.get('outbox')).toBeUndefined();
  });

  it('does not touch the old queue when there is no till program to keep the journal', async () => {
    const old = memoryKV();
    await old.set('outbox', [{ id: 'x', body: 1, createdAt: 'T', attempts: 0 }] satisfies Queued[]);
    const target = new Outbox(memoryKV(), async () => undefined);
    expect(await adoptOldBrowserQueue(target, old, async () => false)).toBe(0);
    expect(await old.get('outbox')).toHaveLength(1);
  });

  it('keeps the old queue if taking it in fails (never dropped)', async () => {
    const old = memoryKV();
    await old.set('outbox', [{ id: 'x', body: 1, createdAt: 'T', attempts: 0 }] satisfies Queued[]);
    const broken = new Outbox(
      {
        get: async () => undefined,
        set: async () => {
          throw new ApiError(0, 'NETWORK', 'till program down');
        },
        delete: async () => undefined,
      },
      async () => undefined,
    );
    await expect(adoptOldBrowserQueue(broken, old, async () => true)).rejects.toThrow();
    expect(await old.get('outbox')).toHaveLength(1);
  });
});

describe('no new sale while one is unconfirmed', () => {
  beforeEach(() => useLink.setState({ block: null, doubt: 0 }));
  it('is allowed when the link is fine and nothing is waiting', () => {
    expect(sellingStoppedNow()).toBe(false);
  });
  it('is stopped while a sale waits, and allowed again once it is settled', () => {
    useLink.getState().setDoubt(1);
    expect(sellingStoppedNow()).toBe(true);
    useLink.getState().setDoubt(0);
    expect(sellingStoppedNow()).toBe(false);
  });
  it('is stopped while the branch server is away, whatever the journal holds', () => {
    useLink.getState().set({ cause: 'branch', reason: 'TIMEOUT', detail: null });
    expect(sellingStoppedNow()).toBe(true);
  });
});
