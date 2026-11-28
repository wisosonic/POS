import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BackupError, createBackup, listBackups, restoreBackup, verifyBackupFile } from '../src/backup/backup';
import { BackupService, STALE_AFTER_MS } from '../src/backup/service';
import { adminAuth, startHq, type Hq } from './helpers';

// HQ's backups (docs/07 §3, P7): a safe copy while HQ keeps working, checked before it counts, optionally encrypted, restorable, and reported. HQ holds the whole
// chain, payroll included, so a backup that cannot be restored is the failure to prevent.
const api = '/api/v1';
const PASSPHRASE = 'a-long-backup-passphrase';
let root = '';
let hq: Hq;
let dir = '';
let copy = '';

const counts = (path: string) => {
  const db = new Database(path, { readonly: true });
  try {
    const n = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    return { branches: n('branches'), employees: n('employees'), migrations: n('schema_migrations') };
  } finally {
    db.close();
  }
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'hq-backup-'));
  dir = join(root, 'main');
  copy = join(root, 'second');
  hq = await startHq({ backup: { dir, copyDir: copy, passphrase: PASSPHRASE, keep: 3 } });
  expect((await hq.http.post(`${api}/branches`).set(adminAuth).send({ code: 'B1', name: 'Hamra' })).status).toBe(201);
  expect((await hq.http.post(`${api}/employees`).set(adminAuth).send({ code: 'SAMI', name: 'Sami', branchIds: [] })).status).toBe(201);
});
afterAll(async () => {
  await hq.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('taking a backup of HQ (US-OPS-backup)', () => {
  it('is made while HQ runs, encrypted, in two places, and restores into the same HQ', async () => {
    const made = await hq.http.post(`${api}/backups`).set(adminAuth);
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ encrypted: true, copyError: null });
    expect(made.body.file).toMatch(/^hq-\d{8}-\d{6}\.db\.enc$/);
    expect(existsSync(join(copy, made.body.file))).toBe(true);
    // it is not a readable database without the passphrase (and the handle is closed again: Windows will not delete a file that is still open)
    const peek = new Database(join(dir, made.body.file), { readonly: true });
    try {
      expect(() => peek.prepare('SELECT 1 FROM sqlite_master').get()).toThrow();
    } finally {
      peek.close();
    }

    const to = join(root, 'restored', 'hq.db');
    expect(await restoreBackup({ from: join(dir, made.body.file), to, passphrase: PASSPHRASE })).toMatchObject({ to });
    expect(counts(to)).toEqual(counts(hq.databasePath));
    expect(counts(to).employees).toBe(1);
    // the restored copy is a whole HQ: it opens with HQ's own code and the new data is there
    const again = await startHq({ databasePath: to });
    try {
      expect((await again.http.get(`${api}/employees`).set(adminAuth)).body.data).toHaveLength(1);
    } finally {
      await again.stop();
    }
  });

  it('a wrong passphrase restores nothing, and a damaged file changes nothing', async () => {
    const file = join(dir, (await listBackups(dir))[0]!.file);
    const to = join(root, 'wrong', 'hq.db');
    await expect(restoreBackup({ from: file, to, passphrase: 'not-the-right-passphrase' })).rejects.toMatchObject({
      code: 'WRONG_PASSPHRASE_OR_DAMAGED',
    });
    expect(existsSync(to)).toBe(false);
    await expect(restoreBackup({ from: file, to })).rejects.toMatchObject({ code: 'PASSPHRASE_REQUIRED' });
    await expect(verifyBackupFile(file, PASSPHRASE)).resolves.toBeUndefined();
  });

  it("a branch's database is refused as an HQ backup, and replacing HQ keeps the old one", async () => {
    const fake = join(root, 'branch.db');
    const b = new Database(fake);
    b.exec('CREATE TABLE schema_migrations (id TEXT); CREATE TABLE products (id INTEGER)');
    b.close();
    await expect(restoreBackup({ from: fake, to: join(root, 'x', 'hq.db') })).rejects.toMatchObject({ code: 'NOT_A_BACKUP' });
    // an existing HQ is only replaced on purpose, and is kept beside the new one
    const to = join(root, 'replace', 'hq.db');
    const file = join(dir, (await listBackups(dir))[0]!.file);
    await restoreBackup({ from: file, to, passphrase: PASSPHRASE });
    await expect(restoreBackup({ from: file, to, passphrase: PASSPHRASE })).rejects.toMatchObject({ code: 'TARGET_EXISTS' });
    const r = await restoreBackup({ from: file, to, passphrase: PASSPHRASE, force: true });
    expect(r.previous).toBeDefined();
    expect(existsSync(r.previous!)).toBe(true);
  });

  it('keeps only the newest few, in both places, and refuses a short passphrase', async () => {
    for (let i = 0; i < 4; i++) await hq.http.post(`${api}/backups`).set(adminAuth);
    expect((await listBackups(dir)).length).toBe(3);
    expect((await listBackups(copy)).length).toBe(3);
    const raw = new Database(hq.databasePath, { readonly: true });
    try {
      await expect(createBackup(raw, { dir: join(root, 'short'), passphrase: 'short' })).rejects.toBeInstanceOf(BackupError);
    } finally {
      raw.close();
    }
    expect(existsSync(join(root, 'short'))).toBe(false);
  });
});

describe('backups in the same second (US-OPS-backup)', () => {
  it('the later one is the newest, so it is the one kept when old ones are removed', async () => {
    const folder = join(root, 'same-second');
    const raw = new Database(hq.databasePath, { readonly: true });
    try {
      const now = new Date('2026-11-20T09:00:00Z');
      for (let i = 0; i < 3; i++) await createBackup(raw, { dir: folder, now, keep: 2 });
      const names = (await listBackups(folder)).map((b) => b.file);
      expect(names).toEqual(['hq-20261120-090000-2.db', 'hq-20261120-090000-1.db']); // the first one was the oldest and is gone
    } finally {
      raw.close();
    }
  });
});

describe('the backup page and its guard (US-OPS-backup)', () => {
  it('shows the last backup to an admin only, and not configured says so', async () => {
    const status = await hq.http.get(`${api}/backups`).set(adminAuth);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ configured: true, encrypted: true, hasSecondCopy: true, stale: false });
    expect(status.body.files.length).toBeGreaterThan(0);
    expect(JSON.stringify(status.body)).not.toContain(PASSPHRASE);
    expect((await hq.http.get(`${api}/backups`)).status).toBe(401);
    const bare = await startHq();
    try {
      expect((await bare.http.get(`${api}/backups`).set(adminAuth)).body).toMatchObject({ configured: false, files: [] });
      expect((await bare.http.post(`${api}/backups`).set(adminAuth)).body.code).toBe('BACKUP_NOT_CONFIGURED');
    } finally {
      await bare.close();
    }
  });

  it('is overdue after 36 hours, due once a day from the chosen time, and catches up after a day off', async () => {
    const folder = join(root, 'svc');
    mkdirSync(folder, { recursive: true });
    const raw = new Database(hq.databasePath, { readonly: true });
    try {
      let now = new Date('2026-11-20T09:00:00Z'); // 11:00 in Beirut
      const svc = new BackupService(raw, { dir: folder, at: '02:00', keep: 5 }, undefined, () => now);
      expect((await svc.status()).stale).toBe(true); // nothing yet
      expect(await svc.due()).toBe(true); // it is past 02:00 and none was taken today
      await svc.run('schedule');
      expect((await svc.status()).stale).toBe(false);
      expect(await svc.due()).toBe(false); // once a day
      // the file's time is real time: 37 hours after it, the backup is overdue
      now = new Date(Date.now() + STALE_AFTER_MS + 3_600_000);
      expect((await svc.status()).stale).toBe(true);
    } finally {
      raw.close();
    }
  });
});
