# 11 · Multi-branch, HR and online marketplace

Status: **design, approved 2026-11-23. Nothing here is built yet.** The rest of `docs/` and `CLAUDE.md` still describe the one-till system that exists today; they change phase by phase as each part ships (rule 16 and the "one till" statements are replaced in P1).

## 1. Goal

Grow from one till on one PC to a chain: 8,000+ products, 5-10 branches (about 50 tills), several cashiers selling at once in each branch, many employees (with shifts, attendance, payroll and payslips), and an online shop where customers order and **pay on delivery**.

## 2. Decisions from the owner

| Topic | Decision |
|---|---|
| Topology | **Hybrid:** one server per branch (sells fully offline) + one cloud HQ server. Both run on the dev machine first (different ports and data folders), moved to real machines later. |
| Sync | Automatic, both directions, **the moment the connection is restored**; resumes where it stopped. |
| Catalog | Central. Per-branch stock and price overrides. Transfers between branches. |
| Customer credit | One shared balance across branches. |
| Database | **SQLite everywhere for now**, built portable so any server (HQ or branch) can move to PostgreSQL later. |
| HR | Accounts, roles, branch assignment, **shifts, attendance (PIN on a till or kiosk page), payroll (monthly, daily, hourly), payslips (employee self-service + HR print)**. NSSF and tax are configurable dated rules. |
| Marketplace | Responsive website (PWA, English + Arabic) first. Cash on delivery, recorded only. Nearest branch by delivery zone. Online shows only what the branch has and reserves stock. Own drivers, tracked. |

## 3. Architecture

```
 HQ staff ──▶  Cloud HQ (apps/central)  ◀── Customer phone (storefront PWA) / Driver phone (driver PWA)
               catalog, prices, users, rates, transfers, reports,
               online orders, HR and payroll, change feed, customer balance authority
                  ▲ pull changes (HTTPS, branch-initiated)      ▲ push facts (batched, idempotent)
        ┌─────────┴────────────┐                     ┌──────────┴───────────┐
        │ Branch A server      │                     │ Branch B server      │  ... up to 10
        │ apps/api + SQLite    │                     └──────────────────────┘
        │ + sync agent         │
        └──▲────▲────▲─────────┘
   LAN/SSE │    │    │
        Till 1  Till 2 Till N  (browser PWA + print agent for the USB receipt printer)
```

- Sync is **branch-initiated** (no inbound port at a shop).
- Tills talk only to their branch server over the LAN and never need the internet.
- The same `apps/api` runs as a branch server (`MODE=branch`). `apps/central` is the HQ.
- The public online shop runs **only on the cloud side**.

### 3.1 Who owns which data (no two writers for the same thing)

| Owner | Data | Direction |
|---|---|---|
| HQ | products, categories, brands, units, suppliers, base prices, branch price overrides, exchange rates, payment methods, users/roles/branch assignment, settings, barcode uniqueness, employees, rosters, pay data | HQ → branch (change feed). Salary data is **never** sent to a branch. |
| Branch | sales, items, payments, returns, register sessions and balances, cash movements, expenses, stock movements, stocktakes, purchases received, audit, attendance punches | branch → HQ (append-only facts) |
| Branch, read by HQ | stock levels (derived from the branch's movements) | branch → HQ |
| Online orders | placed and routed at HQ; after a branch accepts, the branch owns fulfilment | both, one writer per state |
| Two-party | stock transfers (ship at A, receive at B) | via HQ |
| HQ authority | shared customer balance; a payment at any branch is allocated oldest-sale-first at HQ | both |

Facts are **never edited by sync**, only inserted once (dedupe key). Rule 4 (append-only), 2 (server decides totals), 3 (one transaction per sale), 6 (idempotency) and 9 (rate snapshot) stay.

### 3.2 Identity and numbering
- Branch facts keep local integer ids. HQ keys them by `(branch_id, local_id)` plus `client_sale_id` (a UUID) as the dedupe key.
- HQ-owned entities get HQ ids; branches store those ids as their own.
- Receipt `ref` is per branch (unique `(branch_id, ref)`, printed like `B2-004711`). Counters are scoped by branch.

### 3.3 Sync protocol
- **Down:** HQ writes append to `change_log(seq, entity, entity_id, op, payload, version)`. The branch calls `GET /sync/changes?cursor=&limit=500`, applies a page in one transaction, stores the cursor. Paginated and resumable.
- **Up:** the branch writes a `sync_outbox` row **in the same transaction** as the fact. The agent sends batches (≤ 200) to `POST /sync/facts`; HQ inserts idempotently and acknowledges the highest contiguous seq.
- **Reconnect:** while offline the agent probes `GET /sync/ping` (every few seconds, backing off to ~30 s). The first success starts a full catch-up: push the backlog oldest first, then pull everything since the cursor. Sync uses its own short transactions and never blocks a sale.
- **Enrolment:** a one-time code from HQ is exchanged for a revocable branch credential (stored hashed). HQ refuses facts for another branch.
- **Health:** each branch reports lag and last sync; HQ flags a silent branch.
- A branch holds replicated users, so cashiers sign in offline; manager approvals stay local (rule 20).

### 3.4 Several cashiers in one branch
- `terminals` table; a terminal's identity comes from enrolment, not from a client-sent `'T1'`.
- One open register session per terminal (the index exists already). Remove the "one till" logic in `registers/service.ts` and `registers/routes.ts`.
- `defaultWarehouseId()` becomes "the terminal's branch warehouse".
- SSE pushes price, stock, rate and low-stock changes to every till.
- **Printing:** each till PC runs a small **print agent** (localhost, ESC/POS to the spooler and drawer). The reprint/DUPLICATE/drawer rules stay on the server (rule 7 and the pitfall list).
- Heavy reports run on a read-only connection or worker, so they never delay sales.

## 4. Database portability

Goal: changing a server's engine is `DB_ENGINE=sqlite|postgres` plus a one-time copy, with no change to business code.

1. One **async `Db` adapter** (`one`, `all`, `run`, `tx`); drivers `sqlite` (now) and `postgres` (P8). Only driver folders may import a database library (ESLint rule with a shrinking allow-list).
2. **Transactions:** the SQLite driver runs `tx()` one at a time behind an async mutex (same guarantee as `BEGIN IMMEDIATE`). This replaces "no `await` inside a money transaction" once the adapter is in. Code that must not race uses unique constraints with handled conflicts, atomic `UPDATE x = x + ?`, `ON CONFLICT`, and `RETURNING`, so it is also correct on PostgreSQL.
3. **Portable SQL subset:** `RETURNING` (not `lastInsertRowid`), `ON CONFLICT` (not `INSERT OR`), timestamps written by the application as ISO-8601 UTC text (no `strftime`/`now()` defaults), integers for money, quantities and minutes, 0/1 booleans, lower-cased usernames (no `COLLATE NOCASE`), no `WITHOUT ROWID`.
4. **Behind interfaces with two implementations:** product search (FTS5 / `pg_trgm`), backup and restore, append-only triggers.
5. **Migrations per dialect** (`migrations/sqlite`, `migrations/postgres`), with a schema-parity test.
6. **Move tool** `db:move` copies with ids preserved, resets sequences, runs the invariant checks on the target, and refuses to switch if any differ. Works for HQ and for a branch.

## 5. HR

Salary data lives **only at HQ**. Branches get name, code, attendance credential hash and the day's roster, and send up punches.

- **Employee ≠ user.** `employees` (code, name, branches, hire/end, pay profile, optional `user_id`).
- **Rosters and leave** are HQ-owned and edited at HQ (no offline roster edits).
- **Attendance punches** are append-only branch facts. A mistake is fixed by an adjustment row with a reason and an approver.
- **Attendance PIN** can only punch in/out; separate from the till PIN, rate-limited, locked out like a login. A punch outside the roster window is flagged, not blocked.
- **Time is integer minutes, rates are integers, multipliers are basis points.** Pay calculation is a pure function in `packages/shared/src/payroll.ts`.
- **Pay profiles** (monthly, daily, hourly; LBP or USD; overtime multiplier) and **payroll rules** (NSSF, tax brackets, rounding) are **dated settings**, never hard-coded.
- **Payroll run:** draft → calculated → approved → paid → **locked** (triggers make it immutable). It refuses to calculate while a branch's attendance has not synced up to the period end. Each payslip stores the rule versions and the exchange rate it used. Invariant: `net = Σ earnings − Σ deductions`.
- **Privacy:** new roles `hr_manager` and `payroll`; a branch manager sees attendance and roster, **never salaries**; an employee sees only their own payslips. Every payslip view and run change is audited; amounts never go into log lines (rule 21). A payslip is an HTML page that the browser prints or saves as PDF (Arabic renders).

## 6. Online marketplace

- **Order lifecycle** (append-only `order_events`): placed → accepted → picking → ready → out for delivery → delivered | failed | cancelled. A customer may cancel only before picking.
- **An order is not a sale.** At delivery settlement the branch records the real sale through `createSale` (server totals, one transaction, idempotent, cash, current register session), tagged `channel='online'` with the order id. A failed or cancelled delivery creates **no sale**. Online cash on delivery is never credit, so rule 15's invariant is untouched.
- **Prices are locked at order time** and honoured at settlement through a new single-use approval scope **`order`** (one order, its total, consumed inside the transaction).
- **Delivery fee** is a no-stock catalog item.
- **Driver cash:** a delivery run groups orders for one driver; the branch counts the cash at settlement and a variance is recorded.
- **Availability:** `on_hand − reserved − safety_buffer`; items at 0 or below are not orderable online. Placing an order reserves stock at the routed branch; reservations are released on cancel/fail and consumed by the settlement sale. A branch silent for longer than a threshold stops taking new orders. Tills still never block (rule 17).
- **Zones:** HQ-owned delivery zones (named areas first): branch, fee, minimum order, hours, orders per slot.
- **Public door:** catalog browse, zone check, sign-up/login, place order, order status. These are open routes **by design**; rule 19's allow-list grows on purpose, with a separate rate limit, size caps and abuse checks. They read a published catalog read model (no costs or suppliers). Order placement is idempotent.
- **COD abuse:** a no-show counter, optional limits after failed deliveries, a minimum order per zone.
- **Drivers** use a phone PWA against HQ (they are outside the shop LAN); HQ relays to the branch by sync.

## 7. Phases

| Phase | Content |
|---|---|
| P0 | This document, `CLAUDE.md` rule changes, open questions |
| P1 | Portability foundation, then multi-terminal branch server (SQLite, no cloud) |
| P2 | Sync foundation, `apps/central`, automatic reconnect |
| P3 | HQ-owned data down: catalog, price overrides, users, rates |
| P4 | Branch facts up, consolidated HQ reports, reconciliation |
| P5 | Shared customers, transfers, central purchasing |
| P6 | HR: attendance, payroll engine, payslips and self-service |
| P9 | Online marketplace: storefront, branch fulfilment, delivery, hardening |
| P8 | Move to PostgreSQL |
| P7 | Operations and cut-over (branch #1 = today's till) |

Details, files and tests per phase are in the approved plan (`plan.md` will get a matching section when P1 starts).

## 8. The five deployable projects (decided 2026-11-24)

One repository, five things that are installed or hosted separately. They share `packages/shared` (money, pricing, receipts) and `packages/core` (database, sync), so the rules cannot drift.

| # | Project | Runs on | Has | Talks to |
|---|---|---|---|---|
| 1 | **Till** (`apps/till` screens, `apps/till-agent`) | each till PC | The cashier's screens. A **thin local agent**: printer, cash drawer, scale, and a queue of sales waiting for the branch server. | Branch server only, over the local network (plain HTTP) |
| 2 | **Branch server** (`apps/api` becoming `apps/branch`, plus `apps/branch-web`) | a server in the branch's server room | The one authority for the branch: totals, registers, approvals, stock, customers' balances here. Manager screens and monitoring. | The tills (LAN) and HQ (HTTPS, branch-initiated) |
| 3 | **Cloud HQ** (`apps/central`, plus `apps/hq-web`) | cloud | Collects every branch's data, owns the catalog, prices, users, rates; monitoring of all branches; hands online orders to the right branch. | The branch servers and the marketplace server |
| 4 | **Marketplace** (`apps/shop-api`, `apps/storefront`) | cloud, separate from HQ | The public site and its API: browse a published catalog, sign up, order. Nothing else of HQ is reachable from the internet. | HQ only, over a narrow API |
| 5 | **Mobile app** (`apps/mobile`) | customers' phones | The same ordering as the storefront. | The marketplace API (a driver app can follow the same way) |

**The till does not decide a sale.** Totals, approvals, the register, credit and idempotency stay in the branch server (rules 2, 3, 6, 20). The till's agent only queues a sale it could not deliver and sends it when the branch server answers: until the branch server accepts it, a queued sale is not in the system (as the browser outbox already works). While the branch server is unreachable a till sells from the prices it last downloaded; credit sales and manager approvals wait for the server. A full sales engine with its own database on every till was rejected: two sources of truth and conflicts to merge, for little gain.

**Mapping from today's code:** `apps/web` is split by role into the till screens and the branch manager screens (the till build stays small and offline-first); the print agent grows into the till agent; `apps/api` and `apps/central` keep their names until the rename is worth its churn. The marketplace is its own server instead of public routes inside HQ (this replaces the P9a placement in the plan), so the only internet-facing part is isolated from HQ's data.

**Order of work:** the split is a re-organisation, done in steps after P2c/P2d so that sync keeps moving: first the till agent role (queue and devices), then splitting the web app by role, then the marketplace server when P9 starts.

### 8.1 Each project runs alone, on its own machine (requirement, 2026-11-24)

At the end, every project can be put on a separate machine and run there, with nothing but its own settings pointing at the next one:

| Project | Needs to run | Its one setting about the others | Where that setting is edited |
|---|---|---|---|
| Till | its own folder, Node | the **branch server address** (IP or name, port) | the till's **Settings** page |
| Branch server | its own folder, Node, its database | the **HQ address** (a URL) and the one-time code | the branch dashboard's **Settings > HQ** page |
| Cloud HQ | its own folder, Node, its database | none (branches connect to it) | its own admin screens |
| Marketplace | its own folder, Node | the HQ address | its configuration (no screen for customers) |

Rules that keep this true: (1) a project's code imports only from `packages/*`, never from another app (a lint rule enforces it); (2) every project starts with one command in its own folder and needs only its own settings (environment variables or its settings page), with a documented default; (3) a project that cannot reach the next one keeps working as far as it can (the till queues, the branch sells, HQ simply waits) and says so on screen; (4) one "run alone" test per project starts it in an empty folder, with nothing else running, and proves it answers.

**How the till reaches the branch server (decided with this requirement).** The till PC runs the **till agent**, which is a small local server: it serves the till's screens from the till PC itself, passes the screens' calls on to the branch server at the address in its settings (including the live-updates stream), holds the queue of sales that could not be delivered, and drives the printer and drawer. The browser only ever talks to the agent on its own PC, so it stays on one address: the sign-in cookie, the till's device token header and the Content-Security-Policy (`connect-src 'self'`, rule 22) are unchanged, and no cross-origin permission is needed on the branch server. A side benefit: the till screens still load when the branch server is down, and the queue keeps working. The cost: the agent must be running on the till PC (it already has to be, for the printer). The address is kept in the agent's own settings file; the till's Settings page reads and changes it through the agent and has a "Test connection" button.

**Order of the split, revised:** step 2 the till agent becomes that local server (serves the till build, passes calls through to the configured branch server, holds the queue, Settings page for the branch server address); step 3 the web app is split in two builds, the till screens and the branch dashboard, from shared components; the branch dashboard gets the Settings > HQ page (connect, status, disconnect: the API exists); step 4 the independence rules above (lint rule, per-project start command and settings, run-alone tests, one deployment page per machine in `docs/07-operations.md`); step 5 rename `apps/api` to `apps/branch`.

### 8.2 The repository has five project folders (decided 2026-11-24)

```
POS/
  till/            the till: its screens, its local agent (printer, drawer, queue, passes calls to the branch server), tests, docs
  branch-server/   the branch's server (today apps/api) and the branch dashboard (manager screens), tests, docs; data/ and backups/ at run time (not in git)
  cloud-hq/        the HQ server (today apps/central) and its monitoring screens, tests, docs
  marketplace/     the shop server and the storefront, tests, docs
  mobile-app/      the customers' app, tests, docs
  docs/            the design of the whole system (these documents)
  scripts/         install and development scripts for the whole system
  PLAN-MULTI-BRANCH.md, CLAUDE.md, QUESTIONS.md
```

There is **no shared library folder**: each project is complete in itself (its own `package.json`, its own `node_modules`, its own tests) and can be copied to another machine on its own. Code that more than one project needs (money, pricing and receipt rules; the sync contract; the database layer) is **copied into each project that needs it**, from one master copy, and a check keeps the copies identical:

- The master copy of each shared module lives in the project that is its authority: money, pricing and receipts and the database layer in `branch-server/`; the sync contract in `branch-server/` too (HQ copies it). `scripts/sync-shared.mjs` copies a master into the projects that use it, into a folder named `shared/` marked "generated: do not edit here".
- A test in every project, and one in CI, fails if a copy differs from its master. This keeps rule 12 (client and server cannot drift) true without a shared folder. Editing a copy by hand is the one thing that is not allowed.
- A change to a shared module is made in the master, copied by the script, and every project's tests are run.

**Tests that need several projects at once** (HQ and two branches, the till through to the branch server) cannot import one project from another any more. They start each project as a real process with its own start command and its own empty data folder, and talk to it over HTTP, which is also exactly the "run alone" proof. They live in `cloud-hq/tests/system/` (HQ is the hub) and are slower than today's in-process ones.

**How it gets there (revised order, replaces §8.1's last paragraph):** (a) restructure: move today's `apps/*` and `packages/*` into the five folders, put each project's tests and docs inside it, generate the shared copies, fix every path and script, all suites green; (b) the till agent becomes the local server with the branch-server Settings page; (c) the web app is split into the till build and the branch dashboard, with Settings > HQ; (d) the independence checks (lint rule, run-alone tests, process-based system tests, one deployment page per machine); then P3.

## 9. Risks

- **Customer balance offline:** a branch may extend credit against a stale balance (no credit limit by decision); it reconciles on sync and shows "as of last sync".
- **Late sales into closed sessions:** facts keep their own session id and are never re-attributed.
- **Voids and deletes** (rule 4 exception) are shipped as events so HQ reverses stock and balances the same way.
- **Clock drift:** HQ stores both received time and event time.
- **Oversell online:** reservations, a safety buffer, substitutions and a stale-branch cutoff; shortages are reported.
- **Stock leaves at settlement, not dispatch** (open question 10).
- **Public attack surface:** the cloud site is the first internet-facing part; it gets a security review before launch.
- **Payroll is legal-grade:** the first run is checked against the accountant's figures before anyone is paid from it.
- **SQLite at HQ is a stopgap:** one writer for ingest, reports and HQ users. Fine for 5-10 branches early on; the adapter keeps the move to PostgreSQL cheap.
- **Portability drift:** SQLite is forgiving and PostgreSQL is strict. Mitigated by the portable-SQL rules and the schema-parity test.
