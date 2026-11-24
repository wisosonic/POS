import { toReceiptName } from '@pos/shared';
import { hashPassword } from '../auth/password';
import { openDatabase, type Db } from './open';
import { seedReference } from './seed';

// Deterministic data for integration and e2e tests. Contract documented in tests/helpers/app.ts.
// Never run against a real database: it creates users with well-known passwords.

export type Role = 'cashier' | 'manager' | 'admin';
export type SeedProduct = { id: number; costLbp: number };
export type Seed = {
  users: Record<Role, { id: number; username: string; password: string }>;
  customers: { walkIn: { id: number }; registered: { id: number } };
  suppliers: { main: { id: number } };
  units: { piece: { id: number }; kg: { id: number } };
  products: { towel: SeedProduct; choc: SeedProduct; usd: SeedProduct; rare: SeedProduct; kg: SeedProduct };
};

const PASSWORDS: Record<Role, string> = {
  cashier: 'test-cashier-pass',
  manager: 'test-manager-pass',
  admin: 'test-admin-pass',
};

export async function seedTestData(target: string | Db): Promise<Seed> {
  const owned = typeof target === 'string';
  const db = owned ? openDatabase(target) : target;
  try {
    seedReference(db);

    // Hash outside the transaction: hashing is async, SQLite transactions are synchronous.
    const hashes = {
      cashier: await hashPassword(PASSWORDS.cashier),
      manager: await hashPassword(PASSWORDS.manager),
      admin: await hashPassword(PASSWORDS.admin),
    };

    return db
      .transaction((): Seed => {
        const insertUser = db.prepare('INSERT INTO users (username, name, role, password_hash) VALUES (?, ?, ?, ?)');
        const users = {} as Seed['users'];
        for (const role of ['cashier', 'manager', 'admin'] as const) {
          const id = Number(insertUser.run(role, `Test ${role}`, role, hashes[role]).lastInsertRowid);
          users[role] = { id, username: role, password: PASSWORDS[role] };
        }

        const registered = Number(
          db.prepare(`INSERT INTO customers (name, phone) VALUES ('Test Customer', '03000000')`).run().lastInsertRowid,
        );
        const supplier = Number(db.prepare(`INSERT INTO suppliers (name) VALUES ('Test Supplier')`).run().lastInsertRowid);
        const unit = (name: string) => (db.prepare('SELECT id FROM units WHERE name = ?').get(name) as { id: number }).id;
        const category = (name: string) => Number(db.prepare('INSERT INTO categories (name) VALUES (?)').run(name).lastInsertRowid);
        const household = category('Household');
        const snacks = category('Snacks');
        const drinks = category('Drinks');
        const piece = unit('Piece');
        const kg = unit('KG');
        const warehouse = (db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get() as { id: number }).id;

        const insertProduct = db.prepare(
          `INSERT INTO products (name, receipt_name, barcode, cost_minor, price_minor, currency, unit_id, supplier_id, category_id)
         VALUES (@name, @receiptName, @barcode, @cost, @price, @currency, @unitId, @supplierId, @categoryId)`,
        );
        const insertLevel = db.prepare('INSERT INTO stock_levels (product_id, warehouse_id, qty_milli) VALUES (?, ?, ?)');
        const insertMovement = db.prepare(
          `INSERT INTO stock_movements (product_id, warehouse_id, qty_milli_delta, reason, ref_type, note)
         VALUES (?, ?, ?, 'adjustment', 'seed', 'test seed opening stock')`,
        );

        const product = (p: {
          name: string;
          barcode: string;
          cost: number;
          price: number;
          currency: 'USD' | 'LBP';
          unitId: number;
          stockMilli: number;
          categoryId?: number;
        }) => {
          const id = Number(
            insertProduct.run({
              name: p.name,
              receiptName: toReceiptName({ name: p.name }),
              barcode: p.barcode,
              cost: p.cost,
              price: p.price,
              currency: p.currency,
              unitId: p.unitId,
              supplierId: supplier,
              categoryId: p.categoryId ?? null,
            }).lastInsertRowid,
          );
          insertLevel.run(id, warehouse, p.stockMilli);
          insertMovement.run(id, warehouse, p.stockMilli);
          return { id, costLbp: p.currency === 'LBP' ? p.cost : 0 };
        };

        return {
          users,
          customers: { walkIn: { id: 1 }, registered: { id: registered } },
          suppliers: { main: { id: supplier } },
          units: { piece: { id: piece }, kg: { id: kg } },
          products: {
            towel: product({
              name: 'Cedars silver towel',
              barcode: '5287000107945',
              cost: 67000,
              price: 75000,
              currency: 'LBP',
              unitId: piece,
              stockMilli: 10_000,
              categoryId: household,
            }),
            choc: product({
              name: 'Crispy chocolate',
              barcode: '9342390005250',
              cost: 40000,
              price: 50000,
              currency: 'LBP',
              unitId: piece,
              stockMilli: 100_000,
              categoryId: snacks,
            }),
            usd: product({
              name: 'Starbucks Caffe Latte 220ml',
              barcode: '5711953005251',
              cost: 213,
              price: 250,
              currency: 'USD',
              unitId: piece,
              stockMilli: 10_000,
              categoryId: drinks,
            }),
            rare: product({
              name: 'Rare item',
              barcode: '1111111111116',
              cost: 6000,
              price: 10000,
              currency: 'LBP',
              unitId: piece,
              stockMilli: 1_000,
            }),
            kg: product({
              name: 'Loose cheese',
              barcode: '2000000000008',
              cost: 300000,
              price: 400000,
              currency: 'LBP',
              unitId: kg,
              stockMilli: 5_000,
            }),
          },
        };
      })
      .immediate();
  } finally {
    if (owned) db.close();
  }
}
