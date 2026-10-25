import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

describe('restoring a backup from the screen (US-30)', () => {
  let c: TestCtx;
  let dir: string;
  let restarts = 0;
  let cashier: string;
  let manager: string;
  let admin: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pos-bk-restore-'));
    c = await startCtx({ backup: { dir, passphrase: PASS, keep: 5 }, restart: () => void restarts++ });
    cashier = await c.login('cashier');
    manager = await c.login('manager');
    admin = await c.login('admin');
  });
  afterAll(async () => {
    await c.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('only an admin may restore, and only with an explicit confirmation of a listed backup', async () => {
    const body = { file: 'pos-20260101-000000.db.enc', confirm: true };
    expect((await c.http.post(`${api}/backups/restore`).set(auth(cashier)).send(body)).status).toBe(403);
    expect((await c.http.post(`${api}/backups/restore`).set(auth(manager)).send(body)).status).toBe(403);
    expect((await c.http.post(`${api}/backups/restore`).send(body)).status).toBe(401);
    expect((await c.http.post(`${api}/backups/restore`).set(auth(admin)).send({ file: body.file })).status).toBe(400); // no confirmation
    expect((await c.http.post(`${api}/backups/restore`).set(auth(admin)).send({ file: '../../pos.db', confirm: true })).status).toBe(400); // not a backup name
    expect((await c.http.post(`${api}/backups/restore`).set(auth(admin)).send(body)).status).toBe(404); // well named, but not there
    expect(restarts).toBe(0);
    expect(existsSync(`${c.databasePath}.restore-pending`)).toBe(false);
  });

  it('a damaged backup is refused with a reason, and nothing is queued', async () => {
    writeFileSync(join(dir, 'pos-20260102-000000.db.enc'), Buffer.alloc(200, 1));
    const r = await c.http.post(`${api}/backups/restore`).set(auth(admin)).send({ file: 'pos-20260102-000000.db.enc', confirm: true });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('BACKUP_UNUSABLE');
    expect(existsSync(`${c.databasePath}.restore-pending`)).toBe(false);
    expect(restarts).toBe(0);
  });

  it('a good backup: the current data is backed up first, a note is left, it is audited, and the server is asked to restart', async () => {
    const made = await c.http.post(`${api}/backups`).set(auth(admin));
    const before = (await c.http.get(`${api}/backups`).set(auth(admin))).body.files.length;
    const r = await c.http.post(`${api}/backups/restore`).set(auth(admin)).send({ file: made.body.file, confirm: true });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ restarting: true, file: made.body.file });
    expect(r.body.safetyBackup).toMatch(BACKUP_NAME_RE);
    expect(JSON.parse(readFileSync(`${c.databasePath}.restore-pending`, 'utf8')).from).toBe(join(dir, made.body.file));
    expect((await c.http.get(`${api}/backups`).set(auth(admin))).body.files.length).toBe(before + 1); // the safety backup
    expect(JSON.stringify(r.body)).not.toContain(PASS);
    await vi.waitFor(() => expect(restarts).toBe(1));

    const db = new Database(c.databasePath, { readonly: true });
    try {
      const row = db.prepare(`SELECT entity_id FROM audit_log WHERE action = 'backup.restore'`).get() as { entity_id: string };
      expect(row.entity_id).toBe(made.body.file);
    } finally {
      db.close();
    }
  });

  it('without backups set up the answer says so', async () => {
    const bare = await startCtx();
    try {
      const token = await bare.login('admin');
      const r = await bare.http.post(`${api}/backups/restore`).set(auth(token)).send({ file: 'pos-20260101-000000.db', confirm: true });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('BACKUP_NOT_CONFIGURED');
    } finally {
      await bare.close();
    }
  });
});
const BACKUP_NAME_RE = /^pos-\d{8}-\d{6}(-\d+)?\.db\.enc$/;

describe('deleting a backup by hand (US-30)', () => {
  let c: TestCtx;
  let dir: string;
  let copyDir: string;
  let cashier: string;
  let manager: string;
  let admin: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pos-bk-del-'));
    copyDir = mkdtempSync(join(tmpdir(), 'pos-bk-del-copy-'));
    c = await startCtx({ backup: { dir, copyDir, keep: 5 } });
    cashier = await c.login('cashier');
    manager = await c.login('manager');
    admin = await c.login('admin');
  });
  afterAll(async () => {
    await c.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(copyDir, { recursive: true, force: true });
  });

  it('only an admin may; the file goes from the folder and the list, the second copy stays, and it is audited', async () => {
    const made = await c.http.post(`${api}/backups`).set(auth(admin));
    const file = made.body.file as string;
    expect(existsSync(join(dir, file))).toBe(true);
    expect(existsSync(join(copyDir, file))).toBe(true);

    expect((await c.http.delete(`${api}/backups/${file}`).set(auth(cashier))).status).toBe(403);
    expect((await c.http.delete(`${api}/backups/${file}`).set(auth(manager))).status).toBe(403);
    expect((await c.http.delete(`${api}/backups/${file}`)).status).toBe(401);
    expect(existsSync(join(dir, file))).toBe(true);

    expect((await c.http.delete(`${api}/backups/${file}`).set(auth(admin))).status).toBe(204);
    expect(existsSync(join(dir, file))).toBe(false);
    expect(existsSync(join(copyDir, file))).toBe(true); // the copy that survives this PC is left alone
    const list = await c.http.get(`${api}/backups`).set(auth(admin));
    expect(list.body.files.some((f: { file: string }) => f.file === file)).toBe(false);
    expect((await c.http.delete(`${api}/backups/${file}`).set(auth(admin))).status).toBe(404); // already gone

    const log = await c.http.get(`${api}/audit?entity=backup&entityId=${file}&action=backup.delete`).set(auth(admin));
    expect(log.body.data[0].before).toMatchObject({ wasNewest: true, remaining: 0 });
  });

  it('only a file the folder lists, by its own name: nothing else can be named', async () => {
    writeFileSync(join(dir, 'notes.txt'), 'not a backup');
    writeFileSync(join(dir, 'pos-20200101-000000.txt'), 'not a backup either');
    for (const bad of ['notes.txt', '..%2F..%2Fpackage.json', '%2e%2e%2fpos.db', 'pos-2020.db']) {
      const r = await c.http.delete(`${api}/backups/${bad}`).set(auth(admin));
      expect([400, 404], bad).toContain(r.status);
    }
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true);
  });

  it('without backups set up the answer says so', async () => {
    const bare = await startCtx();
    try {
      const token = await bare.login('admin');
      const r = await bare.http.delete(`${api}/backups/pos-20260101-000000.db`).set(auth(token));
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('BACKUP_NOT_CONFIGURED');
    } finally {
      await bare.close();
    }
  });
});
