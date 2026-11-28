import type { Queryable } from '@pos/core/adapter';
import { phoneKey } from '@pos/shared/phone';
import type { Fact } from '@pos/core/sync';

// Shared customers (docs/15 §7, P5e). A branch sends its customers like any fact; HQ recognises one person at several branches by their
// PHONE KEY (`phoneKey`: digits with the country code) and adds their balances up. Slice 5e-1 is the recognition and the one view; paying a
// debt at another branch (the allocation across branches) is slice 5e-2.

/** Keep `customer_keys` in step with the customers a batch just stored. Call it inside the same transaction as the upsert. */
export async function indexCustomers(q: Queryable, branchId: number, facts: Fact[]): Promise<void> {
  for (const f of facts) {
    if (f.tbl !== 'customers') continue;
    const key = f.op === 'u' && f.row && !f.row.is_walk_in ? phoneKey(f.row.phone as string | null) : null;
    if (key) {
      await q.run(
        `INSERT INTO customer_keys (branch_id, customer_id, phone_key) VALUES (?, ?, ?)
         ON CONFLICT (branch_id, customer_id) DO UPDATE SET phone_key = excluded.phone_key`,
        [branchId, f.pk, key],
      );
    } else {
      await q.run('DELETE FROM customer_keys WHERE branch_id = ? AND customer_id = ?', [branchId, f.pk]);
    }
  }
}

export type BranchBalance = { branchId: number; branch: string; customerId: number; name: string; balanceLbp: number };
export type SharedCustomer = { phoneKey: string; name: string; totalBalanceLbp: number; branches: BranchBalance[] };

type Row = { phone_key: string; branch_id: number; branch: string; customer_id: number; name: string; balance_lbp: number };

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** One person per phone key, with what they owe at each branch and in all. `q` matches a name or a phone key; `owing` keeps only those who owe. */
export async function listSharedCustomers(
  q: Queryable,
  opts: { q?: string; owing?: boolean; limit: number; key?: string },
): Promise<SharedCustomer[]> {
  const where: string[] = ['c.deleted_at IS NULL'];
  const params: (string | number)[] = [];
  if (opts.key) {
    where.push('k.phone_key = ?');
    params.push(opts.key);
  }
  if (opts.q) {
    const asKey = phoneKey(opts.q);
    const like = `%${likeEscape(opts.q.toLowerCase())}%`;
    where.push(
      asKey
        ? `(k.phone_key = ? OR LOWER(c.name) LIKE ? ESCAPE '\\')`
        : `(LOWER(c.name) LIKE ? ESCAPE '\\' OR k.phone_key LIKE ? ESCAPE '\\')`,
    );
    params.push(...(asKey ? [asKey, like] : [like, like]));
  }
  const rows = await q.all<Row>(
    `SELECT k.phone_key, c.branch_id, b.name AS branch, c.id AS customer_id, c.name, c.balance_lbp
       FROM customer_keys k
       JOIN customers c ON c.branch_id = k.branch_id AND c.id = k.customer_id
       JOIN branches b ON b.id = c.branch_id
      WHERE ${where.join(' AND ')}
      ORDER BY k.phone_key, c.branch_id`,
    params,
  );
  const people = new Map<string, SharedCustomer>();
  for (const r of rows) {
    let p = people.get(r.phone_key);
    if (!p) {
      p = { phoneKey: r.phone_key, name: r.name, totalBalanceLbp: 0, branches: [] };
      people.set(r.phone_key, p);
    }
    p.totalBalanceLbp += r.balance_lbp;
    p.branches.push({ branchId: r.branch_id, branch: r.branch, customerId: r.customer_id, name: r.name, balanceLbp: r.balance_lbp });
  }
  let out = [...people.values()];
  if (opts.owing) out = out.filter((p) => p.totalBalanceLbp > 0);
  return out.slice(0, opts.limit);
}

/** How many customers have no usable phone (they stay at their own branch and cannot buy on account). */
export async function customersWithoutPhone(q: Queryable): Promise<number> {
  const r = await q.one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM customers c
      WHERE c.is_walk_in = 0 AND c.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM customer_keys k WHERE k.branch_id = c.branch_id AND k.customer_id = c.id)`,
  );
  return r?.n ?? 0;
}
