import { migrateFrom } from '@pos/core/migrate';
import type { Db } from '@pos/core/open';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Apply HQ's pending migrations (its own folder, its own database). Safe to run repeatedly. */
export const migrateCentral = (target: string | Db): string[] => migrateFrom(MIGRATIONS_DIR, target);
