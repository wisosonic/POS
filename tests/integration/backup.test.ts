import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCtx, type TestCtx } from '../helpers/app';

// US-30: who can see and run backups, and what the answers say. The backup itself is covered in tests/db/backup*.test.ts.
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PASS = 'correct horse battery staple';

describe('backups are not set up', () => {
  let c: TestCtx;
  let manager: string;
  let admin: string;
  beforeAll(async () => {
    c = await startCtx();
    manager = await c.login('manager');
    admin = await c.login('admin');
  });
  afterAll(() => c.close());

  it('the status says so without raising an alarm, and a backup now is refused with a clear reason', async () => {
    const s = await c.http.get(`${api}/backups/status`).set(auth(manager));
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ configured: false, stale: false, lastBackupAt: null });
    const run = await c.http.post(`${api}/backups`).set(auth(admin));
    expect(run.status).toBe(409);
    expect(run.body.code).toBe('BACKUP_NOT_CONFIGURED');
  });
});

describe('backups are set up', () => {
  let c: TestCtx;
  let dir: string;
  let copyDir: string;
  let cashier: string;
  let manager: string;
  let admin: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pos-bk-main-'));
    copyDir = mkdtempSync(join(tmpdir(), 'pos-bk-copy-'));
    c = await startCtx({ backup: { dir, copyDir, passphrase: PASS, keep: 5 } });
    cashier = await c.login('cashier');
    manager = await c.login('manager');
    admin = await c.login('admin');
  });
  afterAll(async () => {
    await c.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(copyDir, { recursive: true, force: true });
  });

  it('only an admin may list or run backups; a manager may see the short status; a cashier nothing', async () => {
    expect((await c.http.get(`${api}/backups`).set(auth(manager))).status).toBe(403);
    expect((await c.http.post(`${api}/backups`).set(auth(manager))).status).toBe(403);
    expect((await c.http.get(`${api}/backups/status`).set(auth(manager))).status).toBe(200);
    expect((await c.http.get(`${api}/backups/status`).set(auth(cashier))).status).toBe(403);
    expect((await c.http.get(`${api}/backups`).set(auth(cashier))).status).toBe(403);
  });

  it('before the first backup the status says it is overdue', async () => {
    const s = await c.http.get(`${api}/backups/status`).set(auth(manager));
    expect(s.body).toMatchObject({ configured: true, encrypted: true, hasSecondCopy: true, lastBackupAt: null, stale: true });
  });

  it('an admin runs a backup: it is encrypted, copied to the second place, listed, and recorded in the audit log', async () => {
    const run = await c.http.post(`${api}/backups`).set(auth(admin));
    expect(run.status).toBe(201);
    expect(run.body).toMatchObject({ encrypted: true, copiedTo: true, copyError: null });
    expect(run.body.file).toMatch(/^pos-\d{8}-\d{6}\.db\.enc$/);

    const list = await c.http.get(`${api}/backups`).set(auth(admin));
    expect(list.body.files.map((f: { file: string }) => f.file)).toEqual([run.body.file]);
    expect(list.body.files[0]).toMatchObject({ encrypted: true });
    expect(list.body.lastRun).toMatchObject({ ok: true, trigger: 'manual', file: run.body.file });

    const s = await c.http.get(`${api}/backups/status`).set(auth(manager));
    expect(s.body).toMatchObject({ stale: false, lastRunOk: true });
    expect(s.body.lastBackupAt).toBeTruthy();

    const db = new Database(c.databasePath, { readonly: true });
    try {
      const row = db.prepare(`SELECT entity_id FROM audit_log WHERE action = 'backup.run'`).get() as { entity_id: string };
      expect(row.entity_id).toBe(run.body.file);
    } finally {
      db.close();
    }
  });

  it('the passphrase never appears in any answer', async () => {
    const texts = [
      JSON.stringify((await c.http.get(`${api}/backups`).set(auth(admin))).body),
      JSON.stringify((await c.http.get(`${api}/backups/status`).set(auth(manager))).body),
    ];
    for (const t of texts) expect(t).not.toContain(PASS);
  });

  it('when the backup cannot be made, the admin is told why in plain words', async () => {
    // A context whose backup folder cannot exist: it would have to sit inside a file.
    const broken = await startCtx({ backup: { dir: join(c.databasePath, 'inside'), keep: 5 } });
    try {
      const token = await broken.login('admin');
      const run = await broken.http.post(`${api}/backups`).set(auth(token));
      expect(run.status).toBe(500);
      expect(run.body.code).toBe('BACKUP_FAILED');
      expect(run.body.detail).toMatch(/could not be made/);
      const s = await broken.http.get(`${api}/backups`).set(auth(token));
      expect(s.body.lastRun).toMatchObject({ ok: false });
    } finally {
      await broken.close();
    }
  });
});
