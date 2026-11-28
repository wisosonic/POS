import { downTable, validateRow, type Change } from '@pos/core/sync';
import { applyPaymentOrders } from '../customers/chain';
import type { Database, Queryable } from '../../db/adapter';
import { nowIso } from '../../util/time';
import type { Link } from './service';

// Receiving what HQ owns (docs/12-sync-and-hq.md §5, §15). One call to `pullOnce` asks for the next page of HQ's change log after the number
// this branch remembers, applies the WHOLE page in one short transaction (with the new number), and says whether there is more. A page that
// fails is not applied and the number does not move, so it is simply asked for again. Applying a row is an upsert on HQ's id (`hq_id`), so
// applying the same page twice changes nothing.

export type PullOutcome = { applied: number; more: boolean; changed: string[] } | { error: string; refused?: boolean };

export type PullOptions = { fetchImpl?: typeof fetch; signal?: AbortSignal; limit?: number };

type Page = { changes: Change[]; next: number; more: boolean };

async function fetchPage(link: Link, cursor: number, opts: PullOptions): Promise<Page | { error: string; refused?: boolean }> {
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${link.hqUrl}/api/v1/sync/changes?cursor=${cursor}&limit=${opts.limit ?? 500}`, {
      headers: { 'X-Branch-Token': link.token, Accept: 'application/json' },
      signal: AbortSignal.any([...(opts.signal ? [opts.signal] : []), AbortSignal.timeout(30_000)]),
    });
    if (res.status === 401) return { refused: true, error: 'HQ no longer accepts this branch. Ask HQ for a new code and connect again.' };
    if (!res.ok) return { error: `HQ did not give its changes (${res.status})` };
    return (await res.json()) as Page;
  } catch (e) {
    return { error: e instanceof Error && e.name === 'TimeoutError' ? 'HQ did not answer in time' : 'Cannot reach HQ' };
  }
}

/** Check a page before touching anything: a page with a row this version cannot read is refused whole. */
function checkPage(page: Page, cursor: number): string | null {
  if (!Array.isArray(page.changes) || !Number.isSafeInteger(page.next) || page.next < cursor)
    return 'HQ sent a page this branch cannot read';
  let last = cursor;
  for (const c of page.changes) {
    const table = downTable(c.tbl);
    if (!table) return `HQ sent a table this branch does not know ("${c.tbl}")`;
    if (!Number.isSafeInteger(c.seq) || c.seq <= last) return 'HQ sent changes out of order';
    last = c.seq;
    if (!Number.isSafeInteger(c.pk) || c.pk < 1) return 'HQ sent a bad id';
    if (c.op === 'u') {
      const problem = validateRow(table, c.row);
      if (problem) return `HQ sent a row this branch cannot read: ${problem}`;
      if (c.row!.id !== c.pk) return 'HQ sent a row whose id does not match';
    }
  }
  return null;
}

// The catalog lists use HQ's id as their own id (DOWN_TABLES `ids: 'same'`): an upsert on `id`. Table and column names come from that fixed list.
async function applySameId(q: Queryable, c: Change): Promise<void> {
  const table = downTable(c.tbl)!;
  if (c.op === 'd') {
    await q.run(`DELETE FROM ${table.name} WHERE id = ?`, [c.pk]);
    return;
  }
  const cols = table.columns.map((x) => x.name);
  const updates = cols
    .filter((x) => x !== 'id')
    .map((x) => `${x} = excluded.${x}`)
    .join(', ');
  await q.run(
    `INSERT INTO ${table.name} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ON CONFLICT (id) DO UPDATE SET ${updates}`,
    cols.map((x) => c.row![x] ?? null),
  );
}

// A product (P3b) is an upsert on HQ's id with two differences. `cost_minor` is HQ's STARTING cost: taken when the product first arrives, never
// overwritten after (the branch's own purchases set it). `updated_at` is THIS branch's clock, and moves only when something really changed:
// the till's catalog feed follows it, and an HQ timestamp older than the till's last sync would be skipped, while moving it on a repeat of the
// same page (or on a change the branch does not show) would make every till download all its products again. HQ never deletes a product; a
// delete line (not sent today) retires it here rather than break the history that points at it.
async function applyProduct(q: Queryable, c: Change): Promise<void> {
  if (c.op === 'd') {
    await q.run('UPDATE products SET active = 0, updated_at = ? WHERE id = ? AND active = 1', [nowIso(), c.pk]);
    return;
  }
  const cols = downTable('products')!.columns.map((x) => x.name);
  const overwritten = cols.filter((x) => x !== 'id' && x !== 'cost_minor');
  await q.run(
    `INSERT INTO products (${cols.join(', ')}, updated_at) VALUES (${cols.map(() => '?').join(', ')}, ?)
     ON CONFLICT (id) DO UPDATE SET ${[...overwritten.map((x) => `${x} = excluded.${x}`), 'updated_at = excluded.updated_at'].join(', ')}
     WHERE ${overwritten.map((x) => `products.${x} IS DISTINCT FROM excluded.${x}`).join(' OR ')}`,
    [...cols.map((x) => c.row![x] ?? null), nowIso()],
  );
}

async function applyChange(q: Queryable, c: Change): Promise<void> {
  // A new table adds itself to DOWN_TABLES; `ids: 'same'` ones are handled above, `mapped` ones need their own case here and an hq_id column.
  if (c.tbl === 'products') return applyProduct(q, c);
  if (downTable(c.tbl)?.ids === 'same') return applySameId(q, c);
  if (c.tbl === 'exchange_rates') {
    if (c.op === 'd') {
      await q.run('DELETE FROM exchange_rates WHERE hq_id = ?', [c.pk]);
      return;
    }
    const r = c.row!;
    await q.run(
      `INSERT INTO exchange_rates (rate_lbp_per_usd, effective_from, created_at, hq_id) VALUES (?, ?, ?, ?)
       ON CONFLICT (hq_id) WHERE hq_id IS NOT NULL DO UPDATE SET rate_lbp_per_usd = excluded.rate_lbp_per_usd,
         effective_from = excluded.effective_from, created_at = excluded.created_at`,
      [r.rate_lbp_per_usd ?? null, r.effective_from ?? null, r.created_at ?? null, c.pk],
    );
  }
}

export async function pullOnce(db: Database, link: Link, opts: PullOptions = {}): Promise<PullOutcome> {
  const control = await db.one<{ down_cursor: number }>('SELECT down_cursor FROM sync_control WHERE id = 1');
  const cursor = control?.down_cursor ?? 0;
  const page = await fetchPage(link, cursor, opts);
  if ('error' in page) return page;
  const bad = checkPage(page, cursor);
  if (bad) return { error: bad };
  let stale = false;
  if (page.changes.length > 0 || page.next > cursor) {
    await db.tx(async (tx) => {
      // The branch may have been disconnected (or connected to another HQ) while this page was on its way: then it is not ours to apply.
      const now = await tx.one<{ connected_at: string }>('SELECT connected_at FROM hq_link WHERE id = 1');
      if (!now || now.connected_at !== link.connectedAt) {
        stale = true;
        return;
      }
      for (const c of page.changes) await applyChange(tx, c);
      // Payment orders for this branch's sales are applied in the same transaction, and answered (docs/15 §7.2).
      if (page.changes.some((c) => c.tbl === 'payment_orders')) await applyPaymentOrders(tx);
      await tx.run('UPDATE sync_control SET down_cursor = ? WHERE id = 1', [page.next]);
    });
  }
  if (stale) return { applied: 0, more: false, changed: [] };
  return { applied: page.changes.length, more: page.more, changed: [...new Set(page.changes.map((c) => c.tbl))] };
}
