# Test suite

Written **test-first**: the tests encode the contracts in `docs/` before the code exists. Until the milestone that implements each area lands, its tests fail with "module not found". That is expected. Nothing here has been run yet.

| Layer | Path | Tool | Needs | Milestone |
|---|---|---|---|---|
| Unit (pure domain) | `tests/unit/*` | Vitest | nothing | M1 |
| Database (schema, constraints, triggers, seed) | `tests/db/*` | Vitest | nothing | M1 (done) |
| Integration (HTTP + a throwaway SQLite file) | `tests/integration/*` | Vitest + Supertest | nothing | M1–M3 |
| Migration / ETL, parser and time conversion | `tests/migration/*`, `tests/unit/etl-*` | Vitest | `etl.test.ts` needs `POSDB.sql` (`POSDB_DUMP=path`, skipped without it); `etl-synthetic.test.ts` and the unit tests need nothing | M2 (done) |
| Web logic (cart, payment analysis, catalog cache, outbox) | `tests/web/*` | Vitest | nothing | M3 (done) |
| End-to-end on the built app, with the real security headers | `tests/e2e-prod/*` | Playwright (`production-build` project; builds the app first) | nothing | M5 (done) |
| End-to-end (real browser at 1366×768) | `tests/e2e/*` | Playwright | nothing: it starts a throwaway API (`apps/api/src/cli/e2e-server.ts`, fake printer) and the web app itself. `screenshots.spec.ts` only runs with `SHOTS=<folder>` | M3 (done) |
| Load | `tests/load/run.ts` (`npm run test:load`, `-- --quick` for a fast pass) | Plain Node (no tool to install) | nothing: it imports `POSDB.sql` into a temporary copy, starts the real server in production mode, and deletes everything afterwards | M5 (done) |
| Query plans (the busy queries use their indexes) | `tests/db/query-plans.test.ts` | Vitest | nothing | M5 (done) |

## Run

```bash
npm i
npm run test:unit
npm run test:db
npm run test:integration       # each test file gets its own temporary SQLite database
POSDB_DUMP=./POSDB.sql npm run test:migration
npx playwright install && npm run test:e2e
npm run test:load              # imports POSDB.sql into a temporary copy, ~5 minutes; add -- --quick for ~2
npm run test:e2e               # also runs the built app under the real security headers (project "production-build")
```

## Traceability

| Story | Covered by |
|---|---|
| US-15 products and lookups | `integration/products`, `integration/lookups`, `e2e/products` (add a USD product, edit price, hide/restore, new category, till sells it, filter the list by category and by brand), `integration/products` (category and brand filters alone, together, with search and with hidden products) |
| US-21/22/23 purchases: order, receive in parts, pay the supplier | `integration/purchases`, `db/purchases-schema`, `e2e/purchases` (two deliveries, part payment, overpayment refused, stock 1 → 11, draft delete) |
| US-14 returns | `integration/returns` (incl. the refund amount carried in `REFUND_REQUIRED`), `e2e/stock-returns` (part return, refund confirmed, cannot return twice, unknown receipt) |
| US-17 stock adjustments | `integration/inventory-alerts`, `integration/holds-adjustments`, `e2e/stock-returns` (take out damaged stock, ledger, validation) |
| US-24 expenses | `integration/expenses` (paid from the drawer lowers the balance and the rebuilt Z-report agrees, closed register records nothing, categories, totals, append-only), `e2e/expenses-cash` |
| US-13 cash in / out / transfer | `integration/register`, `integration/register-rules`, `integration/expenses` (movement list), `e2e/expenses-cash` (transfer between balances, same balance refused) |
| US-27/28 dashboard and reports | `integration/reports` (every figure derived by hand: net of a return, net profit, hourly, top items, by day / cashier / category, products, owed each way), `unit` + `web/csv` (spreadsheet quoting), `e2e/reports` (a sale and a return move the dashboard by the right amounts, CSV download, every tab opens) |
| US-30 backups, restore, serving the app | `db/backup` (consistent while writing, encryption, wrong passphrase / damaged / cut-off file, prune, second copy, restore refuses and keeps the old database), `db/backup-service` (when a backup is due, catch-up after a missed night, 30-minute retry, overdue status), `db/backup-cli` (the restore drill as separate processes), `integration/backup` (who may see and run, audit, no passphrase in answers), `integration/static-web` (app served, caching, page addresses, API 404s stay JSON, no path traversal), `e2e/backups` (overdue chip, admin makes a backup) |
| US-06 / R4 printer set-up, US-35 settings and exchange rate | `integration/printer-test` (test slip: header, wrap, transliterated Arabic, ruler as wide as the receipt, drawer only on request, failures explained, admin only), `integration/users-settings` and `integration/rates` (the API), `e2e/settings` (rate round trip with the typo check and a later start, shop details, test slip reaches the printer, admin-only screens, the side menu) |
| US-30 restore from the screen | `db/backup` (a backup is checked without being placed; applied at the next start with the old database kept; an unreadable one changes nothing), `integration/backup` (admin only, explicit confirmation, damaged file refused, safety backup, note left, audit, restart asked), `e2e/backups` (last backup shown with its size, restore needs the tick box and Cancel changes nothing) |
| Tab title is the shop name | `web/shop-title` (trimmed, remembered, kept when empty, blocked storage), `e2e/settings` (follows a rename, and the sign-in page shows it) |
| Appearance: dark / light, letter size | `web/appearance` (defaults, damaged or unknown values, a change keeps the other part, storage that refuses), `e2e/appearance` (a cashier picks dark and large, applied at once, kept after reload, reset; light wins over a dark computer; a fresh browser starts plain) |
| US-25/26 security review | `integration/security` (every registered route refuses an anonymous or garbage token; `alg: none` and wrong-secret tokens; PIN is cashier-only; lockout across capital letters; Host and Origin checks; headers; SQL in every kind of input; no secret in the log or in answers), `e2e-prod/production` (the **built** app under the real Content-Security-Policy: a whole shift, a refresh, a CSV download with zero violations; an inline script is blocked; a product name with markup stays text) |
| US-09 discounts and manager approval | `integration/approvals` (20 tests: within limit needs nothing; over limit refused with the limit and the request; a manager's name and password give a token that works once, for that cashier, up to the percent shown, for ten minutes; a failed sale does not use it up; a retry replays; wrong password, cashier, inactive manager all refused alike; lockout apart from sign-in; audited), `integration/sales-rules` (the limit), `web/discount` (reading the input, percent, when approval is needed, the cart with a discount), `e2e/discount` (within limit; wrong then right manager password; approval withdrawn when the cart changes; too big refused; change and remove; manager needs none; F6; hold says the discount is not kept) |
| US-15 product pictures | `unit/images` (kinds recognised by their bytes; web page, SVG, truncated and polyglot files refused; content names; only our own names are servable), `integration/images` (upload by bytes not by claimed type; refusals; 5 MB; dedupe; replace; remove; sync to the tills; audited; public serving only of our own names, traversal and hand-placed pages refused; Host check), `migration/etl` + `migration/etl-synthetic` (the real 314 products: 289 files, 12 shared, 2 web pages not copied, 2 mislabelled, 418 unused; old folder untouched; refuses to write into the folder it reads), `db/backup` + `db/backup-cli` (pictures backed up, only the new ones each time, put back by restore), `e2e/pictures` (a picture chosen, previewed, shown decoded in the list and in the cashier's search; removed; refused client-side; a server-refused picture does not lose the product; replaced), `e2e-prod` (loads under the real policy) |
| US-26 roles | `integration/auth-rbac` (matrix), `e2e/products` (cashier has no Products menu) |
| US-02 browse the catalog by category | `web/catalog-browse` (grouping, order, "No category" last, empty categories left out, unknown category, the saved copy keeps categories and an older copy is refetched, the icon chosen from the name), `e2e/catalog-browse` (button shows and hides, squares with an icon and a count in order, a category opens to its own products only, "All categories" goes back, picking adds to the cart and the category stays open, search takes over and gives it back) |
| US-01 scan | `unit/barcode`, `e2e/checkout` (scan, unknown, latency) |
| US-03/04 qty, totals | `unit/money`, `unit/pricing` |
| US-05 payment, change | `unit/pricing` (applyTender), `integration/sales`, `e2e/checkout` |
| US-06 receipt (ASCII, credit lines) | `unit/receipt`, `e2e/checkout` (printed, printer failure) |
| US-07 holds | `e2e/checkout` |
| US-10 outbox | `e2e/checkout`, `integration/sales` (idempotency) |
| US-05 payment methods and tender | `unit/pricing`, `integration/sales`, `integration/sales-rules` (wallet limits, mixed currency, change), `e2e/checkout` |
| US-11/12/13 register: open, movements, close, Z-report | `integration/register`, `integration/register-rules` (a known day derived by hand), `e2e/checkout` |
| US-31/32/33 credit, account payments, receivables | `unit/pricing`, `integration/credit`, `integration/customers`, `integration/returns` (credit returns), `e2e/checkout` |
| Q1 per-product currency | `integration/sales` (USD product) |
| R2 stock is informational, per-product alerts, purchases at 0 | `integration/sales` (never blocks), `integration/inventory-alerts`, `e2e/checkout` (low-stock notice) |
| R5 transliteration | `unit/translit`, `unit/receipt`, `integration/inventory-alerts` (receipt_name), `migration/etl` |
| US-14 returns | `integration/sales`, `integration/returns` (30 tests: partial, discounted, weighed, credit, refund checks, idempotency, parallel) |
| US-03/04 discounts, rounding, price rules | `integration/sales-rules` |
| Interface: role-based menu, header, account menu, gear | `web/nav` (what each role sees, Settings sections: Appearance for all, the rest admin only, unique places), and every `e2e` spec goes through the menu, the account menu or the gear (`users`, `switch-cashier`, `sales-screen`), on the 1366 x 768 desktop project and the 1024 x 768 touch project |
| US-14b a sale cancelled (void), US-09 price changed with approval | `integration/void-price` (stock, drawer, customer balance and day figures come back; kept whole; refused after returns, account payments, a closed register, or twice; cashier needs approval: single use, that sale, that cashier, expiry, other scopes refused; price approval for that product and price only, a failed sale does not burn it), `unit` cart pricing in `web/discount`, `e2e/void-price` |
| US-18 stocktake | `integration/stocktake` (differences only, selling during the count is not undone, uncounted products untouched, fractional rules, finished counts frozen by triggers, replay), `e2e/stocktake` |
| US-36 service income | `integration/services` (profit, reference sequence, money into the register balance, closing with no difference, replay, validation, append-only), `e2e/services` |
| US-34 duplicate barcodes | `integration/barcodes` (report, merge with stock transfer and untouched history, re-code, the rule on and off, hidden products), `e2e/barcodes` |
| US-25 PIN switch, first-password rule on the server, HTTPS | `e2e/switch-cashier`, `integration/password-reset`, `integration/tls` |
| Touch tablet (1024 x 768) | the `tablet-1024x768` project reruns checkout, discount, sales screen, void/price, switch cashier and users on its own database |
| US-29 cut-over rehearsal and pre-flight | `migration/rehearse` (the whole rehearsal on the real dump: every check passes), `integration/preflight` (a set-up PC passes; each missing piece is named; warnings do not fail; never prints a secret; missing pictures counted) |
| US-26 deleting users | `integration/users-settings` (admin only, gone from the list, cannot sign in, sessions ended, username reusable, audited, not yourself, an admin always remains), `e2e/users` (confirmation, Cancel keeps the person, no Delete on your own row) |
| US-25 / US-26 users and passwords from the UI | `e2e/users` (admin adds a cashier with a first password and PIN, the cashier is stopped until they choose their own, wrong or mismatched passwords refused, first password dead afterwards, a cashier has no Users page, switch off / on, cannot switch yourself off, PIN added and removed, anyone changes their own password) |
| US-15 products from a CSV | `unit/csv` (the reader: quotes, BOM, line ends, Arabic, exact money), `integration/product-import` (dry run is the default, create / update / unchanged, audit, errors by row and nothing written, file-level refusals, who may import), `e2e/product-import` (problem rows shown and blocked, good file imported, missing category only when ticked) |
| US-14 / US-09 a cashier's return with a manager's approval | `integration/return-approvals` (refused alone with the value, approved and audited, single-use, that sale only, that cashier only, no more than shown, expiry, failure does not burn it, scopes do not mix, replay, lockout), `integration/approvals` (the discount side, with the shared table), `e2e/sales-screen` (cashier from the receipt, wrong then right manager password, refund, line fully returned) |
| US-10 app opens with the server unreachable | `e2e-prod/production` (service worker: opens from its saved copy, says why sign-in fails; the worker leaves `/api` alone and is never cached) |
| US-06 receipts from the API | `integration/sales-rules` |
| US-06 / US-10 / US-14 recent sales, reprint, sales not sent yet | `integration/reprint` (first print vs DUPLICATE, drawer only on the first, audit, failed first print stays first, list names, cashier sees own, paging, `queued-discard`), `unit/receipt` (DUPLICATE marks, no drawer pulse), `web/offline` (retry keeps the sale), `e2e/sales-screen` (reprint at the fake printer, search, cashier vs manager and return link, offline listing, refused sale with Try again, manager discard with reason and audit) |
| US-30 exchange rate | `integration/rates` |
| US-25 login, lockout, sessions, PIN, change-password | `integration/auth-rbac`, `integration/auth-session` |
| US-26 roles and users | `integration/auth-rbac`, `integration/users-settings` |
| US-27 audit | `integration/auth-rbac`, `integration/users-settings`, `integration/products` |
| US-15 products, US-01/02 lookup and search | `integration/products` |
| US-17 low-stock alerts (the query) | `db/stock-alerts`, `integration/products`, `integration/inventory-alerts`, `integration/holds-adjustments` |
| US-16 purchases: order, receive in parts, cost update, pay suppliers | `integration/purchases` (52 tests), `db/purchases-schema` (the rules the database itself enforces) |
| US-23 what suppliers are owed | `integration/purchases` |
| US-07 held carts | `integration/holds-adjustments` |
| US-18 stock adjustments | `integration/holds-adjustments` |
| API helpers (quantities, shop day) | `unit/api-utils` |
| US-29 migration | `migration/etl` (63 tests on the real dump), `migration/etl-synthetic` (28 on hand-made dumps: all-or-nothing, re-runs, clashes, bad files), `unit/etl-parse`, `unit/etl-time` |
| Consistency (brief) | `integration/sales` (atomicity, 50 parallel sales, ledger == cache), `integration/sales-rules` (36 mixed parallel sales: ledger = cache, register recomputes to its running totals, no gaps in receipt numbers) |
| Performance (brief) and concurrency | `load/run.ts` (sale latency at 10, 50 and up to 150 a second, with readers and reports running, a heavy report's stall, 400 duplicate submissions, one hot product, backups during sales, then every money invariant re-checked), `db/query-plans`. Results and how to read them: `docs/09-load-test.md` |

## Not covered yet (add when the features are built)

Stocktake sessions (counting a whole shelf, as opposed to single adjustments), reports/CSV, SSE events, camera scanning, the barcode unique index (M7), refund-against-balance on returns, and the Windows spooler path against a real printer (manual checklist below).

## Manual hardware checklist (before go-live)

- [ ] Scanner reads EAN-13, EAN-8, a damaged label, and 20 scans back-to-back with no dropped or merged codes.
- [ ] Printer (USB, English only): 42-column alignment, a product with an Arabic name prints a readable transliterated name, cut works, drawer opens on cash. Check 80 vs 58 mm.
- [ ] Pull the printer's power mid-sale: the sale is saved and the warning appears.
- [ ] Stop the API service mid-sale: the sale is kept in the outbox and syncs once after the service restarts.
- [ ] Power-cycle the server during a sale: no half-written sale in the DB.
- [ ] Restore last night's backup onto a clean machine and open it.
