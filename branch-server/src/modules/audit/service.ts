import type { Param, Queryable } from '../../db/adapter';
import type { Db } from '../../db/open';

const INSERT_AUDIT = 'INSERT INTO audit_log (user_id, action, entity, entity_id, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?)';

function auditParams(e: AuditEntry): Param[] {
  return [
    e.userId,
    e.action,
    e.entity,
    e.entityId === undefined || e.entityId === null ? null : String(e.entityId),
    e.before === undefined ? null : JSON.stringify(e.before),
    e.after === undefined ? null : JSON.stringify(e.after),
  ];
}

/** `writeAudit` for code on the database adapter. Call it inside the same transaction as the change it describes. */
export async function writeAuditQ(q: Queryable, e: AuditEntry): Promise<void> {
  await q.run(INSERT_AUDIT, auditParams(e));
}

export type AuditEntry = {
  userId: number | null;
  action: string;
  entity: string;
  entityId?: string | number | null;
  before?: unknown;
  after?: unknown;
};

/**
 * Append a row to the audit log. Call it inside the same write transaction as the change it describes,
 * so the change and its audit row commit together. Never pass secrets (passwords, PINs, tokens).
 */
export function writeAudit(db: Db, e: AuditEntry): void {
  db.prepare(INSERT_AUDIT).run(...auditParams(e));
}
