import { AppError } from '@pos/core/errors';
import { parse } from '@pos/core/validate';
import { normalizeBarcode } from '@pos/shared/barcode';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { qtyNumberToMilli } from '../../util/qty';
import { importBody, importProducts, MAX_IMPORT_BYTES } from './import';
import { MAX_IMAGE_BYTES, storeImage } from './images';
import { createProduct, getProduct, listProducts, productJson, setProductImage, updateProduct } from './products';

// A threshold in whole units (up to 3 decimals); null = never alert.
const stockAlert = z
  .number()
  .min(0)
  .refine((v) => qtyNumberToMilli(v) !== null, 'At most 3 decimals')
  .nullable();

// No defaults in the shared fields: Zod applies `.default()` even inside `.partial()`, so a patch built from defaulted fields would reset
// cost, barcode and currency on every edit. Defaults belong to create only (and to the model, which fills what is left out).
const fields = {
  name: z.string().trim().min(1).max(200),
  receiptName: z.string().trim().max(200).nullish(),
  barcode: z.string().max(64).transform(normalizeBarcode),
  priceMinor: z.number().int().min(0),
  costMinor: z.number().int().min(0),
  currency: z.enum(['USD', 'LBP']),
  categoryId: z.number().int().positive().nullish(),
  brandId: z.number().int().positive().nullish(),
  unitId: z.number().int().positive().nullish(),
  supplierId: z.number().int().positive().nullish(),
  stockAlert: stockAlert.optional(),
  expiryDate: z.string().max(40).nullish(),
};
const createBody = z.object({ ...fields, active: z.boolean().optional() }).partial({
  barcode: true,
  priceMinor: true,
  costMinor: true,
  currency: true,
});
const patchBody = z.object(fields).partial().extend({ active: z.boolean().optional() });
const listQuery = z.object({
  q: z.string().max(100).optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  brandId: z.coerce.number().int().positive().optional(),
  supplierId: z.coerce.number().int().positive().optional(),
  active: z.enum(['true', 'false', 'all']).default('true'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.coerce.number().int().positive().optional(),
});
const idParam = z.object({ id: z.coerce.number().int().min(1) });

/** The chain's products (docs/12 §17): set here, every connected branch receives them. HQ staff only. */
export default async function productRoutes(app: FastifyInstance) {
  const db = app.database;
  const admin = { preHandler: app.adminOnly };

  app.get('/products', admin, async (req) => {
    const r = await listProducts(db, parse(listQuery, req.query));
    return { data: r.data.map(productJson), nextCursor: r.nextCursor };
  });

  // Products from a spreadsheet's CSV. dryRun (the default) only says what would happen; a file with any error writes nothing, and applying is
  // one transaction.
  app.post('/products/import', { ...admin, bodyLimit: MAX_IMPORT_BYTES + 4096 }, async (req) => {
    const body = parse(importBody, req.body);
    return body.dryRun ? importProducts(db, body) : db.tx((tx) => importProducts(tx, body));
  });

  app.get('/products/:id', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const row = await getProduct(db, id);
    if (!row) throw new AppError(404, 'NOT_FOUND', 'No such product');
    return productJson(row);
  });

  app.post('/products', admin, async (req, reply) => {
    const b = parse(createBody, req.body);
    const row = await db.tx((tx) => createProduct(tx, b));
    return reply.status(201).send(productJson(row));
  });

  app.patch('/products/:id', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(patchBody, req.body);
    return productJson(await db.tx((tx) => updateProduct(tx, id, b)));
  });

  // A picture arrives as the request body itself (not a form). The type the sender claims is not trusted: the bytes decide (storeImage).
  // octet-stream is accepted for files a browser could not put a type on.
  app.addContentTypeParser(
    ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit: MAX_IMAGE_BYTES },
    (_req, body, done) => done(null, body),
  );

  // Set or replace a product's picture. The file is kept under a name made from its content and the product just points at it; every
  // connected branch then fetches the file by that name (`GET /sync/images/:name`).
  app.post('/products/:id/image', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    if (!(await getProduct(db, id))) throw new AppError(404, 'NOT_FOUND', 'No such product');
    const bytes = req.body;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0)
      throw new AppError(422, 'VALIDATION', 'Send the picture file as the body of the request');
    const stored = storeImage(app.uploadsDir, bytes);
    if (!stored)
      throw new AppError(
        422,
        'UNSUPPORTED_IMAGE',
        'That file is not a picture the shop can use. Use a JPEG, PNG, GIF, WebP or AVIF picture.',
      );
    return productJson(await db.tx((tx) => setProductImage(tx, id, stored.path)));
  });

  // Take the picture off a product. The file stays in the folder: another product may use the same one.
  app.delete('/products/:id/image', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    return productJson(await db.tx((tx) => setProductImage(tx, id, null)));
  });

  // Retire, never delete: a retired product still goes down to the branches (they hide it), and its history stays whole.
  app.delete('/products/:id', admin, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    await db.tx((tx) => updateProduct(tx, id, { active: false }));
    return reply.status(204).send();
  });
}
