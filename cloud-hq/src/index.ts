import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildCentral } from './app';
import { loadCentralConfig } from './config';
import { migrateCentral } from './db/migrate';

// The HQ server entry point: `npm run dev -w @pos/central` (watch) or `npm run start -w @pos/central`.
// HQ_ADMIN_TOKEN is required (a long random value). See docs/12-sync-and-hq.md.
const config = loadCentralConfig();
const databasePath = resolve(config.databasePath);
mkdirSync(dirname(databasePath), { recursive: true });
const applied = migrateCentral(databasePath);

const app = await buildCentral({
  databasePath,
  adminToken: config.adminToken,
  allowedHosts: config.allowedHosts,
  production: config.production,
  logger: true,
});
if (applied.length) app.log.info({ migrations: applied }, 'HQ database migrated');

const stop = async () => {
  await app.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

await app.listen({ host: config.host, port: config.port });
