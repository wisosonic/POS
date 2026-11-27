import type { Queryable } from '@pos/core/adapter';
import { AppError } from '@pos/core/errors';
import { writeAudit } from '../staff/context';

// The catalog's small lists at HQ (docs/12-sync-and-hq.md §15, P3a): categories, brands, units, suppliers. HQ is the only place they change once
// a branch is connected. Every change writes its change_log line and an hq_audit row in the SAME transaction, so a branch cannot miss it.
// Table and column names come from this fixed list, never from a request.

type ListKind = {
  table: 'categories' | 'brands' | 'units' | 'suppliers';
  entity: string;
  /** The columns besides id and name that a person can set. */
  extra: string[];
};

export const LIST_KINDS: Record<string, ListKind> = {
  categories: { table: 'categories', entity: 'category', extra: [] },
  brands: { table: 'brands', entity: 'brand', extra: [] },
  units: { table: 'units', entity: 'unit', extra: ['fractional'] },
  suppliers: { table: 'suppliers', entity: 'supplier', extra: ['address', 'phone', 'email'] },
};

export type ListRow = Record<string, string | number | null> & { id: number; name: string };

const nowIso = () => new Date().toISOString();

async function nameTaken(q: Queryable, kind: ListKind, name: string, exceptId: number): Promise<boolean> {
  return !!(await q.one(`SELECT 1 AS x FROM ${kind.table} WHERE lower(name) = lower(?) AND id <> ? LIMIT 1`, [name, exceptId]));
}

const duplicate = (kind: ListKind, name: string) => {
  const label = kind.entity;
  return new AppError(409, 'DUPLICATE_NAME', `There is already ${/^[aeiou]/.test(label) ? 'an' : 'a'} ${label} called "${name}"`);
};

export const listRows = (q: Queryable, kind: ListKind): Promise<ListRow[]> =>
  q.all<ListRow>(`SELECT id, name${kind.extra.map((c) => `, ${c}`).join('')} FROM ${kind.table} ORDER BY lower(name), id`);

async function record(q: Queryable, kind: ListKind, id: number, action: 'create' | 'update', detail: unknown): Promise<void> {
  const now = nowIso();
  await q.run('INSERT INTO change_log (tbl, pk, op, created_at) VALUES (?, ?, ?, ?)', [kind.table, id, 'u', now]);
  await writeAudit(q, `${kind.entity}.${action}`, kind.entity, id, detail);
}

/** Add an entry. `values` holds only the kind's own extra columns (already checked by the route). */
export async function createRow(
  q: Queryable,
  kind: ListKind,
  name: string,
  values: Record<string, string | number | null>,
): Promise<ListRow> {
  if (await nameTaken(q, kind, name, 0)) throw duplicate(kind, name);
  const now = nowIso();
  const cols = ['name', ...kind.extra, 'created_at', 'updated_at'];
  const row = (await q.one<{ id: number }>(
    `INSERT INTO ${kind.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING id`,
    [name, ...kind.extra.map((c) => values[c] ?? (c === 'fractional' ? 0 : null)), now, now],
  ))!;
  await record(q, kind, row.id, 'create', { name });
  return (await q.one<ListRow>(`SELECT id, name${kind.extra.map((c) => `, ${c}`).join('')} FROM ${kind.table} WHERE id = ?`, [row.id]))!;
}

/** Change an entry; only the fields given. Returns the row as it is after the change. */
export async function updateRow(
  q: Queryable,
  kind: ListKind,
  id: number,
  patch: { name?: string } & Record<string, string | number | null | undefined>,
): Promise<ListRow> {
  const before = await q.one<ListRow>(`SELECT id, name${kind.extra.map((c) => `, ${c}`).join('')} FROM ${kind.table} WHERE id = ?`, [id]);
  if (!before) throw new AppError(404, 'NOT_FOUND', `No such ${kind.entity}`);
  if (patch.name !== undefined && (await nameTaken(q, kind, patch.name, id))) throw duplicate(kind, patch.name);
  const fields = ['name', ...kind.extra].filter((c) => patch[c] !== undefined);
  if (fields.length > 0) {
    await q.run(`UPDATE ${kind.table} SET ${fields.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [
      ...fields.map((c) => patch[c] ?? null),
      nowIso(),
      id,
    ]);
    await record(q, kind, id, 'update', { before: before, changed: fields });
  }
  return (await q.one<ListRow>(`SELECT id, name${kind.extra.map((c) => `, ${c}`).join('')} FROM ${kind.table} WHERE id = ?`, [id]))!;
}
