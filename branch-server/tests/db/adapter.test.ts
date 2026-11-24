import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, inWriteTransaction, type Db } from '../../src/db/open';
import { createSqliteDatabase } from '../../src/db/drivers/sqlite';
import { TransactionYieldedError, type Database } from '../../src/db/adapter';

// Database adapter (docs/11-multi-branch.md §4): the seam that lets a server move from SQLite to PostgreSQL later.
// These tests pin the guarantees every module converted to it relies on.
let dir: string;
let raw: Db;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pos-adapter-'));
  raw = openDatabase(join(dir, 't.db'));
  raw.exec('CREATE TABLE counter (id INTEGER PRIMARY KEY, n INTEGER NOT NULL); INSERT INTO counter VALUES (1, 0);');
  raw.exec('CREATE TABLE note (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL UNIQUE);');
  db = createSqliteDatabase(raw);
});
afterEach(() => {
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

const count = async (table: string) => (await db.one<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))!.n;

describe('adapter · statements', () => {
  it('reads and writes through one, all and run, with ? parameters', async () => {
    const created = await db.one<{ id: number }>('INSERT INTO note (text) VALUES (?) RETURNING id', ['hello']);
    expect(created?.id).toBe(1);
    expect((await db.run('UPDATE note SET text = ? WHERE id = ?', ['bye', 1])).changes).toBe(1);
    expect(await db.all<{ text: string }>('SELECT text FROM note')).toEqual([{ text: 'bye' }]);
    expect(await db.one('SELECT * FROM note WHERE id = ?', [99])).toBeUndefined();
  });
});

describe('adapter · transactions', () => {
  it('commits everything when the function finishes', async () => {
    await db.tx(async (t) => {
      await t.run('INSERT INTO note (text) VALUES (?)', ['a']);
      await t.run('INSERT INTO note (text) VALUES (?)', ['b']);
    });
    expect(await count('note')).toBe(2);
  });

  it('rolls everything back when the function throws, and passes the error on', async () => {
    await expect(
      db.tx(async (t) => {
        await t.run('INSERT INTO note (text) VALUES (?)', ['a']);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await count('note')).toBe(0);
  });

  it('rolls back on a constraint error from the database', async () => {
    await db.run('INSERT INTO note (text) VALUES (?)', ['dup']);
    await expect(
      db.tx(async (t) => {
        await t.run('INSERT INTO note (text) VALUES (?)', ['fresh']);
        await t.run('INSERT INTO note (text) VALUES (?)', ['dup']);
      }),
    ).rejects.toThrow(/UNIQUE/);
    expect(await count('note')).toBe(1);
  });

  it('never loses an update when many transactions read-then-write at the same time', async () => {
    // Each one reads the counter, waits a moment (on the database), then writes read+1. Without serialization they would
    // all read 0 and the total would be 1.
    const bump = () =>
      db.tx(async (t) => {
        const row = await t.one<{ n: number }>('SELECT n FROM counter WHERE id = 1');
        await t.all('SELECT 1');
        await t.run('UPDATE counter SET n = ? WHERE id = 1', [row!.n + 1]);
      });
    await Promise.all(Array.from({ length: 200 }, bump));
    expect((await db.one<{ n: number }>('SELECT n FROM counter'))!.n).toBe(200);
  });

  it('runs transactions one after the other, in the order they were asked', async () => {
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        db.tx(async (t) => {
          order.push(i);
          await t.run('INSERT INTO note (text) VALUES (?)', [`n${i}`]);
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });

  it('calls on the database inside a transaction join it, and are rolled back with it', async () => {
    await expect(
      db.tx(async () => {
        await db.run('INSERT INTO note (text) VALUES (?)', ['inside']); // db, not the tx argument
        expect(await count('note')).toBe(1); // sees its own uncommitted row, no deadlock
        throw new Error('undo');
      }),
    ).rejects.toThrow('undo');
    expect(await count('note')).toBe(0);
  });

  it('a transaction inside a transaction joins the outer one', async () => {
    await expect(
      db.tx(async () => {
        await db.tx(async (t) => {
          await t.run('INSERT INTO note (text) VALUES (?)', ['inner']);
        });
        throw new Error('outer fails');
      }),
    ).rejects.toThrow('outer fails');
    expect(await count('note')).toBe(0);
  });

  it('a plain statement made while a transaction is open waits for it and never sees its half-finished rows', async () => {
    const pending = db.tx(async (t) => {
      await t.run('INSERT INTO note (text) VALUES (?)', ['half']);
      await null;
      await null;
      await t.run('INSERT INTO note (text) VALUES (?)', ['rest']);
    });
    // An unrelated request (its own context, not inside the transaction) asks for a count while the transaction is suspended.
    const outsider = count('note');
    await pending;
    expect(await outsider).toBe(2); // it waited for the commit: both rows, never the half-way 1
  });
});

describe('adapter · the event-loop guard', () => {
  it('rolls back and refuses a transaction that waits on the event loop', async () => {
    await expect(
      db.tx(async (t) => {
        await t.run('INSERT INTO note (text) VALUES (?)', ['slow']);
        await new Promise((r) => setTimeout(r, 5)); // e.g. password hashing or a file read inside a transaction
      }),
    ).rejects.toBeInstanceOf(TransactionYieldedError);
    expect(await count('note')).toBe(0);
  });

  it('allows waiting on promises that are already resolved', async () => {
    await db.tx(async (t) => {
      await Promise.resolve();
      await t.run('INSERT INTO note (text) VALUES (?)', ['fine']);
      await null;
    });
    expect(await count('note')).toBe(1);
  });

  it('the database is usable again after a refused transaction', async () => {
    await expect(db.tx(async () => new Promise((r) => setTimeout(r, 5)))).rejects.toBeInstanceOf(TransactionYieldedError);
    await db.tx(async (t) => {
      await t.run('INSERT INTO note (text) VALUES (?)', ['after']);
    });
    expect(await count('note')).toBe(1);
  });
});

describe('adapter · living next to legacy synchronous code', () => {
  it('legacy synchronous transactions still work on the shared connection', async () => {
    inWriteTransaction(raw, () => raw.prepare('INSERT INTO note (text) VALUES (?)').run('legacy'));
    expect(await count('note')).toBe(1);
  });

  it('refuses a legacy transaction that starts while another request has an adapter transaction open', async () => {
    let collision: unknown;
    const pending = db.tx(async (t) => {
      await t.run('INSERT INTO note (text) VALUES (?)', ['mine']);
      await null;
      await null;
    });
    // A microtask scheduled by a different request (no transaction context) runs while the transaction is suspended.
    queueMicrotask(() => {
      try {
        inWriteTransaction(raw, () => 1);
      } catch (e) {
        collision = e;
      }
    });
    await pending;
    expect(String(collision)).toContain('DB_TX_COLLISION');
    expect(await count('note')).toBe(1);
  });

  it('legacy synchronous code called from inside an adapter transaction is part of it', async () => {
    await expect(
      db.tx(async () => {
        inWriteTransaction(raw, () => raw.prepare('INSERT INTO note (text) VALUES (?)').run('legacy-inside'));
        throw new Error('undo');
      }),
    ).rejects.toThrow('undo');
    expect(await count('note')).toBe(0);
  });
});
