import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateCentral } from '../../apps/central/src/db/migrate';
import { migrate } from '../../apps/api/src/db/migrate';
import { openDatabase, type Db } from '../../apps/api/src/db/open';
import { SYNC_TABLES } from '../../packages/core/src/sync';

// Three descriptions of the same rows must agree: the shared list (packages/core/src/sync.ts), the branch's tables, and HQ's copies
// (docs/12-sync-and-hq.md §4). If someone adds a column to a branch table, this fails until the list and HQ's table know about it too,
// instead of the column silently never reaching HQ.
let dir: string;
let branch: Db;
let hq: Db;

type Info = { name: string; type: string; notnull: number; pk: number };
const info = (db: Db, table: string) => db.prepare(`PRAGMA table_info(${table})`).all() as Info[];
const kind = (type: string) => (type.toUpperCase() === 'INTEGER' ? 'int' : type.toUpperCase() === 'TEXT' ? 'text' : `?${type}`);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pos-syncschema-'));
  migrate(join(dir, 'branch.db'));
  migrateCentral(join(dir, 'hq.db'));
  branch = openDatabase(join(dir, 'branch.db'), { readonly: true });
  hq = openDatabase(join(dir, 'hq.db'), { readonly: true });
});
afterAll(() => {
  branch.close();
  hq.close();
  rmSync(dir, { recursive: true, force: true });
});

describe.each(SYNC_TABLES.map((t) => [t.name, t] as const))('%s', (_name, table) => {
  it('the branch table has exactly the listed columns, with the same kinds and the same empty-or-not', () => {
    const actual = info(branch, table.name).map((c) => ({ name: c.name, kind: kind(c.type), nullable: c.notnull === 0 && c.pk === 0 }));
    expect(actual).toEqual(table.columns.map((c) => ({ name: c.name, kind: c.kind, nullable: c.nullable })));
  });

  it('HQ’s copy has the same columns, kinds and empty-or-not, plus branch_id and hq_received_at, keyed by (branch_id, id)', () => {
    const cols = info(hq, table.name);
    const listed = table.columns.map((c) => ({ name: c.name, kind: c.kind, nullable: c.nullable }));
    const actual = cols
      .filter((c) => c.name !== 'branch_id' && c.name !== 'hq_received_at')
      .map((c) => ({ name: c.name, kind: kind(c.type), nullable: c.notnull === 0 && c.pk === 0 }));
    expect(actual).toEqual(listed);
    const extra = cols.filter((c) => c.name === 'branch_id' || c.name === 'hq_received_at');
    expect(extra.map((c) => [c.name, kind(c.type), c.notnull])).toEqual([
      ['branch_id', 'int', 1],
      ['hq_received_at', 'text', 1],
    ]);
    // (branch_id, id) is the primary key, so two branches can both have a row 1
    const pk = cols
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    expect(pk).toEqual(['branch_id', 'id']);
  });

  it('the branch records inserts, changes and deletes of this table (three triggers)', () => {
    const triggers = (
      branch.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? AND name LIKE 'sync_%'`).all(table.name) as {
        name: string;
      }[]
    )
      .map((t) => t.name)
      .sort();
    expect(triggers).toEqual([`sync_${table.name}_ad`, `sync_${table.name}_ai`, `sync_${table.name}_au`].sort());
  });
});

describe('HQ’s copies are mirrors, not records of HQ’s own', () => {
  it('have no foreign keys (a sale’s lines may arrive a moment after the sale)', () => {
    for (const t of SYNC_TABLES) expect(hq.prepare(`PRAGMA foreign_key_list(${t.name})`).all(), t.name).toEqual([]);
  });

  it('a branch’s sale numbers stay unique per branch, and two branches may share a number', () => {
    const db = openDatabase(join(dir, 'hq.db'));
    const cols = SYNC_TABLES[0]!.columns.map((c) => c.name);
    const insert = (branchId: number, id: number, ref: number) =>
      db
        .prepare(`INSERT INTO sales (branch_id, ${cols.join(', ')}, hq_received_at) VALUES (?, ${cols.map(() => '?').join(', ')}, 'now')`)
        .run(
          branchId,
          ...cols.map((c) =>
            c === 'id'
              ? id
              : c === 'ref'
                ? ref
                : c === 'status' || c === 'notes' || c === 'created_at'
                  ? 'x'
                  : c.endsWith('_id') && c !== 'customer_id' && c !== 'warehouse_id'
                    ? null
                    : c === 'legacy_id'
                      ? null
                      : 1,
          ),
        );
    insert(1, 1, 500);
    expect(() => insert(2, 1, 500)).not.toThrow(); // another branch: the same id and the same number
    expect(() => insert(1, 2, 500)).toThrow(/UNIQUE/); // the same branch cannot use a number twice
    db.exec('DELETE FROM sales');
    db.close();
  });
});
