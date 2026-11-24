import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase, type Db } from './open';

/**
 * Apply any pending `NNNN_name.sql` files from `migrationsDir` in order, each in its own transaction.
 * Accepts a file path (opened and closed here) or an open connection. Safe to run repeatedly.
 * Returns the names of the migrations that were applied by this call.
 * The branch server and the HQ server each have their own folder of migrations and their own database.
 */
export function migrateFrom(migrationsDir: string, target: string | Db): string[] {
  const owned = typeof target === 'string';
  const db = owned ? openDatabase(target) : target;
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`);
    const done = new Set((db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map((r) => r.name));
    const files = readdirSync(migrationsDir)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f))
      .sort();

    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      db.transaction(() => {
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
      }).immediate();
      applied.push(file);
    }
    return applied;
  } finally {
    if (owned) db.close();
  }
}
