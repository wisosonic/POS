# plan.md

Estimates assume one developer working with Claude Code. They are rough. Re-estimate after M1.

## Decisions from the owner (resolved questions)

| # | Topic | Decision | Effect |
|---|---|---|---|
| Q1 | Catalog currency | **Currency per product** (USD or LBP) | `products.currency`. Cart converts to LBP at the current rate. |
| Q2 | Printer | **USB, English/ASCII only** | Server prints raw ESC/POS via the Windows spooler. Receipts use a per-product English `receipt_name`. Browser print is the fallback. |
| Q3 | Hardware | **1 till, server on the same PC** | Windows service owning a local SQLite file. No LAN/TLS setup. Offline outbox is a safety net (Should). One open register session per till. |
| DB | Database | **SQLite** instead of PostgreSQL (owner agreed, 2026-10-19) | One till makes a server database unnecessary. Simpler install, backup and tests. See docs/02 A2. |
| Q4 / R3 | Credit | **Real.** Partial payment or pay later, **registered customers only**. **No credit limit** | Statuses `paid / partial / unpaid`. Customer balance, account payments, receivables report. Walk-In blocked. |
| Q5 | Tax | **Prices are tax-inclusive** | No tax code, column or receipt line. |
| Q6 / R1 | Payment methods | **Cash, Whish Money, OMT**, no third-party integration. Wallets are tracked in **both USD and LBP** (confirmed) | Payments recorded per method × currency. Opening balances set by the cashier at open. Closing shows expected vs counted for all six balances. |
| R5 | Arabic on receipts | **Transliterate** automatically to Latin, editable by hand | `receipt_name` generated on save and by the ETL. A manual edit is never overwritten. |
| Q7 | Duplicate barcodes | **Leave for the end** | Imported as-is, non-unique index, picker handles duplicates. Clean-up and unique index in M7. |
| Q8 | Register columns | `D*` = Dollar, `L*` = Lebanese pound | Confirmed mapping in the ETL. |
| Q9 / R2 | Stock | **Informational only.** Each product has its own low-stock threshold; the owner is notified when quantity falls to or below it. **Quantity 0 never prevents selling or buying from suppliers** | No stock blocking, no override, no `allow_negative_stock`. `stock_alert` per product, `/stock/alerts`, dashboard badge, till notice. |

## Remaining open items

| # | Question | Needed by |
|---|---|---|
| R4 | Printer model (paper width 80 or 58 mm, cash drawer attached?). **Deferred by the owner.** Receipt width defaults to 42 columns (80 mm) and is a setting. The hardware check happens in M3 | M3 |
| R6 | Legacy sales with tax ≠ 0: **one** sale (receipt 3171, tax amount 1), listed in the ETL report and the amount kept in the sale notes. **Accepted by the owner** | done |

No other questions block work.

## Milestones

### M0 · Foundations — **done** (2026-10-19)
- [x] Monorepo scaffold (npm workspaces `apps/api`, `apps/web`, `packages/shared`; TS strict; ESLint + Prettier; `.gitignore` incl. `POSDB.sql`, `Uploads/`)
- [x] ~~`docker-compose.yml`~~ removed when the database became SQLite (see the SQLite decision below). No Docker is needed anywhere.
- [x] CI workflow: lint, format, typecheck, unit tests (`continue-on-error` until M1), integration job disabled until M1
- [x] `npm run test:unit` runs. The only failures are the 5 unwritten modules (`money`, `pricing`, `barcode`, `receipt`, `translit`).
- **Exit met:** `lint`, `format:check` and `typecheck` pass. Not a git repository yet (run `git init` when you want version control).

### M1 · Domain core + sale API — **done** (2026-10-20)
- [x] `packages/shared`: money, pricing (incl. payment methods, credit), barcode, receipt (ASCII), translit → `tests/unit/*` green (**done 2026-10-19: 81 tests passing**; the unit CI job is now a hard check)
- [x] DB schema + migrations (`0001_init.sql`: constraints and append-only triggers), `openDatabase`/`migrate`/`nextRef`, reference seed, test seed (**done 2026-10-19: 46 database tests passing**)
- [x] Auth (Argon2id, 15-minute JWT, rotating refresh with theft detection, lockout, PIN switch, change-password), RBAC with role read from the database on every request, audit log, users and settings endpoints, `create-admin` CLI (**done 2026-10-19**)
- [x] Catalog read and edit (search, barcode lookup, sync, per-product currency and low-stock threshold, receipt names) and the stock/alert reads, dashboard stub (**done**)
- [x] **Register open/close with 6 balance buckets**, cash movements and transfers, Z-report with a per-balance breakdown (**done 2026-10-20**)
- [x] `POST /sales`: multi-method payment, credit, idempotency, discounts with a cashier limit, price override by managers, stock ledger that never blocks, `lowStock` in the response, receipts (json and text), exchange rate with per-sale snapshot (**done 2026-10-20**)
- [x] **Returns** (refund from the chosen balance, or against what the customer owes) and **customers: accounts, payments applied oldest sale first, receivables** (**done 2026-10-20**)
- [x] **Supplier purchases** (create, edit while open, receive in parts or whole, cost follows what was paid, pay suppliers, payables report), **stock adjustments** and **held carts** (**done 2026-10-20**; this is the first schema change after 0001, as migration `0002_purchase_payments.sql`)
- **Exit met 2026-10-20: 645 tests pass** (167 unit and database, 478 integration across 15 files). Lint, typecheck and formatting are clean.

### M2 · Legacy migration — **done** (2026-10-20)
- [x] Streaming T-SQL dump parser (the 137 MB `Images` table is skipped unparsed; the whole file reads in under a second)
- [x] Importer: one transaction, idempotent, refuses to save unless revenue less refunds equals the legacy total to the lira
- [x] Opening stock from `ProductQuantity` (zero and negative kept), per-product `stock_alert` from the legacy `StockAlert`, register history from `Register`/`RegisterLogs`
- [x] `receipt_name` for every product by transliteration (180 Arabic names listed for review)
- [x] Reconciliation report (`<db>.etl-report.json`): every oddity listed, none fixed silently
- [x] Returns rebuilt: the old app zeroed a sale on return, so the original sale is reconstructed and the return kept apart (verified on all 116)
- [x] Pictures: links become `/uploads/<file>` and all 314 files exist
- **Exit met:** the real dump imports in about 11 seconds into a 13 MB database; **63 tests pass against it** and 28 more against hand-made dumps (these run in CI). See `docs/01-data-analysis.md` section 6 for what was found.
- **Whole project 2026-10-20: 768 tests pass** (199 unit and database, 478 integration, 91 migration). Lint, typecheck (including the tests) and formatting are clean.

**For the owner to review before go-live** (all listed in the report):
1. **220,000 LBP owed by unidentified Walk-In customers** (2 sales). It sits on the placeholder customer "Walk-In debts (from the old system)". Decide who owes it, or collect it and write it off.
2. **5 sales whose total differs from their lines** by 35,000 to 940,000 LBP (receipts 1061, 1174, 4479, 7872, 12151), plus 1 header with no lines (7871). Imported as recorded.
3. **180 automatic English receipt names.** The transliteration is a consonant skeleton (e.g. `khbz kbyr`); fix the ones that read badly (`PATCH /products/{id}` with `receiptName`).
4. **Set a password for both users** (`atom.support`, `sale`). Their old ones were not carried over.
5. **The old open register** (opened 2026-10-18) came across as the open session. Count and close it before the first real day.
6. **21 shared barcodes** (52 products) stay as they are until M7.

### M3 · Cashier UI (≈ 2.5 weeks)
- [x] Checkout screen per docs/05: scan, search, cart, pay dialog (Cash / Whish / OMT, split), change, customer picker, remaining-on-account, hold
- [x] Open/close register screens with all balances (the close screen shows expected vs counted per bucket)
- [x] Customer accounts screen: balance, receive payment
- [x] Receipt printing: spooler → USB printer (ASCII), browser fallback (drawer pulse not yet wired: needs the printer model, R4)
- [x] Product cache + outbox (Should): offline sales queue and sync exactly once
- [x] Low-stock list from the menu and the header badge
- **Exit:** `tests/e2e/checkout.spec.ts` green (13 tests, 1366×768). **Still open:** hardware checklist on the real scanner and printer.
- **Done after M5:** the interface refresh (`docs/05-ui-mockups.md` §0): new header (Menu, status chips, settings gear for the admin, account menu with change password / switch cashier / sign out), grouped icon menu in a drawer, shared tokens and self-hosted IBM Plex fonts, icons on the main actions and page titles, phone / tablet / wide layouts checked on screenshots, and the screens other than the till loaded on demand (first download 443 kB to 340 kB).
- **Done after M5:** discount UI (US-09, F6) and the manager's approval for over-limit discounts (name + password, not a PIN; single-use, bound to the percent shown; `docs/08-security-review.md`).
- **Done after M5:** the Sales screen (Menu → Sales): sales not in the system yet (offline or refused, with the reason, Try again, and a manager-only Discard that asks why and leaves a note), recent sales (a cashier sees their own, a manager everyone's; find by receipt number), a receipt view with **Print again** (stamped DUPLICATE, never opens the drawer, audited) and a manager's "Return items" straight into the return screen. The header's "pending" and "need attention" chips link to it.
- **Done after M5:** a cashier can start a return (Sales → receipt → Return items, or Menu → Returns): the manager approves at the till with their own name and password, for that sale and the value shown (same single-use approval as discounts, new scope `return`, migration 0006).
- **Done after M5:** void a sale (while its register is open; a cashier with a manager's approval), sell at another price (a cashier with a manager's approval for that product and price), PIN switch of cashier at the till (Menu → Switch cashier), the server refusing everything but a password change for someone with a first password, service income (Menu → Services, `service_sales` now written, with its own lists and cash-in), optional HTTPS (`TLS_CERT`, `TLS_KEY`), and a tablet browser-test project (1024 x 768, touch, its own database).
- **Done after M5:** a service worker (`apps/web/sw.template.js`, built into `dist/sw.js`): once the till has been opened, the app opens from its saved copy even if the server cannot be reached (restart of the browser, API down). It never serves `/api`. **Signing in still needs the server** (a session cannot be renewed without it), and says so; sales already in progress stay in the outbox.
- Run it: `npm run dev -w @pos/api` and `npm run dev -w @pos/web`; browser tests with `npm run test:e2e`; a picture walkthrough with `SHOTS=<folder> npx playwright test screenshots`.

### M4 · Back office (≈ 2 weeks)
- [x] Products screen: search (Arabic too), add/edit with currency per product and `receipt_name`, hide/restore, reorder level. Lookups API + screen (categories, brands, units, suppliers: add and rename, no delete). Back-office pages work without an open register and are manager-only
- [x] Product pictures: the importer copies the 314 products' pictures from `Uploads/` into the new pictures folder (judged by their bytes, named by content, 289 files; 2 "pictures" were saved web pages and are reported), the server serves them (`/uploads/<name>`, only our own names), a manager sets, replaces or removes one in the product form (5 MB), they show in the product list and the till's search, and backups and restore carry them. **Owner review:** 2 products point at saved web pages (they import without a picture) and **418 old pictures belong to no product** (not copied: nothing says which product each is for; only 2 are named after a barcode)
- [x] CSV import (products): Products → Import CSV…. The file is checked first (new / changed / unchanged / problem, by spreadsheet row), a file with any problem imports nothing, empty cells never overwrite, existing products are found by barcode or name, missing categories/brands/suppliers are created only on request, units never. Shared strict reader in `packages/shared/src/csv.ts`.
- [x] Purchases screen: draft / order, receive in parts or all at once (optionally updating costs), pay the supplier in parts, delete drafts. Never depends on stock on hand
- [x] Stock adjustments: a Stock button on each product (add or take out with a reason, ledger of recent movements)
- [x] Returns screen (Menu → Returns): find a sale by receipt number, bring back part or all, hand the refund back from a chosen method and currency, or take it off what the customer owes; cannot return more than was sold
- [x] Low-stock thresholds per product (product form), alert list and header badge
- [x] Stocktake (optional): Menu → Stocktake. Count by scanning or typing, finish posts only the differences (the quantity at the moment of counting is kept, so selling during the count is not undone); a finished count cannot change
- [x] Expenses (optionally paid from a drawer or wallet balance, so the closing count agrees; never edited) and cash in / out / between balances. Menu → Expenses, Cash in and out; expense types under Lists
- **Exit:** manager can run a full day without the legacy app.

### M5 · Reporting and hardening (≈ 1.5 weeks)
- [x] Dashboard (Menu → Dashboard: net of returns, profit, by the hour, best sellers, what is owed each way) and Reports (Menu → Reports: sales by day / cashier / category, products with margin, customers who owe, owed to suppliers, closed registers with each Z-report), each with a spreadsheet download
- [x] Load test (`npm run test:load`, `docs/09-load-test.md`): a sale takes about 25 ms (p95) at 10 a second against a 150 ms target; no failure in any scenario; 400 duplicate submissions record exactly 40 sales; 9 money invariants hold after 5,000 sales; a heavy report delays a sale by at most ~0.1 s. Indexes tuned (migration 0004: three listings that scanned a whole table) with a query-plan test. **Run on a fast dev machine, not the shop PC: run it on the real till PC before the first real day**
- [ ] Heavy reports on a worker thread: only if the all-history product report ever takes more than ~0.5 s (`docs/09-load-test.md` §6)
- [x] Backups: daily online copy, verified, optionally encrypted (AES-256-GCM), written to a main folder and a second place, newest 30 kept, catches up after a missed night; Backups page (admin), "Backup overdue" chip for managers, `npm run backup`, `npm run restore`. Restore drill run as separate command-line processes (`tests/db/backup-cli.test.ts`); steps in `docs/07-operations.md`
- [x] The API serves the built web app (`WEB_DIST`), checked in a real production-mode start; `npm run build`
- [x] Windows install script (`scripts/windows/install-service.ps1`: startup task as SYSTEM, restarts on failure, `-DryRun`, `-Uninstall`). **Dry run and parsing tested only; the install itself has not been run on a real till PC**
- [x] **Settings screen** (Menu → Settings, admin: shop details, receipt footer and width, printer name, rounding, cashier discount limit, **Print a test slip** with optional drawer pulse) and **exchange-rate screen** (Menu → Exchange rate, admin, or the header chip: new rate now or later, a "Is that right?" check for a change over 10%, history). Found missing while writing the operations guide
- [ ] Offsite copy proof: the second folder is "any folder", so offsite means pointing it at a synced folder; decide with the owner which service (not done)
- [x] Security review (`docs/08-security-review.md`): found and fixed a PIN opening manager/admin accounts, a server that answered to any host name (DNS rebinding), and missing browser security headers; vitest upgraded so `npm audit` is clean; every route's sign-in guard, the secrecy of the log, and the policy on the real built app are now tests. **Not an outside penetration test.** Open: the server runs as SYSTEM (least privilege untested), no HTTPS for a tablet, see its section 3
- **Exit:** load-test budgets pass (done, on a dev machine; repeat on the shop PC). Restore onto a second PC documented (`docs/07-operations.md`).

### M6 · Cut-over (≈ 1 week, then 2 weeks parallel run)
- [ ] Staff training (the stocktake is optional and never blocks a sale)
- [x] Rehearsal tool: `npm run rehearse` (import → invariants → a real sale on the imported data → backup and restore, 41 checks, ~30 s, passes on the real dump). `npm run preflight` checks the till PC. Runbook with rollback and sign-off list: `docs/10-cutover.md`
- [x] Users screen (Menu → Users) and *Choose your password* on first sign-in: found missing while writing the runbook, and needed to give imported users their passwords
- [ ] Run the rehearsal and `preflight` on the real till PC, then the real thing: fresh dump → ETL → reconcile → switch the till
- [ ] Legacy DB read-only for 30 days

### M7 · Barcode clean-up (last, per Q7)
- [x] Report of duplicate barcodes with the products sharing each (Menu → Duplicate barcodes: stock, sales and price of each)
- [x] Merge (stock moves across, the others are hidden, history untouched) or re-code each duplicate (US-34)
- [x] Turn the rule on once the report is empty: the database then refuses a second active product with a barcode (`DUPLICATE_BARCODE`, migration 0010: a trigger with a switch, because an index cannot be switched on only after the clean-up). **Still to do on the shop's data: the 21 groups, by the owner**
- **Exit:** the report is empty and the rule is on (the tool is built; the real data still has its 21 groups).

## Risks

| Risk | Mitigation |
|---|---|
| Single PC (till = server) fails | UPS, nightly backups to two places, tested restore, spare PC |
| Legacy stock numbers are wrong, so the first low-stock list is noisy | Thresholds start empty (no alerts) and the owner opts products in. Selling is never blocked |
| Wallet balances drift (manual bookkeeping) | Variance at every close. Cashier counts each balance |
| Machine transliteration reads oddly for some names | Editable `receipt_name`, review report from the ETL |
| Dirty legacy data | The ETL reports and never silently fixes. Owner reviews the report |
| Scope creep (loyalty, e-commerce, multi-store, wallet APIs) | Not in M1–M7. Capture in a backlog |

## Definition of done (per feature)

Code + tests (unit and integration where applicable) + user-story acceptance criteria met + docs updated (`docs/06-api-spec.md` for any endpoint) + no new lint/type errors.
