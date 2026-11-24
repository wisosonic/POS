import { describe, it, expect } from 'vitest';
import { digestRows, MAX_BATCH_ROWS, SYNC_TABLES, syncTable, validateRow, type FactRow } from '../../core/src/sync';

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
  it('lists the sale cluster, each table starting with its id', () => {
    expect(SYNC_TABLES.map((t) => t.name)).toEqual(['sales', 'sale_items', 'payments', 'stock_movements']);
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
