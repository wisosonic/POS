# 02 · Decision Table

Two parts: **A** technology decisions (weighted matrix), **B** checkout business rules (condition → action table).
Weights: 1 (nice) → 5 (critical). Scores: 1 (poor) → 5 (excellent). Scores are judgment calls. Change them if your context differs.

## A. Technology decisions

### A1. Backend framework (weight in brackets)

| Criterion | Express 5 | **Fastify 5** | NestJS |
|---|:-:|:-:|:-:|
| Throughput / low overhead [3] | 3 | 5 | 3 |
| Built-in schema validation → OpenAPI [4] | 2 | 5 | 4 |
| TypeScript ergonomics [3] | 3 | 4 | 5 |
| Simplicity for a small team [4] | 5 | 4 | 2 |
| Ecosystem (auth, WS, SSE) [3] | 5 | 4 | 4 |
| **Weighted total** | 61 | **75** | 60 |

**Decision: Fastify + TypeScript + Zod schemas.** It is "Express or similar" per the brief, and it validates every request body.

### A2. Database

**Revised.** The first version of this table chose PostgreSQL, weighting "concurrent multi-terminal" at 5. The owner's decisions (1 till, server on the same PC, ~80 sales/day) cut that weight to 2 and raised the value of a simple install and backup, so the answer changed.

| Criterion (weight) | PostgreSQL 16 | SQL Server (current) | **SQLite** |
|---|:-:|:-:|:-:|
| ACID transactions for sale + stock + register [5] | 5 | 5 | 5 |
| Cost and install effort on one shop PC [4] | 3 | 2 (Express: 10 GB cap) | 5 |
| Node tooling [3] | 5 | 3 | 5 |
| Migration effort from the current dump [3] | 3 | 5 | 3 |
| Concurrent multi-terminal [2] (one till) | 5 | 5 | 2 |
| Backup and restore simplicity [3] | 3 | 3 | 5 |
| **Weighted total** | 80 | 76 | **88** |

**Decision: SQLite** (`better-sqlite3`, plain SQL migrations). The ETL in 01-data-analysis.md is needed with any choice, because the schema is being redesigned.

How SQLite is used safely:
- Only the API process writes. The file lives on the till PC's own disk, never a network share.
- `journal_mode=WAL` (reports never block the till), `synchronous=FULL` (a committed sale survives a power cut), `foreign_keys=ON`.
- Every sale runs in `BEGIN IMMEDIATE`, so writes are serialized and two sales cannot interleave their stock and balance updates.
- "Never edit history" is enforced by triggers, so the database refuses edits even if application code has a bug.

Trade-off accepted: a second till or cloud sync later means moving to PostgreSQL.

### A3. Architecture style

| Option | Verdict |
|---|---|
| **Modular monolith** (one deployable, module boundaries in code) | **Chosen.** ~80 sales/day does not justify distributed complexity. Consistency across modules is a hard requirement, so a single DB transaction covers sale + stock + register. |
| Microservices | Rejected. Cross-service consistency (sagas) adds risk and no benefit at this scale. |
| Serverless | Rejected. The printer is USB on the till PC. |

### A4. Other choices

| Concern | Decision | Why / alternative rejected |
|---|---|---|
| Front end | React 19 + Vite + TypeScript, TanStack Query, Zustand, Tailwind | Required React. Vite is faster than CRA, which the legacy app used. |
| Realtime | **Server-Sent Events** for dashboard pushes | One-way is all that's needed. Low priority: one till, so it mainly serves a manager's phone or second screen on the LAN. |
| Barcode input | **Keyboard-wedge (HID) scanners** via a global key-buffer, no driver | 99% of retail scanners. Camera scanning (BarcodeDetector/ZXing) as a phone fallback. |
| Receipt printing | **USB ESC/POS printer, English/ASCII only.** The API server runs on the till PC, so it sends raw ESC/POS bytes to the printer through the Windows print spooler (printer installed with its driver, shared as a local queue). Fallback: 80 mm browser print (`window.print`). | Decided with the owner (Q2): USB printer, no Arabic code page. Avoids WebUSB and a separate print agent. Non-ASCII characters print as `?`, so products get a `receipt_name` (English) used on receipts. |
| Offline | PWA + IndexedDB outbox, idempotent sale POST | With the server on the same PC the network is localhost, so this only covers the API process restarting or a brief DB outage. **Should-have, not must-have** (US-10). A service worker keeps a copy of the app (files named by content) and of viewed product pictures, so the app opens with the server down; it never answers `/api`, and signing in still needs the server. |
| Auth | Argon2id, JWT access (15 min) + rotating refresh cookie, PIN quick-switch per user | Fixes plaintext passwords. |
| Cache/queue | **None** | Not needed at this scale. |
| Hosting | **One Windows PC at the till** runs the API (as a Windows service) with its SQLite file and serves the web app on `localhost`. Nightly backup of the database file to an external drive plus an offsite copy | Decided with the owner (Q3): 1 till, server on the same PC. No database server to install. A UPS is strongly advised, because there is a single point of failure. |
| Payment methods | **Cash, Whish Money, OMT.** Recorded only, with **no third-party integration** (Q6). Each (method × currency) is a balance "bucket" tracked per register session | A `payment_methods` table keeps the list configurable. Wallet buckets are bookkeeping: opening balance set by the cashier at open, expected balance computed, counted balance entered at close. |
| Tax / VAT | **None calculated.** Selling prices are tax-inclusive (Q5) | No tax column, tax setting or receipt line. |
| Credit | Registered customers only. Balance per customer. See rules in part B | Q4. |
| Money | Integer minor units (USD cents, LBP whole), rate snapshot per sale | Floats caused the legacy `float` price columns. |
| Testing | Vitest (unit, database), Supertest + a throwaway SQLite file per test file (integration), Playwright (e2e) | See `tests/`. No Docker needed. |

## B. Checkout business-rule decision table

Conditions are evaluated top to bottom. **Y** = true, **N** = false, **–** = irrelevant.

| # | Register session open | Barcode matches product | Product active | Stock ≥ qty | Action |
|--:|:-:|:-:|:-:|:-:|---|
| 1 | N | – | – | – | Block selling. Prompt "Open register": the cashier enters opening balances for **cash, Whish and OMT in USD and LBP**. |
| 2 | Y | N | – | – | Error beep, toast "Unknown barcode", offer **Quick-add product** (manager) or manual search. |
| 3 | Y | Y (multiple) | – | – | Show a picker of the products sharing the code (barcode duplicates are cleaned up last, Q7). |
| 4 | Y | Y | N | – | Reject, "Product inactive". |
| 5 | Y | Y | Y | Y | Add line (qty +1 if already in cart). If this sale takes stock to or below the product's own threshold, show the same "Low stock" notice. |
| 6 | Y | Y | Y | N | Add the line anyway. **Stock never blocks a sale** (R2). Quantity may go to 0 or negative. If the product has a threshold and the sale takes it to or below it, show a non-blocking "Low stock" notice. |

**Stock is informational.** Its job is to tell the owner what to reorder: each product has its own `stock_alert` threshold (empty = no alert). Buying from suppliers never depends on the quantity on hand, including 0 or negative.

Product price is shown in the product's own currency. The cart converts every line to LBP at the current rate (Q1).

| # | Tendered vs total | Customer | Action |
|--:|---|---|---|
| 7 | = total | any | Complete, status `paid`. |
| 8 | > total | any | Complete, status `paid`. **Change is always given as cash**, in LBP by default (rounded to 5,000). Wallet (Whish/OMT) tenders may not exceed the total, because change cannot be paid out of a wallet. |
| 9 | < total, > 0 | **Walk-In** | Reject: "Select a registered customer". |
| 10 | < total, > 0 | registered | Complete as `partial`. `rest` is added to the customer's balance. |
| 11 | none (0) | **Walk-In** | Reject. |
| 12 | none (0) | registered | Complete as `unpaid` (pay later). Full amount added to the balance. |
| 13 | – | – | Mixed USD/LBP and mixed methods are allowed in one sale. Each tender converts at the **sale's rate snapshot** and is stored with its own method and currency. |
| 14 | – | registered | Customer later pays any amount by cash, Whish or OMT. It reduces the balance and is applied to their **oldest open sale first**. It cannot exceed the balance. |
| 15 | – | – | A completed sale is **one DB transaction**: sale, items, payments, stock movements, customer balance, register buckets. Any failure rolls everything back. |

| # | Event | Rule |
|--:|---|---|
| 16 | Duplicate POST (same `Idempotency-Key`) | Return the original sale, do not create a second one. |
| 17 | Discount > subtotal | Reject. |
| 18 | Discount above role limit (cashier 10% default) | Require a manager's approval: their name and password typed at the till (a PIN is cashier-only), single-use, for that cashier, up to the percent shown to the manager, valid ten minutes. Audited. Not available offline. |
| 19 | A cashier takes goods back, cancels a sale, or sells at another price | The same approval, with its own scope: a return (one sale, up to the value shown), a void (one sale, only while its register is open), a price (one product at exactly one unit price). A manager does any of them without asking. All audited with who approved. |
| 20 | A product shares its barcode with another | Allowed until the owner has cleaned them up; then the rule is switched on and the database refuses a second **active** product with the same barcode. Merging products never rewrites sale history. |
| 19 | Return of a completed sale | Manager role. Creates a `return` + positive stock movement + refund from a chosen bucket (or reduces the customer's balance if the sale was unpaid). Never edits the original sale. |
| 20 | Register close | For **each method × currency bucket** (cash, Whish, OMT × USD, LBP) show opening, expected and counted, and store the variance. The wallet balances at close can pre-fill the next opening. Admin sees variances. |
| 21 | Exchange rate changed | Affects new sales only. Old sales keep their snapshot. |
