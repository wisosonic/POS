import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { copyMissingPictures, restoreBackup } from './backup';

// A restore chosen on the Backups screen cannot happen under a running server (it owns the database file). The screen's request
// checks the backup, leaves this note beside the database and asks the server to stop; the launcher starts it again, and the
// start-up puts the backup in place before the database is opened.
export const pendingRestorePath = (databasePath: string) => `${databasePath}.restore-pending`;

export function requestRestore(databasePath: string, from: string): void {
  writeFileSync(pendingRestorePath(databasePath), JSON.stringify({ from }), 'utf8');
}

/** Apply a waiting restore, if there is one. Returns what happened in words, or null when nothing was waiting. Never throws. */
export async function applyPendingRestore(
  databasePath: string,
  passphrase: string | undefined,
  uploadsDir: string,
): Promise<string | null> {
  const note = pendingRestorePath(databasePath);
  if (!existsSync(note)) return null;
  try {
    const { from } = JSON.parse(readFileSync(note, 'utf8')) as { from: string };
    const r = await restoreBackup({ from, to: databasePath, passphrase, force: true });
    const pictures = await copyMissingPictures(join(dirname(from), 'uploads'), uploadsDir);
    return `restored ${from}; the old database is kept as ${r.previous}; ${pictures} pictures put back`;
  } catch (err) {
    return `restore FAILED, the existing database was not changed: ${(err as Error).message}`;
  } finally {
    await rm(note, { force: true });
  }
}
