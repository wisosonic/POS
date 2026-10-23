// Take a backup now, from the command line. Safe while the API is running (SQLite's online backup).
//   npm run backup -w @pos/api -- [--to <folder>] [--copy <folder>] [--keep <n>]
// Folders default to BACKUP_DIR and BACKUP_COPY_DIR; the passphrase comes from BACKUP_PASSPHRASE (never from the command line,
// where other programs could read it).
import Database from 'better-sqlite3';
import { dirname, join, resolve } from 'node:path';
import { createBackup } from '../backup/backup';
import { loadConfig } from '../config';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const config = loadConfig();
const dir = flag('to') ?? config.backupDir;
if (!dir) {
  process.stderr.write('Say where to put it: --to <folder>, or set BACKUP_DIR.\n');
  process.exit(2);
}

// Read-only: only the API process writes to the database.
const db = new Database(resolve(config.databasePath), { readonly: true, fileMustExist: true });
try {
  const keep = flag('keep') ? Number(flag('keep')) : config.backupKeep;
  const r = await createBackup(db, {
    dir: resolve(dir),
    copyDir: flag('copy') ?? config.backupCopyDir,
    passphrase: config.backupPassphrase,
    uploadsDir: config.uploadsDir ?? join(dirname(resolve(config.databasePath)), 'uploads'),
    keep,
  });
  process.stdout.write(
    `Backup written: ${r.path} (${(r.bytes / 1_048_576).toFixed(1)} MB${r.encrypted ? ', encrypted' : ', NOT encrypted'})\n`,
  );
  if (r.copiedTo) process.stdout.write(`Second copy: ${r.copiedTo}\n`);
  if (r.pictures)
    process.stdout.write(
      `Pictures: ${r.pictures.copied} new ${r.pictures.copied === 1 ? 'picture' : 'pictures'} copied${r.pictures.error ? `, but with a problem: ${r.pictures.error}` : ''}\n`,
    );
  if (r.copyError) process.stderr.write(`WARNING: the second copy failed: ${r.copyError}\n`);
  if (r.pruned.length) process.stdout.write(`Removed ${r.pruned.length} old backup(s), keeping ${keep}.\n`);
  process.exitCode = r.copyError ? 1 : 0;
} catch (err) {
  process.stderr.write(`Backup FAILED: ${(err as Error).message}\n`);
  process.exitCode = 1;
} finally {
  db.close();
}
