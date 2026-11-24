import type { Queryable } from '@pos/core/adapter';
import { AppError } from '@pos/core/errors';
import { digestRows, MAX_BATCH_ROWS, syncTable, validateRow, type Digest, type Fact, type FactRow, type SyncTable } from '@pos/core/sync';

// What branches send up (docs/12-sync-and-hq.md §3-4). HQ stores each row exactly as the branch reports it, keyed by (branch, id). A message is
// an UPSERT (or a delete), so receiving the same one twice, or in a repeated batch after a lost answer, changes nothing. A whole batch is applied
// in ONE transaction: it is all stored or none of it is, and a batch with one bad row is refused whole, so a version mismatch between a
// branch and HQ is loud and visible, not a silent loss of data. The branch id always comes from the branch's token, never from the body.

const nowIso = () => new Date().toISOString();

// Table and column names are built from the fixed list in packages/core/src/sync.ts, never from anything a branch sends.
const upsertSql = (t: SyncTable): string => {
  const cols = t.columns.map((c) => c.name);
  const updates = [...cols.filter((c) => c !== 'id'), 'hq_received_at'].map((c) => `${c} = excluded.${c}`).join(', ');
  return `INSERT INTO ${t.name} (branch_id, ${cols.join(', ')}, hq_received_at) VALUES (?, ${cols.map(() => '?').join(', ')}, ?)
          ON CONFLICT (branch_id, id) DO UPDATE SET ${updates}`;
};

/** Check the whole batch before touching the database. Throws `FACTS_INVALID` naming the first problem. */
export function checkBatch(facts: Fact[]): void {
  if (facts.length > MAX_BATCH_ROWS)
    throw new AppError(422, 'FACTS_INVALID', `A batch holds at most ${MAX_BATCH_ROWS} rows (got ${facts.length})`);
  facts.forEach((f, i) => {
    const where = `Row ${i + 1} (${f.tbl} ${f.pk})`;
    const table = syncTable(f.tbl);
    if (!table) throw new AppError(422, 'FACTS_INVALID', `${where}: HQ does not take the table "${f.tbl}"`);
    if (!Number.isSafeInteger(f.pk) || f.pk < 1)
      throw new AppError(422, 'FACTS_INVALID', `${where}: the id must be a positive whole number`);
    if (f.op === 'd') return;
    const problem = validateRow(table, f.row);
    if (problem) throw new AppError(422, 'FACTS_INVALID', `${where}: ${problem}`);
    if (f.row!.id !== f.pk) throw new AppError(422, 'FACTS_INVALID', `${where}: the row's id does not match`);
  });
}

/** Store a batch for one branch. Call it inside a transaction. Returns how many rows it applied. */
export async function applyFacts(q: Queryable, branchId: number, facts: Fact[]): Promise<number> {
  checkBatch(facts);
  const received = nowIso();
  for (const f of facts) {
    const table = syncTable(f.tbl)!;
    if (f.op === 'd') {
      await q.run(`DELETE FROM ${table.name} WHERE branch_id = ? AND id = ?`, [branchId, f.pk]);
    } else {
      await q.run(upsertSql(table), [branchId, ...table.columns.map((c) => f.row![c.name] ?? null), received]);
    }
  }
  return facts.length;
}

/** The fingerprint of everything HQ holds of one table for one branch (compare with the branch's own: `digestRows`). */
export async function tableDigest(q: Queryable, branchId: number, tableName: string): Promise<Digest> {
  const table = syncTable(tableName);
  if (!table) throw new AppError(422, 'FACTS_INVALID', `HQ does not take the table "${tableName}"`);
  const rows = await q.all<FactRow>(
    `SELECT ${table.columns.map((c) => c.name).join(', ')} FROM ${table.name} WHERE branch_id = ? ORDER BY id`,
    [branchId],
  );
  return digestRows(table, rows);
}
