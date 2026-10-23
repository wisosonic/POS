import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BACKUP_NAME,
  BackupError,
  createBackup,
  isEncryptedFile,
  listBackups,
  restoreBackup,
  verifyBackupFile,
  verifyDatabaseFile,
} from '../../apps/api/src/backup/backup';
import { applyPendingRestore, pendingRestorePath, requestRestore } from '../../apps/api/src/backup/pending';
import { migrate } from '../../apps/api/src/db/migrate';
import { openDatabase, type Db } from '../../apps/api/src/db/open';
import { storeImage } from '../../apps/api/src/modules/catalog/images';
import { gif, jpeg, png } from '../helpers/images';
import { seedTestData } from '../../apps/api/src/db/seed-test';

// US-30 backups: a copy taken while the till keeps working, checked before it counts, optionally encrypted, and restorable.
const PASS = 'correct horse battery staple';
let root: string;
let dbPath: string;
let db: Db;
let n = 0;
const fresh = (name: string) => {
  const dir = join(root, `${name}-${++n}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const count = (path: string, table: string) => {
  const c = new Database(path, { readonly: true });
  try {
    return (c.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    c.close();
  }
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pos-backup-'));
  dbPath = join(root, 'live.db');
  migrate(dbPath);
  await seedTestData(dbPath);
  db = openDatabase(dbPath);
});
afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('taking a backup', () => {
  it('writes a verified copy that holds the same data and is named so it sorts by time', async () => {
    const dir = fresh('plain');
    const r = await createBackup(db, { dir, now: new Date('2026-10-20T23:30:00Z') });
    expect(r.file).toBe('pos-20261020-233000.db');
    expect(r.encrypted).toBe(false);
    expect(BACKUP_NAME.test(r.file)).toBe(true);
    expect(() => verifyDatabaseFile(r.path)).not.toThrow();
    expect(count(r.path, 'products')).toBe(count(dbPath, 'products'));
    expect(count(r.path, 'users')).toBe(count(dbPath, 'users'));
    expect(readdirSync(dir)).toEqual([r.file]); // no half-made files left behind
  });

  it('is consistent even while sales keep being written', async () => {
    const dir = fresh('busy');
    let writes = 0;
    const done = createBackup(db, { dir });
    let finished = false;
    void done.finally(() => (finished = true));
    while (!finished && writes < 5000) {
      db.prepare(`INSERT INTO customers (name) VALUES (?)`).run(`busy ${writes++}`);
      await new Promise((r) => setImmediate(r));
    }
    const r = await done;
    expect(() => verifyDatabaseFile(r.path)).not.toThrow();
    expect(count(r.path, 'customers')).toBeLessThanOrEqual(count(dbPath, 'customers'));
  });

  it('two backups in the same second get different names', async () => {
    const dir = fresh('same-second');
    const now = new Date('2026-10-20T10:00:00Z');
    const a = await createBackup(db, { dir, now });
    const b = await createBackup(db, { dir, now });
    expect(a.file).not.toBe(b.file);
    expect((await listBackups(dir)).map((f) => f.file)).toHaveLength(2);
  });

  it('keeps only the newest N, in the main folder and in the second copy', async () => {
    const dir = fresh('prune');
    const copyDir = fresh('prune-copy');
    for (const day of ['18', '19', '20', '21'])
      await createBackup(db, { dir, copyDir, keep: 2, now: new Date(`2026-10-${day}T02:00:00Z`) });
    const names = async (d: string) => (await listBackups(d)).map((f) => f.file);
    expect(await names(dir)).toEqual(['pos-20261021-020000.db', 'pos-20261020-020000.db']);
    expect(await names(copyDir)).toEqual(['pos-20261021-020000.db', 'pos-20261020-020000.db']);
  });

  it('a second copy that cannot be written is reported, and the backup itself still counts', async () => {
    const dir = fresh('bad-copy');
    const notAFolder = join(fresh('bad-copy-parent'), 'file.txt');
    writeFileSync(notAFolder, 'x');
    const r = await createBackup(db, { dir, copyDir: join(notAFolder, 'inside') });
    expect(r.copyError).toBeTruthy();
    expect(existsSync(r.path)).toBe(true);
  });

  it('a backup that fails leaves nothing that looks like a backup', async () => {
    const dir = fresh('failed');
    const other = openDatabase(join(root, 'closing.db'));
    other.close();
    await expect(createBackup(other, { dir })).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('encryption', () => {
  it('an encrypted backup is unreadable without the passphrase and leaves no plain copy', async () => {
    const dir = fresh('enc');
    const r = await createBackup(db, { dir, passphrase: PASS });
    expect(r.file.endsWith('.db.enc')).toBe(true);
    expect(isEncryptedFile(r.path)).toBe(true);
    const bytes = readFileSync(r.path);
    expect(bytes.subarray(0, 16).toString('latin1')).not.toContain('SQLite format 3');
    expect(bytes.includes(Buffer.from('Test Supplier'))).toBe(false); // data from the seed is not visible
    expect(readdirSync(dir)).toEqual([r.file]);
  });

  it('restores with the right passphrase', async () => {
    const dir = fresh('enc-ok');
    const r = await createBackup(db, { dir, passphrase: PASS });
    const to = join(fresh('enc-ok-target'), 'pos.db');
    await restoreBackup({ from: r.path, to, passphrase: PASS });
    expect(count(to, 'products')).toBe(count(dbPath, 'products'));
  });

  it('refuses a wrong passphrase, a missing one, a damaged file and a cut-off file, and creates nothing', async () => {
    const dir = fresh('enc-bad');
    const r = await createBackup(db, { dir, passphrase: PASS });
    const target = join(fresh('enc-bad-target'), 'pos.db');
    const attempt = (from: string, passphrase?: string) => restoreBackup({ from, to: target, passphrase });

    await expect(attempt(r.path, 'a different passphrase')).rejects.toMatchObject({ code: 'WRONG_PASSPHRASE_OR_DAMAGED' });
    await expect(attempt(r.path)).rejects.toMatchObject({ code: 'PASSPHRASE_REQUIRED' });

    const bytes = readFileSync(r.path);
    const flipped = Buffer.from(bytes);
    flipped[Math.floor(bytes.length / 2)]! ^= 0xff;
    const damaged = join(dir, 'damaged.enc');
    writeFileSync(damaged, flipped);
    await expect(attempt(damaged, PASS)).rejects.toMatchObject({ code: 'WRONG_PASSPHRASE_OR_DAMAGED' });

    const cut = join(dir, 'cut.enc');
    writeFileSync(cut, bytes.subarray(0, bytes.length - 100));
    await expect(attempt(cut, PASS)).rejects.toMatchObject({ code: 'WRONG_PASSPHRASE_OR_DAMAGED' });

    expect(existsSync(target)).toBe(false);
    expect(readdirSync(join(target, '..'))).toEqual([]); // not even a temporary file
  });

  it('refuses a passphrase that is too short, before doing anything', async () => {
    const dir = fresh('short');
    await expect(createBackup(db, { dir, passphrase: 'short' })).rejects.toBeInstanceOf(BackupError);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });
});

describe('restoring', () => {
  it('will not replace an existing database without being told to', async () => {
    const r = await createBackup(db, { dir: fresh('r1') });
    const target = join(fresh('r1-target'), 'pos.db');
    writeFileSync(target, 'precious');
    await expect(restoreBackup({ from: r.path, to: target })).rejects.toMatchObject({ code: 'TARGET_EXISTS' });
    expect(readFileSync(target, 'utf8')).toBe('precious');
  });

  it('with force, keeps the old database beside the new one, with its log files', async () => {
    const r = await createBackup(db, { dir: fresh('r2') });
    const dir = fresh('r2-target');
    const target = join(dir, 'pos.db');
    writeFileSync(target, 'old database');
    writeFileSync(`${target}-wal`, 'old log');
    const out = await restoreBackup({ from: r.path, to: target, force: true, now: new Date('2026-10-20T12:00:00Z') });
    expect(out.previous).toBe(`${target}.before-restore-20261020-120000`);
    expect(readFileSync(out.previous!, 'utf8')).toBe('old database');
    expect(readFileSync(`${out.previous}-wal`, 'utf8')).toBe('old log');
    expect(existsSync(`${target}-wal`)).toBe(false); // the old log must not be replayed onto the restored file
    expect(count(target, 'products')).toBe(count(dbPath, 'products'));
  });

  it('refuses a file that is not a backup, and leaves the existing database alone', async () => {
    const dir = fresh('r3');
    const target = join(dir, 'pos.db');
    writeFileSync(target, 'precious');
    const junk = join(dir, 'junk.db');
    writeFileSync(junk, Buffer.from('this is not a database '.repeat(50)));
    await expect(restoreBackup({ from: junk, to: target, force: true })).rejects.toMatchObject({ code: 'NOT_A_BACKUP' });

    const stranger = join(dir, 'stranger.db');
    const s = new Database(stranger);
    s.exec('CREATE TABLE something_else (x)');
    s.close();
    await expect(restoreBackup({ from: stranger, to: target, force: true })).rejects.toMatchObject({ code: 'NOT_A_BACKUP' });

    await expect(restoreBackup({ from: join(dir, 'missing.db'), to: target, force: true })).rejects.toMatchObject({ code: 'NOT_A_BACKUP' });
    expect(readFileSync(target, 'utf8')).toBe('precious');
    expect(readdirSync(dir).sort()).toEqual(['junk.db', 'pos.db', 'stranger.db']);
  });

  it('a restored database passes the app’s own checks and can be opened for use', async () => {
    const r = await createBackup(db, { dir: fresh('r4'), passphrase: PASS });
    const target = join(fresh('r4-target'), 'pos.db');
    await restoreBackup({ from: r.path, to: target, passphrase: PASS });
    const reopened = openDatabase(target);
    try {
      expect(reopened.pragma('foreign_keys', { simple: true })).toBe(1);
      expect((reopened.prepare('SELECT count(*) AS n FROM schema_migrations').get() as { n: number }).n).toBeGreaterThan(0);
    } finally {
      reopened.close();
    }
  });
});

describe('product pictures are backed up with the database', () => {
  const pictures = (dir: string) => (existsSync(join(dir, 'uploads')) ? readdirSync(join(dir, 'uploads')).sort() : []);

  it('copies them to the backup folder and to the second copy, and a later backup adds only what is new', async () => {
    const live = fresh('pics-live');
    const dir = fresh('pics-main');
    const copyDir = fresh('pics-second');
    const one = storeImage(live, png('one'))!;
    const first = await createBackup(db, { dir, copyDir, uploadsDir: live, now: new Date('2026-10-20T01:00:00Z') });
    expect(first.pictures).toEqual({ copied: 1 });
    expect(pictures(dir)).toEqual([one.file]);
    expect(pictures(copyDir)).toEqual([one.file]);

    const two = storeImage(live, jpeg('two'))!;
    const second = await createBackup(db, { dir, copyDir, uploadsDir: live, now: new Date('2026-10-21T01:00:00Z') });
    expect(second.pictures).toEqual({ copied: 1 }); // only the new one
    expect(pictures(dir)).toEqual([one.file, two.file].sort());
    expect(pictures(copyDir)).toEqual([one.file, two.file].sort());

    const third = await createBackup(db, { dir, copyDir, uploadsDir: live, now: new Date('2026-10-22T01:00:00Z') });
    expect(third.pictures).toEqual({ copied: 0 });
  });

  it('copies only whole picture names: a web page or a half-copied file in the folder is left where it is', async () => {
    const live = fresh('pics-junk');
    const dir = fresh('pics-junk-main');
    const kept = storeImage(live, png('real'))!;
    writeFileSync(join(live, 'saved-page.html'), '<html>hello</html>');
    writeFileSync(join(live, `${kept.file}.tmp`), 'half');
    writeFileSync(join(live, '0123456789abcdef01234567.html'), '<html></html>');
    await createBackup(db, { dir, uploadsDir: live });
    expect(pictures(dir)).toEqual([kept.file]);
  });

  it('a pictures folder that does not exist yet is fine', async () => {
    const dir = fresh('pics-none');
    const r = await createBackup(db, { dir, uploadsDir: join(root, 'no-such-folder') });
    expect(r.pictures).toEqual({ copied: 0 });
    expect(existsSync(r.path)).toBe(true);
  });

  it('pictures are kept as they are (not encrypted), and are not removed when old database backups are', async () => {
    const live = fresh('pics-enc');
    const dir = fresh('pics-enc-main');
    const kept = storeImage(live, gif('enc'))!;
    for (const day of ['18', '19', '20'])
      await createBackup(db, { dir, uploadsDir: live, passphrase: PASS, keep: 1, now: new Date(`2026-10-${day}T01:00:00Z`) });
    expect((await listBackups(dir)).map((f) => f.file)).toHaveLength(1); // old database backups were pruned
    expect(pictures(dir)).toEqual([kept.file]);
    expect(readFileSync(join(dir, 'uploads', kept.file))).toEqual(gif('enc'));
  });

  it('a problem with the pictures is reported, and the database backup still counts', async () => {
    const live = fresh('pics-problem');
    const dir = fresh('pics-problem-main');
    storeImage(live, png('problem'));
    writeFileSync(join(dir, 'uploads'), 'a file where the pictures folder should be');
    const r = await createBackup(db, { dir, uploadsDir: live });
    expect(r.pictures?.error).toBeTruthy();
    expect(existsSync(r.path)).toBe(true);
    expect(() => verifyDatabaseFile(r.path)).not.toThrow();
  });
});

describe('a restore chosen on the Backups screen (US-30)', () => {
  it('is checked without being put anywhere, and a wrong passphrase or a damaged file is refused', async () => {
    const dir = fresh('verify');
    const r = await createBackup(db, { dir, passphrase: PASS });
    await expect(verifyBackupFile(r.path, PASS)).resolves.toBeUndefined();
    await expect(verifyBackupFile(r.path, 'another passphrase here')).rejects.toMatchObject({ code: 'WRONG_PASSPHRASE_OR_DAMAGED' });
    await expect(verifyBackupFile(r.path)).rejects.toMatchObject({ code: 'PASSPHRASE_REQUIRED' });
    await expect(verifyBackupFile(join(dir, 'missing.db'))).rejects.toMatchObject({ code: 'NOT_A_BACKUP' });
    expect(readdirSync(dir)).toEqual([r.file]); // nothing left behind
  });

  it('is applied at the next start: the backup replaces the database, the old one is kept, and the note is gone', async () => {
    const dir = fresh('pending');
    const target = join(dir, 'pos.db');
    migrate(target);
    const live = openDatabase(target);
    live.prepare(`INSERT INTO categories (name) VALUES ('Before the backup')`).run();
    const backup = await createBackup(live, { dir: join(dir, 'backups'), passphrase: PASS });
    live.prepare(`INSERT INTO categories (name) VALUES ('After the backup')`).run();
    live.close();
    const before = count(target, 'categories');

    requestRestore(target, backup.path);
    expect(existsSync(pendingRestorePath(target))).toBe(true);
    const said = await applyPendingRestore(target, PASS, join(dir, 'uploads'));
    expect(said).toMatch(/^restored /);
    expect(existsSync(pendingRestorePath(target))).toBe(false);
    expect(count(target, 'categories')).toBe(before - 1); // the later row is gone
    expect(readdirSync(dir).some((f) => f.startsWith('pos.db.before-restore-'))).toBe(true);
    expect(await applyPendingRestore(target, PASS, join(dir, 'uploads'))).toBeNull(); // nothing waiting now
  });

  it('a backup that cannot be read changes nothing, and the note is still cleared so it is not tried at every start', async () => {
    const dir = fresh('pending-bad');
    const target = join(dir, 'pos.db');
    migrate(target);
    const before = count(target, 'schema_migrations');
    requestRestore(target, join(dir, 'pos-20260101-000000.db'));
    expect(await applyPendingRestore(target, undefined, join(dir, 'uploads'))).toMatch(/restore FAILED/);
    expect(existsSync(pendingRestorePath(target))).toBe(false);
    expect(count(target, 'schema_migrations')).toBe(before);
    expect(readdirSync(dir).filter((f) => f.includes('before-restore'))).toEqual([]);
  });
});
