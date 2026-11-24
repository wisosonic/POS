// Create (or reset the password of) an admin user.
//   npm run create-admin -w @pos/api -- <username> <password>
// The first admin has to be created this way, since every other user is created by an admin through the API.
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { hashPassword } from '../auth/password';
import { loadConfig } from '../config';
import { openDatabase } from '../db/open';
import { migrate } from '../db/migrate';
import { seedReference } from '../db/seed';
import { writeAudit } from '../modules/audit/service';

const [username, password] = process.argv.slice(2);
if (!username || !password || password.length < 8) {
  console.error('Usage: create-admin <username> <password (at least 8 characters)>');
  process.exit(1);
}

const databasePath = resolve(loadConfig().databasePath);
mkdirSync(dirname(databasePath), { recursive: true }); // a first run has no data folder yet
migrate(databasePath);
seedReference(databasePath);

const hash = await hashPassword(password);
const db = openDatabase(databasePath);
db.transaction(() => {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number } | undefined;
  if (existing) {
    db.prepare(`UPDATE users SET password_hash = ?, role = 'admin', active = 1, must_reset_password = 0 WHERE id = ?`).run(
      hash,
      existing.id,
    );
    writeAudit(db, { userId: null, action: 'user.admin.reset', entity: 'user', entityId: existing.id, after: { via: 'cli' } });
  } else {
    const id = Number(
      db.prepare(`INSERT INTO users (username, name, role, password_hash) VALUES (?, ?, 'admin', ?)`).run(username, username, hash)
        .lastInsertRowid,
    );
    writeAudit(db, { userId: null, action: 'user.create', entity: 'user', entityId: id, after: { username, role: 'admin', via: 'cli' } });
  }
}).immediate();
db.close();
process.stdout.write(`Admin "${username}" is ready.\n`);
