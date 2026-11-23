import { Mutex } from '../../util/mutex';
import { TransactionYieldedError, type Database, type Param, type Queryable, type RunResult } from '../adapter';
import type { Db } from '../open';
import { adapterTxState, txStore } from '../txstate';

/** The statements, run directly on one better-sqlite3 connection. Each call is synchronous underneath. */
function statements(handle: Db): Queryable {
  // Preparing a statement costs far more than running it, and a sale runs the same few statements per line. The SQL text is
  // always a fixed string (values go in parameters), so the cache stays small; the cap only guards against a runaway
  // generator of many different `IN (?,?,...)` lists.
  type Statement = {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number };
  };
  const cache = new Map<string, Statement>();
  const prepare = (sql: string): Statement => {
    let st = cache.get(sql);
    if (!st) {
      if (cache.size >= 500) cache.clear();
      st = handle.prepare(sql) as unknown as Statement; // the one place the library's generic statement type is narrowed
      cache.set(sql, st);
    }
    return st;
  };
  return {
    async one<T>(sql: string, params: Param[] = []) {
      return prepare(sql).get(...params) as T | undefined;
    },
    async all<T>(sql: string, params: Param[] = []) {
      return prepare(sql).all(...params) as T[];
    },
    async run(sql: string, params: Param[] = []): Promise<RunResult> {
      return { changes: prepare(sql).run(...params).changes };
    },
  };
}

/**
 * The SQLite driver. Wraps a connection from `openDatabase()` (so the legacy synchronous code and the adapter can
 * share one connection while modules are converted one at a time).
 *
 * Safety model:
 * - One connection, so transactions run **one at a time** behind a mutex (same guarantee as BEGIN IMMEDIATE today).
 * - Statements outside a transaction also wait for the mutex, so they can never read half of someone else's transaction.
 * - Inside `tx()`, calls on the database itself join the open transaction (no deadlock, no second handle).
 * - A transaction body may only wait on database calls (which resolve in microtasks). If it waits on the event loop,
 *   other requests could run in the middle of it; it is rolled back with TransactionYieldedError instead.
 */
export function createSqliteDatabase(handle: Db): Database {
  const mutex = new Mutex();
  const direct = statements(handle);

  // Outside a transaction: take the lock for the one statement. Inside one: use that transaction.
  const current = (): Queryable | undefined => txStore.getStore() as Queryable | undefined;

  return {
    engine: 'sqlite',
    one: (sql, params) => {
      const q = current();
      return (q ?? ({ one: (s, p) => mutex.run(() => direct.one(s, p)) } as Queryable)).one(sql, params);
    },
    all: (sql, params) => {
      const q = current();
      return (q ?? ({ all: (s, p) => mutex.run(() => direct.all(s, p)) } as Queryable)).all(sql, params);
    },
    run: (sql, params) => {
      const q = current();
      return (q ?? ({ run: (s, p) => mutex.run(() => direct.run(s, p)) } as Queryable)).run(sql, params);
    },
    async tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const joined = current();
      if (joined) return fn(joined);
      return mutex.run(async () => {
        handle.exec('BEGIN IMMEDIATE');
        adapterTxState.enter();
        let yielded = false;
        const timer = setImmediate(() => {
          yielded = true;
        });
        try {
          const result = await txStore.run(direct, () => fn(direct));
          if (yielded) throw new TransactionYieldedError();
          handle.exec('COMMIT');
          return result;
        } catch (err) {
          if (handle.inTransaction) handle.exec('ROLLBACK');
          throw err;
        } finally {
          clearImmediate(timer);
          adapterTxState.exit();
        }
      });
    },
  };
}
