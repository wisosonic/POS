import type { Db } from '../../db/open';

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
  db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?)').run(
    e.userId,
    e.action,
    e.entity,
    e.entityId === undefined || e.entityId === null ? null : String(e.entityId),
    e.before === undefined ? null : JSON.stringify(e.before),
    e.after === undefined ? null : JSON.stringify(e.after),
  );
}
