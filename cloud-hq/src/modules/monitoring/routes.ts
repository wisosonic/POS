import { parse } from '@pos/core/validate';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { branchHealth } from './service';

/** The chain's health for the owner (docs/12 §32, P7): every branch's reachability, how far behind it is, whether it agrees with HQ, and HQ's own backup. */
export default async function monitoringRoutes(app: FastifyInstance) {
  const db = app.database;
  const view = { preHandler: app.requireStaff('viewer') };

  app.get('/monitoring/branches', view, async (req) => {
    const q = parse(z.object({ staleMinutes: z.coerce.number().int().min(1).max(1440).default(10) }), req.query);
    const branches = await branchHealth(db, { staleMinutes: q.staleMinutes });
    const backup = await app.backups.status();
    const backupProblem = backup.configured
      ? backup.stale
        ? 'BACKUP_STALE'
        : backup.lastRun && !backup.lastRun.ok
          ? 'BACKUP_FAILED'
          : null
      : 'BACKUP_NOT_CONFIGURED';
    const withProblems = branches.filter((b) => b.problems.length > 0);
    return {
      now: new Date().toISOString(),
      status: withProblems.length === 0 && !backupProblem ? 'ok' : 'attention',
      backup: {
        configured: backup.configured,
        encrypted: backup.encrypted,
        hasSecondCopy: backup.hasSecondCopy,
        lastBackupAt: backup.lastBackupAt,
        problem: backupProblem,
      },
      branches,
      summary: { branches: branches.length, withProblems: withProblems.length },
    };
  });
}
