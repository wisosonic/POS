import type { Queryable } from '@pos/core/adapter';
import { writeAudit } from '../staff/context';

// HQ's exchange rate (docs/12-sync-and-hq.md §15). A rate is added, never edited: the newest effective one applies, as at a branch.
// Adding one writes the change_log line in the same transaction, so a branch cannot miss it.

const nowIso = () => new Date().toISOString();

export type RateRow = { id: number; rate_lbp_per_usd: number; effective_from: string; created_at: string };

export async function addRate(q: Queryable, rate: number, effectiveFrom?: string): Promise<RateRow> {
  const now = nowIso();
  const row = (await q.one<RateRow>(
    'INSERT INTO exchange_rates (rate_lbp_per_usd, effective_from, created_at) VALUES (?, ?, ?) RETURNING id, rate_lbp_per_usd, effective_from, created_at',
    [rate, effectiveFrom ?? now, now],
  ))!;
  await q.run('INSERT INTO change_log (tbl, pk, op, created_at) VALUES (?, ?, ?, ?)', ['exchange_rates', row.id, 'u', now]);
  await writeAudit(q, 'rate.add', 'exchange-rate', row.id, { rateLbpPerUsd: rate, effectiveFrom: row.effective_from });
  return row;
}

export const listRates = (q: Queryable): Promise<RateRow[]> =>
  q.all<RateRow>(
    'SELECT id, rate_lbp_per_usd, effective_from, created_at FROM exchange_rates ORDER BY effective_from DESC, id DESC LIMIT 200',
  );
