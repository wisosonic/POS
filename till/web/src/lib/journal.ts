import { indexedDbKV, type KV } from './kv';

// Where the sale journal (lib/outbox.ts) is kept. On a till PC the till's own server keeps it on its disk (`/till/journal`, docs/14 §4.3):
// it survives a closed page, cleared browser data and a restart. A page served by the branch server directly (no till program: a
// developer's browser) has no such place, so the journal stays in the browser (IndexedDB) as it always was.

type Mode = 'till' | 'browser';
let probed: Promise<Mode | 'unknown'> | undefined;

/** Does a till program on this PC keep the journal? Asked once; a failure to ask (not a "no") is asked again next time. */
function probe(): Promise<Mode | 'unknown'> {
  const ask = (async (): Promise<Mode | 'unknown'> => {
    try {
      const res = await fetch('/till/journal', { headers: { Accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin' });
      if (res.ok && (res.headers.get('content-type') ?? '').includes('json')) return 'till';
      return 'browser'; // answered, but not as a till program does: there is none (a 404 from the branch server, or the web server)
    } catch {
      return 'unknown';
    }
  })();
  probed = ask;
  void ask.then((m) => {
    if (m === 'unknown' && probed === ask) probed = undefined;
  });
  return ask;
}

export async function usesTillJournal(): Promise<boolean> {
  return (await (probed ?? probe())) === 'till';
}

type Entry = { id: string };

/** The store the sale journal uses: the till program's file when there is one, the browser's own storage when there is not. */
export function tillJournalKV(browser: KV = indexedDbKV('till-outbox')): KV {
  const mode = async (): Promise<Mode> => {
    const m = await (probed ?? probe());
    if (m === 'unknown') throw new Error('The till program on this PC did not answer');
    return m;
  };
  return {
    async get<T>(key: string) {
      if ((await mode()) === 'browser') return browser.get<T>(key);
      const res = await fetch('/till/journal', { headers: { Accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) throw new Error(`The till program answered ${res.status}`);
      return ((await res.json()) as { items: Entry[] }).items as T;
    },
    async set(key, value) {
      if ((await mode()) === 'browser') return browser.set(key, value);
      const res = await fetch('/till/journal', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: value }),
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(`The till program could not keep the sale (${res.status})`);
    },
    async delete(key) {
      if ((await mode()) === 'browser') return browser.delete(key);
      const res = await fetch('/till/journal', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [] }),
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(`The till program could not clear the journal (${res.status})`);
    },
  };
}
