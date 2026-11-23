# PLAN-MULTI-BRANCH.md: multi-branch, HR and online marketplace

> **For any session (human or AI):** this is the master plan for growing the POS into a chain. **Read this file first, and update the Progress section below at the end of every piece of work** (tick boxes, add a dated log line, note what is next and any decision or surprise). The architecture is also in `docs/11-multi-branch.md`; open owner questions are in `QUESTIONS.md` (#10-14). `CLAUDE.md` still describes the one-till system until P1 changes it.

## Progress

Last updated: 2026-11-23 (end of third P1 session)

| Phase | Status | Notes |
|---|---|---|
| P0 Design docs | **partly done** | Done: `docs/11-multi-branch.md`, questions #10-14, `CLAUDE.md` pointer + adapter/Windows pitfalls. **Still to do:** replace rule 16 and the "one till" statements (when P1 terminals land), new ownership/sync/branch rules, `docs/04`, `docs/06`, `docs/07` |
| P1 Portability foundation + multi-terminal branch server | **in progress** | **Done:** `Database` adapter + SQLite driver (mutex, event-loop guard, statement cache), lint guard, and the **whole money core on the adapter**: holds, sales (create/void/delete/list/print), returns, customers (+ payments), expenses, services, registers, purchases, inventory (+ stocktake), approvals. **Next:** the multi-terminal work (migration 0015: branches, terminals, branch_id, per-branch counters, branch_users; per-terminal register sessions; warehouse by terminal), then SSE, print agent, paginated catalog sync, reports worker. `users`/`auth`/`catalog`/`settings`/`reports` can wait for P8's mechanical pass |
| P2 Sync foundation (`apps/central`, automatic reconnect) | not started | |
| P3 HQ-owned data down (catalog, price overrides, users, rates) | not started | |
| P4 Branch facts up + HQ reports + reconciliation | not started | |
| P5 Shared customers, transfers, central purchasing | not started | |
| P6 HR (6a attendance, 6b payroll engine, 6c payslips) | not started | |
| P9 Online marketplace (9a-9d) | not started | Needs P2-P5 |
| P8 Move to PostgreSQL | not started | When servers reach real machines |
| P7 Operations and cut-over | not started | |

### Log
- 2026-11-23: Plan designed and approved by the owner (hybrid branch + cloud, SQLite now / PostgreSQL later, HR, online marketplace). Wrote `docs/11-multi-branch.md` and added open questions #10-14. No code changed. Work is on `main` (a `darwish` branch also exists, pushed, same commit as `main`; ask the owner which to use).

- 2026-11-23 (P1, session 1, branch `darwish`, nothing committed): 
  - **Added** `apps/api/src/db/adapter.ts` (`Database`/`Queryable`: `one`, `all`, `run`, `tx`; `TransactionYieldedError`), `db/drivers/sqlite.ts` (wraps the existing connection; transactions one at a time behind `util/mutex.ts`; calls inside `tx()` join it via AsyncLocalStorage in `db/txstate.ts`; a transaction that waits on the event loop is rolled back with `TX_YIELDED`), `app.database` decorator, `currentRateQ` in `settings/context.ts`.
  - **Legacy bridge:** `inWriteTransaction` now throws `DB_TX_COLLISION` if it starts while another request's adapter transaction is open (otherwise it would silently join it). Legacy code and the adapter share one connection until every module is converted.
  - **Converted (pilot):** `modules/holds/routes.ts` (no `better-sqlite3`, `RETURNING id`, `?` params). ESLint now forbids `better-sqlite3` in `apps/api/src` except `db/` and four file-level tools (allow-list only shrinks) and forbids `db/open` in converted folders (list in `eslint.config.js`).
  - **Tests:** `tests/db/adapter.test.ts` (15: parallel read-then-write loses no update, rollback, join, order, event-loop guard, legacy collision). Full suites green: unit+db+web 443, integration 802 (+4 skipped).
  - **Found and fixed (environment):** run tests from `C:\` not `c:\` (else vitest "reading 'config'"), and `node_modules/@pos/*` junctions pointed at a renamed folder `POS_New`; recreated. Both noted in `CLAUDE.md` pitfalls.
  - **Surprise to remember:** `queueMicrotask` and promises inherit the AsyncLocalStorage context, so code spawned *inside* a `tx()` joins it; only genuinely separate requests are outside. Tests that simulate "another request" must start it from outside the transaction.
  - **Not yet done in P1:** convert `counters`/`nextRef`, `createSale` and what it calls (`registers`, stock, customers balance), `returns`, `purchases`, `inventory`, `users`, `auth`; the rest of the ~45 files can follow in P8's mechanical pass. Then: migration 0015 (`branches`, `terminals`, `branch_id`, per-branch counters, `branch_users`), terminal enrolment, per-terminal register sessions (remove "one till" in `registers/service.ts` + `routes.ts`), `defaultWarehouseId` by terminal, per-branch receipt numbers, SSE, print agent, paginated catalog sync, reports on a read-only worker, multi-terminal load test.
  - **Open for the owner:** `QUESTIONS.md` #10-14. Whether to commit (nothing is committed yet; `darwish` branch only).
  - *(Session 1 was later committed to `main`: `671e63f` docs, `20ff078` adapter + holds, pushed.)*
- 2026-11-23 (P1, session 2, on `main`, **not committed**): **money core converted to the adapter.**
  - **Converted (async, `Queryable`):** `auth/approvals.ts` (all five scopes through one `consume()`), `modules/registers/service.ts` + `routes.ts` (open now re-checks "already open" inside the transaction; `closed_at` is app-supplied ISO text, no `strftime`), `modules/sales/{service,void,delete,routes}.ts`, `returns/{service,routes}.ts`, `customers/{service,routes}.ts`, `expenses/routes.ts`, `services/routes.ts`; `auth/routes.ts` issues approvals through `app.database`.
  - **Twins kept for unconverted modules** (delete them when the last legacy caller goes): `nextRefQ`/`nextRef`, `writeAuditQ`/`writeAudit`, `findReplayQ`/`findReplay` (+ `rememberResponseQ`), `currentRateQ`/`shopSettingsQ`/`defaultWarehouseIdQ`/`walkInCustomerIdQ` next to the sync versions in `settings/context.ts`. SQL text is shared where it was easy.
  - **Portability fixes made on the way:** `RETURNING id` instead of `lastInsertRowid` everywhere in converted code; delete's named parameters (`@sale`) became `?`; customer search uses `LOWER(x) LIKE LOWER(?)` (PostgreSQL's `LIKE` is case-sensitive); `receipt_width w` alias got `AS`. Statement cache in the SQLite driver (500 cap) so per-line inserts do not re-prepare.
  - **Tests:** nothing changed in existing tests: unit+db+web 443 and integration 802 pass untouched. New `tests/integration/concurrent-sales.test.ts`: 40 parallel sales + 20 copies of one Idempotency-Key + 10 partly-paid credit sales + 10 customer payments mixed with 20 more sales; asserts one sale per key, gap-free unique receipt numbers, stock, register expected = Z-report recount, and `customer.balance = Σ open rest`. **Total now 1247 passed, 4 skipped.** ESLint, Prettier, both typechecks clean. Lint guard list extended to all converted folders.
  - **Not verified:** `npm run test:load` (needs `POSDB.sql`, not in this checkout). Expect the adapter to cost a few microtasks per statement; re-measure on the dump before the real till PC run. Remember PostgreSQL returns `count(*)`/`SUM` as strings (bigint): the future driver must parse int8 to number.
  - **Still legacy (sync `inWriteTransaction`):** `purchases`, `inventory` (+ stocktake), `catalog` (products, import, lookups, barcodes), `users`, `auth` (login, sessions), `settings`, `audit/routes`, `reports`, `backup`, ETL and CLI tools. Next in order: `purchases` and `inventory` (they share the twins above), then the multi-terminal work. *(Purchases and inventory were done in the next entry.)*
- 2026-11-23 (P1, session 3, on `main`, **not committed**): **`purchases` and `inventory` (incl. stocktake) converted.**
  - Converted: `purchases/{service,routes}.ts` (create, edit, receive, supplier payments, payables report), `inventory/{routes,stocktake}.ts` (stock list, adjustments, movements, alerts, all stocktake routes). `lowStock` is now `async lowStock(q)`; `reports/routes.ts` calls it through `app.database`; `tests/db/stock-alerts.test.ts` runs it through `createSqliteDatabase(db)` (same assertions).
  - **More portability fixes** (SQLite-only habits that PostgreSQL rejects): alias used in `HAVING` (`HAVING total_milli <= ...`) now repeats the sum (also in `createSale`'s low-stock query); `ORDER BY` no longer uses an alias inside an expression; scalar `MAX(a, b)` became `CASE WHEN`; `SUM(a <> b)` (summing a boolean) became `SUM(CASE WHEN ... THEN 1 ELSE 0 END)`; `strftime('now')` defaults in stocktake updates became app-supplied `nowIso()`; stocktake line upsert writes `counted_at` explicitly. A purchase edit now does its checks inside the transaction.
  - **Twins removed:** the sync `shopSettings`, `defaultWarehouseId`, `walkInCustomerId` (no callers left). **Twins still needed:** `nextRef` (only `tests/db/schema.test.ts`), `findReplay`/`rememberResponse` (`catalog/barcodes.ts`), `writeAudit` (auth, backup, catalog, settings, users, CLI), `currentRate` (`settings/rates.ts`).
  - Lint guard list now also covers purchases and inventory. Full suites: **1247 passed, 4 skipped**; ESLint, Prettier, typechecks clean.
  - **Next:** the multi-terminal work (it needs the money core converted, which it now is): migration 0015 (`branches`, `terminals`, `branch_id` columns, per-branch counters, `branch_users`), terminal enrolment, one register session per terminal (remove the one-till logic in `registers/service.ts` `getOpenSession` and the "already open" check in `registers/routes.ts`), warehouse by terminal (`defaultWarehouseIdQ`), per-branch receipt numbers. The remaining legacy modules (catalog, users, auth, settings, reports, backup) can wait for P8's mechanical pass or be converted when touched.

---

# Plan: Darwish POS → multi-branch chain (hybrid: branch servers + cloud HQ)

## Context
Today the system is one till on one PC (docs/04 "One till, one PC"; rule 16; `getOpenSession` and `defaultWarehouseId()` assume a single till and a single warehouse). The owner wants it to serve a large market chain: 8,000+ products, 5–10 branches, many cashiers selling at the same time in each branch, many employees, data held centrally.

**Decisions from the owner (this session)**
| Topic | Decision |
|---|---|
| Topology | **Hybrid.** A server in every branch (keeps selling when the internet is down) + one **cloud HQ server**. Both built and run on the dev machine first (different ports/data folders), moved to real machines later. |
| Offline | Branch keeps selling **fully** offline. **Sync runs automatically the moment the internet connection is restored** (no manual step), in both directions, and resumes where it stopped. |
| Scale | 5–10 branches (≈ 50 tills). |
| Catalog | Central catalog; **per-branch stock and price overrides**; transfers between branches. |
| Customer credit | **One shared balance** across branches. |
| Database | **SQLite everywhere for now** (branches and the HQ cloud server). **PostgreSQL later**, when the servers move to their real machines (P8). Everything is built **portable**, so any server (HQ *or* a branch) can move from SQLite to PostgreSQL without rewriting business code. |
| Employees | Accounts, roles, branch assignment, audit **plus an HR module**: shifts/rosters, attendance, payroll, payslips. |
| Attendance | Clock in/out by **PIN/password on a till or a branch kiosk page**; works offline through the branch server. |
| Pay types | **Monthly salary, hourly and daily rates**, overtime, bonuses, deductions, advances/loans; per-employee currency (LBP or USD). |
| Statutory | NSSF / income tax as **configurable, dated rules** calculated by the system (never hard-coded rates; HR/accountant verifies). |
| Payslips | **Employee self-service** (own attendance and payslips) + HR print/PDF. |
| Online marketplace | New module: customers order online and **pay on delivery (cash, recorded only)**. Responsive **website/PWA first** (English + Arabic); native apps later on the same API. |
| Fulfilment | Order is routed to the **nearest branch by delivery zone**; that branch picks, packs and delivers. |
| Online stock | Online shows **only what the branch has** and **reserves** stock when ordered (tills keep rule 17: never blocked). Pickers can substitute or remove items. |
| Delivery | **Own drivers**, assigned and tracked in the system: zones and fees, run status, cash collected and settled at the branch. |

## Key insight from exploring the code
- SQLite is enough **today** for a branch: p95 32 ms at 50 sales/s (docs/09); 20 tills selling is well under 1 sale/s. So we stay on SQLite now.
- **But the code is not portable today.** About 276 raw `db.prepare`/`db.exec` sites in 45 files, ~64 synchronous `inWriteTransaction` callers, `lastInsertRowid`, `strftime` defaults, an FTS5 virtual table, `COLLATE NOCASE`, SQLite-only triggers and the online-backup API all tie it to better-sqlite3. "Easy to migrate later" therefore needs a **database portability layer built first** (P1), so everything written afterwards (sync, central, HR) is portable from day one and the existing modules are converted as they are touched.
- Schema is already partly ready: `warehouses`, `stock_levels(product_id, warehouse_id)`, `register_sessions.terminal_id` with a unique-open-per-terminal index, `sales.client_sale_id`, `idempotency_keys`. The *code* ignores them.

## Architecture
```
                         ┌───────────── Cloud HQ (apps/central, Fastify + SQLite now) ─────────────┐
 HQ staff browser ─────▶ │ catalog authoring · prices · users/roles · rates · transfers · reports   │
                         │ ingest of branch facts · customer balance authority · change feed        │
                         └───────▲───────────────────────────────▲─────────────────────────────────┘
                     pull changes│(HTTPS, branch-initiated)      │push facts (batched, idempotent)
              ┌──────────────────┴───────┐              ┌───────┴──────────────────┐
              │ Branch A server          │              │ Branch B server          │   … up to 10
              │ Fastify + SQLite (today's│              │ (same code)              │
              │ api) + sync agent        │              └──────────────────────────┘
              └──▲────▲────▲─────────────┘
   LAN / SSE     │    │    │
        Till 1  Till 2 Till N   each: browser PWA + tiny print agent (USB ESC/POS)
```
- **Branch-initiated sync** (pull + push over HTTPS) so branches behind NAT/CGNAT need no inbound port.
- **Tills talk only to their branch server** over the LAN; they never need the internet.
- The same `apps/api` runs as a branch server (`MODE=branch`). A new `apps/central` is the HQ. HQ UI = same web app in an HQ mode, hitting the cloud.

### Data ownership (this is what removes conflicts)
| Owner | Data | Direction |
|---|---|---|
| **HQ** | products, categories, brands, units, suppliers, base prices, **branch price overrides**, exchange rates, payment methods, users/roles/branch assignment, global settings, barcode uniqueness | HQ → branches (change feed) |
| **Branch** | sales, items, payments, returns, register sessions/balances/movements, expenses, stock movements, stocktakes, purchases received, audit rows, receipt prints | branch → HQ (append-only facts) |
| **Per branch, read by HQ** | stock levels (derived from the branch's movements) | branch → HQ |
| **Online orders** | Placed and routed at HQ (the public site lives in the cloud); once a branch accepts, the **branch owns fulfilment** (picking, substitutions, dispatch, delivery outcome, cash settlement). Single writer per state, so no conflicts. | HQ → branch (new orders), branch → HQ (status, settlement) |
| **Two-party** | stock transfers: *ship* at A (in transit), *receive* at B; HQ is the coordinator | via HQ |
| **HQ authority** | customer shared balance: payments recorded at any branch are allocated oldest-sale-first **at HQ**; the branch shows "last synced balance + local movements since" and reconciles on sync | both |

Rules that stay: append-only history (rule 4), server-decided totals (2), one transaction per sale (3), idempotency (6), exchange rate snapshot per sale (9). Facts are **never edited by sync**, only inserted once (dedupe key below).

### Identity and numbering
- Branch-owned facts keep local integer ids; HQ keys them by `(branch_id, local_id)` plus the existing `client_sale_id` (make it a UUID everywhere) as the dedupe key. No renumbering of existing FKs.
- HQ-owned entities get HQ ids; branches **store those ids as their own** (no local autoincrement for products/categories/…), so a product id means the same thing everywhere.
- Receipt `ref` becomes **per branch** (unique `(branch_id, ref)`, printed `B2-004711`); counters scoped by branch. Terminal id is shown on the receipt.

### Sync protocol
- **Down (HQ → branch):** every HQ write appends to `change_log(seq, entity, entity_id, op, payload, version)`. Branch calls `GET /sync/changes?cursor=<seq>&limit=500`, applies in one transaction, stores cursor. Paginated, resumable; first sync of 8,000 products is ~16 pages (today's `/products/sync` has no pagination: fixed here too).
- **Up (branch → HQ):** branch writes a row to `sync_outbox` **inside the same transaction** as the fact (like the existing audit rule). A sync agent sends batches (`POST /sync/facts`, ≤ 200 events), HQ inserts idempotently on the dedupe key and acks the highest contiguous seq. Retry with backoff; duplicates and out-of-order batches are harmless.
- **Enrolment:** a branch gets a one-time enrol code from HQ → exchanges it for a long-lived branch credential (hashed at HQ, revocable). Mutual checks: HQ refuses facts for another branch id.
- **Automatic reconnect:** the sync agent never needs a person. It runs on a short timer while online, and while offline it probes HQ (`GET /sync/ping`, a few seconds, then backing off to ~30 s) so **the first successful probe starts a full catch-up immediately**: push the backlog of facts (oldest first, in batches), then pull all HQ changes since the stored cursor. A failure mid-batch just resumes from the last acknowledged seq. Pushes are also triggered right after each local commit when online, so normal latency is seconds. After a long outage the backlog drains in the background and never blocks tills (sync uses its own short transactions, not the sale path).
- **Health:** each branch reports lag and last sync; HQ dashboard flags a silent branch.
- Offline login works because branch server holds replicated users (hashes) and issues its own tokens; manager approvals stay local (rule 20).

### Multiple cashiers at once (inside a branch)
- `terminals` table (id, branch_id, name, printer, enrolled). Terminal identity comes from enrolment, **not** a client-sent `'T1'`.
- Register session per terminal (index already exists). Remove "one till" logic in `registers/service.ts` (`getOpenSession`) and `registers/routes.ts` (open refuses if any open).
- Wire `defaultWarehouseId()` → the terminal's branch warehouse (`modules/settings/context.ts`).
- SSE (`/events`, planned in docs/04 but not built) pushes price/stock/rate changes and low-stock to every till.
- Hot rows (`stock_levels`, customer balance, register `expected`) stay safe under SQLite's single writer; add a multi-terminal load test to prove it.
- **Printing:** today the API spawns PowerShell on its own host (`printing/driver.ts`). With the server away from the tills, each till PC runs a small **print agent** (localhost, ESC/POS to the Windows spooler/drawer); the browser sends it the bytes. Rule 7 (printer failure never fails a sale) and the DUPLICATE/drawer rule stay on the server side.
- Reports move to a read-only worker connection (the open item in plan.md/docs/09 §6) so heavy reports never delay sales.

### Employees
Add `branch_users(user_id, branch_id, role)` (a person can work in several branches), new roles beyond `cashier < manager < admin` in `auth/permissions.ts`: **branch manager, stock clerk, accountant, HQ admin**, with a capabilities map scoped by branch (today it is a hardcoded rank, no scoping). Audit rows carry `branch_id`. HQ manages users; branches receive them. A PIN stays cashier-only (rule 20).

## Online marketplace (order online, pay on delivery)

**Where it runs.** The public site must be reachable from the internet, so it lives on the **cloud HQ side** (never on a branch server, which sits on a shop LAN). Branches reach it the same way they reach HQ today: branch-initiated sync. A branch that is offline simply does not receive new orders until it reconnects (see availability below).

```
 Customer phone ─▶ Storefront PWA (apps/storefront, EN/AR) ─▶ Shop API (public routes, in apps/central)
                                                                │ orders, reservations, zones, accounts
                                  sync (branch pulls new orders)▼
 Branch server ── pick/pack queue ── dispatch ── Driver PWA (phone, talks to HQ) ── cash settled at branch
```

**Order lifecycle** (append-only `order_events`, one writer per state): `placed → accepted → picking → ready → out_for_delivery → delivered | failed | cancelled`. Customer may cancel only before `picking`; after that it is a request the branch decides. Branch wins once it has accepted.

**Pay on delivery without breaking the money rules.** An order is **not** a sale and does not touch registers or customer credit until the cash exists. At **delivery settlement** the branch records the real sale through the existing `createSale` (rule 2 and 3: the server recomputes totals, one transaction, idempotent, cash method, current register session), tagged `channel='online'` with the order id. A failed or cancelled delivery creates **no sale**, only releases the reservation. This leaves rule 13 (cash only, recorded, no third-party calls) and rule 15 (`customer.balance = Σ open rest`) untouched: online COD is never credit.
- **Prices are locked at order time.** Settlement uses the order's agreed line prices, via a new single-use manager-style approval scope **`order`** (bound to one order and its total, consumed inside the transaction, like scopes in rule 20), so no manual price override is needed.
- **Delivery fee** is a normal no-stock catalog item (`Delivery fee`), so it flows through the same pricing and rounding (LBP rounds to 5,000, rule 1, in `packages/shared`).
- **Driver cash:** a `delivery_run` groups orders for one driver; the driver's expected cash is the sum of delivered orders; the branch counts it at settlement and a variance is recorded (like a register count). The cash lands in the branch drawer through the settlement sale, so closing counts agree.

**Availability and reservations (new rule, tills unchanged).** HQ keeps a per-branch stock snapshot built from synced stock movements. Online availability = `on_hand − reserved − safety_buffer` (per product settings); items ≤ 0 are not orderable. Placing an order **reserves** quantities at the routed branch; reservations are released on cancel/fail and consumed by the settlement sale. A branch whose last sync is older than a threshold (e.g. 10 min) is marked **temporarily unavailable** for new orders (or the order routes to the next covering branch). Till sales still never block (rule 17), so the picker can substitute or remove a line if stock vanished.

**Zones, hours, slots.** HQ-owned `delivery_zones` (named areas first, map polygons later): branch, fee, minimum order, delivery hours, max orders per slot. Routing = the branch whose zone covers the customer's area (first by priority, then by capacity).

**Customers and the public door.**
- Online accounts are separate from staff `users` and link to the shared `customers` record (so a customer is one person across shop and online; shared balance decision stays).
- Sign-up with phone + password (OTP/SMS later, an outside service, decide with the owner). Saved addresses. Order history. Walk-in rules do not apply.
- **Public API is a new class of open route:** catalog browse, zone check, sign-up/login, place order, order status. Rule 19's allow-list grows **on purpose** and `security.test.ts` is extended; they use a separate rate limit, request-size caps, CAPTCHA/abuse checks, and read only a **published catalog read model** (no costs, suppliers, stock numbers beyond available/not). Order placement is idempotent (rule 6 extended).
- **COD abuse:** no-show counter per phone/address, optional order limit or block after repeated failed deliveries, minimum order per zone.
- **Product content is HQ-owned:** online name/description (EN/AR), photos, `online_enabled`. Pictures are content-addressed already (`storeImage`), so they are uploaded at HQ and distributed to branches and the storefront.

**Branch and driver screens.** Branch: *Online orders* queue (new-order alert via the branch SSE), pick list with substitute/remove, ready, assign driver, dispatch, record outcome, cash settlement. Driver: a phone PWA with its own `driver` role (employees, linked to HR), works against HQ (drivers are outside the shop LAN); HQ relays to the branch by sync. Notifications to the customer: status page first; web push, then SMS/WhatsApp later.

**Reports:** online sales by branch/zone/driver, order-to-delivery time, cancel/fail/no-show rate, substitution rate, cash variance per driver.

## Database portability (SQLite now, PostgreSQL later, for any server)

**Goal:** switching a server's engine is a configuration change (`DB_ENGINE=sqlite|postgres`) plus a one-time data copy, with no change to sales, sync, HR or report code.

1. **One async `Db` adapter** (`apps/api/src/db/adapter.ts`, shared by branch and central): `one()`, `all()`, `run()`, `tx(fn)`, with `?`-style parameters translated per driver (`$1…` for PostgreSQL). Drivers: `drivers/sqlite.ts` (wraps better-sqlite3, today's `openDatabase` settings kept: WAL, `synchronous=FULL`, FK on) now; `drivers/postgres.ts` (`pg` pool) in P8. Only the driver folders may import a database library (ESLint `no-restricted-imports`, allow-list that shrinks as modules are converted).
2. **Transactions stay correct on both engines.** CLAUDE.md's "no `await` inside a money transaction" exists because better-sqlite3 is synchronous. An async API would let two requests interleave on one SQLite connection, so the SQLite driver's `tx()` runs transactions **one at a time behind an async mutex** (same guarantee as `BEGIN IMMEDIATE` today); the PostgreSQL driver gives each transaction its own pooled connection. Code that must not race (idempotency, counters, stock, balances) is written to be safe on **both**: unique constraints + handled conflicts for idempotency keys, atomic `UPDATE x = x + ?` (no read-then-write), `ON CONFLICT` upserts, `RETURNING` for ids and counters. That also makes concurrency on PostgreSQL correct later with no redesign.
3. **A portable SQL subset** (written in docs/04 and enforced by review + a test that scans migrations): `RETURNING` instead of `lastInsertRowid`; `ON CONFLICT` instead of `INSERT OR …`; **timestamps are written by the application** as ISO-8601 UTC text (no `strftime`/`now()` defaults, so values are identical on both engines); money, quantities and minutes stay `INTEGER`/`BIGINT` integers; booleans stay 0/1; usernames stored lower-case (no `COLLATE NOCASE`); no `WITHOUT ROWID`, no SQLite pragmas outside the driver.
4. **Engine-specific things sit behind interfaces with two implementations:** product search (`searchProducts`: FTS5 trigram now, `pg_trgm` later); backup/restore (SQLite online backup now, `pg_dump`/WAL archiving later, same encrypted-file and verify steps); append-only and lock triggers (SQLite `RAISE(ABORT)` now, plpgsql later).
5. **Migrations per dialect, kept in lockstep:** `migrations/sqlite/NNNN_*.sql` (today's folder, unchanged numbering) and `migrations/postgres/NNNN_*.sql`. A test compares the resulting schema (tables, columns, nullability, unique/FK/check names) from both and fails on drift. A new migration without a PostgreSQL twin fails CI once P8 starts.
6. **Move tool** (`npm run db:move -- --from sqlite:<file> --to postgres:<url>`, P8): copies tables in dependency order with ids preserved, resets sequences, then runs the existing invariant checks (the `rehearse` set: counts, sums, `customer.balance = Σ open rest`, stock = ledger) on the target and refuses to switch if any differ. Run on a throwaway copy first, like `rehearse`. Works for HQ **and** for any branch server; a branch can stay on SQLite forever.
7. **Existing code is converted behind module repositories as each module is touched** (sales, registers, inventory, users in P1), the rest in a mechanical pass in P8 before the first PostgreSQL server. Every converted module keeps its tests, which then run on both engines.

## HR module (shifts, attendance, payroll, payslips)

**Principle: least data at the branch.** Salary data lives **only at HQ (cloud)**. Branches receive just what they need to run the floor: employee name/code, attendance credential hash, today's roster. Branches send up attendance punches. Payroll is computed at HQ because one employee may work in several branches.

| Piece | Owner | Notes |
|---|---|---|
| `employees` (code, name, branch assignments, hire/end date, pay profile, optional `user_id`) | HQ | Not every employee has a sign-in account (cleaners, baggers), so employee ≠ user. Link when one exists. |
| `shift_templates`, `rosters` (employee × date × shift × branch), `holidays`, `leave_types`, `leave_requests/balances` | HQ | Roster edits happen in the HQ UI (a branch manager uses HQ online). Roster is pushed down to the branch. No offline roster editing (avoids conflicts). |
| `attendance_punches` (employee, branch, terminal, in/out, time, source) | **Branch** → HQ | Append-only fact like a sale. A mistaken punch is fixed by an **adjustment row** with reason and approver, never an edit (rule 4). Dedupe key = UUID. |
| `attendance_days` (derived: worked minutes, late, early leave, overtime, absence, leave) | HQ | Recomputed from punches + roster + holidays + leave; deterministic. |
| `pay_profiles` (type: monthly/daily/hourly, base amount, currency, overtime multiplier, allowances) | HQ only | Dated (effective_from) like `exchange_rates`. |
| `payroll_rules` (NSSF employee/employer rates and caps, income-tax brackets, rounding) | HQ only | **Dated and configurable.** Seed with placeholders; accountant confirms. Never hard-coded in code. |
| `loans_advances` + installments | HQ | An advance given from a till is an expense type that creates the loan row; repayments are deducted at payroll. |
| `payroll_runs` (period, branch/all, status draft → calculated → approved → paid → **locked**) and `payslips` + `payslip_lines` | HQ only | Locked runs and issued payslips are immutable (triggers, like closed registers). A correction is an adjustment line in the next run. |

**Money and time rules (extend CLAUDE.md hard rule 1):** time is integer **minutes**, rates are integers (LBP whole, USD cents), multipliers are integer basis points. No floats. Pay calculation is a pure function in `packages/shared` (`payroll.ts`) so it is unit-testable with golden cases; each payslip stores the **rule versions and exchange rate it used** (snapshot, like a sale). Every line has a stable code so `net = Σ earnings − Σ deductions` is an invariant tested for every payslip.

**Attendance credential:** an **attendance PIN** that can only punch in/out (no other access, rate-limited, lockout like login). It is a *new* credential, separate from the till PIN, so rule 20 (PIN is cashier-only for signing in) is not weakened; document this as a new rule. A punch records branch, terminal and server time; a clock-in outside the roster window is flagged for review, not blocked.

**Payroll run:** HQ checks every branch has synced attendance up to the period end (sync watermark) and **refuses to calculate** otherwise, listing the late branches. Approve → pay (cash from a drawer is recorded through the existing expenses/cash-out path, or marked paid by bank/other) → lock.

**Payslips and privacy:** salary and payslips are the most sensitive data in the system.
- New roles: `hr_manager` (employees, rosters, leave, attendance fixes), `payroll` (runs, payslips, rules); HQ admin sees all. A **branch manager sees attendance and roster of their branch, never salaries.**
- Employees with an account see **only their own** attendance, leave and payslips (self-service in HQ; needs the internet). HR can print or export.
- Payslip = HTML rendered by the web app and printed/saved to PDF by the browser (Arabic renders correctly; no PDF library). English/Arabic follows the screen language.
- Every payslip view/export and every run state change is audited (never logged with amounts in plain log lines, rule 21).
- Backups of HQ are encrypted (existing AES-256-GCM scheme, applied to whichever engine the HQ runs).

## Phases (each ends with tests green and docs updated)
**P0 – Design docs** (no code): `docs/11-multi-branch.md` (this design), update docs/04, 06, 07; new rules in CLAUDE.md (replace rules 16 and the "one till" statements, add rules for ownership, sync idempotency, branch scoping); QUESTIONS.md entries.

**P1 – Multi-terminal branch server (SQLite, no cloud).** Deliver first: it already satisfies "several cashiers per branch". Starts with the **portability foundation** (adapter, SQLite driver, async mutex transaction, portable-SQL rules, lint guard, convert sales/registers/inventory/users/counters to the adapter), then the multi-terminal work below.
- Migration `0015`: `branches`, `terminals`, `branch_id` on `warehouses/users scope/sales/returns/expenses/audit`, per-branch counters, `branch_users`.
- Terminals + enrolment; per-terminal sessions; warehouse by terminal; receipt numbering per branch.
- SSE events; print agent; paginated catalog sync; reports on a read-only worker.
- Tests: concurrent sales from N simulated terminals (extend `tests/load/run.ts`), invariants hold; RBAC matrix updated; e2e with two browser contexts.

**P2 – Sync foundation.** `apps/central` skeleton (Fastify + **SQLite through the same adapter**, same migrations style), `change_log`, `sync_outbox`, enrolment, branch sync agent, dev script launching HQ (:4000) + branch A (:3000) + branch B (:3001) from `scripts/dev.mjs`, each with its own data folder.

**P3 – HQ-owned data down.** Catalog (8,000 products from the ETL/CSV import), prices, **branch price overrides** (new `branch_prices`; `createSale` prices from override else base), rates, users/roles, settings, barcode uniqueness at HQ. HQ screens for products, prices, users, branches/terminals.

**P4 – Branch facts up + HQ reporting.** Ingest sales/returns/registers/expenses/stock movements; consolidated dashboard and reports (portable SQL aggregates, not JS loops, so they also run well on PostgreSQL later; heavy ones on a read-only connection/worker); per-branch drill down; reconciliation job (per branch per day: counts and sums must match, flag any gap).

**P5 – Shared customers + transfers + purchasing.** HQ customer balance authority and cross-branch payment allocation; stock transfer (ship/receive, in transit); optional central purchase orders; central view of stock per branch with low-stock alerts.

**P6 – HR module** (depends on P2–P4 sync and P1 employees/roles). Done as three shippable slices:
- **P6a Employees, shifts, attendance.** `employees`, branch assignments, shift templates, rosters, holidays; attendance PIN; clock-in screen (till + branch kiosk page); `attendance_punches` branch fact + sync up; adjustment flow; daily attendance view; leave types and requests. Tests: offline punches sync once, adjustment never edits, roster window flags.
- **P6b Payroll engine.** `packages/shared/src/payroll.ts` (pure, integer math), `pay_profiles`, `payroll_rules`, loans/advances, `payroll_runs` and `payslips` with lock triggers, sync-watermark gate, rule/rate snapshot per payslip. Golden-case unit tests (monthly, daily, hourly, overtime, absence, advance repayment, NSSF/tax from configured rules, LBP and USD employees, rounding).
- **P6c Payslips and self-service.** Payslip view/print/PDF (EN/AR), employee self-service pages, role scoping (`hr_manager`, `payroll`), audit of views, HR reports (attendance, payroll cost by branch, overtime). RBAC matrix and security tests extended (an employee cannot read another's payslip; a branch manager cannot read salaries).

**P9 – Online marketplace** (needs P2–P5: sync, HQ catalog with pictures, branch stock at HQ, shared customers; execution order versus HR is the owner's call). Four slices:
- **P9a Storefront and ordering.** `apps/storefront` PWA (EN/AR, RTL), public Shop API routes in `apps/central`, published catalog read model, online accounts and addresses, delivery zones/fees/hours, availability, **reservations**, order placement (idempotent), `order_events`. Tests: reservation math, availability with a stale branch, anonymous-door allow-list.
- **P9b Branch fulfilment.** Order sync down/status up, *Online orders* queue and pick/substitute screens, SSE new-order alert, ready state, **`order` approval scope** (new migration rebuilding the `approvals` CHECK, as in 0006/0007), `channel` and `order_id` on sales, settlement through `createSale`, reservation release in the same transaction.
- **P9c Delivery.** `driver` role, `delivery_runs`, driver phone PWA against HQ, outcomes (delivered/failed/returned), cash settlement with variance, failed-delivery handling, no-show tracking.
- **P9d Hardening and reporting.** Public-API security review (rate limits, CAPTCHA, size caps, no secrets in logs), notifications, online reports, load test of the public site and of order bursts.

**P8 – Move to PostgreSQL (when the servers reach their real machines).** `drivers/postgres.ts`, `migrations/postgres/` for all migrations (plpgsql triggers, `pg_trgm` search, `pg_dump` backups), mechanical conversion of the modules not yet on the adapter, `db:move` tool, the whole test suite run on both engines (`DB_ENGINE`), a load test on PostgreSQL (row-lock behaviour of stock/counters/balances under real concurrency), then HQ first, branches only if/when they need it. Install PostgreSQL natively on the dev machine for this phase (CLAUDE.md says no Docker).

**P7 – Operations and cut-over.** Backups for HQ and branches (whichever engine each runs); branch provisioning script (extends `scripts/windows/install-service.ps1`); monitoring of sync lag; migrate today's till as branch #1 with its history uploaded to HQ; multi-branch load test; update `docs/10-cutover.md`; moving the dev-machine servers to real machines.

## Critical files (representative)
- `apps/api/src/db/open.ts`, `counters.ts`, `migrate.ts`, `migrations/` (new 0015+)
- `apps/api/src/modules/registers/service.ts`, `routes.ts`; `settings/context.ts` (`defaultWarehouseId`)
- `apps/api/src/modules/sales/service.ts` (`createSale`: branch pricing, ref series, outbox row), `returns`, `customers`, `inventory`
- `apps/api/src/auth/permissions.ts`, `plugin.ts`, `modules/users/routes.ts`
- `apps/api/src/modules/printing/driver.ts` (move to print agent), `catalog/products.ts:182` (sync pagination)
- `apps/web/src/lib/catalog.ts`, `outbox.ts`, `print.ts`, `api.ts`
- `scripts/dev.mjs`, `tests/load/run.ts`, `tests/integration/security.test.ts` (new routes must be guarded)
- New: `apps/central/`, `apps/storefront/` (customer PWA), driver PWA, `packages/shared` sync types and Zod schemas (rule 12: shared logic in one place)

## Risks and answers
- **Customer balance offline:** a branch may extend credit against a stale balance. No credit limit exists by owner decision, so this is a bookkeeping reconcile, not a block. Mitigation: show "as of last sync".
- **Closed register sessions are immutable;** a late-arriving sale cannot land in an already-synced closed session: facts carry their own session id and are never re-attributed.
- **Voids/deletes (rule 4 exception)** must be shipped as events too, so HQ reverses stock and balances exactly as the branch did.
- **Clock drift:** reports attribute by the branch's recorded timestamp plus its timezone; HQ stores both received and event time.
- **Cloud outage:** branches are unaffected. **Branch outage:** only that branch.
- **Oversell:** tills never block and stock is a synced snapshot, so an online order can meet empty shelves. Mitigated by reservations, the safety buffer, picker substitutions and the stale-branch cutoff; shortages are reported, not hidden.
- **Cash risk on delivery:** driver cash is tracked per run with a counted variance at settlement; late settlement is flagged.
- **Public attack surface:** the cloud site is the first internet-facing part. It runs separate from staff routes, exposes only a read model, and is security-reviewed in P9d before launch. Customer personal data (phone, address) is handled as private: never logged, never sent to outside services without the owner's say.
- **Stock leaves at settlement,** not at dispatch, so between dispatch and settlement a till may sell an item already in a bag. Accepted bookkeeping trade-off (negative stock is allowed, rule 17); the alternative of posting stock out at dispatch is a design-doc decision in P9b.
- **Portability drift:** SQLite is forgiving (loose types, silent coercions) and PostgreSQL is strict. Mitigated by the portable-SQL rules, the schema-parity test, strict column types in the new migrations, and running the suite on both engines from P8 (a PostgreSQL test run may be added earlier, if PostgreSQL is installed, to catch drift sooner).
- **SQLite at HQ is a stopgap:** it is one writer for ingest, reports and HQ users. Fine for 5–10 branches during development and early rollout; the plan to move HQ to PostgreSQL is P8, and the adapter keeps that move cheap.
- **Not an outside security test;** HQ is internet-facing, so it needs TLS, rate limits, branch credential rotation and the secret-in-logs rule (rules 11, 21) from day one.

- **Payroll correctness is legal-grade:** NSSF and tax rules change; they are dated data, not code, and the first run is **parallel-checked against the accountant's figures** before anyone is paid from it.
- **Time:** punches use server time of the branch plus its timezone/DST; the roster and attendance day boundary is per branch. A branch with a wrong clock is flagged by comparing received vs event time.
- **Late-arriving attendance** after a payroll period is locked becomes an adjustment in the next run, never a rewrite.
- **Self-service needs HQ reachable** and a separate employee account type with the least privileges.

## Verification
- P1: `npm run test:integration`, new multi-terminal load test (invariants from docs/09 hold with 20 simulated tills), Playwright with two contexts selling at once, security test lists new routes.
- P2–P4: a **three-process test** (HQ + two branches, temp files): sell offline on both, reconnect, assert HQ totals = Σ branch totals, no duplicates after replaying batches, out-of-order and dropped-connection cases.
- P2: automatic catch-up test: cut the HQ connection, sell at the branch, change prices at HQ, restore the connection with **no manual action**, and assert both sides converge within one probe interval; also kill the connection mid-batch and assert it resumes without duplicates.
- P3: edit price/override at HQ → appears at the branch till within one sync interval, and a sale uses the override.
- P5: transfer A→B conserves stock; payment at B reduces balance of an A-sale (oldest first) at HQ.
- P1: the existing suites pass unchanged through the adapter; a concurrency test fires many parallel sales/returns/payments through the async mutex and proves no interleaving (same invariants as `test:load`); lint guard fails on a new direct `better-sqlite3` import.
- P9: end-to-end Playwright: customer orders on the phone-size site, branch accepts and picks with a substitution, driver delivers and collects cash, branch settles; assert one sale exists with the order's locked prices, stock and register expected updated once, reservation released, and that a failed delivery creates no sale. Tests: an order cannot reserve more than available; a stale branch stops taking orders and recovers on reconnect; the `order` token is single-use and bound to one order; anonymous routes are exactly the intended public allow-list; replaying an order POST creates one order.
- P8: schema-parity test (SQLite vs PostgreSQL), full suite on both engines, `db:move` round-trip on a copy of real data with every invariant re-checked, load test on PostgreSQL.
- P6: payroll golden-case unit tests; invariant test over every generated payslip (`net = earnings − deductions`, lines sum, rules/rate snapshot present); locked run and issued payslip reject UPDATE/DELETE; payroll refuses while a branch is behind on sync; offline punch on a branch appears once at HQ after replays; RBAC/security tests for salary privacy; Playwright: clock in on a till, HR runs payroll, employee opens their payslip and prints it.
- P7: rehearsal (`npm run rehearse`) extended to branch+HQ; restore drill for both databases.
