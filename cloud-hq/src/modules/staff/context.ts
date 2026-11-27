import type { Database, Queryable } from '@pos/core/adapter';

// Who is doing this (docs/12 §21, P3d). A staff request runs its writes through `asStaff`: the actor is put in `hq_context` at the start of the
// transaction and cleared at its end (both inside it), so every audit row written meanwhile, by code that knows nothing about people, says who made
// the change. A transaction that fails rolls the context back too, so a later one never sees a stale name.

/** The person (or the break-glass token) behind a request. `actor` is what the audit log shows. */
export type Staff = {
  /** null for the break-glass token (`HQ_ADMIN_TOKEN`), which is not a person. */
  id: number | null;
  username: string;
  name: string;
  role: StaffRole;
  mustResetPassword: boolean;
  actor: string;
};

export type StaffRole = 'viewer' | 'catalog' | 'admin';
export const ROLE_RANK: Record<StaffRole, number> = { viewer: 1, catalog: 2, admin: 3 };
export const hasRole = (have: StaffRole, need: StaffRole): boolean => ROLE_RANK[have] >= ROLE_RANK[need];

/** Run `fn` in ONE transaction with `staff` recorded as the actor of every audit row it writes. */
export function asStaff<T>(db: Database, staff: Staff | null, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  return db.tx(async (tx) => {
    await tx.run('UPDATE hq_context SET actor = ? WHERE id = 1', [staff?.actor ?? null]);
    const result = await fn(tx);
    await tx.run('UPDATE hq_context SET actor = NULL WHERE id = 1');
    return result;
  });
}

/** The one way HQ writes its audit log: append-only, with the actor of the transaction it is written in. Never put a secret in `detail`. */
export async function writeAudit(
  q: Queryable,
  action: string,
  entity: string,
  entityId?: number | string | null,
  detail?: unknown,
): Promise<void> {
  await q.run(
    `INSERT INTO hq_audit (action, entity, entity_id, detail_json, created_at, actor)
     VALUES (?, ?, ?, ?, ?, (SELECT actor FROM hq_context WHERE id = 1))`,
    [
      action,
      entity,
      entityId === undefined || entityId === null ? null : String(entityId),
      detail === undefined ? null : JSON.stringify(detail),
      new Date().toISOString(),
    ],
  );
}
