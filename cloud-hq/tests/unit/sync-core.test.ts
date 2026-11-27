import { describe, it, expect } from 'vitest';
import {
  CONTROLS,
  controlDays,
  controlSql,
  diffControls,
  digestRows,
  MAX_BATCH_ROWS,
  SYNC_TABLES,
  syncTable,
  validateRow,
  type FactRow,
} from '../../core/src/sync';

// The shared definition of what a branch sends to HQ, and the fingerprint used to prove HQ holds the same rows (docs/12-sync-and-hq.md §3-4).
const sales = syncTable('sales')!;
const goodSale = (over: Partial<FactRow> = {}): FactRow => ({
  id: 1,
  ref: 1001,
  session_id: 1,
  user_id: 2,
  customer_id: 1,
  warehouse_id: 1,
  rate_lbp_per_usd: 90000,
  subtotal_lbp: 75000,
  discount_lbp: 0,
  shipping_lbp: 0,
  rounding_lbp: 0,
  total_lbp: 75000,
  paid_lbp: 75000,
  change_lbp: 0,
  rest_lbp: 0,
  profit_lbp: 15000,
  status: 'paid',
  notes: '',
  client_sale_id: 'abc',
  idempotency_key: 'k',
  legacy_id: null,
  created_at: '2026-11-23T10:00:00.000Z',
  ...over,
});

describe('what is synced', () => {
  it('lists the sale cluster first, then what P4a added, each table starting with its id', () => {
    const names = SYNC_TABLES.map((t) => t.name);
    expect(names.slice(0, 4)).toEqual(['sales', 'sale_items', 'payments', 'stock_movements']);
    expect(new Set(names).size).toBe(names.length); // no table twice
    for (const t of [
      'returns',
      'return_items',
      'customer_payments',
      'register_sessions',
      'register_balances',
      'register_movements',
      'expenses',
      'purchases',
      'wallet_entries',
      'wallet_counts',
      'service_sales',
    ])
      expect(names).toContain(t);
    for (const t of SYNC_TABLES) {
      expect(t.columns[0]).toEqual({ name: 'id', kind: 'int', nullable: false });
      expect(new Set(t.columns.map((c) => c.name)).size).toBe(t.columns.length); // no column twice
    }
  });

  it('finds a table by name, and not one that is not listed', () => {
    expect(syncTable('sales')?.name).toBe('sales');
    expect(syncTable('users')).toBeUndefined(); // never sent: a branch's staff are not HQ's business here
    expect(syncTable('sync_outbox')).toBeUndefined();
    expect(syncTable('audit_log')).toBeUndefined(); // not yet (P4)
  });

  it('a batch is at most 500 rows', () => {
    expect(MAX_BATCH_ROWS).toBe(500);
  });
});

describe('checking a row', () => {
  it('accepts a complete, well-formed row, with empty values where a column may be empty', () => {
    expect(validateRow(sales, goodSale())).toBeNull();
    expect(validateRow(sales, goodSale({ session_id: null, user_id: null, client_sale_id: null, idempotency_key: null }))).toBeNull();
  });

  it('refuses a row that is not an object', () => {
    for (const bad of [null, undefined, 'x', 5, [], [1, 2]]) expect(validateRow(sales, bad), String(bad)).toBe('the row is not an object');
  });

  it('refuses an unknown column (a version mismatch must be loud, not silently dropped)', () => {
    expect(validateRow(sales, { ...goodSale(), surprise: 1 })).toBe('unknown column "surprise"');
  });

  it('refuses a missing column', () => {
    const { total_lbp: _gone, ...rest } = goodSale();
    expect(validateRow(sales, rest)).toBe('missing column "total_lbp"');
  });

  it('refuses an empty value where one is required', () => {
    expect(validateRow(sales, goodSale({ total_lbp: null }))).toBe('column "total_lbp" cannot be empty');
    expect(validateRow(sales, goodSale({ status: null }))).toBe('column "status" cannot be empty');
  });

  it('refuses the wrong kind of value: money must be a whole number, text must be text', () => {
    expect(validateRow(sales, goodSale({ total_lbp: 75000.5 }))).toBe('column "total_lbp" must be a whole number');
    expect(validateRow(sales, goodSale({ total_lbp: '75000' }))).toBe('column "total_lbp" must be a whole number');
    expect(validateRow(sales, goodSale({ total_lbp: Number.NaN }))).toBe('column "total_lbp" must be a whole number');
    expect(validateRow(sales, goodSale({ total_lbp: 2 ** 60 }))).toBe('column "total_lbp" must be a whole number'); // beyond what a number holds exactly
    expect(validateRow(sales, goodSale({ status: 5 }))).toBe('column "status" must be text');
  });
});

describe('the fingerprint of a set of rows', () => {
  const rows = [goodSale({ id: 1 }), goodSale({ id: 2, ref: 1002 }), goodSale({ id: 3, ref: 1003, status: 'void' })];

  it('says how many rows, the highest id, and a checksum', () => {
    const d = digestRows(sales, rows);
    expect(d).toMatchObject({ count: 3, maxPk: 3 });
    expect(d.checksum).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is the same however the rows are ordered', () => {
    expect(digestRows(sales, [...rows].reverse())).toEqual(digestRows(sales, rows));
  });

  it('changes when any single value of any row changes', () => {
    const base = digestRows(sales, rows).checksum;
    const changes: FactRow[] = [
      { total_lbp: 75001 },
      { status: 'paid' },
      { notes: 'x' },
      { client_sale_id: null },
      { created_at: '2026-11-23T10:00:00.001Z' },
    ];
    for (const change of changes) {
      const altered: FactRow[] = [rows[0]!, rows[1]!, { ...rows[2]!, ...change }];
      expect(digestRows(sales, altered).checksum, JSON.stringify(change)).not.toBe(base);
    }
  });

  it('changes when a row is missing or added', () => {
    const base = digestRows(sales, rows);
    expect(digestRows(sales, rows.slice(0, 2)).checksum).not.toBe(base.checksum);
    expect(digestRows(sales, [...rows, goodSale({ id: 4, ref: 1004 })]).checksum).not.toBe(base.checksum);
    expect(digestRows(sales, [])).toEqual({ count: 0, maxPk: 0, checksum: '000000000000' });
  });

  it('tells a null from an empty text and from zero (they are different values)', () => {
    const a = digestRows(sales, [goodSale({ client_sale_id: null })]).checksum;
    const b = digestRows(sales, [goodSale({ client_sale_id: '' })]).checksum;
    const c = digestRows(sales, [goodSale({ legacy_id: 0 })]).checksum;
    expect(new Set([a, b, c, digestRows(sales, [goodSale()]).checksum]).size).toBe(4);
  });

  it('is exact across many rows (no drift from adding large numbers)', () => {
    const many = Array.from({ length: 5000 }, (_, i) => goodSale({ id: i + 1, ref: 1000 + i }));
    const d = digestRows(sales, many);
    expect(d.count).toBe(5000);
    expect(digestRows(sales, [...many].reverse())).toEqual(d);
    expect(digestRows(sales, many.slice(1))).not.toEqual(d);
  });
});

describe('the daily control (docs/12 §24)', () => {
  it('covers the days that end before today, oldest first, and never today', () => {
    expect(controlDays('2026-11-27', 3)).toEqual({
      from: '2026-11-24',
      to: '2026-11-27',
      days: ['2026-11-24', '2026-11-25', '2026-11-26'],
    });
    expect(controlDays('2026-03-02', 2).days).toEqual(['2026-02-28', '2026-03-01']); // across a month end
  });

  it('says which tables differ, skips what the other side does not know, and treats a table HQ has no rows of as zero', () => {
    const same = { n: 2, s: 10 };
    expect(diffControls({ sales: same, expenses: same }, { sales: same, expenses: same })).toEqual([]);
    expect(diffControls({ sales: same }, { sales: { n: 2, s: 11 } })).toEqual([{ table: 'sales', branch: same, hq: { n: 2, s: 11 } }]);
    expect(diffControls({ sales: same }, {})).toEqual([{ table: 'sales', branch: same, hq: { n: 0, s: 0 } }]);
    expect(diffControls({ future_table: same } as never, {})).toEqual([]); // a table from another version is not a difference
    expect(diffControls({}, { sales: same })).toEqual([]); // the branch said nothing about it
  });

  it('is one definition for both sides: a child table counts on its parent’s day, and HQ always narrows to one branch', () => {
    const items = CONTROLS.find((c) => c.name === 'sale_items')!;
    expect(controlSql(items, 'branch')).toContain('JOIN sales p ON p.id = x.sale_id');
    expect(controlSql(items, 'hq')).toContain('p.branch_id = x.branch_id AND p.id = x.sale_id');
    expect(controlSql(items, 'hq')).toContain('x.branch_id = ?');
    for (const spec of CONTROLS) {
      expect(controlSql(spec, 'hq'), spec.name).toContain('x.branch_id = ?');
      expect(controlSql(spec, 'branch'), spec.name).not.toContain('branch_id');
    }
    expect(new Set(CONTROLS.map((c) => c.name)).size).toBe(CONTROLS.length);
  });
});
