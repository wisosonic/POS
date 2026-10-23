import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../../apps/api/src/db/migrate';
import { seedTestData } from '../../apps/api/src/db/seed-test';

// US-29 (cut-over): the pre-flight check says what is missing on the till PC, and never prints a secret.
const SECRET = 'jwt-secret-that-must-never-be-printed-0123456789';
const PASSPHRASE = 'backup-passphrase-never-printed';
let dir: string;
let dbPath: string;

const settings = (over: Record<string, string | null> = {}) => {
  const base: Record<string, string | null> = {
    DATABASE_PATH: dbPath,
    JWT_SECRET: SECRET,
    BACKUP_DIR: join(dir, 'backups'),
    BACKUP_COPY_DIR: join(dir, 'copy'),
    BACKUP_PASSPHRASE: PASSPHRASE,
    WEB_DIST: join(dir, 'web'),
    PORT: '3987', // nothing listens here
  };
  const file = join(dir, `settings-${Math.random().toString(36).slice(2)}.env`);
  writeFileSync(
    file,
    Object.entries({ ...base, ...over })
      .filter(([, v]) => v !== null)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
  );
  return file;
};
const run = (envFile: string) => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', resolve('apps/api/src/cli/preflight.ts'), '--env', envFile], {
    encoding: 'utf8',
    // Nothing from the developer's own environment may leak into the check.
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
    timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pos-preflight-'));
  dbPath = join(dir, 'pos.db');
  migrate(dbPath);
  await seedTestData(dbPath);
  mkdirSync(join(dir, 'backups'));
  mkdirSync(join(dir, 'copy'));
  mkdirSync(join(dir, 'web'));
  writeFileSync(join(dir, 'web', 'index.html'), '<!doctype html>');
  writeFileSync(join(dir, 'web', 'sw.js'), '//');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('preflight', () => {
  it('a PC that is set up passes: no FAIL, exit 0, and it says what is fine', () => {
    const { code, out } = run(settings());
    expect(out).not.toMatch(/\bFAIL\b/);
    expect(code).toBe(0);
    expect(out).toContain('PASS  there is an active admin');
    expect(out).toContain('PASS  an exchange rate is in force');
    expect(out).toContain('PASS  the backup folder can be written to');
    expect(out).toContain('PASS  backups are encrypted');
  });

  it('what is not ready is named, and the exit code says so', () => {
    const { code, out } = run(settings({ BACKUP_DIR: null, JWT_SECRET: 'short', WEB_DIST: null }));
    expect(code).toBe(1);
    expect(out).toMatch(/FAIL {2}the service settings are not valid for production: JWT_SECRET/);
    expect(out).toMatch(/FAIL {2}a backup folder is set/);
    expect(out).toMatch(/FAIL {2}the built web app is there/);
    expect(out).toContain('Do not open the shop until the FAILs are fixed');
  });

  it('missing safety nets are warned about, not failed: no encryption, no second copy', () => {
    const { code, out } = run(settings({ BACKUP_PASSPHRASE: null, BACKUP_COPY_DIR: null }));
    expect(code).toBe(0);
    expect(out).toMatch(/WARN {2}backups are encrypted/);
    expect(out).toMatch(/WARN {2}a second copy of each backup goes somewhere else/);
    expect(out).toMatch(/WARN {2}there is a backup in it/); // none taken yet
  });

  it('a database that is not there is a FAIL that says where it looked', () => {
    const { code, out } = run(settings({ DATABASE_PATH: join(dir, 'nowhere', 'pos.db') }));
    expect(code).toBe(1);
    expect(out).toMatch(/FAIL {2}the database file exists: nothing at .*nowhere/);
  });

  it('never prints the JWT secret or the backup passphrase', () => {
    for (const over of [{}, { BACKUP_DIR: null }, { WEB_DIST: null }] as Record<string, string | null>[]) {
      const { out } = run(settings(over));
      expect(out).not.toContain(SECRET);
      expect(out).not.toContain(PASSPHRASE);
    }
  });

  it('a product picture that is missing from the pictures folder is counted, and found once it is there', () => {
    const w = new Database(dbPath);
    w.prepare(`UPDATE products SET image_path = '/uploads/0123456789abcdef01234567.png' WHERE id = 1`).run();
    w.close();
    const uploads = join(dir, 'uploads');
    expect(run(settings({ UPLOADS_DIR: uploads })).out).toMatch(
      /WARN {2}every product picture is in the pictures folder: 0 of 1, 1 missing/,
    );
    mkdirSync(uploads, { recursive: true });
    writeFileSync(join(uploads, '0123456789abcdef01234567.png'), 'x');
    expect(run(settings({ UPLOADS_DIR: uploads })).out).toMatch(/PASS {2}every product picture is in the pictures folder: 1 of 1/);
  });

  it('a server that is not running is a WARN, since it may simply not be started yet', () => {
    expect(run(settings()).out).toMatch(/WARN {2}the server is running and ready: nothing answered/);
  });
});
