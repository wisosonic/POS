import { describe, expect, it } from 'vitest';
import type { WalletState } from '../src/lib/types';
import { staleWallets } from '../src/lib/wallets';

// docs/13 §6: the dashboard reminds a manager when a wallet has not been counted since yesterday. It never blocks anything.
const wallet = (countedAt: string | null): WalletState => ({
  method: 'whish',
  methodName: 'Whish',
  currency: 'LBP',
  expected: 0,
  inSince: 0,
  outSince: 0,
  lastCount: countedAt
    ? {
        id: 1,
        counted: 0,
        expected: null,
        variance: null,
        purpose: 'check',
        note: null,
        countedAt,
        countedByName: null,
      }
    : null,
});
const now = new Date(2026, 10, 25, 9, 0); // 25 November 2026, local time

describe('the wallet count reminder (US-12)', () => {
  it('reminds when a wallet was never counted', () => {
    expect(staleWallets([wallet(null)], now)).toHaveLength(1);
  });
  it('does not remind when it was counted today or yesterday', () => {
    expect(staleWallets([wallet(new Date(2026, 10, 25, 8, 0).toISOString())], now)).toHaveLength(0);
    expect(staleWallets([wallet(new Date(2026, 10, 24, 23, 59).toISOString())], now)).toHaveLength(0);
  });
  it('reminds when the last count was before yesterday, across a month end too', () => {
    expect(staleWallets([wallet(new Date(2026, 10, 23, 23, 59).toISOString())], now)).toHaveLength(1);
    expect(staleWallets([wallet(new Date(2026, 9, 31, 12, 0).toISOString())], now)).toHaveLength(1);
    expect(staleWallets([wallet(new Date(2026, 10, 30, 12, 0).toISOString())], new Date(2026, 11, 1, 9, 0))).toHaveLength(0);
  });
});
