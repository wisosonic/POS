// Import the legacy SQL Server dump into the new database.
//
//   npm run etl -w @pos/api -- --dump ../../POSDB.sql [--db ./data/pos.db] [--uploads ../../Uploads] [--images ./data/uploads] [--report ./etl-report.json]
//
// Stop the API first: the import needs the database to itself. It is one transaction, so a failure changes nothing,
// and it is safe to run again (rows already imported are left alone).
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig } from '../config';
import { runEtl } from './run';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dump = arg('dump');
if (!dump) {
  process.stderr.write('Usage: etl --dump <POSDB.sql> [--db <pos.db>] [--uploads <folder>] [--images <folder>] [--report <file.json>]\n');
  process.exit(1);
}

const databasePath = resolve(arg('db') ?? loadConfig().databasePath);
mkdirSync(dirname(databasePath), { recursive: true });
const reportPath = resolve(arg('report') ?? `${databasePath}.etl-report.json`);
const say = (m: string) => process.stdout.write(`${m}\n`);

say(`Importing ${resolve(dump)}\n     into ${databasePath}`);
const report = await runEtl({
  dumpPath: resolve(dump),
  databasePath,
  uploadsDir: arg('uploads') ? resolve(arg('uploads')!) : undefined,
  imagesDir: arg('images') ? resolve(arg('images')!) : undefined,
  reportPath,
  log: say,
});

const c = report.counts;
say('');
say(`Done in ${report.seconds}s. Imported (already there):`);
for (const [table, v] of Object.entries(c))
  say(`  ${table.padEnd(20)} ${String(v.imported).padStart(7)}  (${v.existing} already there, ${v.legacy} in the dump)`);
say('');
say('Needs a person to look at:');
say(`  ${report.reconciliation.inconsistentSales.length} sales whose total differs from their lines by 5,000 LBP or more`);
say(`  ${report.walkInDebts.length} sales where Walk-In still owed money (moved to a placeholder customer)`);
say(`  ${report.duplicateBarcodes.length} barcodes shared by several products`);
say(`  ${report.users.length} users need a new password (the old ones were not carried over)`);
say(`  ${report.receiptNames.transliterated} Arabic product names got an automatic English receipt name to review`);
say(`  ${report.images.missing.length} product pictures are missing from the Uploads folder`);
say(`  ${report.images.notPictures.length} product pictures are not pictures at all (a saved web page): those products have none`);
say('');
say(`Pictures: ${report.images.stored} copied into the new pictures folder (${report.images.shared} are shared by several products),`);
say(`  ${report.images.extensionFixed.length} had a name that did not match what they are (stored as what they are),`);
say(`  ${report.images.unused} files in the Uploads folder are used by no product and were not copied.`);
say(`\nFull report: ${reportPath}`);
