import { AppError } from '@pos/core/errors';
import type { FastifyInstance } from 'fastify';
import { BackupError, listBackups } from '../../backup/backup';

/**
 * HQ's backups (docs/07 §3, P7). An admin sees when the last one was made and whether it worked, and can take one now (safe while HQ runs). Restoring is
 * done by a person with the server stopped (`npm run restore --prefix cloud-hq`), never through the running server.
 */
export default async function backupRoutes(app: FastifyInstance) {
  const admin = { preHandler: app.requireStaff('admin') };

  app.get('/backups', admin, async () => {
    const dir = app.backups.settings.dir;
    return { ...(await app.backups.status()), files: dir ? (await listBackups(dir)).slice(0, 30) : [] };
  });

  app.post('/backups', admin, async (_req, reply) => {
    try {
      const r = await app.backups.run('manual');
      return reply
        .status(201)
        .send({ file: r.file, bytes: r.bytes, encrypted: r.encrypted, copiedTo: r.copiedTo ?? null, copyError: r.copyError ?? null });
    } catch (err) {
      if (err instanceof BackupError && err.code === 'NOT_CONFIGURED') throw new AppError(409, 'BACKUP_NOT_CONFIGURED', err.message);
      throw new AppError(500, 'BACKUP_FAILED', 'The backup failed: look at the HQ log');
    }
  });
}
