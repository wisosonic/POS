import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildApp } from './app';
import { loadConfig } from './config';
import { migrate } from './db/migrate';
import { seedReference } from './db/seed';

// Server entry point: `npm run dev -w @pos/api` (watch) or `npm run start -w @pos/api`.
const config = loadConfig();
const databasePath = resolve(config.databasePath);
mkdirSync(dirname(databasePath), { recursive: true });

const applied = migrate(databasePath);
seedReference(databasePath);

const app = await buildApp({
  databasePath,
  jwtSecret: config.jwtSecret,
  rateLimit: config.production,
  logger: true,
});
if (applied.length) app.log.info({ applied }, 'database migrated');

await app.listen({ host: config.host, port: config.port });
if (app.backups.configured) {
  app.backups.start();
  app.log.info(
    { at: config.backupAt, dir: config.backupDir, copyDir: config.backupCopyDir, encrypted: !!config.backupPassphrase },
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
