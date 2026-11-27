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

/** The sale cluster (P2b). More branch-owned tables are added the same way in P4. */
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
];

export const syncTable = (name: string): SyncTable | undefined => SYNC_TABLES.find((t) => t.name === name);

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
];
export const downTable = (name: string): DownTable | undefined => DOWN_TABLES.find((t) => t.name === name);

/** One entry of HQ's change log, as a branch receives it. `seq` is HQ's order; a branch remembers the last one it applied. */
export type Change = { seq: number; tbl: string; pk: number; op: 'u' | 'd'; row?: FactRow };
export const MAX_CHANGES_PAGE = 500;
