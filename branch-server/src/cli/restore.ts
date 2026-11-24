// Put a backup in place as the live database. STOP THE SERVICE FIRST.
//   npm run restore -w @pos/api -- --from <backup file> [--db <database file>] [--force]
// The backup is decrypted and checked before anything existing is touched. Without --force it refuses to replace a database;
// with it, the old database is kept beside the new one as <name>.before-restore-<time>. The passphrase comes from BACKUP_PASSPHRASE.
import { dirname, join, resolve } from 'node:path';
import { BackupError, copyMissingPictures, restoreBackup } from '../backup/backup';
import { loadConfig } from '../config';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const config = loadConfig();
const from = flag('from');
if (!from) {
  process.stderr.write('Say which backup: --from <backup file>\n');
  process.exit(2);
}

try {
  const r = await restoreBackup({
    from: resolve(from),
    to: resolve(flag('db') ?? config.databasePath),
    passphrase: config.backupPassphrase,
    force: args.includes('--force'),
  });
  process.stdout.write(`Restored into ${r.to}\n`);
  if (r.previous) process.stdout.write(`The database that was there is kept as ${r.previous}\n`);
  // The pictures live in an "uploads" folder beside the backups: put back the ones this PC does not have.
  const pictures = await copyMissingPictures(join(dirname(resolve(from)), 'uploads'), config.uploadsDir ?? join(dirname(r.to), 'uploads'));
  process.stdout.write(`Pictures: ${pictures} ${pictures === 1 ? 'picture' : 'pictures'} put back.\n`);
  process.stdout.write('Start the service again. Check a recent sale before opening the shop.\n');
} catch (err) {
  process.stderr.write(`Restore FAILED, nothing was changed: ${(err as Error).message}\n`);
  process.exitCode = err instanceof BackupError ? 1 : 3;
}
