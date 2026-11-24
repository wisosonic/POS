import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { buildApp } from './app';
import { applyPendingRestore } from './backup/pending';
import { loadConfig } from './config';
import { migrate } from './db/migrate';
import { seedReference } from './db/seed';

/** The exit code that means "start me again" (a restore is waiting). scripts/dev.mjs knows it too. */
const RESTART_EXIT_CODE = 75;

// Server entry point: `npm run dev -w @pos/api` (watch) or `npm run start -w @pos/api`.
const config = loadConfig();
const databasePath = resolve(config.databasePath);
mkdirSync(dirname(databasePath), { recursive: true });

// A restore chosen on the Backups screen is applied here, before the database is opened (docs/07-operations.md).
const restored = await applyPendingRestore(
  databasePath,
  config.backupPassphrase,
  resolve(config.uploadsDir ?? join(dirname(databasePath), 'uploads')),
);
if (restored) process.stdout.write(`${JSON.stringify({ level: 30, time: Date.now(), msg: `backup restore: ${restored}` })}\n`);

const applied = migrate(databasePath);
seedReference(databasePath);

// Outside production, with no BACKUP_DIR, backups go to a "backups" folder in the project (the folder holding apps/ and packages/).
const projectBackups = resolve(import.meta.dirname, '..', '..', '..', 'backups');
const app = await buildApp({
  databasePath,
  jwtSecret: config.jwtSecret,
  rateLimit: config.production,
  logger: true,
  backup: config.backupDir || config.production ? undefined : { dir: projectBackups },
  // A restore ends here: the server stops and the launcher (runner.bat, npm run dev, the Windows task) starts it again.
  restart: () => {
    app.log.info('stopping so the restored database can be put in place');
    void app.close().then(() => process.exit(RESTART_EXIT_CODE));
  },
});
if (applied.length) app.log.info({ applied }, 'database migrated');

await app.listen({ host: config.host, port: config.port });
if (app.backups.configured) {
  app.backups.start();
  app.log.info(
    { at: config.backupAt, dir: app.backups.settings.dir, copyDir: config.backupCopyDir, encrypted: !!config.backupPassphrase },
    'daily backup on',
  );
} else app.log.warn('no backups: set BACKUP_DIR (see docs/07-operations.md)');

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close(); // closes the database so the WAL is checkpointed cleanly
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
