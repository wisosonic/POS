import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, type Db } from './open';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Apply any pending `migrations/NNNN_name.sql` files in order, each in its own transaction.
 * Accepts a file path (opened and closed here) or an open connection. Safe to run repeatedly.
 * Returns the names of the migrations that were applied by this call.
 */
export function migrate(target: string | Db): string[] {
  const owned = typeof target === 'string';
  const db = owned ? openDatabase(target) : target;
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`);
    const done = new Set((db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map((r) => r.name));
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f))
      .sort();

    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
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
