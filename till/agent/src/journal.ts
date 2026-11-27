import { mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

// The sale in doubt (docs/14-connection-and-till-backend.md §4.3). When the cashier presses Complete the screen writes the sale here
// BEFORE it sends it, and takes it out when the branch server has answered. If the connection drops, the page is closed or this PC
// restarts with a sale unanswered, the entry is still here: the screen finds it and sends it again with the SAME key (its own id), which
// the branch server recognises, so the sale can never be recorded twice.
//
// This file only keeps the list. It never sends anything itself: sending a sale needs the signed-in person's access token, and this
// program never reads, stores or logs that (rules 11 and 21). One SQLite file, `synchronous = FULL`: an entry that was acknowledged
// is on disk even if the power goes. An entry holds what the screen sent (products, quantities, amounts, and a manager's approval
// token if there was one: single-use, good for ten minutes), and never a password, a sign-in token or the device token.

export const MAX_JOURNAL_ITEMS = 200;
export const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;

export type Journal = {
  /** Every entry, in the order they were written. */
  list(): unknown[];
  /** Replace the whole list (the screen keeps the rules: add, retry, refuse, remove). Throws on a list that is not valid. */
  replace(items: unknown): void;
  close(): void;
};

const SCHEMA = 'CREATE TABLE IF NOT EXISTS journal (key TEXT PRIMARY KEY, value TEXT NOT NULL)';

function open(file: string): Database.Database {
  const db = new Database(file);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.exec(SCHEMA);
    if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('the journal is damaged');
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}

/** Check the list a screen sent: an array of objects that each have an `id`, not too many, not too big. Returns it as text. */
export function checkJournalItems(items: unknown): string {
  if (!Array.isArray(items)) throw new Error('items must be a list');
  if (items.length > MAX_JOURNAL_ITEMS) throw new Error('too many entries');
  const ids = new Set<string>();
  for (const item of items) {
    const id = (item as { id?: unknown } | null)?.id;
    if (typeof item !== 'object' || item === null || typeof id !== 'string' || !id || id.length > 100)
      throw new Error('every entry needs an id');
    if (ids.has(id)) throw new Error('an id is listed twice');
    ids.add(id);
  }
  const text = JSON.stringify(items);
  if (Buffer.byteLength(text) > MAX_JOURNAL_BYTES) throw new Error('the journal is too big');
  return text;
}

/**
 * Open the journal at `file`. A damaged file is put aside (`.broken-<time>`, never deleted: it may hold a sale nobody has confirmed)
 * and an empty one is started, and `log` says so.
 */
export function openJournal(file: string, log: (message: string) => void = () => undefined): Journal {
  mkdirSync(dirname(file), { recursive: true });
  let db: Database.Database;
  try {
    db = open(file);
  } catch (e) {
    log(`The sale journal could not be opened (${(e as Error).message}); the old file is kept aside and a new one is started`);
    try {
      renameSync(file, `${file}.broken-${Date.now()}`);
    } catch {
      /* already gone */
    }
    db = open(file);
  }
  const read = db.prepare("SELECT value FROM journal WHERE key = 'items'");
  const write = db.prepare("INSERT INTO journal (key, value) VALUES ('items', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  return {
    list() {
      const row = read.get() as { value: string } | undefined;
      if (!row) return [];
      try {
        const parsed: unknown = JSON.parse(row.value);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    },
    replace(items) {
      write.run(checkJournalItems(items));
    },
    close: () => void db.close(),
  };
}
