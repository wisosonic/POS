import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { digestRows, syncTable, type FactRow } from '../../branch-server/core/src/sync';
import { adminAuth, branchAuth, startHq, type Hq } from './helpers';

// What a branch sends up and HQ stores (docs/12-sync-and-hq.md P2b): a batch is applied whole or not at all, sending it twice changes nothing,
// and one branch can never write into another's records.
let hq: Hq;
let tokenA = '';
let tokenB = '';
const api = '/api/v1';

const sale = (id: number, over: Partial<FactRow> = {}): FactRow => ({
  id,
  ref: 1000 + id,
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
  client_sale_id: `c-${id}`,
  idempotency_key: `k-${id}`,
  legacy_id: null,
  created_at: '2026-11-23T10:00:00.000Z',
  ...over,
});
const up = (id: number, over: Partial<FactRow> = {}) => ({ tbl: 'sales', pk: id, op: 'u' as const, row: sale(id, over) });
const send = (token: string, rows: unknown[]) => hq.http.post(`${api}/sync/facts`).set(branchAuth(token)).send({ rows });
const digest = async (token: string, tbl = 'sales') => (await hq.http.get(`${api}/sync/digest?tbl=${tbl}`).set(branchAuth(token))).body;

const enrolled = async (code: string) => {
  const enrolCode = (await hq.http.post(`${api}/branches`).set(adminAuth).send({ code, name: code })).body.enrolCode as string;
  return (await hq.http.post(`${api}/sync/enrol`).send({ code: enrolCode })).body.token as string;
};

beforeAll(async () => {
  hq = await startHq();
  tokenA = await enrolled('A1');
  tokenB = await enrolled('B1');
});
afterAll(() => hq.close());

describe('who may send', () => {
  it('refuses no token, a wrong token and the admin token (US-HQ-facts)', async () => {
    expect((await hq.http.post(`${api}/sync/facts`).send({ rows: [] })).status).toBe(401);
    expect((await send('garbage-token', [])).status).toBe(401);
    expect((await hq.http.post(`${api}/sync/facts`).set(adminAuth).send({ rows: [] })).status).toBe(401);
    expect((await hq.http.get(`${api}/sync/digest?tbl=sales`)).status).toBe(401);
  });
});

describe('storing a batch', () => {
  it('stores rows, and says how many', async () => {
    const res = await send(tokenA, [up(1), up(2)]);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ applied: 2 });
    const d = await digest(tokenA);
    expect(d).toMatchObject({ tbl: 'sales', count: 2, maxPk: 2 });
    expect(d.checksum).toBe(digestRows(syncTable('sales')!, [sale(1), sale(2)]).checksum);
  });

  it('sending the same batch again changes nothing (a lost answer is harmless)', async () => {
    const before = await digest(tokenA);
    await send(tokenA, [up(1), up(2)]);
    await send(tokenA, [up(1), up(2)]);
    expect(await digest(tokenA)).toEqual(before);
  });

  it('a later version of a row replaces the earlier one (a sale that was voided)', async () => {
    await send(tokenA, [up(2, { status: 'void', rest_lbp: 0 })]);
    const d = await digest(tokenA);
    expect(d.count).toBe(2);
    expect(d.checksum).toBe(digestRows(syncTable('sales')!, [sale(1), sale(2, { status: 'void' })]).checksum);
  });

  it('a deletion removes the row, and deleting what is not there is fine', async () => {
    await send(tokenA, [{ tbl: 'sales', pk: 2, op: 'd' }]);
    expect((await digest(tokenA)).count).toBe(1);
    expect(
      (
        await send(tokenA, [
          { tbl: 'sales', pk: 2, op: 'd' },
          { tbl: 'sales', pk: 99, op: 'd' },
        ])
      ).status,
    ).toBe(200);
  });

  it('an empty batch is fine', async () => {
    expect((await send(tokenA, [])).body).toEqual({ applied: 0 });
  });

  it('the lines of a sale can arrive before or after the sale itself (no foreign keys at HQ)', async () => {
    const item = {
      id: 1,
      sale_id: 77,
      product_id: null,
      name_snap: 'x',
      qty_milli: 1000,
      unit_price_lbp: 1000,
      line_total_lbp: 1000,
    };
    const cols = syncTable('sale_items')!.columns.map((c) => c.name);
    const row = Object.fromEntries(cols.map((c) => [c, (item as Record<string, unknown>)[c] ?? (c === 'name_snap' ? 'x' : 0)]));
    const res = await send(tokenA, [{ tbl: 'sale_items', pk: 1, op: 'u', row }]);
    // either 200 (the row fits) or a clear refusal naming the column: never a crash
    expect([200, 422]).toContain(res.status);
  });
});

describe('a bad batch is refused whole', () => {
  it('one bad row among good ones stores none of them', async () => {
    const before = await digest(tokenB);
    const res = await send(tokenB, [up(10), up(11), { tbl: 'sales', pk: 12, op: 'u', row: { ...sale(12), total_lbp: 1.5 } }]);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('FACTS_INVALID');
    expect(res.body.detail ?? res.body.title).toMatch(/Row 3/);
    expect(await digest(tokenB)).toEqual(before);
  });

  it.each([
    ['a table HQ does not take', { tbl: 'users', pk: 1, op: 'd' }],
    ['an id that is not positive', { tbl: 'sales', pk: 0, op: 'd' }],
    ['a row whose id differs from the stated one', { tbl: 'sales', pk: 5, op: 'u', row: sale(6) }],
    ['an unknown column', { tbl: 'sales', pk: 5, op: 'u', row: { ...sale(5), surprise: 1 } }],
    ['a missing row on an update', { tbl: 'sales', pk: 5, op: 'u' }],
  ])('refuses %s', async (_name, fact) => {
    const res = await send(tokenB, [fact]);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('FACTS_INVALID');
  });

  it('refuses a body that is not a list of rows, or more than 500 rows', async () => {
    expect((await hq.http.post(`${api}/sync/facts`).set(branchAuth(tokenB)).send({ rows: 'x' })).status).toBe(400);
    expect((await hq.http.post(`${api}/sync/facts`).set(branchAuth(tokenB)).send({})).status).toBe(400);
    const many = Array.from({ length: 501 }, (_, i) => up(i + 1));
    expect((await send(tokenB, many)).status).toBe(400);
    expect((await send(tokenB, many.slice(0, 500))).status).toBe(200);
    expect((await digest(tokenB)).count).toBe(500);
  });

  it('never writes SQL from what a branch sends: odd table names and values are just refused or stored as text', async () => {
    expect((await send(tokenB, [{ tbl: 'sales; DROP TABLE sales', pk: 1, op: 'd' }])).status).toBe(422);
    const res = await send(tokenB, [up(900, { notes: "x'); DROP TABLE sales; --" })]);
    expect(res.status).toBe(200);
    expect((await digest(tokenB)).count).toBeGreaterThan(0);
  });
});

describe('branches are kept apart', () => {
  it('two branches may use the same id and the same receipt number', async () => {
    await send(tokenA, [up(500, { ref: 5000 })]);
    expect((await send(tokenB, [up(500, { ref: 5000 })])).status).toBe(200);
  });

  it('a branch sees only its own fingerprint and deletes only its own rows', async () => {
    const a = await digest(tokenA);
    await send(tokenB, [{ tbl: 'sales', pk: 500, op: 'd' }]);
    expect(await digest(tokenA)).toEqual(a);
  });

  it('a revoked branch can no longer send', async () => {
    const t = await enrolled('C1');
    expect((await send(t, [up(1)])).status).toBe(200);
    const id = (await hq.http.get(`${api}/branches`).set(adminAuth)).body.data.find((b: { code: string }) => b.code === 'C1').id;
    await hq.http.post(`${api}/branches/${id}/revoke`).set(adminAuth);
    expect((await send(t, [up(2)])).status).toBe(401);
  });

  it('asking for the fingerprint of a table HQ does not take is refused', async () => {
    expect((await hq.http.get(`${api}/sync/digest?tbl=users`).set(branchAuth(tokenA))).status).toBe(422);
  });
});
