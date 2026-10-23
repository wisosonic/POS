import Database from 'better-sqlite3';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { copyFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Db } from '../db/open';
import { STORED_NAME } from '../modules/catalog/images';

// A backup is a consistent copy of the database taken while the API keeps selling (SQLite's online backup, never a plain
// file copy, which can catch a half-written page). It is checked before it counts, and may be encrypted with a passphrase.
// The format is deliberately plain so a restore does not depend on this code staying exactly as it is:
//   plain:      an ordinary SQLite file
//   encrypted:  "POSBK1\0\0" (8 bytes) · salt (16) · iv (12) · AES-256-GCM ciphertext · auth tag (16); key = scrypt(passphrase, salt)

export class BackupError extends Error {
  constructor(
    readonly code:
      'NOT_CONFIGURED' | 'INTEGRITY' | 'WRONG_PASSPHRASE_OR_DAMAGED' | 'PASSPHRASE_REQUIRED' | 'TARGET_EXISTS' | 'NOT_A_BACKUP',
    message: string,
  ) {
    super(message);
  }
}

const MAGIC = Buffer.from('POSBK1\0\0', 'latin1');
const SALT = 16;
const IV = 12;
const TAG = 16;
const HEADER = MAGIC.length + SALT + IV;
export const MIN_PASSPHRASE = 12;

/** Backup file names sort in time order: `pos-20261020-023000.db`, `.db.enc` when encrypted. */
export const BACKUP_NAME = /^pos-\d{8}-\d{6}(-\d+)?\.db(\.enc)?$/;

export type BackupOptions = {
  dir: string;
  /** A second place for the same file, such as an external drive or a folder that syncs offsite. A failure there never fails the backup. */
  copyDir?: string;
  passphrase?: string;
  /** The product pictures folder. Pictures not yet in the backup folders are copied (they are never encrypted: they are not secret). */
  uploadsDir?: string;
  /** How many backups to keep in each folder. */
  keep?: number;
  now?: Date;
};

export type BackupResult = {
  file: string;
  path: string;
  bytes: number;
  encrypted: boolean;
  copiedTo?: string;
  copyError?: string;
  /** The product pictures copied this time, and why not if it failed (the database backup still counts). */
  pictures?: { copied: number; error?: string };
  pruned: string[];
};

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

const key = (passphrase: string, salt: Buffer) => scryptSync(passphrase, salt, 32);

export function checkPassphrase(passphrase: string | undefined): void {
  if (passphrase !== undefined && passphrase.length < MIN_PASSPHRASE)
    throw new BackupError('PASSPHRASE_REQUIRED', `The backup passphrase must be at least ${MIN_PASSPHRASE} characters`);
}

/** Open a copy read-only and make sure it is a whole, consistent database of ours. Throws BackupError('INTEGRITY') otherwise. */
export function verifyDatabaseFile(path: string): void {
  let copy: InstanceType<typeof Database> | undefined;
  try {
    copy = new Database(path, { readonly: true, fileMustExist: true });
    const integrity = copy.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new BackupError('INTEGRITY', `The database copy failed its integrity check: ${String(integrity)}`);
    const broken = copy.pragma('foreign_key_check') as unknown[];
    if (broken.length > 0) throw new BackupError('INTEGRITY', `The database copy has ${broken.length} broken references`);
    const hasSchema = copy.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`).get();
    if (!hasSchema) throw new BackupError('NOT_A_BACKUP', 'This is not a Darwish POS database');
  } catch (err) {
    if (err instanceof BackupError) throw err;
    throw new BackupError('NOT_A_BACKUP', `This file is not a readable database: ${(err as Error).message}`);
  } finally {
    copy?.close();
  }
}

/**
 * The copy inherits the live database's WAL mode, which keeps companion `-wal` and `-shm` files beside it. A backup must be
 * one self-contained file that can be renamed, copied to a USB drive or encrypted on its own, so switch it to the plain
 * rollback journal first (this folds anything pending into the file itself and removes the companions).
 */
function makeSelfContained(path: string): void {
  const copy = new Database(path, { fileMustExist: true });
  try {
    copy.pragma('journal_mode = DELETE');
  } finally {
    copy.close();
  }
}

async function encryptFile(from: string, to: string, passphrase: string): Promise<void> {
  const salt = randomBytes(SALT);
  const iv = randomBytes(IV);
  const cipher = createCipheriv('aes-256-gcm', key(passphrase, salt), iv);
  cipher.setAAD(MAGIC);
  const out = createWriteStream(to, { flags: 'wx' });
  out.write(Buffer.concat([MAGIC, salt, iv]));
  await pipeline(createReadStream(from), cipher, out, { end: false });
  out.end(cipher.getAuthTag());
  await new Promise<void>((resolve, reject) => out.once('finish', resolve).once('error', reject));
}

async function decryptFile(from: string, to: string, passphrase: string): Promise<void> {
  const size = statSync(from).size;
  if (size < HEADER + TAG) throw new BackupError('WRONG_PASSPHRASE_OR_DAMAGED', 'This backup file is too short to be complete');
  const fd = openSync(from, 'r');
  const header = Buffer.alloc(HEADER);
  const tag = Buffer.alloc(TAG);
  try {
    readSync(fd, header, 0, HEADER, 0);
    readSync(fd, tag, 0, TAG, size - TAG);
  } finally {
    closeSync(fd);
  }
  const salt = header.subarray(MAGIC.length, MAGIC.length + SALT);
  const iv = header.subarray(MAGIC.length + SALT);
  const decipher = createDecipheriv('aes-256-gcm', key(passphrase, salt), iv);
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  try {
    await pipeline(createReadStream(from, { start: HEADER, end: size - TAG - 1 }), decipher, createWriteStream(to, { flags: 'wx' }));
  } catch {
    await rm(to, { force: true });
    throw new BackupError('WRONG_PASSPHRASE_OR_DAMAGED', 'The passphrase is wrong, or the backup file is damaged');
  }
}

export function isEncryptedFile(path: string): boolean {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(MAGIC.length);
    readSync(fd, head, 0, MAGIC.length, 0);
    return head.equals(MAGIC);
  } finally {
    closeSync(fd);
  }
}

/**
 * Copy the product pictures that are not yet in `dest`. A picture's name is made from its content, so a file that is there
 * is the same file and never needs copying again: each backup only adds what is new. Only whole picture names are copied.
 */
export async function copyMissingPictures(src: string, dest: string): Promise<number> {
  if (!existsSync(src)) return 0;
  const names = (await readdir(src)).filter((n) => STORED_NAME.test(n));
  mkdirSync(dest, { recursive: true });
  let copied = 0;
  for (const name of names) {
    const target = join(dest, name);
    if (existsSync(target)) continue;
    await copyFile(join(src, name), `${target}.tmp`);
    await rename(`${target}.tmp`, target); // never a half-copied picture under its real name
    copied++;
  }
  return copied;
}

export type BackupFile = { file: string; bytes: number; modifiedAt: string; encrypted: boolean };

/** The backups in a folder, newest first. */
export async function listBackups(dir: string): Promise<BackupFile[]> {
  if (!existsSync(dir)) return [];
  const names = (await readdir(dir))
    .filter((n) => BACKUP_NAME.test(n))
    .sort()
    .reverse();
  return Promise.all(
    names.map(async (file) => {
      const s = await stat(join(dir, file));
      return { file, bytes: s.size, modifiedAt: s.mtime.toISOString(), encrypted: file.endsWith('.enc') };
    }),
  );
}

async function prune(dir: string, keep: number): Promise<string[]> {
  const old = (await listBackups(dir)).slice(keep).map((b) => b.file);
  for (const file of old) await rm(join(dir, file), { force: true });
  return old;
}

/**
 * Take a backup now. The copy is made while the database stays in use, verified, then encrypted if a passphrase is given.
 * The plain copy never remains on disk when encryption is on.
 */
export async function createBackup(db: Db, options: BackupOptions): Promise<BackupResult> {
  checkPassphrase(options.passphrase);
  const keep = Math.max(1, options.keep ?? 30);
  mkdirSync(options.dir, { recursive: true });

  let base = `pos-${stamp(options.now ?? new Date())}`;
  for (let n = 1; existsSync(join(options.dir, `${base}.db`)) || existsSync(join(options.dir, `${base}.db.enc`)); n++)
    base = `pos-${stamp(options.now ?? new Date())}-${n}`;

  const partial = join(options.dir, `${base}.db.partial`);
  try {
    await db.backup(partial);
    makeSelfContained(partial);
    verifyDatabaseFile(partial);
    const file = options.passphrase ? `${base}.db.enc` : `${base}.db`;
    const path = join(options.dir, file);
    if (options.passphrase) {
      await encryptFile(partial, path, options.passphrase);
      await rm(partial, { force: true });
    } else await rename(partial, path);

    const result: BackupResult = {
      file,
      path,
      bytes: statSync(path).size,
      encrypted: !!options.passphrase,
      pruned: await prune(options.dir, keep),
    };
    if (options.copyDir) {
      try {
        mkdirSync(options.copyDir, { recursive: true });
        const target = join(options.copyDir, file);
        await copyFile(path, target);
        result.copiedTo = target;
        await prune(options.copyDir, keep);
      } catch (err) {
        result.copyError = (err as Error).message;
      }
    }
    if (options.uploadsDir) {
      let copied = 0;
      try {
        copied = await copyMissingPictures(options.uploadsDir, join(options.dir, 'uploads'));
        if (options.copyDir) await copyMissingPictures(options.uploadsDir, join(options.copyDir, 'uploads'));
        result.pictures = { copied };
      } catch (err) {
        result.pictures = { copied, error: (err as Error).message };
      }
    }
    return result;
  } catch (err) {
    await rm(partial, { force: true }); // a failed backup leaves nothing that looks like one
    throw err;
  }
}

export type RestoreOptions = {
  from: string;
  /** The database file to create. */
  to: string;
  passphrase?: string;
  /** Replace an existing database. The old one is kept beside it as `<name>.before-restore-<time>`, never deleted. */
  force?: boolean;
  now?: Date;
};

/**
 * Put a backup in place as the live database. The API must be stopped first. The file is decrypted and verified in a
 * temporary spot beside the target before anything existing is touched, so a wrong passphrase or a damaged file changes nothing.
 */
export async function restoreBackup(options: RestoreOptions): Promise<{ to: string; previous?: string }> {
  if (!existsSync(options.from)) throw new BackupError('NOT_A_BACKUP', `There is no file at ${options.from}`);
  if (existsSync(options.to) && !options.force)
    throw new BackupError(
      'TARGET_EXISTS',
      `${options.to} already exists. Stop the service and use --force to replace it (the old one is kept)`,
    );

  mkdirSync(dirname(options.to), { recursive: true });
  const temp = `${options.to}.restoring`;
  await rm(temp, { force: true });
  try {
    if (isEncryptedFile(options.from)) {
      if (!options.passphrase) throw new BackupError('PASSPHRASE_REQUIRED', 'This backup is encrypted: set BACKUP_PASSPHRASE');
      await decryptFile(options.from, temp, options.passphrase);
    } else await copyFile(options.from, temp);
    verifyDatabaseFile(temp);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  } finally {
    // Checking a file that is in WAL mode can leave companion files beside the temporary copy. They are not wanted.
    for (const ext of ['-wal', '-shm']) await rm(temp + ext, { force: true });
  }

  let previous: string | undefined;
  if (existsSync(options.to)) {
    previous = `${options.to}.before-restore-${stamp(options.now ?? new Date())}`;
    await rename(options.to, previous);
    // The old database's log files go with it. Left behind they would be replayed onto the restored file.
    for (const ext of ['-wal', '-shm']) if (existsSync(options.to + ext)) await rename(options.to + ext, previous + ext);
  }
  for (const ext of ['-wal', '-shm']) await rm(options.to + ext, { force: true });
  await rename(temp, options.to);
  return { to: options.to, previous };
}
