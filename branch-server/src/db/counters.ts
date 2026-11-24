import type { Queryable } from './adapter';
import type { Db } from './open';

export type CounterName = 'sale_ref' | 'return_ref' | 'purchase_ref' | 'service_ref';

/** `nextRef` for code on the database adapter. Same rule: call it inside the document's own transaction. */
export async function nextRefQ(q: Queryable, name: CounterName): Promise<number> {
  const row = await q.one<{ value: number }>('UPDATE counters SET value = value + 1 WHERE name = ? RETURNING value', [name]);
  if (!row) throw new Error(`Unknown counter "${name}". Was the reference data seeded?`);
  return row.value;
}

/**
 * Take the next receipt/reference number. Must be called inside the write transaction of the document
 * being created, so a rolled-back sale gives its number back and numbers are never duplicated.
 */
export function nextRef(db: Db, name: CounterName): number {
  const row = db.prepare('UPDATE counters SET value = value + 1 WHERE name = ? RETURNING value').get(name) as { value: number } | undefined;
  if (!row) throw new Error(`Unknown counter "${name}". Was the reference data seeded?`);
  return row.value;
}
