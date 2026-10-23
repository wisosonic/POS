import Database from 'better-sqlite3';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCtx, type TestCtx } from '../helpers/app';
import { avif, gif, html, jpeg, png, svg, webp } from '../helpers/images';

// US-15: product pictures. A manager sets or removes one; anyone's browser can show it; nothing else in the folder can be reached.
let c: TestCtx;
let manager: string;
let cashier: string;
let folder: string;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const towel = () => c.seed.products.towel.id;
const choc = () => c.seed.products.choc.id;
const files = () => (existsSync(folder) ? readdirSync(folder).sort() : []);

const upload = (id: number, bytes: Buffer, type = 'image/png', token = manager) =>
  c.http.post(`${api}/products/${id}/image`).set(auth(token)).set('Content-Type', type).send(bytes);
const fromDb = <T>(sql: string, ...p: unknown[]) => {
  const db = new Database(c.databasePath, { readonly: true });
  try {
    return db.prepare(sql).all(...p) as T[];
  } finally {
    db.close();
  }
};

beforeAll(async () => {
  c = await startCtx();
  manager = await c.login('manager');
  cashier = await c.login('cashier');
  folder = join(dirname(c.databasePath), 'uploads');
});
afterAll(() => c.close());

describe('setting a picture', () => {
  it('keeps it under a name made from its content and points the product at it', async () => {
    const res = await upload(towel(), png('towel'));
    expect(res.status).toBe(200);
    expect(res.body.imagePath).toMatch(/^\/uploads\/[0-9a-f]{24}\.png$/);
    expect(files()).toContain(res.body.imagePath.slice('/uploads/'.length));
    const listed = await c.http.get(`${api}/products/${towel()}`).set(auth(cashier));
    expect(listed.body.imagePath).toBe(res.body.imagePath);
  });

  it('judges the picture by its bytes: a PNG sent as JPEG is stored as a PNG, a JPEG sent with no type as a JPEG', async () => {
    const asJpeg = await upload(choc(), png('lie'), 'image/jpeg');
    expect(asJpeg.status).toBe(200);
    expect(asJpeg.body.imagePath).toMatch(/\.png$/);
    const noType = await upload(choc(), jpeg('plain'), 'application/octet-stream');
    expect(noType.status).toBe(200);
    expect(noType.body.imagePath).toMatch(/\.jpg$/);
  });

  it('takes all five kinds', async () => {
    for (const [make, ext] of [
      [png, 'png'],
      [jpeg, 'jpg'],
      [gif, 'gif'],
      [webp, 'webp'],
      [avif, 'avif'],
    ] as const) {
      const type = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      const res = await upload(towel(), make('kinds'), type);
      expect(res.status, ext).toBe(200);
      expect(res.body.imagePath.endsWith(`.${ext}`), ext).toBe(true);
    }
  });

  it('refuses something that is not a picture, whatever it says it is, and stores nothing', async () => {
    const before = files();
    for (const bytes of [html(), svg(), Buffer.from('plain text, not a picture')]) {
      const res = await upload(towel(), bytes, 'image/png');
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('UNSUPPORTED_IMAGE');
    }
    expect(files()).toEqual(before);
  });

  it('refuses an empty body, and a type that is not a picture at all', async () => {
    expect((await upload(towel(), Buffer.alloc(0))).status).toBe(400);
    const page = await upload(towel(), html(), 'text/html');
    expect(page.status).toBe(415);
    expect(page.body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    // A picture sent as JSON is read as JSON, and is not JSON: refused either way.
    expect((await upload(towel(), png(), 'application/json')).status).toBe(400);
  });

  it('refuses a picture bigger than 5 MB, stores nothing, and the product is unchanged', async () => {
    const before = files();
    const had = (await c.http.get(`${api}/products/${towel()}`).set(auth(cashier))).body.imagePath;
    // Far over the limit the server stops reading and closes the connection, so a client may see a reset instead of a 413.
    const outcome = await upload(towel(), Buffer.concat([png('big'), Buffer.alloc(5 * 1024 * 1024)])).then(
      (r) => r.status,
      (e: NodeJS.ErrnoException) => e.code,
    );
    expect([413, 'ECONNRESET', 'EPIPE']).toContain(outcome);
    expect(files()).toEqual(before);
    expect((await c.http.get(`${api}/products/${towel()}`).set(auth(cashier))).body.imagePath).toBe(had);
  });

  it('a picture just under the limit is fine', async () => {
    const res = await upload(towel(), Buffer.concat([png('almost'), Buffer.alloc(5 * 1024 * 1024 - 1000)]));
    expect(res.status).toBe(200);
  });

  it('keeps one copy of a picture that two products share', async () => {
    const shared = png('shared-by-two');
    const a = await upload(towel(), shared);
    const b = await upload(choc(), shared);
    expect(b.body.imagePath).toBe(a.body.imagePath);
    expect(files().filter((f) => f === a.body.imagePath.slice('/uploads/'.length))).toHaveLength(1);
  });

  it('replacing a picture changes the product, and the old file stays (another product may use it)', async () => {
    const first = await upload(towel(), png('first'));
    const second = await upload(towel(), png('second'));
    expect(second.body.imagePath).not.toBe(first.body.imagePath);
    expect(files()).toContain(first.body.imagePath.slice('/uploads/'.length));
  });

  it('makes the product show up in the till’s catalog update, so every till gets the new picture', async () => {
    const since = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 15));
    const res = await upload(choc(), png('sync'));
    const sync = await c.http.get(`${api}/products/sync?since=${encodeURIComponent(since)}`).set(auth(cashier));
    expect(sync.body.data.find((p: { id: number }) => p.id === choc()).imagePath).toBe(res.body.imagePath);
  });

  it('is written to the audit log with the old and the new picture', async () => {
    const before = (await upload(towel(), png('audit-1'))).body.imagePath;
    const after = (await upload(towel(), png('audit-2'))).body.imagePath;
    const row = fromDb<{ before_json: string; after_json: string }>(
      `SELECT before_json, after_json FROM audit_log WHERE action = 'product.image.update' AND entity_id = ? ORDER BY id DESC LIMIT 1`,
      String(towel()),
    )[0]!;
    expect(JSON.parse(row.before_json).imagePath).toBe(before);
    expect(JSON.parse(row.after_json).imagePath).toBe(after);
  });
});

describe('who may set one', () => {
  it('a manager may; a cashier may not; nobody anonymous; an unknown product is not found', async () => {
    expect((await upload(towel(), png('roles'), 'image/png', cashier)).status).toBe(403);
    expect((await c.http.post(`${api}/products/${towel()}/image`).set('Content-Type', 'image/png').send(png())).status).toBe(401);
    expect((await upload(999_999, png('ghost'))).status).toBe(404);
    expect((await c.http.delete(`${api}/products/${towel()}/image`).set(auth(cashier))).status).toBe(403);
  });
});

describe('removing a picture', () => {
  it('takes it off the product, leaves the file, and may be repeated', async () => {
    const set = (await upload(towel(), png('to-remove'))).body.imagePath as string;
    const gone = await c.http.delete(`${api}/products/${towel()}/image`).set(auth(manager));
    expect(gone.status).toBe(200);
    expect(gone.body.imagePath).toBeNull();
    expect(files()).toContain(set.slice('/uploads/'.length));
    expect((await c.http.delete(`${api}/products/${towel()}/image`).set(auth(manager))).body.imagePath).toBeNull();
    const audited = fromDb<{ n: number }>(
      `SELECT count(*) AS n FROM audit_log WHERE action = 'product.image.remove' AND entity_id = ?`,
      String(towel()),
    )[0]!;
    expect(audited.n).toBe(1); // the second removal had nothing to remove, so it is not recorded again
  });

  it('is also what the tills hear about', async () => {
    await upload(choc(), png('sync-remove'));
    const since = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 15));
    await c.http.delete(`${api}/products/${choc()}/image`).set(auth(manager));
    const sync = await c.http.get(`${api}/products/sync?since=${encodeURIComponent(since)}`).set(auth(cashier));
    expect(sync.body.data.find((p: { id: number }) => p.id === choc()).imagePath).toBeNull();
  });
});

describe('showing a picture', () => {
  it('anyone’s browser can load it, with the right type, for ever, and as a picture only', async () => {
    const bytes = jpeg('shown');
    const { imagePath } = (await upload(towel(), bytes, 'image/jpeg')).body;
    const res = await c.http
      .get(imagePath)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (d: Buffer) => chunks.push(d));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toBe('inline');
    expect(res.body).toEqual(bytes);
  });

  it('answers to the security rules as any page does: another host name is refused', async () => {
    const { imagePath } = (await upload(towel(), png('host'))).body;
    expect((await c.http.get(imagePath).set('Host', 'evil.example.com')).status).toBe(403);
  });

  it('serves only the names the server makes: nothing else in or beside the folder can be reached', async () => {
    const attempts = [
      '/uploads/',
      '/uploads/index.html',
      '/uploads/secret.txt',
      '/uploads/pos.db',
      '/uploads/..%2Fpos.db',
      '/uploads/..%2f..%2fpos.db',
      '/uploads/%2e%2e/pos.db',
      '/uploads/0123456789abcdef01234567.html', // the right shape, the wrong kind
      '/uploads/0123456789abcdef01234567.svg',
      '/uploads/0123456789abcdef01234567.png.html',
      '/uploads/0123456789ABCDEF01234567.png',
      '/uploads/0123456789abcdef01234567.png', // the right name, but no such picture
      `/uploads/${encodeURIComponent('0123456789abcdef01234567.png\0.html')}`,
    ];
    for (const path of attempts) {
      const res = await c.http.get(path).set('Accept', 'image/*');
      expect(res.status, path).toBe(404);
      expect(String(res.headers['content-type']), path).not.toMatch(/^(image\/|text\/html)/);
    }
  });

  it('a web page dropped into the folder by hand is still never served (its name is not one the server makes)', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(folder, 'saved-page.html'), html());
    writeFileSync(join(folder, '0123456789abcdef01234567.html'), html());
    for (const name of ['saved-page.html', '0123456789abcdef01234567.html']) {
      const res = await c.http.get(`/uploads/${name}`).set('Accept', 'text/html');
      expect(res.status, name).toBe(404);
      expect(res.text, name).not.toContain('alert(1)');
    }
  });

  it('the picture is part of the product everywhere a product is read', async () => {
    const { imagePath } = (await upload(towel(), png('everywhere'))).body;
    const byList = await c.http.get(`${api}/products?q=towel`).set(auth(cashier));
    expect(byList.body.data.find((p: { id: number }) => p.id === towel()).imagePath).toBe(imagePath);
    const byBarcode = await c.http.get(`${api}/products/by-barcode/5287000107945`).set(auth(cashier));
    expect(byBarcode.body.data[0].imagePath).toBe(imagePath);
  });
});

describe('the folder', () => {
  it('holds only whole, correctly named pictures after all of the above', () => {
    for (const f of files().filter((n) => !n.endsWith('.html'))) expect(f, f).toMatch(/^[0-9a-f]{24}\.(jpg|png|gif|webp|avif)$/);
    expect(
      readFileSync(
        join(
          folder,
          files().find((f) => f.endsWith('.png'))!,
        ),
      ).subarray(0, 4),
    ).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
});
