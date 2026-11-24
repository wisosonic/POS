import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { E } from '../../errors';
import { inWriteTransaction } from '../../db/open';
import { parse } from '../../util/validate';
import { writeAudit } from '../audit/service';

// Categories, brands, units and suppliers: small lists a manager edits and the product form picks from.
// No delete: a product may still point at one, and renaming covers the real need.

const name = z.string().trim().min(1).max(120);
const optionalText = (max: number) => z.string().trim().max(max).nullish();

type Kind = {
  path: string;
  table: 'categories' | 'brands' | 'units' | 'suppliers' | 'expense_categories' | 'service_categories';
  entity: string;
  /** How the entry is called in messages shown to people. Defaults to `entity`. */
  label?: string;
  extra: z.ZodRawShape;
  /** Column ↔ JSON field for the extra attributes. */
  columns: Record<string, string>;
};

const KINDS: Kind[] = [
  { path: '/categories', table: 'categories', entity: 'category', extra: {}, columns: {} },
  { path: '/brands', table: 'brands', entity: 'brand', extra: {}, columns: {} },
  {
    path: '/expense-categories',
    table: 'expense_categories',
    entity: 'expense_category',
    label: 'expense category',
    extra: {},
    columns: {},
  },
  {
    path: '/service-categories',
    table: 'service_categories',
    entity: 'service_category',
    label: 'service type',
    extra: {},
    columns: {},
  },
  { path: '/units', table: 'units', entity: 'unit', extra: { fractional: z.boolean() }, columns: { fractional: 'fractional' } },
  {
    path: '/suppliers',
    table: 'suppliers',
    entity: 'supplier',
    extra: { address: optionalText(300), phone: optionalText(40), email: optionalText(120) },
    columns: { address: 'address', phone: 'phone', email: 'email' },
  },
];

const duplicateMessage = (kind: Kind, name: string) => {
  const label = kind.label ?? kind.entity;
  return `There is already ${/^[aeiou]/.test(label) ? 'an' : 'a'} ${label} called "${name}"`;
};

type Row = Record<string, unknown> & { id: number; name: string };

const toJson = (kind: Kind, r: Row) => {
  const out: Record<string, unknown> = { id: r.id, name: r.name };
  for (const [field, column] of Object.entries(kind.columns)) out[field] = field === 'fractional' ? r[column] === 1 : (r[column] ?? null);
  return out;
};

export default async function lookupRoutes(app: FastifyInstance) {
  const db = app.db;
  const read = { preHandler: app.authenticate };
  const write = { preHandler: app.requireRole('manager') };

  for (const kind of KINDS) {
    const createBody = z.object({ name, ...kind.extra });
    const patchBody = z.object({ name, ...kind.extra }).partial();
    const get = (id: number) => db.prepare(`SELECT * FROM ${kind.table} WHERE id = ?`).get(id) as Row | undefined;
    const taken = (n: string, exceptId = 0) =>
      !!db.prepare(`SELECT 1 FROM ${kind.table} WHERE lower(name) = lower(?) AND id <> ? LIMIT 1`).get(n, exceptId);
    const dbValue = (field: string, v: unknown) => (field === 'fractional' ? (v ? 1 : 0) : (v ?? null));

    app.get(kind.path, read, async () => {
      const rows = db.prepare(`SELECT * FROM ${kind.table} ORDER BY name COLLATE NOCASE, id`).all() as Row[];
      return { data: rows.map((r) => toJson(kind, r)) };
    });

    app.post(kind.path, write, async (req, reply) => {
      const b = parse(createBody, req.body) as Record<string, unknown> & { name: string };
      if (taken(b.name)) throw E.conflict('DUPLICATE_NAME', duplicateMessage(kind, b.name));
      const fields = Object.keys(kind.columns);
      const id = inWriteTransaction(db, () => {
        const cols = ['name', ...fields.map((f) => kind.columns[f]!)];
        const newId = Number(
          db
            .prepare(`INSERT INTO ${kind.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
            .run(b.name, ...fields.map((f) => dbValue(f, b[f]))).lastInsertRowid,
        );
        writeAudit(db, {
          userId: req.auth.id,
          action: `${kind.entity}.create`,
          entity: kind.entity,
          entityId: newId,
          after: { name: b.name },
        });
        return newId;
      });
      return reply.status(201).send(toJson(kind, get(id)!));
    });

    app.patch(`${kind.path}/:id`, write, async (req) => {
      const id = Number((req.params as { id: string }).id);
      const b = parse(patchBody, req.body) as Record<string, unknown>;
      const before = get(id);
      if (!before) throw E.notFound(kind.entity);
      if (typeof b.name === 'string' && taken(b.name, id)) throw E.conflict('DUPLICATE_NAME', duplicateMessage(kind, b.name));

      const sets: string[] = [];
      const vals: unknown[] = [];
      if (b.name !== undefined) {
        sets.push('name = ?');
        vals.push(b.name);
      }
      for (const [field, column] of Object.entries(kind.columns)) {
        if (b[field] === undefined) continue;
        sets.push(`${column} = ?`);
        vals.push(dbValue(field, b[field]));
      }
      if (sets.length === 0) return toJson(kind, before);
      inWriteTransaction(db, () => {
        db.prepare(`UPDATE ${kind.table} SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
        writeAudit(db, {
          userId: req.auth.id,
          action: `${kind.entity}.update`,
          entity: kind.entity,
          entityId: id,
          before: toJson(kind, before),
          after: toJson(kind, get(id)!),
        });
      });
      return toJson(kind, get(id)!);
    });
  }
}
