import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateFrom } from '@pos/core/migrate';
import type { Db } from './open';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Apply any pending `migrations/NNNN_name.sql` files in order, each in its own transaction.
 * Accepts a file path (opened and closed here) or an open connection. Safe to run repeatedly.
 * Returns the names of the migrations that were applied by this call. (The runner itself is shared with the HQ server: @pos/core.)
 */
export function migrate(target: string | Db): string[] {
  return migrateFrom(MIGRATIONS_DIR, target);
}
