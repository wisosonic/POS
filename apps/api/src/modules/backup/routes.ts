import type { FastifyInstance } from 'fastify';
import { BackupError } from '../../backup/backup';
import { AppError, E } from '../../errors';
import { writeAudit } from '../audit/service';

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
}
