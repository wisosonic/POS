import { createHash } from 'node:crypto';

// What travels from a branch to HQ (docs/12-sync-and-hq.md §3-4). ONE definition, used by both servers: the branch reads these columns
// and sends them, HQ checks every row against the same list before storing it. The column lists must match the branch's tables and
// HQ's copies exactly; `tests/db/sync-schema.test.ts` checks both, so adding a column to a table without updating this fails a test
// instead of silently losing the column at HQ.

export type ColumnKind = 'int' | 'text';
export type SyncColumn = { name: string; kind: ColumnKind; nullable: boolean };
/** A table whose rows a branch sends to HQ. The first column is `id`, the primary key (an integer, never reused). */
export type SyncTable = { name: string; columns: SyncColumn[] };

const int = (name: string, nullable = false): SyncColumn => ({ name, kind: 'int', nullable });
const text = (name: string, nullable = false): SyncColumn => ({ name, kind: 'text', nullable });

/**
 * What a branch records and HQ keeps a copy of: the sale cluster (P2b), then returns, customer payments, registers, expenses, purchases, wallets
 * and services (P4a). A table here needs a branch migration with its three capture triggers and an HQ mirror table.
 */
export const SYNC_TABLES: readonly SyncTable[] = [
  {
    name: 'sales',
    columns: [
      int('id'),
      int('ref'),
      int('session_id', true),
      int('user_id', true),
      int('customer_id'),
      int('warehouse_id'),
      int('rate_lbp_per_usd'),
      int('subtotal_lbp'),
      int('discount_lbp'),
      int('shipping_lbp'),
      int('rounding_lbp'),
      int('total_lbp'),
      int('paid_lbp'),
      int('change_lbp'),
      int('rest_lbp'),
      int('profit_lbp'),
      text('status'),
      text('notes'),
      text('client_sale_id', true),
      text('idempotency_key', true),
      int('legacy_id', true),
      text('created_at'),
    ],
  },
  {
    name: 'sale_items',
    columns: [
      int('id'),
      int('sale_id'),
      int('product_id', true),
      text('name_snap'),
      text('receipt_name_snap', true),
      text('barcode_snap'),
      text('brand_snap'),
      text('unit_snap'),
      int('qty_milli'),
      int('unit_price_lbp'),
      int('unit_cost_lbp'),
      int('line_total_lbp'),
      int('legacy_id', true),
    ],
  },
  {
    name: 'payments',
    columns: [
      int('id'),
      int('sale_id', true),
      int('customer_payment_id', true),
      text('method'),
      text('currency'),
      int('amount'),
      int('rate_snap'),
      text('created_at'),
    ],
  },
  {
    name: 'stock_movements',
    columns: [
      int('id'),
      int('product_id'),
      int('warehouse_id'),
      int('qty_milli_delta'),
      text('reason'),
      text('ref_type', true),
      int('ref_id', true),
      int('user_id', true),
      text('note', true),
      text('created_at'),
    ],
  },
  {
    name: 'returns',
    columns: [
      int('id'),
      int('ref'),
      int('sale_id'),
      int('session_id', true),
      int('user_id', true),
      text('reason'),
      int('refund_lbp'),
      int('balance_reduced_lbp'),
      text('refund_method', true),
      text('refund_currency', true),
      int('refund_amount', true),
      text('idempotency_key', true),
      int('legacy_id', true),
      text('created_at'),
    ],
  },
  {
    name: 'return_items',
    columns: [int('id'), int('return_id'), int('sale_item_id'), int('qty_milli'), int('amount_lbp')],
  },
  {
    name: 'customer_payments',
    columns: [
      int('id'),
      int('customer_id'),
      int('session_id', true),
      int('user_id', true),
      int('amount_lbp'),
      text('idempotency_key', true),
      text('created_at'),
    ],
  },
  {
    name: 'register_sessions',
    columns: [
      int('id'),
      text('terminal_id'),
      int('opened_by', true),
      text('opened_at'),
      int('closed_by', true),
      text('closed_at', true),
      text('status'),
      int('legacy_id', true),
    ],
  },
  {
    name: 'register_balances',
    columns: [
      int('id'),
      int('session_id'),
      text('method'),
      text('currency'),
      int('opening'),
      int('expected'),
      int('counted', true),
      int('variance', true),
    ],
  },
  {
    name: 'register_movements',
    columns: [
      int('id'),
      int('session_id'),
      text('type'),
      text('from_method', true),
      text('from_currency', true),
      text('to_method', true),
      text('to_currency', true),
      int('amount'),
      text('reason'),
      int('user_id', true),
      text('created_at'),
    ],
  },
  {
    name: 'expenses',
    columns: [
      int('id'),
      int('category_id', true),
      int('session_id', true),
      text('title'),
      text('reference'),
      text('note', true),
      int('amount_minor'),
      text('currency'),
      int('legacy_id', true),
      text('created_at'),
    ],
  },
  {
    name: 'expense_categories',
    columns: [int('id'), text('name'), int('legacy_id', true)],
  },
  {
    name: 'purchases',
    columns: [
      int('id'),
      int('ref'),
      int('supplier_id', true),
      int('warehouse_id'),
      text('status'),
      text('currency'),
      int('total_minor'),
      int('paid_minor'),
      text('payment_type', true),
      text('idempotency_key', true),
      int('legacy_id', true),
      text('created_at'),
      text('received_at', true),
    ],
  },
  {
    name: 'purchase_items',
    columns: [
      int('id'),
      int('purchase_id'),
      int('product_id', true),
      text('name_snap'),
      int('qty_milli'),
      int('cost_minor'),
      int('received_milli'),
      int('legacy_id', true),
    ],
  },
  {
    name: 'purchase_payments',
    columns: [
      int('id'),
      int('purchase_id'),
      int('amount_minor'),
      text('note', true),
      int('user_id', true),
      text('idempotency_key', true),
      text('created_at'),
    ],
  },
  {
    name: 'wallet_entries',
    columns: [
      int('id'),
      text('method'),
      text('currency'),
      int('amount'),
      text('kind'),
      text('ref_type', true),
      int('ref_id', true),
      int('session_id', true),
      int('user_id', true),
      text('reason', true),
      text('created_at'),
    ],
  },
  {
    name: 'wallet_counts',
    columns: [
      int('id'),
      text('method'),
      text('currency'),
      int('counted'),
      int('expected', true),
      int('variance', true),
      int('entry_mark'),
      text('purpose'),
      text('note', true),
      int('counted_by'),
      text('counted_at'),
    ],
  },
  {
    name: 'service_sales',
    columns: [
      int('id'),
      int('category_id', true),
      int('customer_id', true),
      int('user_id', true),
      text('reference'),
      text('note', true),
      int('cost_minor'),
      int('fee_minor'),
      int('profit_minor'),
      text('currency'),
      int('legacy_id', true),
      text('created_at'),
      int('session_id', true),
    ],
  },
  {
    name: 'service_categories',
    columns: [int('id'), text('name'), int('legacy_id', true)],
  },
];

export const syncTable = (name: string): SyncTable | undefined => SYNC_TABLES.find((t) => t.name === name);

// ------------------------------------------------------------------ reconciliation (docs/12 §24, P4c)

/**
 * A control: for each day (the UTC date of a row's time), how many rows a table has and the sum of one amount. The branch computes it from its own
 * tables and sends it; HQ computes the SAME thing from its mirror and compares. A difference means a row is missing, doubled or changed on one side
 * (a restored backup, a lost write, a bug), which no one would otherwise see. Defined ONCE here, so the two sides cannot drift.
 * `parent`: the table has no time of its own; its rows count on the day of the parent row they belong to.
 */
export type ControlSpec = { name: string; day: string; amount: string; parent?: { table: string; fk: string } };

/** Columns are written with the alias `x` (the table) and, with a parent, `p` (the parent). `day` is the time column of the table or its parent. */
export const CONTROLS: readonly ControlSpec[] = [
  { name: 'sales', day: 'created_at', amount: 'x.total_lbp' },
  { name: 'sale_items', day: 'created_at', amount: 'x.line_total_lbp', parent: { table: 'sales', fk: 'sale_id' } },
  { name: 'payments', day: 'created_at', amount: 'x.amount' },
  { name: 'stock_movements', day: 'created_at', amount: 'x.qty_milli_delta' },
  { name: 'returns', day: 'created_at', amount: 'x.refund_lbp + x.balance_reduced_lbp' },
  { name: 'return_items', day: 'created_at', amount: 'x.amount_lbp', parent: { table: 'returns', fk: 'return_id' } },
  { name: 'customer_payments', day: 'created_at', amount: 'x.amount_lbp' },
  { name: 'register_sessions', day: 'opened_at', amount: '0' },
  { name: 'register_balances', day: 'opened_at', amount: 'x.expected', parent: { table: 'register_sessions', fk: 'session_id' } },
  { name: 'register_movements', day: 'created_at', amount: 'x.amount' },
  { name: 'expenses', day: 'created_at', amount: 'x.amount_minor' },
  { name: 'purchases', day: 'created_at', amount: 'x.total_minor' },
  { name: 'purchase_items', day: 'created_at', amount: 'x.qty_milli', parent: { table: 'purchases', fk: 'purchase_id' } },
  { name: 'purchase_payments', day: 'created_at', amount: 'x.amount_minor' },
  { name: 'wallet_entries', day: 'created_at', amount: 'x.amount' },
  { name: 'wallet_counts', day: 'counted_at', amount: 'x.counted' },
  { name: 'service_sales', day: 'created_at', amount: 'x.fee_minor' },
];

/** One number pair: rows and their summed amount. */
export type Control = { n: number; s: number };
/** One day's controls, by table name. `day` is `YYYY-MM-DD` (UTC). */
export type DayControls = { day: string; tables: Record<string, Control> };

/** The query that groups one table by day. Parameters, in order: from, to (plain dates: from inclusive, to exclusive), then on HQ's side the branch id (twice with a parent). */
export function controlSql(spec: ControlSpec, side: 'branch' | 'hq'): string {
  const hq = side === 'hq';
  if (!spec.parent) {
    return `SELECT substr(x.${spec.day}, 1, 10) AS d, COUNT(*) AS n, COALESCE(SUM(${spec.amount}), 0) AS s FROM ${spec.name} x
      WHERE x.${spec.day} >= ? AND x.${spec.day} < ?${hq ? ' AND x.branch_id = ?' : ''} GROUP BY d`;
  }
  const on = hq ? `p.branch_id = x.branch_id AND p.id = x.${spec.parent.fk}` : `p.id = x.${spec.parent.fk}`;
  return `SELECT substr(p.${spec.day}, 1, 10) AS d, COUNT(*) AS n, COALESCE(SUM(${spec.amount}), 0) AS s FROM ${spec.name} x
    JOIN ${spec.parent.table} p ON ${on}
    WHERE p.${spec.day} >= ? AND p.${spec.day} < ?${hq ? ' AND x.branch_id = ?' : ''} GROUP BY d`;
}

/** The days a control covers: the `count` days that END before `today` (a plain date), oldest first. Today itself is still changing. */
export function controlDays(today: string, count: number): { from: string; to: string; days: string[] } {
  const end = Date.parse(`${today}T00:00:00Z`);
  const days: string[] = [];
  for (let i = count; i >= 1; i--) days.push(new Date(end - i * 86_400_000).toISOString().slice(0, 10));
  return { from: days[0]!, to: today, days };
}

export type ControlDiff = { table: string; branch: Control; hq: Control };

/** Which tables differ between what the branch says and what HQ holds (a table the other side does not know is skipped, not a difference). */
export function diffControls(branch: Record<string, Control>, hq: Record<string, Control>): ControlDiff[] {
  const out: ControlDiff[] = [];
  for (const spec of CONTROLS) {
    const b = branch[spec.name];
    if (!b) continue;
    const h = hq[spec.name] ?? { n: 0, s: 0 };
    if (b.n !== h.n || b.s !== h.s) out.push({ table: spec.name, branch: b, hq: h });
  }
  return out;
}

export type FactValue = number | string | null;
export type FactRow = Record<string, FactValue>;
/** One change: `u` = this is the row now (insert or update), `d` = it is gone. */
export type Fact = { tbl: string; pk: number; op: 'u' | 'd'; row?: FactRow };
/** What a branch POSTs to HQ in one request. */
export type FactsBatch = { rows: Fact[] };

/** The most rows in one batch. HQ refuses more. */
export const MAX_BATCH_ROWS = 500;

/** Is this a row of that table, exactly? Returns what is wrong, or null. Unknown columns are refused, not ignored: that is a version mismatch. */
export function validateRow(table: SyncTable, row: unknown): string | null {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return 'the row is not an object';
  const r = row as Record<string, unknown>;
  const known = new Set(table.columns.map((c) => c.name));
  for (const key of Object.keys(r)) if (!known.has(key)) return `unknown column "${key}"`;
  for (const c of table.columns) {
    const v = r[c.name];
    if (v === undefined) return `missing column "${c.name}"`;
    if (v === null) {
      if (!c.nullable) return `column "${c.name}" cannot be empty`;
      continue;
    }
    if (c.kind === 'int' && !(typeof v === 'number' && Number.isSafeInteger(v))) return `column "${c.name}" must be a whole number`;
    if (c.kind === 'text' && typeof v !== 'string') return `column "${c.name}" must be text`;
  }
  return null;
}

/** One row as a stable string: the columns in their fixed order, each as JSON. */
const canonical = (table: SyncTable, row: FactRow): string => table.columns.map((c) => JSON.stringify(row[c.name] ?? null)).join('|');

const MOD = 2 ** 48;
export type Digest = { count: number; maxPk: number; checksum: string };

/**
 * A fingerprint of a set of rows, the same on both sides when the rows are the same: how many, the highest id, and the sum (mod 2^48)
 * of the first 48 bits of each row's SHA-256. The sum does not depend on the order the rows are read in. Used to prove that HQ holds
 * exactly what a branch holds.
 */
export function digestRows(table: SyncTable, rows: Iterable<FactRow>): Digest {
  let count = 0;
  let maxPk = 0;
  let sum = 0;
  for (const row of rows) {
    count += 1;
    maxPk = Math.max(maxPk, Number(row.id));
    sum = (sum + parseInt(createHash('sha256').update(canonical(table, row)).digest('hex').slice(0, 12), 16)) % MOD;
  }
  return { count, maxPk, checksum: sum.toString(16).padStart(12, '0') };
}

// ------------------------------------------------------------------ going DOWN: what HQ owns and the branch receives (docs/12 §5, §15)

/**
 * The tables HQ owns and branches copy. Each row keeps HQ's id; at a branch it is stored in the column `hq_id` of its own table (so HQ's
 * numbers never collide with ids the branch made itself). Same column checks as for what goes up.
 */
export type DownTable = SyncTable & {
  /**
   * `mapped`: the branch keeps HQ's id in `hq_id` beside its own ids (a rate: nothing points at it).
   * `same`: the branch uses HQ's id AS its own id (the catalog, docs/12 §15 and P3): a product, a sale item or a stock movement then
   * means the same thing at HQ and at every branch. Possible because a branch must have an empty catalog when it connects.
   */
  ids: 'mapped' | 'same';
};
export const DOWN_TABLES: readonly DownTable[] = [
  { name: 'exchange_rates', ids: 'mapped', columns: [int('id'), int('rate_lbp_per_usd'), text('effective_from'), text('created_at')] },
  { name: 'categories', ids: 'same', columns: [int('id'), text('name')] },
  { name: 'brands', ids: 'same', columns: [int('id'), text('name')] },
  { name: 'units', ids: 'same', columns: [int('id'), text('name'), int('fractional')] },
  { name: 'suppliers', ids: 'same', columns: [int('id'), text('name'), text('address', true), text('phone', true), text('email', true)] },
  {
    // The products themselves (P3b). `cost_minor` is HQ's starting cost: a branch takes it when it first receives the product and then keeps
    // its own (a purchase received at the branch sets it). `updated_at` is the branch's own (the till's catalog feed follows it). So neither
    // overwrites what the branch has. `image_path` names a picture file that the branch fetches from HQ by that name (docs/12 §19).
    name: 'products',
    ids: 'same',
    columns: [
      int('id'),
      text('name'),
      text('receipt_name', true),
      int('receipt_name_manual'),
      text('barcode'),
      int('cost_minor'),
      int('price_minor'),
      text('currency'),
      int('category_id', true),
      int('brand_id', true),
      int('unit_id', true),
      int('supplier_id', true),
      int('stock_alert_milli', true),
      text('expiry_date', true),
      int('active'),
      text('image_path', true),
    ],
  },
];
export const downTable = (name: string): DownTable | undefined => DOWN_TABLES.find((t) => t.name === name);

/** One entry of HQ's change log, as a branch receives it. `seq` is HQ's order; a branch remembers the last one it applied. */
export type Change = { seq: number; tbl: string; pk: number; op: 'u' | 'd'; row?: FactRow };
export const MAX_CHANGES_PAGE = 500;
