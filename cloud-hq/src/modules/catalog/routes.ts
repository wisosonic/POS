import { parse } from '@pos/core/validate';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createRow, LIST_KINDS, listRows, updateRow, type ListRow } from './lists';

const name = z.string().trim().min(1).max(120);
const optionalText = (max: number) => z.string().trim().max(max).nullish();
const idParam = z.object({ id: z.coerce.number().int().min(1) });

// What each list lets a person set, besides its name.
const EXTRA: Record<string, z.ZodRawShape> = {
  categories: {},
  brands: {},
  units: { fractional: z.boolean() },
  suppliers: { address: optionalText(300), phone: optionalText(40), email: optionalText(120) },
};

const toJson = (path: string, r: ListRow) => ({ ...r, ...(path === 'units' ? { fractional: r.fractional === 1 } : {}) });
const toDb = (v: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(v).map(([k, x]) => [k, typeof x === 'boolean' ? (x ? 1 : 0) : ((x as string | number | null | undefined) ?? null)]),
  );

/** The catalog's small lists for the whole chain (docs/12 §15): set here, every connected branch receives them. HQ staff only. */
export default async function catalogListRoutes(app: FastifyInstance) {
  const db = app.database;
  const admin = { preHandler: app.adminOnly };

  for (const [path, kind] of Object.entries(LIST_KINDS)) {
    const createBody = z.object({ name, ...EXTRA[path]! });
    const patchBody = z.object({ name, ...EXTRA[path]! }).partial();

    app.get(`/${path}`, admin, async () => ({ data: (await listRows(db, kind)).map((r) => toJson(path, r)) }));

    app.post(`/${path}`, admin, async (req, reply) => {
      const { name: n, ...rest } = parse(createBody, req.body) as { name: string } & Record<string, unknown>;
      const row = await db.tx((tx) => createRow(tx, kind, n, toDb(rest)));
      return reply.status(201).send(toJson(path, row));
    });

    app.patch(`/${path}/:id`, admin, async (req) => {
      const { id } = parse(idParam, req.params);
      const b = parse(patchBody, req.body) as Record<string, unknown>;
      const row = await db.tx((tx) => updateRow(tx, kind, id, toDb(b)));
      return toJson(path, row);
    });
  }
}
