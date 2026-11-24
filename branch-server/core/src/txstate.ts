import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Which adapter transaction the running code belongs to (if any). `db.one()` called inside `db.tx()` joins that
 * transaction automatically, so code cannot deadlock by using the wrong handle.
 */
export const txStore = new AsyncLocalStorage<unknown>();

let openCount = 0;

/** How many adapter transactions are open right now (0 or 1 on SQLite). The legacy synchronous helper checks it. */
export const adapterTxState = {
  enter(): void {
    openCount += 1;
  },
  exit(): void {
    openCount -= 1;
  },
  get open(): number {
    return openCount;
  },
};
