import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// buildApp is created in milestone M1 (see plan.md). The database layer already exists.
import { buildApp, type BuildOptions } from '../../apps/api/src/app';
import { migrate } from '../../apps/api/src/db/migrate';
import { seedTestData, type Seed } from '../../apps/api/src/db/seed-test';
import type { ReceiptPrinter } from '../../apps/api/src/modules/printing/driver';

export type TestCtx = {
  http: ReturnType<typeof request>;
  seed: Seed;
  /** The throwaway database file, for tests that need to look inside (open it read-only). */
  databasePath: string;
  /** Every route the server registered (method and URL pattern). */
  routes: { method: string; url: string }[];
  login: (role: 'cashier' | 'manager' | 'admin') => Promise<string>;
  openRegister: (token: string) => Promise<{ id: number }>;
  newSaleBody: (over?: Record<string, unknown>) => Record<string, unknown>;
  close: () => Promise<void>;
};

/** Each context gets its own throwaway SQLite file, so test files cannot affect each other and no Docker is needed. */
export async function startCtx(
  options: { printer?: ReceiptPrinter; backup?: BuildOptions['backup']; webDist?: string; logStream?: BuildOptions['logStream'] } = {},
): Promise<TestCtx> {
  const dir = mkdtempSync(join(tmpdir(), 'pos-it-'));
  const databasePath = join(dir, 'pos.db');
  migrate(databasePath);
  const seed = await seedTestData(databasePath); // 3 users (one per role), rate 90000, products below, Walk-In customer id 1
  const app = await buildApp({
    databasePath,
    logger: !!options.logStream,
    logStream: options.logStream,
    printer: options.printer,
    backup: options.backup,
    webDist: options.webDist,
  });
  await app.ready();
  // Listen once on a free port. Letting supertest start and stop the server per request breaks requests that are
  // built before an `await` (it closes the server under them).
  await app.listen({ host: '127.0.0.1', port: 0 });
  const http = request(app.server);

  return {
    http,
    seed,
    databasePath,
    routes: app.registeredRoutes,
    async login(role) {
      const u = seed.users[role];
      const res = await http.post('/api/v1/auth/login').send({ username: u.username, password: u.password });
      return res.body.accessToken as string;
    },
    async openRegister(token) {
      const res = await http
        .post('/api/v1/registers/open')
        .set('Authorization', `Bearer ${token}`)
        .send({
          terminalId: 'T1',
          openingBalances: [
            { method: 'cash', currency: 'USD', amount: 7000 },
            { method: 'cash', currency: 'LBP', amount: 3_000_000 },
            { method: 'whish', currency: 'USD', amount: 1000 },
            { method: 'whish', currency: 'LBP', amount: 500_000 },
            { method: 'omt', currency: 'USD', amount: 2000 },
            { method: 'omt', currency: 'LBP', amount: 1_000_000 },
          ],
        });
      return res.body;
    },
    newSaleBody(over = {}) {
      return {
        clientSaleId: randomUUID(),
        customerId: 1,
        items: [{ productId: seed.products.towel.id, qty: '1', unitPriceLbp: 75000 }],
        payments: [{ method: 'cash', currency: 'LBP', amount: 75000 }],
        ...over,
      };
    },
    async close() {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Test seed contract (implemented in apps/api/src/db/seed-test.ts):
 *  customers: id 1 = Walk-In (no credit), id 2 = "Test Customer" (registered, balance 0)
 *  settings: lbpRounding = 5000 (stock never blocks sales, so there is no stock setting)
 *  products.towel   barcode 5287000107945  price 75,000 LBP   stock 10   stockAlert null (no alert)
 *  products.choc    barcode 9342390005250  price 50,000 LBP   stock 100
 *  products.usd     barcode 5711953005251  price $2.50 (currency USD, 250 cents)  stock 10
 *  products.rare    barcode 1111111111116  price 10,000 LBP   stock 1
 *  products.kg      barcode 2000000000008  price 400,000 LBP per KG (fractional unit) stock 5.000
 *  suppliers.main (id from seed), units.piece (non-fractional)
 */
