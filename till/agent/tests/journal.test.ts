import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkJournalItems, MAX_JOURNAL_ITEMS, openJournal } from '../src/journal';
import { createTillServer } from '../src/tillServer';

// docs/14 §4.3: the sale in doubt is kept on the till PC's disk, so it survives a closed page or a restart. The till program only keeps
// the list; the screen sends the sale again with the same key.

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'till-journal-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sale = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  body: { clientSaleId: id, items: [{ productId: 1, qty: '1', unitPriceLbp: 75000 }] },
  createdAt: '2026-11-27T09:00:00.000Z',
  attempts: 0,
  ...extra,
});

describe('the journal file (US-10)', () => {
  it('starts empty', () => {
    const j = openJournal(join(dir, 'journal.db'));
    expect(j.list()).toEqual([]);
    j.close();
  });

  it('keeps what it is given, in order, and still has it after the program is closed and opened again', () => {
    const file = join(dir, 'journal.db');
    const first = openJournal(file);
    first.replace([sale('a'), sale('b', { attempts: 2, blocked: { code: 'REGISTER_CLOSED', detail: 'closed' } })]);
    first.close();
    const again = openJournal(file);
    expect(again.list()).toEqual([sale('a'), sale('b', { attempts: 2, blocked: { code: 'REGISTER_CLOSED', detail: 'closed' } })]);
    again.close();
  });

  it('replaces the whole list, so removing an answered sale is just writing the list without it', () => {
    const j = openJournal(join(dir, 'journal.db'));
    j.replace([sale('a'), sale('b')]);
    j.replace([sale('b')]);
    expect(j.list().map((i) => (i as { id: string }).id)).toEqual(['b']);
    j.replace([]);
    expect(j.list()).toEqual([]);
    j.close();
  });

  it('refuses a list that is not valid, and keeps the old one', () => {
    const j = openJournal(join(dir, 'journal.db'));
    j.replace([sale('a')]);
    for (const bad of ['text', { id: 'a' }, [{}], [{ id: '' }], [{ id: 5 }], [null], [sale('x'), sale('x')]])
      expect(() => j.replace(bad), JSON.stringify(bad)).toThrow();
    expect(() => j.replace(Array.from({ length: MAX_JOURNAL_ITEMS + 1 }, (_, i) => sale(`s${i}`)))).toThrow(/too many/);
    expect(() => j.replace([sale('big', { body: 'x'.repeat(3 * 1024 * 1024) })])).toThrow(/too big/);
    expect(j.list().map((i) => (i as { id: string }).id)).toEqual(['a']);
    j.close();
  });

  it('checks a list without opening a file', () => {
    expect(checkJournalItems([sale('a')])).toContain('"id":"a"');
    expect(() => checkJournalItems(undefined)).toThrow();
  });

  it('a damaged file is put aside, not deleted (it may hold a sale nobody has confirmed), and a new one is started', () => {
    const file = join(dir, 'journal.db');
    writeFileSync(file, 'this is not a database '.repeat(300));
    const j = openJournal(file);
    expect(j.list()).toEqual([]);
    expect(readdirSync(dir).some((f) => f.startsWith('journal.db.broken-'))).toBe(true);
    j.replace([sale('a')]);
    expect(j.list()).toHaveLength(1);
    j.close();
  });
});

describe('the till server keeps it (GET and PUT /till/journal)', () => {
  const start = async () => {
    const till = createTillServer({ dataDir: dir, port: 0, link: { enabled: false }, catalog: { enabled: false } });
    const port = await till.listen('127.0.0.1');
    const url = `http://127.0.0.1:${port}/till/journal`;
    return {
      till,
      get: async () => (await fetch(url)).json() as Promise<{ items: { id: string }[] }>,
      put: (body: unknown) => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    };
  };

  it('starts empty, keeps a list, and has it after the till program restarts', async () => {
    const one = await start();
    expect((await one.get()).items).toEqual([]);
    expect((await one.put({ items: [sale('a'), sale('b')] })).status).toBe(200);
    await one.till.close();
    const two = await start();
    expect((await two.get()).items.map((i) => i.id)).toEqual(['a', 'b']);
    await two.till.close();
  });

  it('refuses a list that is not valid with 400, and keeps what it had', async () => {
    const t = await start();
    await t.put({ items: [sale('a')] });
    for (const bad of [{}, { items: 'x' }, { items: [{ nope: 1 }] }]) expect((await t.put(bad)).status).toBe(400);
    const notJson = await fetch(`http://127.0.0.1:${(t.till.server.address() as { port: number }).port}/till/journal`, {
      method: 'PUT',
      body: '{broken',
    });
    expect(notJson.status).toBe(400);
    expect((await t.get()).items.map((i) => i.id)).toEqual(['a']);
    await t.till.close();
  });

  it('answers with no store, so a proxy or a browser never keeps it', async () => {
    const t = await start();
    const res = await fetch(`http://127.0.0.1:${(t.till.server.address() as { port: number }).port}/till/journal`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    await t.till.close();
  });
});
