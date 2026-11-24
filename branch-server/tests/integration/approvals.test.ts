import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCtx, type TestCtx } from '../helpers/app';

// US-09: a discount above the cashier's limit needs a manager's approval, given by the manager typing their password at
// the till. The approval works once, for that cashier only, for a few minutes, and is written to the audit log.
let c: TestCtx;
let cashier: string;
let admin: string;
let cashier2: string;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const MANAGER = { username: '', password: '' };
const TOWEL = 75000;

const sale = (over: Record<string, unknown> = {}, token = cashier, key = randomUUID()) =>
  c.http
    .post(`${api}/sales`)
    .set(auth(token))
    .set('Idempotency-Key', key)
    .send(
      c.newSaleBody({
        items: [{ productId: c.seed.products.towel.id, qty: '1', unitPriceLbp: TOWEL }],
        payments: [{ method: 'cash', currency: 'LBP', amount: TOWEL }],
        ...over,
      }),
    );
const approve = (body: Record<string, unknown> = {}, token = cashier) =>
  c.http
    .post(`${api}/auth/approve`)
    .set(auth(token))
    .send({ username: MANAGER.username, password: MANAGER.password, scope: 'discount', pct: 40, ...body });
const withDb = <T>(fn: (db: Database.Database) => T) => {
  const db = new Database(c.databasePath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
};
const over = { discount: { type: 'percent', value: 40 } }; // far above the limit; 40% of 75,000 = 30,000 → total 45,000
const paid45 = { payments: [{ method: 'cash', currency: 'LBP', amount: 45000 }] };

beforeAll(async () => {
  c = await startCtx();
  cashier = await c.login('cashier');
  admin = await c.login('admin');
  MANAGER.username = c.seed.users.manager.username;
  MANAGER.password = c.seed.users.manager.password;
  await c.openRegister(cashier);

  const made = await c.http
    .post(`${api}/users`)
    .set(auth(admin))
    .send({ username: 'cashier-two', name: 'Cashier Two', role: 'cashier', password: 'a-long-enough-password' });
  expect(made.status).toBe(201);
  cashier2 = (await c.http.post(`${api}/auth/login`).send({ username: 'cashier-two', password: 'a-long-enough-password' })).body
    .accessToken;
});
afterAll(() => c.close());

describe('the limit', () => {
  it('a discount within the limit needs nothing', async () => {
    const pub = await c.http.get(`${api}/settings/public`).set(auth(cashier));
    expect(pub.body.cashierDiscountLimitPct).toBeGreaterThanOrEqual(5);
    const res = await sale({ discount: { type: 'percent', value: 5 }, payments: [{ method: 'cash', currency: 'LBP', amount: 71250 }] });
    expect(res.status).toBe(201);
    expect(res.body.totalLbp).toBeLessThan(TOWEL);
  });

  it('over the limit is refused, and the refusal says what the limit is and what was asked', async () => {
    const res = await sale({ ...over, ...paid45 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DISCOUNT_OVER_LIMIT');
    expect(res.body.limitPct).toBeGreaterThanOrEqual(5);
    expect(res.body.requestedPct).toBe(40);
  });

  it('a manager needs no approval for any discount, and an approval they carry is not used up', async () => {
    const manager = await c.login('manager');
    const token = (await approve({}, manager)).body.approvalToken;
    const res = await sale({ ...over, ...paid45, approvalToken: token }, manager);
    expect(res.status).toBe(201);
    const row = withDb((db) => db.prepare('SELECT used_at FROM approvals ORDER BY id DESC LIMIT 1').get() as { used_at: string | null });
    expect(row.used_at).toBeNull();
  });
});

describe('getting an approval', () => {
  it('a manager’s name and password give the cashier a token, and say who approved', async () => {
    const res = await approve();
    expect(res.status).toBe(200);
    expect(res.body.approvalToken).toMatch(/^[\w-]{20,}$/);
    expect(res.body.approvedBy).toEqual({ id: c.seed.users.manager.id, name: 'Test manager' });
    expect(Date.parse(res.body.expiresAt)).toBeGreaterThan(Date.now());
    expect(Date.parse(res.body.expiresAt)).toBeLessThanOrEqual(Date.now() + 11 * 60_000);
  });

  it('only a stored hash is kept, never the token', async () => {
    const token = (await approve()).body.approvalToken as string;
    const stored = withDb((db) => JSON.stringify(db.prepare('SELECT * FROM approvals').all()));
    expect(stored).not.toContain(token);
  });

  it('a wrong password, an unknown name, a cashier and an admin-who-is-inactive are all refused with the same answer', async () => {
    const answers = [
      await approve({ password: 'wrong-password' }),
      await approve({ username: 'nobody-here' }),
      await approve({ username: 'cashier-two', password: 'a-long-enough-password' }), // right password, but not a manager
    ];
    for (const a of answers) {
      expect(a.status).toBe(401);
      expect(a.body.detail).toBe('That manager name and password were not accepted');
    }
  });

  it('a deactivated manager cannot approve', async () => {
    const m = await c.http
      .post(`${api}/users`)
      .set(auth(admin))
      .send({ username: 'ex-manager', name: 'Ex Manager', role: 'manager', password: 'a-long-enough-password' });
    await c.http.patch(`${api}/users/${m.body.id}`).set(auth(admin)).send({ active: false });
    expect((await approve({ username: 'ex-manager', password: 'a-long-enough-password' })).status).toBe(401);
  });

  it('needs a sign-in, and only knows the scope "discount"', async () => {
    expect((await c.http.post(`${api}/auth/approve`).send({ username: 'x', password: 'y', scope: 'discount' })).status).toBe(401);
    expect((await approve({ scope: 'refund' })).status).toBe(400);
    expect((await approve({ scope: undefined })).status).toBe(400);
  });

  it('five wrong passwords lock approvals, but do not stop the manager signing in', async () => {
    const username = 'lockable-manager';
    await c.http
      .post(`${api}/users`)
      .set(auth(admin))
      .send({ username, name: 'Lockable', role: 'manager', password: 'a-long-enough-password' });
    for (let i = 0; i < 5; i++) await approve({ username, password: 'wrong' });
    const locked = await approve({ username, password: 'a-long-enough-password' });
    expect(locked.status).toBe(423);
    expect(locked.headers['retry-after']).toBeDefined();
    const signIn = await c.http.post(`${api}/auth/login`).send({ username, password: 'a-long-enough-password' });
    expect(signIn.status).toBe(200);
  });
});

describe('an approval covers the discount the manager was shown, and no more', () => {
  it('is for a percent: the request must say how much, from 0 to 100', async () => {
    expect((await approve({ pct: undefined })).status).toBe(400);
    expect((await approve({ pct: 101 })).status).toBe(400);
    expect((await approve({ pct: -1 })).status).toBe(400);
    expect((await approve({ pct: 15 })).body.maxPct).toBe(15);
  });

  it('a cashier cannot ask a manager to approve a small discount and then take a big one', async () => {
    const pub = await c.http.get(`${api}/settings/public`).set(auth(cashier));
    expect(pub.body.cashierDiscountLimitPct).toBeLessThan(15);

    const token = (await approve({ pct: 15 })).body.approvalToken;
    const greedy = await sale({ ...over, ...paid45, approvalToken: token }); // 40% with an approval for 15%
    expect(greedy.status).toBe(403);
    expect(greedy.body.code).toBe('DISCOUNT_OVER_LIMIT');

    // The refusal did not use the approval up: the 15% the manager actually agreed to still goes through.
    const honest = await sale({
      discount: { type: 'percent', value: 15 },
      payments: [{ method: 'cash', currency: 'LBP', amount: TOWEL }], // 63,750 rounds to 65,000; the rest comes back as change
      approvalToken: token,
    });
    expect(honest.status).toBe(201);
    expect(honest.body.totalLbp).toBe(65000);
  });

  it('works for a discount given as an amount, judged by the percent it comes to', async () => {
    const token = (await approve({ pct: 40 })).body.approvalToken;
    const res = await sale({ discount: { type: 'amount', value: 30000 }, ...paid45, approvalToken: token });
    expect(res.status).toBe(201);
    expect(res.body.totalLbp).toBe(45000);
  });

  it('a discount a little under the approved percent is fine; a little over is not', async () => {
    const under = (await approve({ pct: 40 })).body.approvalToken;
    expect(
      (
        await sale({
          discount: { type: 'amount', value: 29999 },
          payments: [{ method: 'cash', currency: 'LBP', amount: 45001 }],
          approvalToken: under,
        })
      ).status,
    ).toBe(201);
    const exact = (await approve({ pct: 39 })).body.approvalToken;
    expect((await sale({ discount: { type: 'amount', value: 30000 }, ...paid45, approvalToken: exact })).status).toBe(403);
  });
});

describe('using an approval', () => {
  it('lets the sale through, takes the discount off, and records who approved it', async () => {
    const token = (await approve()).body.approvalToken;
    const res = await sale({ ...over, ...paid45, approvalToken: token });
    expect(res.status).toBe(201);
    expect(res.body.totalLbp).toBe(45000);

    const audit = withDb(
      (db) =>
        db
          .prepare(`SELECT user_id, before_json, after_json FROM audit_log WHERE action = 'sale.discount.override' AND entity_id = ?`)
          .get(String(res.body.id)) as {
          user_id: number;
          before_json: string;
          after_json: string;
        },
    );
    const after = JSON.parse(audit.after_json);
    expect(after).toMatchObject({ discountLbp: 30000, pct: 40 });
    expect(after.approvedBy).toBe(c.seed.users.manager.id);
    expect(JSON.parse(audit.before_json).limitPct).toBeGreaterThanOrEqual(5);
    const granted = withDb(
      (db) => db.prepare(`SELECT count(*) AS n FROM audit_log WHERE action = 'approval.grant'`).get() as { n: number },
    );
    expect(granted.n).toBeGreaterThan(0);
  });

  it('works once: a second sale with the same approval is refused', async () => {
    const token = (await approve()).body.approvalToken;
    expect((await sale({ ...over, ...paid45, approvalToken: token })).status).toBe(201);
    const again = await sale({ ...over, ...paid45, approvalToken: token });
    expect(again.status).toBe(403);
    expect(again.body.code).toBe('DISCOUNT_OVER_LIMIT');
  });

  it('works for the cashier it was given to, and no one else', async () => {
    const token = (await approve({}, cashier)).body.approvalToken;
    const stolen = await sale({ ...over, ...paid45, approvalToken: token }, cashier2);
    expect(stolen.status).toBe(403);
    expect((await sale({ ...over, ...paid45, approvalToken: token })).status).toBe(201); // the owner of it can still use it
  });

  it('runs out after ten minutes', async () => {
    const token = (await approve()).body.approvalToken;
    withDb((db) => db.prepare(`UPDATE approvals SET expires_at = ? WHERE used_at IS NULL`).run(new Date(Date.now() - 1000).toISOString()));
    expect((await sale({ ...over, ...paid45, approvalToken: token })).status).toBe(403);
  });

  it('a made-up token, or one with the wrong shape, is just refused', async () => {
    for (const approvalToken of ['not-a-real-token', 'x'.repeat(100), '']) {
      expect((await sale({ ...over, ...paid45, approvalToken })).status, approvalToken).toBe(403);
    }
    expect((await sale({ ...over, ...paid45, approvalToken: 'x'.repeat(101) })).status).toBe(400);
  });

  it('a sale that fails for another reason does not use the approval up', async () => {
    const token = (await approve()).body.approvalToken;
    // Part-paid for a Walk-In customer is refused (no credit without a registered customer): the whole sale rolls back.
    const failed = await sale({ ...over, approvalToken: token, payments: [{ method: 'cash', currency: 'LBP', amount: 10000 }] });
    expect(failed.status).toBe(422);
    expect(failed.body.code).toBe('CREDIT_REQUIRES_CUSTOMER');
    const retry = await sale({ ...over, ...paid45, approvalToken: token });
    expect(retry.status).toBe(201); // the same approval still works
  });

  it('sending the same sale again (a retry) replays it and neither needs nor uses a second approval', async () => {
    const token = (await approve()).body.approvalToken;
    const key = randomUUID();
    const body = { ...over, ...paid45, approvalToken: token, clientSaleId: randomUUID() };
    const first = await sale(body, cashier, key);
    const second = await sale(body, cashier, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.body.id).toBe(first.body.id);
    const overrides = withDb(
      (db) =>
        db
          .prepare(`SELECT count(*) AS n FROM audit_log WHERE action = 'sale.discount.override' AND entity_id = ?`)
          .get(String(first.body.id)) as { n: number },
    );
    expect(overrides.n).toBe(1);
  });
});
