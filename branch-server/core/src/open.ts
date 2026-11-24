import Database from 'better-sqlite3';
import { adapterTxState, txStore } from './txstate';

export type Db = Database.Database;

/**
 * Open the POS database. SQLite is safe here because exactly one process (this API) writes to the file,
 * and the file lives on the till PC's own disk (docs/04-architecture.md §8).
 * - WAL: readers (reports) never block the till.
 * - synchronous=FULL: a committed sale survives a power cut.
 * - foreign_keys: SQLite ignores foreign keys unless asked.
 */
export function openDatabase(path: string, options: { readonly?: boolean } = {}): Db {
  const db = new Database(path, { readonly: options.readonly ?? false });
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

/**
 * Run `fn` inside a write transaction that takes the write lock up front (BEGIN IMMEDIATE), so two sales
 * can never interleave their stock and balance updates. Rolls back if `fn` throws.
 */
export function inWriteTransaction<T>(db: Db, fn: () => T): T {
  // While modules move to the async adapter (docs/11 §4), a legacy synchronous transaction must never start in the middle
  // of an adapter transaction that belongs to another request: it would silently join it. Code that runs inside the
  // adapter transaction itself is allowed (it has the same context).
  if (adapterTxState.open > 0 && txStore.getStore() === undefined)
    throw new Error('DB_TX_COLLISION: a synchronous transaction was started while an adapter transaction is open');
  return db.transaction(fn).immediate();
}
