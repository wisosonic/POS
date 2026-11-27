import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { adminAuth, branchAuth, startHq, type Hq } from '../helpers';
import { api, auth, startFreshBranch, until, type FreshBranch } from './freshBranch';

// Product pictures come down from HQ (docs/12 §19): the product carries the NAME of the picture and the branch fetches the file by that name,
// checking that the content gives that name.
let hq: Hq;
let b: FreshBranch;
let hqToken = '';

const png = (tail: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tail)]);
const nameOf = (bytes: Buffer) => `${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}.png`;
const upload = (id: number, body: Buffer | string, type = 'image/png') =>
  hq.http.post(`${api}/products/${id}/image`).set(adminAuth).set('Content-Type', type).send(body);
const product = async (name: string) =>
  (await hq.http.post(`${api}/products`).set(adminAuth).send({ name, priceMinor: 1000 })).body as { id: number; imagePath: string | null };
const atBranch = (name: string) => b.http.get(`/uploads/${name}`);

beforeAll(async () => {
  hq = await startHq();
  b = await startFreshBranch();
  const code = (await hq.http.post(`${api}/branches`).set(adminAuth).send({ code: 'PIC', name: 'PIC' })).body.enrolCode as string;
  hqToken = (await hq.http.post(`${api}/sync/enrol`).send({ code })).body.token as string;
});
afterAll(async () => {
  await b.close();
  await hq.close();
});

describe('a picture at HQ', () => {
  it('is judged by its bytes, kept under a name made from them, and audited', async () => {
    const p = await product('Pictured');
    const bytes = png('one');
    const done = await upload(p.id, bytes);
    expect(done.status).toBe(200);
    expect(done.body.imagePath).toBe(`/uploads/${nameOf(bytes)}`);
    expect(existsSync(join(hq.app.uploadsDir, nameOf(bytes)))).toBe(true);
    const html = await upload(p.id, '<html><script>alert(1)</script></html>', 'application/octet-stream');
    expect([html.status, html.body.code]).toEqual([422, 'UNSUPPORTED_IMAGE']);
    expect((await upload(9999, bytes)).status).toBe(404);
  });

  it('is served to a branch by its name, and only by a name of that one shape', async () => {
    const p = await product('Served');
    const bytes = png('two');
    await upload(p.id, bytes);
    const ok = await hq.http.get(`${api}/sync/images/${nameOf(bytes)}`).set(branchAuth(hqToken));
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('image/png');
    expect(Buffer.from(ok.body).equals(bytes)).toBe(true);
    expect((await hq.http.get(`${api}/sync/images/${nameOf(bytes)}`)).status).toBe(401);
    for (const bad of ['..%2fhq.db', 'hq.db', 'x.png', `${nameOf(bytes)}.exe`])
      expect((await hq.http.get(`${api}/sync/images/${bad}`).set(branchAuth(hqToken))).status, bad).toBe(404);
  });
});

describe('a picture reaches the branch', () => {
  it('the product arrives with its picture, and the file is served by the branch itself', async () => {
    expect((await b.connect(hq, 'PIC1')).status).toBe(200);
    const p = await product('With picture');
    const bytes = png('three');
    await upload(p.id, bytes);
    const name = nameOf(bytes);
    expect(await until(async () => (await atBranch(name)).status === 200)).toBe(true);
    const got = await atBranch(name);
    expect(got.headers['content-type']).toBe('image/png');
    const there = (await b.http.get(`${api}/products/${p.id}`).set(auth(b.admin))).body;
    expect(there.imagePath).toBe(`/uploads/${name}`);
  });

  it('a file that does not match its name is not used, and the right one is taken once HQ has it', async () => {
    const p = await product('Tampered');
    const good = png('four');
    const name = nameOf(good);
    // HQ's folder holds the WRONG content under this name (a damaged or swapped file), and the product points at the name.
    writeFileSync(join(hq.app.uploadsDir, name), png('something else'));
    await hq.app.database.run('UPDATE products SET image_path = ? WHERE id = ?', [`/uploads/${name}`, p.id]);
    await hq.app.database.run('INSERT INTO change_log (tbl, pk, op, created_at) VALUES (?, ?, ?, ?)', [
      'products',
      p.id,
      'u',
      new Date().toISOString(),
    ]);
    expect(
      await until(async () => (await b.http.get(`${api}/products/${p.id}`).set(auth(b.admin))).body.imagePath === `/uploads/${name}`),
    ).toBe(true);
    await new Promise((r) => setTimeout(r, 1200)); // a few rounds
    expect((await atBranch(name)).status).toBe(404); // the wrong content was not kept under that name
    writeFileSync(join(hq.app.uploadsDir, name), good); // HQ is repaired
    expect(await until(async () => (await atBranch(name)).status === 200)).toBe(true);
  });

  it('while connected the branch cannot set or remove a product picture itself', async () => {
    const some = (await b.http.get(`${api}/products?limit=1`).set(auth(b.admin))).body.data[0] as { id: number };
    const set = await b.http
      .post(`${api}/products/${some.id}/image`)
      .set(auth(b.admin))
      .set('Content-Type', 'image/png')
      .send(png('local'));
    expect([set.status, set.body.code]).toEqual([409, 'HQ_OWNS_CATALOG']);
    expect((await b.http.delete(`${api}/products/${some.id}/image`).set(auth(b.admin))).body.code).toBe('HQ_OWNS_CATALOG');
  });

  it('removing the picture at HQ removes it from the product at the branch', async () => {
    const p = await product('Unpictured');
    const bytes = png('five');
    await upload(p.id, bytes);
    expect(
      await until(
        async () => (await b.http.get(`${api}/products/${p.id}`).set(auth(b.admin))).body.imagePath === `/uploads/${nameOf(bytes)}`,
      ),
    ).toBe(true);
    expect((await hq.http.delete(`${api}/products/${p.id}/image`).set(adminAuth)).body.imagePath).toBeNull();
    expect(await until(async () => (await b.http.get(`${api}/products/${p.id}`).set(auth(b.admin))).body.imagePath === null)).toBe(true);
  });
});
