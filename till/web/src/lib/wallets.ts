import type { WalletState } from './types';

/** The local calendar day of a time, as 2026-11-25. */
const dayOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Wallets nobody has counted since yesterday: never counted, or last counted before yesterday's date (so a count made yesterday
 * still holds today). The dashboard reminds the manager; it never blocks anything (docs/13: a count is never required).
 */
export function staleWallets(wallets: WalletState[], now: Date = new Date()): WalletState[] {
  const yesterday = dayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  return wallets.filter((w) => !w.lastCount || dayOf(new Date(w.lastCount.countedAt)) < yesterday);
}
