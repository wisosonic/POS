import { Mutex } from '../../util/mutex';
import { TransactionYieldedError, type Database, type Param, type Queryable, type RunResult } from '../adapter';
import type { Db } from '../open';
import { adapterTxState, txStore } from '../txstate';

/** The statements, run directly on one better-sqlite3 connection. Each call is synchronous underneath. */
function statements(handle: Db): Queryable {
  return {
    async one<T>(sql: string, params: Param[] = []) {
      return handle.prepare(sql).get(...params) as T | undefined;
    },
    async all<T>(sql: string, params: Param[] = []) {
      return handle.prepare(sql).all(...params) as T[];
    },
    async run(sql: string, params: Param[] = []): Promise<RunResult> {
      return { changes: handle.prepare(sql).run(...params).changes };
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
