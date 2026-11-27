import type { Queryable } from '../../db/adapter';
import { E } from '../../errors';

/**
 * Connected to HQ, HQ buys (docs/15 §6, decision #27): the goods are delivered to the STOCK branches, which receive them under Transfers. The branch's own
 * purchase routes answer `409 HQ_OWNS_PURCHASING`; reading its history stays open. Not connected, the branch buys for itself as before.
 */
export async function refuseIfHqBuys(q: Queryable): Promise<void> {
  if (await q.one('SELECT 1 AS x FROM hq_link WHERE id = 1'))
    throw E.conflict(
      'HQ_OWNS_PURCHASING',
      'This branch is connected to HQ: HQ buys, and the goods are delivered to the stock branches (a stock branch receives them under Transfers).',
    );
}
