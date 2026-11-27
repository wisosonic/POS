import type { Db } from '../../db/open';
import { E } from '../../errors';

// Once a branch is connected, the catalog (products, categories, brands, units, suppliers) is HQ's: it comes down by itself, and a second source
// would fight it (docs/12 §17). Not connected, the branch works as before.

export const hqOwnsCatalog = (db: Db): boolean => !!db.prepare('SELECT 1 FROM hq_link WHERE id = 1').get();

/** Throw `409 HQ_OWNS_CATALOG` while this branch is connected to HQ. */
export function refuseIfHqOwnsCatalog(db: Db, what = 'the catalog'): void {
  if (hqOwnsCatalog(db))
    throw E.conflict('HQ_OWNS_CATALOG', `This branch is connected to HQ: ${what} is changed at HQ and arrives here by itself.`);
}
