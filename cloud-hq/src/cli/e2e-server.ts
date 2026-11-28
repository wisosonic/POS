// A throwaway HQ for the browser tests (tests/e2e): its own temporary data folder, the BUILT screen, one admin, gone when the run ends.
//   npm run e2e-server   (E2E_HQ_PORT, default 4100; E2E_ADMIN / E2E_PASSWORD name the admin the tests sign in as)
// It never reads DATABASE_PATH, so it cannot touch a real HQ's data.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '@pos/core/open';
import { createSqliteDatabase } from '@pos/core/sqlite';
import { hashPassword } from '../auth/password';
import { buildCentral } from '../app';
import { migrateCentral } from '../db/migrate';
import { asStaff } from '../modules/staff/context';
import { createUser } from '../modules/staff/users';

const port = Number(process.env.E2E_HQ_PORT ?? 4100);
const admin = process.env.E2E_ADMIN ?? 'boss';
const password = process.env.E2E_PASSWORD ?? 'Correct-Horse-Battery-9';
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
if (!existsSync(join(webDist, 'index.html'))) {
  console.error('The HQ screen is not built: run `npm run build` first.');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'hq-e2e-'));
const databasePath = join(dir, 'hq.db');
migrateCentral(databasePath);
const hash = await hashPassword(password);
const raw = openDatabase(databasePath);
const cli = { id: null, username: 'cli', name: 'e2e', role: 'admin' as const, mustResetPassword: false, actor: 'cli' };
await asStaff(createSqliteDatabase(raw), cli, (tx) =>
  createUser(tx, { username: admin, name: admin, role: 'admin', passwordHash: hash, mustReset: false }),
);
raw.close();

const app = await buildCentral({ databasePath, webDist, logger: false });
const stop = async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await app.listen({ host: '127.0.0.1', port });
