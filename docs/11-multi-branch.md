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

## 8. Risks

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
