import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../apps/api/src/db/migrate';
import { seedTestData } from '../../apps/api/src/db/seed-test';
import { storeImage } from '../../apps/api/src/modules/catalog/images';
import { png } from '../helpers/images';

// The restore drill, run the way the owner would run it: the real command-line tools, as separate processes.
const repo = resolve(__dirname, '..', '..');
const PASS = 'correct horse battery staple';
let root: string;
let live: string;
let backups: string;
let picture: string; // the name of a product picture kept in the live pictures folder

const run = (script: 'backup' | 'restore', args: string[], env: Record<string, string>) => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(repo, 'apps', 'api', 'src', 'cli', `${script}.ts`), ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_PATH: live, BACKUP_DIR: backups, BACKUP_PASSPHRASE: PASS, ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const rows = (path: string) => {
  const db = new Database(path, { readonly: true });
  try {
    return (db.prepare('SELECT count(*) AS n FROM products').get() as { n: number }).n;
  } finally {
    db.close();
  }
};
const backupFile = () =>
  join(
    backups,
    readdirSync(backups).find((f) => f.endsWith('.db.enc'))!,
  );

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pos-drill-'));
  live = join(root, 'live', 'pos.db');
  backups = join(root, 'backups');
  mkdirSync(join(root, 'live'));
  migrate(live);
  await seedTestData(live);
  picture = storeImage(join(root, 'live', 'uploads'), png('drill'))!.file;
}, 60_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('backup and restore from the command line (US-30)', () => {
  it('npm run backup writes an encrypted backup and says so', () => {
    const r = run('backup', [], {});
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/Backup written: .*pos-\d{8}-\d{6}\.db\.enc \(.*encrypted\)/);
    expect(readdirSync(backups).filter((f) => f.endsWith('.db.enc'))).toHaveLength(1);
    expect(r.out).toMatch(/Pictures: 1 new picture copied/);
    expect(readdirSync(join(backups, 'uploads'))).toEqual([picture]); // the pictures are saved beside the database
  }, 60_000);

  it('refuses without a place to put it', () => {
    const r = run('backup', [], { BACKUP_DIR: '' });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/Say where to put it/);
  }, 60_000);

  it('restore puts it on another PC: same products, and the original is untouched', () => {
    const elsewhere = join(root, 'second-pc', 'pos.db');
    const r = run('restore', ['--from', backupFile(), '--db', elsewhere], {});
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/Restored into/);
    expect(rows(elsewhere)).toBe(rows(live));
    expect(r.out).toMatch(/Pictures: 1 picture put back/);
    expect(readdirSync(join(root, 'second-pc', 'uploads'))).toEqual([picture]); // and put back with it
  }, 60_000);

  it('restore will not overwrite a database unless told to, and says nothing was changed', () => {
    const r = run('restore', ['--from', backupFile()], {});
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/already exists/);
    expect(r.err).toMatch(/nothing was changed/);
  }, 60_000);

  it('a wrong passphrase changes nothing', () => {
    const before = readdirSync(join(root, 'live')).sort();
    const r = run('restore', ['--from', backupFile(), '--force'], { BACKUP_PASSPHRASE: 'definitely the wrong one' });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/passphrase is wrong, or the backup file is damaged/);
    expect(readdirSync(join(root, 'live')).sort()).toEqual(before);
  }, 60_000);

  it('with --force it replaces the live database and keeps the old one beside it', () => {
    const r = run('restore', ['--from', backupFile(), '--force'], {});
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/is kept as .*before-restore-/);
    const kept = readdirSync(join(root, 'live')).filter((f) => f.includes('before-restore') && !f.endsWith('-wal') && !f.endsWith('-shm'));
    expect(kept).toHaveLength(1);
    expect(rows(live)).toBe(rows(join(root, 'live', kept[0]!)));
    expect(existsSync(`${live}.restoring`)).toBe(false);
  }, 60_000);
});
