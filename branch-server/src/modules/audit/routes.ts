import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../../util/validate';

const query = z.object({
  entity: z.string().max(50).optional(),
  entityId: z.string().max(50).optional(),
  userId: z.coerce.number().int().positive().optional(),
  action: z.string().max(80).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.coerce.number().int().positive().optional(),
});

type Row = {
  id: number;
  user_id: number | null;
  action: string;
  entity: string;
  entity_id: string | null;
  before_json: string | null;
  after_json: string | null;
  created_at: string;
};

export default async function auditRoutes(app: FastifyInstance) {
  app.get('/audit', { preHandler: app.requireRole('admin') }, async (req) => {
    const q = parse(query, req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      if (v === undefined) return;
      where.push(sql);
      params.push(v);
    };
    add('entity = ?', q.entity);
    add('entity_id = ?', q.entityId);
    add('user_id = ?', q.userId);
    add('action = ?', q.action);
    add('created_at >= ?', q.from);
    add('created_at <= ?', q.to);
    add('id < ?', q.cursor);

    const rows = app.db
      .prepare(`SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`)
      .all(...params, q.limit + 1) as Row[];
    const page = rows.slice(0, q.limit);
    return {
      data: page.map((r) => ({
        id: r.id,
        userId: r.user_id,
        action: r.action,
        entity: r.entity,
        entityId: r.entity_id,
        before: r.before_json ? JSON.parse(r.before_json) : null,
        after: r.after_json ? JSON.parse(r.after_json) : null,
        createdAt: r.created_at,
      })),
      nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  });
}
