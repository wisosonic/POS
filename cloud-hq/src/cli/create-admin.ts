// Create (or reset the password of) an HQ admin. The first admin has to be made this way: every other account is made by an admin through the API.
//   npm run create-admin --prefix cloud-hq -- <username> <password (at least 12 characters)>
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openDatabase } from '@pos/core/open';
import { createSqliteDatabase } from '@pos/core/sqlite';
import { hashPassword } from '../auth/password';
import { loadCentralConfig } from '../config';
import { migrateCentral } from '../db/migrate';
import { asStaff } from '../modules/staff/context';
import { checkPassword, createUser, normaliseUsername, setPassword, USERNAME } from '../modules/staff/users';

const [rawName, password] = process.argv.slice(2);
if (!rawName || !password) {
  console.error('Usage: create-admin <username> <password (at least 12 characters)>');
  process.exit(1);
}
const username = normaliseUsername(rawName);
if (!USERNAME.test(username)) {
  console.error('The user name has 3 to 40 characters: letters, digits, dot, dash and underscore.');
  process.exit(1);
}
try {
  checkPassword(password);
} catch (e) {
  console.error(e instanceof Error ? e.message : 'That password will not do.');
  process.exit(1);
}

const databasePath = resolve(loadCentralConfig().databasePath);
mkdirSync(dirname(databasePath), { recursive: true });
migrateCentral(databasePath);
const hash = await hashPassword(password);
const raw = openDatabase(databasePath);
const db = createSqliteDatabase(raw);
const cli = { id: null, username: 'cli', name: 'create-admin', role: 'admin' as const, mustResetPassword: false, actor: 'cli' };
await asStaff(db, cli, async (tx) => {
  const existing = await tx.one<{ id: number }>('SELECT id FROM hq_users WHERE username = ?', [username]);
  if (existing) {
    await tx.run(`UPDATE hq_users SET role = 'admin', active = 1 WHERE id = ?`, [existing.id]);
    await setPassword(tx, existing.id, hash, false, 'user.admin.reset');
  } else {
    await createUser(tx, { username, name: username, role: 'admin', passwordHash: hash, mustReset: false });
  }
});
raw.close();
process.stdout.write(`HQ admin "${username}" is ready.\n`);
