import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { adminAuth, startHq, type Hq } from '../helpers';
import { buildApp } from '../../../branch-server/src/app';
import { migrate } from '../../../branch-server/src/db/migrate';
import { seedReference } from '../../../branch-server/src/db/seed';
import { openDatabase } from '../../../branch-server/src/db/open';
import { hashPassword } from '../../../branch-server/src/auth/password';

// The catalog's small lists come down from HQ with HQ's ids (docs/12 §15, P3a): categories, brands, units, suppliers.
// The branch here is a FRESH install (no catalog of its own), which is the only kind that may connect.
let hq: Hq;
let dir: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let http: ReturnType<typeof request>;
let admin: string;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const until = async (check: () => Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return check();
};
const list = async (path: string) => (await http.get(`${api}/${path}`).set(auth(admin))).body.data as { id: number; name: string }[];
const connect = async (code: string) => {
  const enrol = (await hq.http.post(`${api}/branches`).set(adminAuth).send({ code, name: code })).body.enrolCode as string;
  return http.post(`${api}/sync/connect`).set(auth(admin)).send({ url: hq.url, code: enrol });
};

beforeAll(async () => {
  hq = await startHq();
  dir = mkdtempSync(join(tmpdir(), 'pos-lists-'));
  const databasePath = join(dir, 'pos.db');
  migrate(databasePath);
  seedReference(databasePath);
  const db = openDatabase(databasePath);
  db.prepare(`INSERT INTO users (username, name, role, password_hash) VALUES ('boss', 'boss', 'admin', ?)`).run(
    await hashPassword('correct-horse-battery'),
  );
  db.close();
  // the connect check is ON here (the default)
  app = await buildApp({ databasePath, reports: { worker: false }, sync: { intervalMs: 60, backoffMs: [60, 200], idleMs: 40 } });
  await app.ready();
  await app.listen({ host: '127.0.0.1', port: 0 });
  http = request(app.server);
  admin = (await http.post(`${api}/auth/login`).send({ username: 'boss', password: 'correct-horse-battery' })).body.accessToken as string;
});
afterAll(async () => {
  await app.close();
  await hq.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the catalog lists at HQ', () => {
  it('HQ staff add and rename entries; a name is unique per list; anonymous callers are refused (US-HQ-lists)', async () => {
    const made = await hq.http.post(`${api}/categories`).set(adminAuth).send({ name: 'Dairy' });
    expect(made.status).toBe(201);
    expect((await hq.http.post(`${api}/categories`).set(adminAuth).send({ name: 'dairy' })).body.code).toBe('DUPLICATE_NAME');
    const renamed = await hq.http.patch(`${api}/categories/${made.body.id}`).set(adminAuth).send({ name: 'Dairy and eggs' });
    expect(renamed.body.name).toBe('Dairy and eggs');
    expect((await hq.http.patch(`${api}/categories/9999`).set(adminAuth).send({ name: 'x' })).status).toBe(404);
    expect((await hq.http.get(`${api}/categories`)).status).toBe(401);
    expect((await hq.http.post(`${api}/units`).send({ name: 'x', fractional: false })).status).toBe(401);
  });

  it('HQ starts with the three units every branch starts with, with the same ids', async () => {
    const units = (await hq.http.get(`${api}/units`).set(adminAuth)).body.data as { id: number; name: string; fractional: boolean }[];
    expect(
      units
        .filter((u) => u.id <= 3)
        .map((u) => [u.id, u.name, u.fractional])
        .sort(),
    ).toEqual([
      [1, 'Piece', false],
      [2, 'KG', true],
      [3, 'Box', false],
    ]);
  });
});

describe('the lists reach a fresh branch with HQ’s ids', () => {
  it('connecting takes the lists, a change at HQ follows, and the screens are told', async () => {
    const heard: string[] = [];
    const stop = app.events.tap((e) => heard.push(e.type));
    expect((await connect('L1')).status).toBe(200);
    const dairy = (await list('categories')).find((c) => c.name === 'Dairy and eggs');
    expect(await until(async () => !!(await list('categories')).find((c) => c.name === 'Dairy and eggs'))).toBe(true);
    expect(dairy ?? (await list('categories')).find((c) => c.name === 'Dairy and eggs')).toBeTruthy();
    expect(heard).toContain('catalog.changed');

    const brand = (await hq.http.post(`${api}/brands`).set(adminAuth).send({ name: 'Almarai' })).body;
    const unit = (await hq.http.post(`${api}/units`).set(adminAuth).send({ name: 'Litre', fractional: true })).body;
    const supplier = (await hq.http.post(`${api}/suppliers`).set(adminAuth).send({ name: 'Beirut Foods', phone: '01 234 567' })).body;
    expect(await until(async () => (await list('suppliers')).some((s) => s.id === supplier.id))).toBe(true);
    // the same id on both sides
    expect((await list('brands')).find((b) => b.id === brand.id)?.name).toBe('Almarai');
    const litre = ((await http.get(`${api}/units`).set(auth(admin))).body.data as { id: number; fractional: boolean }[]).find(
      (u) => u.id === unit.id,
    );
    expect(litre?.fractional).toBe(true);
    // a rename at HQ is a rename at the branch, not a second entry
    await hq.http.patch(`${api}/brands/${brand.id}`).set(adminAuth).send({ name: 'Almarai Co' });
    expect(await until(async () => (await list('brands')).find((b) => b.id === brand.id)?.name === 'Almarai Co')).toBe(true);
    expect((await list('brands')).filter((b) => b.id === brand.id)).toHaveLength(1);
    stop();
  });

  it('while connected the branch cannot change these lists itself; the other lists stay its own', async () => {
    for (const path of ['categories', 'brands', 'units', 'suppliers']) {
      const r = await http.post(`${api}/${path}`).set(auth(admin)).send({ name: 'Local one', fractional: false });
      expect([path, r.status, r.body.code]).toEqual([path, 409, 'HQ_OWNS_CATALOG']);
    }
    const first = (await list('categories'))[0]!;
    expect((await http.patch(`${api}/categories/${first.id}`).set(auth(admin)).send({ name: 'Renamed here' })).body.code).toBe(
      'HQ_OWNS_CATALOG',
    );
    expect((await http.post(`${api}/expense-categories`).set(auth(admin)).send({ name: 'Cleaning' })).status).toBe(201);
  });

  it('applying the same changes again changes nothing, and what HQ holds equals what the branch holds', async () => {
    const before = { categories: await list('categories'), suppliers: await list('suppliers') };
    await app.database.run('UPDATE sync_control SET down_cursor = 0 WHERE id = 1'); // forget how far it got: everything comes again
    expect(
      await until(
        async () => (await app.database.one<{ down_cursor: number }>('SELECT down_cursor FROM sync_control WHERE id = 1'))!.down_cursor > 0,
      ),
    ).toBe(true);
    expect(await list('categories')).toEqual(before.categories);
    expect(await list('suppliers')).toEqual(before.suppliers);
    const hqCats = (await hq.http.get(`${api}/categories`).set(adminAuth)).body.data as { id: number; name: string }[];
    expect(new Map((await list('categories')).map((c) => [c.id, c.name]))).toEqual(new Map(hqCats.map((c) => [c.id, c.name])));
  });
});

describe('only a branch with no catalog of its own may connect', () => {
  it('a branch that has products or categories is refused, BEFORE the one-time code is spent (US-HQ-lists)', async () => {
    const db2 = mkdtempSync(join(tmpdir(), 'pos-lists2-'));
    const databasePath = join(db2, 'pos.db');
    migrate(databasePath);
    seedReference(databasePath);
    const raw = openDatabase(databasePath);
    raw
      .prepare(`INSERT INTO users (username, name, role, password_hash) VALUES ('boss', 'boss', 'admin', ?)`)
      .run(await hashPassword('correct-horse-battery'));
    raw.prepare(`INSERT INTO categories (name) VALUES ('Mine')`).run();
    raw.close();
    const other = await buildApp({ databasePath, reports: { worker: false }, sync: { intervalMs: 60 } });
    await other.ready();
    await other.listen({ host: '127.0.0.1', port: 0 });
    try {
      const h = request(other.server);
      const token = (await h.post(`${api}/auth/login`).send({ username: 'boss', password: 'correct-horse-battery' })).body
        .accessToken as string;
      const enrol = (await hq.http.post(`${api}/branches`).set(adminAuth).send({ code: 'L2', name: 'L2' })).body.enrolCode as string;
      const refused = await h.post(`${api}/sync/connect`).set(auth(token)).send({ url: hq.url, code: enrol });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('CATALOG_NOT_EMPTY');
      // the code was not spent: once the branch has no catalog of its own it works
      const raw2 = openDatabase(databasePath);
      raw2.prepare(`DELETE FROM categories`).run();
      raw2.close();
      expect((await h.post(`${api}/sync/connect`).set(auth(token)).send({ url: hq.url, code: enrol })).status).toBe(200);
    } finally {
      await other.close();
      rmSync(db2, { recursive: true, force: true });
    }
  });

  it('a branch whose catalog came from this HQ can connect again with a new code', async () => {
    await http.post(`${api}/sync/disconnect`).set(auth(admin));
    expect((await connect('L1again')).status).toBe(200);
  });
});
