/**
 * The database seam (docs/11-multi-branch.md §4). Business code talks to this interface, never to a database
 * library, so a server can move from SQLite to PostgreSQL by changing the driver and not the sales code.
 *
 * Rules for code written against it (they hold on BOTH engines):
 * - Parameters use `?`. The PostgreSQL driver rewrites them to `$1, $2, ...`.
 * - Get a new row's id with `... RETURNING id` (`one`), never `lastInsertRowid`.
 * - Upsert with `ON CONFLICT`, not `INSERT OR ...`. Change a number with `UPDATE t SET x = x + ?`, never read-then-write.
 * - Timestamps are written by the application as ISO-8601 UTC text. Booleans are 0/1. Money, quantities and minutes are integers.
 * - Inside `tx()` only `await` calls on the transaction itself. Hashing, file or network work happens BEFORE `tx()`.
 *   (The SQLite driver enforces this: a transaction that waits on the event loop is rolled back with TX_YIELDED.)
 */
export type Param = string | number | bigint | null | Uint8Array;

export type RunResult = { changes: number };

/** Something you can run statements on: the database itself, or one open transaction. */
export interface Queryable {
  /** The first row, or undefined. */
  one<T = Record<string, unknown>>(sql: string, params?: Param[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, params?: Param[]): Promise<T[]>;
  run(sql: string, params?: Param[]): Promise<RunResult>;
}

export interface Database extends Queryable {
  readonly engine: 'sqlite' | 'postgres';
  /**
   * Run `fn` as one all-or-nothing transaction. Transactions never overlap on SQLite (one at a time); on PostgreSQL each
   * gets its own connection. Rolls back if `fn` throws. Calling `tx` inside a transaction joins it.
   */
  tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

/** Raised (after a rollback) when a transaction waited on something slow. Move that work before `tx()`. */
export class TransactionYieldedError extends Error {
  readonly code = 'TX_YIELDED';
  constructor() {
    super(
      'A database transaction waited on the event loop (hashing, I/O, a timer). Do that work before db.tx() and keep the transaction to database calls.',
    );
  }
}
