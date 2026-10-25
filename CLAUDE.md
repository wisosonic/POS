# CLAUDE.md

Guidance for Claude Code and other AI assistants working in this repository.

## Project

Market POS for Darwish Market (Beirut). Replaces a legacy ASP.NET + SQL Server app. React PWA front end, Fastify + TypeScript API, SQLite (`better-sqlite3`).
The full design is in `docs/`. **Read the relevant doc before changing a related area, and update the doc when behaviour changes.**
Deployment: one Windows PC at the till runs the API (which owns the SQLite file) + the browser. Current state: design and tests only. Implementation follows `plan.md`.

## Commands (once scaffolded)

```bash
npm run test:unit          # fast, pure logic (packages/shared)
npm run test:db            # schema, constraints, triggers, seed (temp SQLite files)
npm run test:integration   # HTTP + a throwaway SQLite file, no Docker
POSDB_DUMP=./POSDB.sql npm run test:migration
npm run test:e2e           # Playwright, needs the stack running
npm run typecheck
npm run dev                   # API and web screen together in ONE terminal (scripts/dev.mjs; Ctrl+C stops both). runner.bat wraps it for Windows
npm run dev -w @pos/api       # API alone on 127.0.0.1:3000 (SQLite file in ./data)
npm run create-admin -w @pos/api -- <user> <password>
npm run test:load             # ~5 min; imports POSDB.sql into a temp copy, drives the real server, re-checks every money invariant
npm run build                 # the web app, into apps/web/dist (the API serves it when WEB_DIST is set)
npm run backup -w @pos/api -- --to <folder>           # safe while the API runs (BACKUP_PASSPHRASE encrypts)
npm run restore -w @pos/api -- --from <file> --db <path> [--force]   # stop the API first
npm run rehearse -w @pos/api -- --dump ../../POSDB.sql   # ~30 s; ETL into a THROWAWAY db + invariants + a test sale + backup/restore. Run before and on cut-over day
npm run preflight -w @pos/api -- --env <service.env>      # read-only check of the till PC (printer, backups, rate, users, pictures)
```

## Hard rules

1. **Money is integers.** LBP in whole LBP, USD in cents. Never use `float`/`number` fractions for money. Never parse money from strings except in the ETL and the product CSV import, and fail loudly there (the import uses `parseDecimalMinor` from `packages/shared`: exact, no floats, refuses commas, signs and extra decimals). Each product has its **own currency**. The cart converts to LBP at the current rate.
   **There is no tax.** Selling prices are tax-inclusive. Do not add tax fields, settings or receipt lines.
2. **The server decides totals.** Recompute from catalog prices and the rate. Never trust client-sent totals.
3. **One DB transaction per sale** covering sale, items, payments, stock movements, customer balance, register balances and audit, via `inWriteTransaction` (`BEGIN IMMEDIATE`). Never write outside it. Only the API process may open the database for writing.
4. **History is append-only.** Never UPDATE or DELETE sales, payments, stock movements or audit rows. Corrections are new rows (returns, adjustments, voids). The database enforces this with triggers (migration 0001), so a violation throws.
   **One exception, by the owner's decision (QUESTIONS.md #8, option C):** a cancelled sale, or a sale that has had items taken back, can be deleted for good through `POST /sales/{id}/delete` (`modules/sales/delete.ts`, migration 0014). That is the only code that deletes these rows. The triggers let a sale's own rows go only while `sale_delete_unlock` holds a row for that sale, which the routine inserts and removes inside its one transaction. It reverses the stock, recomputes the register's expected figures (a counted register's variance changes) and lowers the customer's balance in that same transaction, and the audit log (never deletable) keeps what the sale was and who deleted it. Do not add another delete path, and never leave a row in `sale_delete_unlock`.
   **SQLite rules:** quantities are integer thousandths (`qty_milli`), never floats. Use `openDatabase()` so WAL, `synchronous=FULL` and `foreign_keys=ON` are set. Schema changes are new numbered `.sql` files in `apps/api/src/db/migrations/`. Never edit an applied migration.
5. **Stock = ledger.** Change stock only by inserting `stock_movements`. `stock_levels` is a cache updated in the same transaction.
6. **Idempotency** on `POST /sales`, `/returns`, `/customers/{id}/payments`, `/purchases/{id}/receive`.
7. **A printer failure must never fail or roll back a sale.** The printer is USB and **English/ASCII only**: receipts use `receipt_name`, which is auto-transliterated from Arabic names (`packages/shared/translit`). Only truly unprintable characters print as `?`.
8. **Barcode checksums are advisory.** Legacy codes include EAN-8 and arbitrary numbers, so lookups must accept any string.
9. **Exchange rate is snapshotted per sale.** Never recompute historical totals with the current rate.
10. **Validate every input with Zod.** Parameterized SQL only. No string-built queries.
11. **Never log or return password hashes, PINs or tokens.** Argon2id for passwords.
12. **Shared domain logic lives in `packages/shared`** (money, pricing, barcode, receipt) so client and server cannot drift.
13. **Payment methods are `cash`, `whish`, `omt`, recorded only.** Never call a third-party service. Change is always cash. A wallet tender may not exceed the amount due.
14. **Register balances are buckets** (method × currency: 6). Open and close require all six. `expected` is updated in the same transaction as the change that causes it.
15. **Credit needs a registered customer.** Partial or unpaid sales are rejected for Walk-In (`customers.is_walk_in`, id 1). Invariant: `customer.balance = Σ open sales.rest`. Customer payments are applied to the oldest open sale first.
16. **One till.** One open register session per terminal, and any logged-in user may sell in it. Sales record `user_id` and `session_id`.
17. **Stock never blocks a sale or a purchase.** Its purpose is notifying the owner when a product is low: each product has its own `stock_alert` threshold (null = no alert). Quantity may be 0 or negative. Do not add stock checks, stock errors or override flags to the sale or purchase flows.
18. **Barcodes are unique only once the rule is switched on.** The legacy data has shared barcodes, so lookups can return several products and the rule starts OFF. Menu → Duplicate barcodes cleans them up (re-code, or fold products into one with `POST /products/merge`) and then turns on `store_settings.barcode_unique`, after which triggers (migration 0010) refuse a second **active** product with the same barcode (`DUPLICATE_BARCODE`). A hidden product may keep a code. Never rewrite sale history to merge products: retire them and move the stock.
19. **Every route needs a sign-in guard** (`preHandler: app.authenticate` or `app.requireRole(...)`). `tests/integration/security.test.ts` lists the routes the server registered and fails for any that answers an anonymous request. The only open doors are the six in its allow-list: add one only on purpose.
20. **A PIN is cashier-only.** Managers and admins sign in with a password. Never lift that. A manager's approval at the till (over-limit discount) is their **name and password** → `POST /auth/approve` → a token that is single-use, for one cashier, up to the percent the manager was shown, for ten minutes, used inside the sale's transaction. Never make it a PIN, never make it reusable, and never let it cover more than was shown. The same token mechanism covers a **cashier's return** (`scope: "return"`: bound to one sale and the value in LBP the server computed; `RETURN_NEEDS_APPROVAL` carries that value so the screen can show it). The scopes are `discount` (a percent), `return` (one sale and a value), `void` (one sale), `delete` (one sale, to delete it for good) and `price` (one product at one unit price). A new thing a cashier may do only with approval gets its own scope, bound to what the manager saw, and is consumed inside the transaction. Add it to the `approvals` table's CHECK with a migration (the table is rebuilt, as in 0006 and 0007).
21. **Never put a secret in a log line, an error or an answer** (password, PIN, token, cookie, backup passphrase). The security test captures the real log and fails if one appears.
22. **No inline scripts, no `eval`, no foreign origins.** The Content-Security-Policy is `script-src 'self'`. Styles may be inline (React writes `style=""`). The `production-build` e2e project runs the built app under the real policy.

## Pitfalls already hit (do not repeat)

- **Zod `.partial()` keeps `.default()`.** A PATCH schema built from defaulted fields silently resets those fields on every edit. Keep patch fields free of defaults and put defaults on create only (regression test in `tests/integration/products.test.ts`).
- **SQL aliases can shadow columns.** `SUM(l.qty_milli) AS qty_milli` made `HAVING qty_milli` read a single row. Never reuse a real column name as an alias (regression test in `tests/db/stock-alerts.test.ts`).
- **Return the row after the update, not before.** Build responses from a fresh read when a write changes what the response shows.
- **supertest:** the test server listens once (`app.listen({ port: 0 })`). Letting supertest start and stop it per request breaks requests built before an `await`.
- **No `await` inside a money transaction.** `createSale`, `createReturn` and `receiveCustomerPayment` are synchronous inside `inWriteTransaction`, so two requests cannot interleave and the idempotency check cannot race. Do slow async work (hashing, I/O) before opening the transaction.
- **Idempotency order matters:** the replay check runs inside the transaction, a rejected request is not recorded (so its key can be reused after the fix), and only a successful one stores its answer.
- **Tests that build a table with `it.each` run before `beforeAll`.** Read seeded ids lazily (use thunks).
- **The ETL must never guess silently.** Anything odd in the legacy data is imported as faithfully as the rules allow and added to the report (`apps/api/src/etl/report.ts`). The import refuses to save unless revenue less refunds equals the legacy total. Run it only with the API stopped.
- **The legacy app edited sales on return** (zeroed quantity and total). The new system keeps the original sale and the return apart, so the ETL rebuilds the original. Do not "simplify" this.
- **Shell edits:** the Bash tool halves backslashes. Use Edit/Write for regexes and `\n` or `\u` escapes.
- **A `﻿` escape can come out as a literal invisible byte-order mark** after an edit (seen in the ETL and in `tests/e2e/reports.spec.ts`). `npm run lint` catches it (`no-irregular-whitespace`); fix it by character code, not by retyping it.
- **Product pictures: judge the bytes, name by content, serve only our own names.** `storeImage` (`modules/catalog/images.ts`) is the only way a picture enters the pictures folder, from the importer and from the upload alike. Never trust a file extension or a sender's content type (the legacy folder has a ".png" that is WebP and two saved web pages), never accept SVG, and only serve names matching `STORED_NAME`. `Uploads/` is the **old** folder: read it, never write to it (on Windows `Uploads` and `uploads` are the same folder: the importer refuses that). Backups copy the pictures too (`copyMissingPictures`).
- **The Bash tool halves backslashes in Python/JS you pass through it, even in a heredoc**: a `\n` meant for a source file arrives as a real line break (seen again with the importer's and backup tool's messages). Use the Edit tool for any text with a backslash, and check the file after.
- **A reprint is not a sale.** Only the first print of a sale (the one that reaches the printer) is the original and may open the cash drawer; every later print is marked DUPLICATE, never opens the drawer, and is audited (`sale.print`). Do not add a path that prints a receipt without going through that rule, and do not let a client force the drawer open on a reprint. A sale that waits on a till (the outbox) is **not in the system**: it can only leave the outbox by being sent, or by a manager discarding it through `POST /sales/queued-discard`, which leaves a note. Never delete from the outbox without that.
- **A CSV import never guesses and never half-writes.** `importProducts` (`modules/catalog/import.ts`) checks every row first and writes nothing if any row has a problem; `dryRun` defaults to true so a missing flag cannot write; an empty cell leaves a product as it is; units are never created (they decide fractional sales); a barcode shared by several products, or the same barcode or product twice in the file, is an error, not a pick. Excel mangles long barcodes into `7.6E+12`: that is refused, not accepted.
- **The rehearsal must pass on the final dump before cut-over, and it only ever works on a throwaway copy.** `npm run rehearse` (`apps/api/src/cli/rehearse.ts`) imports into a temp folder and deletes it; never point it, or a test, at the real `pos.db`. Its checks must stay independent of one dump's numbers (no hard-coded totals): the cut-over-day dump is a different one. The imported legacy register session is open and must be counted and closed before a new one can be opened (the rehearsal does this step; `docs/10-cutover.md` lists it).
- **Every account needs a way to be created and given a password from the UI**, or cut-over is blocked (a missing Users screen was found by writing the runbook). The admin gives a first password in Menu → Users; with `mustResetPassword` the person is stopped at *Choose your password* before anything else. That stop is in the UI only: the server still accepts the first password. Do not rely on it as a security boundary.
- **A void reverses with new rows and keeps the sale whole.** `voidSale` (`modules/sales/void.ts`) only works while the sale's register session is open (a closed session is immutable and its figures settled: use a return). It puts stock back as `adjustment` movements (`refType: void`), takes each payment out of its register balance and puts the change back, lowers the customer's balance, and sets `status = 'void'` **and `rest_lbp = 0`** (a void sale that still showed money owed would be picked by the next customer payment: a test caught it). The register's rebuilt figures (`computeBreakdown`) and every report already skip void sales; keep it that way for any new report.
- **A stocktake adjusts by what was seen, not by what is there now.** Each count line keeps the system quantity at the moment of counting; finishing posts `counted - that`. Posting `counted - current` would undo every sale made while counting. Only counted products change, and a finished count is frozen by triggers (migration 0008).
- **HTTPS is optional and changes three things together:** `TLS_CERT` + `TLS_KEY` (both or neither), the sign-in cookie becomes `Secure`, and `Strict-Transport-Security` is sent. Anything that reaches the server across a network needs it (`docs/07-operations.md`); localhost does not.
- **The browser-test projects must not share a database when their specs are not repeatable.** `tablet-1024x768` has its own API (3200) and web server (5174). Specs reach the fake printer through the web server's `/__e2e` proxy, never a hard-coded port.
- **A restore from the Backups screen is applied at the next start, never under the running server.** `POST /backups/restore` checks the backup, makes a safety backup, leaves `<db>.restore-pending` and asks the server to stop with exit code 75; the launcher starts it again and `applyPendingRestore` (`backup/pending.ts`) runs before the database is opened. `scripts/dev.mjs` starts the API without the file watcher and restarts it on 75 (a watcher would sit waiting after the exit). Never open the database before that step.
- **Never copy the live database file.** A plain copy can catch a half-written page. Backups use SQLite's online backup (`createBackup`), then switch the copy out of WAL mode so it is one self-contained file (a test caught the companion `-wal`/`-shm` files this otherwise leaves). Restore decrypts and verifies **before** touching anything and keeps the old database (`before-restore-*`).
- **Fastify allows one not-found handler per scope.** `buildApp` sets exactly one (it serves the web app's pages when the built app exists); do not call `setNotFoundHandler` again.
- **Windows PowerShell 5 strips quotes inside arguments passed to programs** (`node -p "a.split(\".\")"` broke the install script's version check). Read `node --version` instead, and keep `.ps1` files ASCII.
- **Reports and sales share one thread** (SQLite is synchronous), so a heavy report delays everything behind it. Keep report queries on their indexes (`tests/db/query-plans.test.ts` guards the busy ones) and do not add a report that loads whole tables into JavaScript without measuring it with `npm run test:load` (`docs/09-load-test.md` §6 says when to move reports to a worker).
- **Migration lists in tests come from the folder**, not a hard-coded array: adding `000N_*.sql` needs no test edit. Keep it that way.
- **Reports attribute by date:** a sale counts on the day it was made and a return on the day it was taken back, and a return is charged to the original sale's cashier. Keep that when adding a report, or the dashboard and the sales report will disagree.

## Conventions

- TypeScript strict. No `any` without a comment.
- Module boundaries in `apps/api/src/modules/*`: call another module through its exported service, never its tables.
- Errors are RFC 7807 with a stable `code` (list in `docs/06-api-spec.md`).
- Tests reference user stories (`US-xx`) in their names. Keep `tests/README.md` traceability current.
- New endpoint → update `docs/06-api-spec.md`, add an integration test, and add it to the RBAC matrix test.
- UI: touch targets ≥ 48 px, every till action keyboard-reachable, RTL-safe CSS (logical properties), Arabic text must render. Use the shared tokens in `styles.css` (no new hex colours or pixel spacings in a page), `components/Icon.tsx` for icons (add a path there; never an emoji or a downloaded icon font; an icon-only button needs an `aria-label`), and add a new page to `lib/nav.ts` (the menu, by role) and, if it is heavy, load it lazily in `App.tsx`. Keep native roles (`link`, `button`) in menus: tests and screen readers rely on them.
- Text on screen goes through `useT()` (`t('English text')`, values as `{name}`); the Arabic is in `lib/ar.ts` and `tests/web/i18n.test.ts` fails if one is missing. Use `tNow()` outside a component. Labels kept in lists (the menus) are written in English in the list and translated where they are drawn. Arabic is right to left, so use logical CSS (`start`/`end`, `inset-inline-*`), never `left`/`right`. Receipts and the printer stay English/ASCII whatever the screen language.
- Commit messages: imperative, one concern per commit.

## Domain glossary

| Term | Meaning |
|---|---|
| LL / LBP | Lebanese pound. Primary display currency. Totals round to **5,000** (setting) |
| Rate | LBP per 1 USD (currently 90,000). Dated history in `exchange_rates` |
| Register session | One till shift: open with balances → sales → close with counts per bucket |
| Hold | Parked cart, recallable later |
| Walk-In | Default customer, `customerId = 1`. Cannot carry a balance or buy on credit |
| Bucket | One (payment method × currency) balance in a register session, e.g. `whish/LBP` |
| Whish / OMT | Wallet payment methods. Bookkeeping only, with no integration |
| On account | The unpaid rest of a partial or unpaid sale, owed by a registered customer |
| Z-report | End-of-session summary: expected vs counted for every bucket |
| Legacy | The old SQL Server app and `POSDB.sql`. See `docs/01-data-analysis.md` |

## Legacy data cautions

- `POSDB.sql` is **157 MB**. Never open or `cat` it whole. Use `grep -a`, `sed -n`, `head`. It's T-SQL (`GO` batches, `N'…'` literals, UTF-8 BOM).
- Legacy tables store numbers and dates as strings. `SaleProducts` links to `Sales` only by `reference`. Don't assume FKs exist.
- The dump contains plaintext passwords. Never print them, copy them into docs, or commit them.
- `Uploads/` holds ~700 product images. Treat as read-only input.

## Open questions (see QUESTIONS.md and plan.md)

**Whenever you have a question for the owner, add it to `QUESTIONS.md` (Open section, with context and an `Answer:` line) instead of asking in chat, and read the file for answers before asking again. Move answered ones to "Answered" with the date.**


Only the printer model remains open (deferred by the owner). Resolved decisions are in `plan.md` → "Decisions from the owner". Don't re-ask them. There is no customer credit limit by decision.
