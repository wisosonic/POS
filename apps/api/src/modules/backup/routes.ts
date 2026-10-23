import type { FastifyInstance } from 'fastify';
import { join } from 'node:path';
import { z } from 'zod';
import { BACKUP_NAME, BackupError, verifyBackupFile } from '../../backup/backup';
import { requestRestore } from '../../backup/pending';
import { AppError, E } from '../../errors';
import { writeAudit } from '../audit/service';

const restoreBody = z.object({ file: z.string().regex(BACKUP_NAME), confirm: z.literal(true) });

export default async function backupRoutes(app: FastifyInstance) {
  const db = app.db;
  const admin = { preHandler: app.requireRole('admin') };

  // Small and for managers: is there a recent backup? The header shows a warning when not.
  app.get('/backups/status', { preHandler: app.requireRole('manager') }, async () => {
    const { lastRun, ...status } = await app.backups.status();
    return { ...status, lastRunOk: lastRun?.ok ?? null };
  });

  // The full picture for the admin: settings (never the passphrase), the last run, and the files on disk.
  app.get('/backups', admin, async () => ({ ...(await app.backups.status()), files: await app.backups.files() }));

  app.post('/backups', admin, async (req, reply) => {
    try {
      const r = await app.backups.run('manual');
      writeAudit(db, {
        userId: req.auth.id,
        action: 'backup.run',
        entity: 'backup',
        entityId: r.file,
        after: { bytes: r.bytes, encrypted: r.encrypted },
      });
      return reply
        .status(201)
        .send({ file: r.file, bytes: r.bytes, encrypted: r.encrypted, copiedTo: !!r.copiedTo, copyError: r.copyError ?? null });
    } catch (err) {
      if (err instanceof BackupError && err.code === 'NOT_CONFIGURED') throw E.conflict('BACKUP_NOT_CONFIGURED', err.message);
      // Say what went wrong in words the admin can act on (a full disk, a missing drive); the details stay in the log.
      throw new AppError(500, 'BACKUP_FAILED', `The backup could not be made: ${(err as Error).message}`);
    }
  });

  // Put one of the listed backups in place as the live database. The server owns the file, so it cannot be swapped under a running
  // server: the backup is checked, the data as it is now is backed up first (and the old database file is kept again by the
  // restore itself), a note is left, and the server stops. The launcher starts it again and the start-up applies the note.
  app.post('/backups/restore', admin, async (req, reply) => {
    const body = restoreBody.parse(req.body);
    const dir = app.backups.settings.dir;
    if (!dir) throw E.conflict('BACKUP_NOT_CONFIGURED', 'Backups are not set up: set BACKUP_DIR');
    if (!(await app.backups.files()).some((f) => f.file === body.file)) throw E.notFound('That backup');
    const from = join(dir, body.file);
    try {
      await verifyBackupFile(from, app.backups.settings.passphrase);
    } catch (err) {
      throw new AppError(422, 'BACKUP_UNUSABLE', `This backup cannot be restored: ${(err as Error).message}`);
    }
    let safety: string;
    try {
      safety = (await app.backups.run('manual')).file;
    } catch (err) {
      throw new AppError(
        500,
        'BACKUP_FAILED',
        `Nothing was restored. The data as it is now could not be backed up first: ${(err as Error).message}`,
      );
    }
    requestRestore(app.dbPath, from);
    writeAudit(db, {
      userId: req.auth.id,
      action: 'backup.restore',
      entity: 'backup',
      entityId: body.file,
      after: { safetyBackup: safety },
    });
    void reply.status(202).send({ restarting: true, file: body.file, safetyBackup: safety });
    setTimeout(() => app.requestRestart(), 500).unref();
  });
}
