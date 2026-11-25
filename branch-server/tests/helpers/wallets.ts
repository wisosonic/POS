import { walletBuckets } from '../../src/modules/registers/service';
import { walletBalances } from '../../src/modules/registers/wallets';
import type { TestCtx } from './app';

/**
 * What the branch's wallet (Whish or OMT, in one currency) should hold now. Wallets belong to the branch, not to a till's register
 * (docs/13-branch-wallets.md), so they are not in `GET /registers/current`: they are read from the wallet ledger.
 */
export async function walletExpected(c: TestCtx, method: string, currency: string): Promise<number> {
  const all = await walletBalances(c.app.database, await walletBuckets(c.app.database));
  const found = all.find((b) => b.method === method && b.currency === currency);
  if (!found) throw new Error(`${method}/${currency} is not a wallet`);
  return found.expected;
}
