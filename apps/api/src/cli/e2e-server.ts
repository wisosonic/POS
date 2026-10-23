// A throwaway API for the browser tests (Playwright). NOT for real use: it creates users with well-known passwords on a
// temporary database and replaces the USB printer with one that only records what it was sent.
//   npx tsx apps/api/src/cli/e2e-server.ts        (port 3100, or E2E_API_PORT)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../app';
import { migrate } from '../db/migrate';
import { openDatabase } from '../db/open';
import { seedTestData } from '../db/seed-test';
import type { ReceiptPrinter } from '../modules/printing/driver';

const port = Number(process.env.E2E_API_PORT ?? 3100);
const dir = mkdtempSync(join(tmpdir(), 'pos-e2e-'));
const databasePath = join(dir, 'pos.db');

migrate(databasePath);
await seedTestData(databasePath);

const db = openDatabase(databasePath);
db.prepare("UPDATE products SET stock_alert_milli = 1000 WHERE barcode = '1111111111116'").run(); // the "rare" item: 1 in stock, alert at 1
db.prepare("UPDATE store_settings SET printer_name = 'E2E Printer'").run();
db.prepare("INSERT INTO customers (name, phone) VALUES ('Ahmad Darwish', '03123456')").run();
db.close();

const prints: { at: string; bytes: number; text: string }[] = [];
const printer: ReceiptPrinter = {
  async print(bytes) {
    prints.push({ at: new Date().toISOString(), bytes: bytes.length, text: Buffer.from(bytes).toString('latin1') });
  },
};

// Backups go to the throwaway folder too. No schedule runs here, so "no backup yet" stays true until a test makes one.
// E2E_WEB_DIST: also serve the built web app from this server, to test the production build with its real headers.
const app = await buildApp({
  databasePath,
  logger: false,
  printer,
  backup: { dir: join(dir, 'backups'), keep: 5 },
  webDist: process.env.E2E_WEB_DIST || undefined,
});
app.get('/__e2e/prints', async () => ({ data: prints }));
await app.listen({ host: '127.0.0.1', port });
process.stdout.write(`e2e api on ${port}\n`);

const stop = async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
