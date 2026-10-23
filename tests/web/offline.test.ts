import { describe, it, expect, beforeEach } from 'vitest';
import { ApiError } from '../../apps/web/src/lib/api';
import { Catalog } from '../../apps/web/src/lib/catalog';
import { memoryKV } from '../../apps/web/src/lib/kv';
import { Outbox, type Queued } from '../../apps/web/src/lib/outbox';
import type { Product } from '../../apps/web/src/lib/types';

const product = (id: number, name: string, barcode: string, over: Partial<Product> = {}): Product => ({
  id,
  name,
  receiptName: null,
  barcode,
  costMinor: 0,
  priceMinor: 1000,
  currency: 'LBP',
  qty: '0',
  unitName: 'Piece',
  fractional: false,
  stockAlert: null,
  active: true,
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('catalog on the till', () => {
  let feeds: { data: Product[]; serverTime: string }[];
  let asked: string[];
  let kv = memoryKV();
  const make = () => new Catalog(kv, async (since) => (asked.push(since), feeds.shift() ?? { data: [], serverTime: since }));

  beforeEach(() => {
    kv = memoryKV();
    asked = [];
    feeds = [
      {
        serverTime: 'T1',
        data: [
          product(1, 'Cedars silver towel', '5287000107945'),
          product(2, 'Crispy chocolate', '9342390005250'),
          product(3, 'خبز كبير', '5287001240016', { receiptName: 'khbz kbyr' }),
          product(4, 'Twin A', '333'),
          product(5, 'Twin B', '333'),
          product(6, 'Master chips BBQ 80g', '5283003303810'),
          product(7, 'BBQ sauce', '111'),
        ],
      },
    ];
  });

  it('finds a product by barcode instantly, once synced', async () => {
    const c = make();
    await c.sync();
    expect(c.byCode('5287000107945').map((p) => p.name)).toEqual(['Cedars silver towel']);
    expect(c.size).toBe(7);
  });

  it('ignores the carriage return a scanner appends, and returns nothing for an unknown code', async () => {
    const c = make();
    await c.sync();
    expect(c.byCode('5287000107945\r\n')).toHaveLength(1);
    expect(c.byCode('0000000000000')).toEqual([]);
  });

  it('returns every product sharing a barcode, so the cashier can choose', async () => {
    const c = make();
    await c.sync();
    expect(
      c
        .byCode('333')
        .map((p) => p.name)
        .sort(),
    ).toEqual(['Twin A', 'Twin B']);
  });

  it('searches by part of a name, case-insensitively', async () => {
    const c = make();
    await c.sync();
    expect(c.search('SILVER tow').map((p) => p.name)).toEqual(['Cedars silver towel']);
  });

  it('searches Arabic names and the English receipt name', async () => {
    const c = make();
    await c.sync();
    expect(c.search('خبز').map((p) => p.id)).toEqual([3]);
    expect(c.search('khbz').map((p) => p.id)).toEqual([3]);
  });

  it('every word must match, in any order', async () => {
    const c = make();
    await c.sync();
    expect(c.search('chips bbq').map((p) => p.id)).toEqual([6]);
    expect(c.search('bbq nothing')).toEqual([]);
  });

  it('puts names that start with the word before names that merely contain it', async () => {
    const c = make();
    await c.sync();
    expect(c.search('bbq').map((p) => p.id)).toEqual([7, 6]); // "BBQ sauce" before "Master chips BBQ 80g"
  });

  it('puts an exact barcode first, and finds by part of a barcode', async () => {
    const c = make();
    await c.sync();
    expect(c.search('5287000107945')[0]!.id).toBe(1);
    expect(c.search('9342390').map((p) => p.id)).toEqual([2]);
  });

  it('limits the number of results, and returns nothing for blank input', async () => {
    const c = make();
    await c.sync();
    expect(c.search('e', 2)).toHaveLength(2);
    expect(c.search('   ')).toEqual([]);
  });

  it('asks the server only for what changed since the last sync', async () => {
    const c = make();
    await c.sync();
    feeds.push({ serverTime: 'T2', data: [product(2, 'Crispy chocolate', '9342390005250', { priceMinor: 55000 })] });
    expect(await c.sync()).toBe(1);
    expect(asked).toEqual(['', 'T1']);
    expect(c.get(2)!.priceMinor).toBe(55000);
    expect(c.size).toBe(7);
  });

  it('removes a product the server has deactivated', async () => {
    const c = make();
    await c.sync();
    feeds.push({ serverTime: 'T2', data: [product(2, 'Crispy chocolate', '9342390005250', { active: false })] });
    await c.sync();
    expect(c.byCode('9342390005250')).toEqual([]);
    expect(c.search('crispy')).toEqual([]);
    expect(c.size).toBe(6);
  });

  it('is usable straight away from the copy saved on this computer, before any network', async () => {
    await make().sync();
    const fresh = make();
    expect(await fresh.loadFromCache()).toBe(true);
    expect(fresh.byCode('5287000107945')).toHaveLength(1);
    expect(fresh.lastSync).toBe('T1');
    expect(asked).toEqual(['']); // the second catalog asked nothing yet
  });

  it('then only asks for what is new since the saved copy', async () => {
    await make().sync();
    const fresh = make();
    await fresh.loadFromCache();
    await fresh.sync();
    expect(asked).toEqual(['', 'T1']);
  });

  it('has nothing to load the very first time', async () => {
    expect(await make().loadFromCache()).toBe(false);
  });

  it('a failed sync leaves the catalog as it was', async () => {
    const c = new Catalog(kv, async () => {
      throw new ApiError(0, 'NETWORK', 'down');
    });
    await expect(c.sync()).rejects.toThrow();
    expect(c.size).toBe(0);
  });

  it('clear forgets the saved copy too', async () => {
    const c = make();
    await c.sync();
    await c.clear();
    expect(c.size).toBe(0);
    expect(await make().loadFromCache()).toBe(false);
  });
});

describe('outbox: sales waiting for the server (US-10)', () => {
  let sent: Queued[];
  let behaviour: (item: Queued) => Promise<void>;
  let kv = memoryKV();
  const make = () => new Outbox(kv, async (item) => (sent.push(item), behaviour(item)));
  const ok = async () => undefined;
  const fail = (e: Error) => async () => {
    throw e;
  };

  beforeEach(() => {
    kv = memoryKV();
    sent = [];
    behaviour = ok;
  });

  it('keeps a sale and counts it as waiting', async () => {
    const box = make();
    await box.add('a', { n: 1 });
    expect(await box.counts()).toEqual({ waiting: 1, blocked: 0 });
    expect((await box.list())[0]).toMatchObject({ id: 'a', attempts: 0, body: { n: 1 } });
  });

  it('sends everything, oldest first, and empties the queue', async () => {
    const box = make();
    await box.add('a', 1);
    await box.add('b', 2);
    await box.add('c', 3);
    expect(await box.flush()).toEqual({ sent: 3, blocked: 0, waiting: 0 });
    expect(sent.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(await box.counts()).toEqual({ waiting: 0, blocked: 0 });
  });

  it('survives a restart: a new outbox on the same storage still has the sales', async () => {
    await make().add('a', 1);
    const afterRestart = make();
    expect(await afterRestart.counts()).toEqual({ waiting: 1, blocked: 0 });
    await afterRestart.flush();
    expect(sent.map((s) => s.id)).toEqual(['a']);
  });

  it('queues the same sale only once, however many times it is added', async () => {
    const box = make();
    await box.add('a', 1);
    await box.add('a', 1);
    expect((await box.list()).length).toBe(1);
  });

  it('while the server is unreachable it stops at the first failure and keeps everything', async () => {
    const box = make();
    await box.add('a', 1);
    await box.add('b', 2);
    behaviour = fail(new ApiError(0, 'NETWORK', 'down'));
    expect(await box.flush()).toEqual({ sent: 0, blocked: 0, waiting: 2 });
    expect(sent.map((s) => s.id)).toEqual(['a']); // did not hammer the second one
    expect((await box.list()).map((i) => i.attempts)).toEqual([1, 0]);
    behaviour = ok;
    expect(await box.flush()).toEqual({ sent: 2, blocked: 0, waiting: 0 });
  });

  it('a server error (5xx) is treated like being offline: keep and retry later', async () => {
    const box = make();
    await box.add('a', 1);
    behaviour = fail(new ApiError(503, 'INTERNAL', 'restarting'));
    expect((await box.flush()).waiting).toBe(1);
  });

  it('a refusal blocks that one sale with the reason, and the rest still go through', async () => {
    const box = make();
    await box.add('a', 1);
    await box.add('b', 2);
    behaviour = async (item) => {
      if (item.id === 'a') throw new ApiError(422, 'PRICE_MISMATCH', 'The price changed');
    };
    expect(await box.flush()).toEqual({ sent: 1, blocked: 1, waiting: 0 });
    const left = await box.list();
    expect(left).toHaveLength(1);
    expect(left[0]!.blocked).toEqual({ code: 'PRICE_MISMATCH', detail: 'The price changed' });
    expect(await box.counts()).toEqual({ waiting: 0, blocked: 1 });
  });

  it('a blocked sale is not retried forever, and can be discarded by a person', async () => {
    const box = make();
    await box.add('a', 1);
    behaviour = fail(new ApiError(409, 'REGISTER_CLOSED', 'closed'));
    await box.flush();
    sent.length = 0;
    behaviour = ok;
    await box.flush();
    expect(sent).toEqual([]);
    await box.discard('a');
    expect(await box.counts()).toEqual({ waiting: 0, blocked: 0 });
  });

  it('a refused sale can be put back for another try, and only that one', async () => {
    const box = make();
    await box.add('a', 1);
    await box.add('b', 2);
    behaviour = fail(new ApiError(409, 'REGISTER_CLOSED', 'closed'));
    await box.flush();
    expect(await box.counts()).toEqual({ waiting: 0, blocked: 2 });

    await box.retry('a');
    expect(await box.counts()).toEqual({ waiting: 1, blocked: 1 });
    sent.length = 0;
    behaviour = ok; // the register is open again
    expect(await box.flush()).toEqual({ sent: 1, blocked: 0, waiting: 0 });
    expect(sent.map((s) => s.id)).toEqual(['a']); // b was not touched
    expect((await box.list()).map((i) => i.id)).toEqual(['b']);
  });

  it('a retried sale that is refused again is blocked again, with the new reason', async () => {
    const box = make();
    await box.add('a', 1);
    behaviour = fail(new ApiError(409, 'REGISTER_CLOSED', 'closed'));
    await box.flush();
    await box.retry('a');
    behaviour = fail(new ApiError(422, 'PRICE_MISMATCH', 'The price changed'));
    await box.flush();
    const [item] = await box.list();
    expect(item!.blocked).toEqual({ code: 'PRICE_MISMATCH', detail: 'The price changed' });
    expect(item!.attempts).toBe(2);
  });

  it('retrying a sale that is not blocked, or that does not exist, changes nothing', async () => {
    const box = make();
    await box.add('a', 1);
    await box.retry('a');
    await box.retry('nope');
    expect(await box.counts()).toEqual({ waiting: 1, blocked: 0 });
    expect((await box.list())[0]!.attempts).toBe(0);
  });

  it('keeps its place in the queue and its original time when retried, so the order of sales is not changed', async () => {
    const box = make();
    await box.add('a', 1);
    await box.add('b', 2);
    const [first] = await box.list();
    behaviour = async (item) => {
      if (item.id === 'a') throw new ApiError(409, 'REGISTER_CLOSED', 'closed');
    };
    await box.flush();
    await box.retry('a');
    const after = await box.list();
    expect(after.find((i) => i.id === 'a')!.createdAt).toBe(first!.createdAt);
  });

  it('two flushes at once send each sale once', async () => {
    const box = make();
    await box.add('a', 1);
    await box.add('b', 2);
    behaviour = () => new Promise((r) => setTimeout(r, 10));
    await Promise.all([box.flush(), box.flush(), box.flush()]);
    expect(sent.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('a sale added while another is being sent is not lost', async () => {
    const box = make();
    await box.add('a', 1);
    behaviour = () => new Promise((r) => setTimeout(r, 20));
    const flushing = box.flush();
    await box.add('b', 2);
    await flushing;
    expect((await box.list()).map((i) => i.id)).toEqual(['b']);
  });

  it('tells listeners whenever the queue changes', async () => {
    const box = make();
    let changes = 0;
    box.subscribe(() => changes++);
    await box.add('a', 1);
    await box.flush();
    expect(changes).toBeGreaterThanOrEqual(2);
  });

  it('sends each sale with its own id, which the server uses to recognise a repeat', async () => {
    const box = make();
    await box.add('7c0f-uuid', { clientSaleId: '7c0f-uuid' });
    await box.flush();
    expect(sent[0]!.id).toBe('7c0f-uuid');
  });
});
