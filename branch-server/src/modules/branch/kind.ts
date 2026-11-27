import type { Queryable } from '../../db/adapter';
import { AppError } from '../../errors';

// What kind of branch this is (docs/15 §3). A SALE branch has tills and sells; a STOCK branch is a warehouse and has none. HQ decides, and tells
// the branch when it connects (modules/sync/service.ts `saveLink`). The kind stays when the branch disconnects.

export type BranchKind = 'sale' | 'stock';

export async function getBranchKind(q: Queryable): Promise<BranchKind> {
  const row = await q.one<{ kind: BranchKind }>('SELECT kind FROM branches WHERE id = 1');
  return row?.kind ?? 'sale';
}

/** Throw `409 NOT_A_SALE_BRANCH` at a stock branch: it has no tills, so it cannot add one, open a register or sell. */
export async function assertSaleBranch(q: Queryable): Promise<void> {
  if ((await getBranchKind(q)) === 'stock')
    throw new AppError(
      409,
      'NOT_A_SALE_BRANCH',
      'This is a stock branch (a warehouse): it has no tills, so it cannot sell or open a register.',
    );
}

/**
 * A branch can be connected as a stock branch only from a fresh install: one that has sold, opened a register or enrolled a till has been a
 * sale branch, and its history would not make sense in a warehouse.
 */
export async function assertCanBecomeStock(q: Queryable): Promise<void> {
  const used = async (sql: string) => (await q.one<{ n: number }>(sql))!.n > 0;
  if (
    (await used('SELECT COUNT(*) AS n FROM sales')) ||
    (await used('SELECT COUNT(*) AS n FROM register_sessions')) ||
    (await used('SELECT COUNT(*) AS n FROM terminals WHERE enrolled_at IS NOT NULL'))
  )
    throw new AppError(
      409,
      'BRANCH_HAS_SALES',
      'This branch has already sold, opened a register or enrolled a till, so it cannot be connected as a stock branch (a warehouse). Use a fresh install.',
    );
}
