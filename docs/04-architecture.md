# 04 · System Architecture

## 1. Context

One till, one PC. The server runs on the same Windows PC as the browser.

```
┌───────────────────────────── Till PC (Windows, behind a UPS) ─────────────────────────────┐
│                                                                                            │
│  USB scanner ──keys──▶  Browser (React PWA, http://localhost)                              │
│                            │  IndexedDB outbox + product cache                             │
│                            ▼  HTTP / SSE (localhost)                                       │
│                         Fastify API (Windows service) ──▶ SQLite file (local disk)         │
│                            │                              /uploads (images)                │
│                            ▼ raw ESC/POS via Windows print spooler                         │
│  USB receipt printer (English only) ◀─────────────────────                                 │
└────────────────────────────────────────────────────────────────────────────────────────────┘
 Optional: manager's phone on the shop Wi-Fi opens the same app (dashboard/reports only).
 Nightly: safe copy of the database file → encrypted → external drive + offsite copy.
 Cash, Whish Money and OMT are recorded only; there are no calls to any third-party service.
```

## 2. Principles

1. **Modular monolith.** One deployable, strict module boundaries. Modules talk through their public service interfaces, never through each other's tables.
2. **One transaction per sale.** Sale, items, payments, stock movements and register totals commit together or not at all.
3. **Server is the authority for money.** The client shows previews. The server recomputes totals from catalog prices and the rate, and rejects mismatches.
4. **Append-only history.** Sales, returns, stock movements and audit rows are never edited. Corrections are new rows.
5. **Durable at the till.** A sale accepted by the PWA is saved in IndexedDB before the request is sent, so an API restart cannot lose it.
6. **Shared domain code.** Money, pricing, barcode and receipt logic live in `packages/shared` and are used by both client and server.

## 3. Repository layout (monorepo, npm workspaces)

```
apps/
  api/                 Fastify + TypeScript
    src/modules/       auth, catalog, inventory, sales, registers, returns,
                       purchasing, customers, reports, printing, settings, audit
    src/db/            Drizzle schema, migrations, seeds
    src/etl/           legacy SQL Server dump → SQLite
  web/                 React + Vite PWA
    src/features/      checkout, products, purchasing, reports, register, admin
    src/lib/           api client, offline outbox, scanner, printer
    sw.template.js     service worker (vite.config.ts writes dist/sw.js from it, production only)
packages/
  shared/              money, pricing, barcode, receipt, zod schemas, types
tests/                 unit, integration, e2e, migration
docs/
```

## 4. Key flows

### 4.1 Checkout (happy path)

```
Scanner ─keys▶ ScanDetector ─code▶ catalog cache lookup ─▶ cart (Zustand)
Cashier presses PAY ─▶ client builds sale draft + Idempotency-Key (uuid)
   ├─ online : POST /api/v1/sales ─▶ server recomputes ─▶ TX{ sale, items, payments,
   │            stock_movements, register totals, audit } ─▶ 201 {sale, receipt}
   │            └▶ SSE "sale.completed" to dashboards / other tills' stock
   └─ API down: write to IndexedDB outbox, show "Pending N"
               background sync replays POSTs; 200/201 clear the outbox; 409/422 surface to the manager
Receipt: POST /api/v1/sales/{id}/print (server sends ASCII ESC/POS to the USB printer) or client window.print()
```

### 4.2 Consistency and concurrency

- Every write runs in a `BEGIN IMMEDIATE` transaction (`inWriteTransaction`). SQLite allows one writer at a time, so writes are serialized: no deadlocks and no lost stock updates. This is why the design needs no row locks.
- **Stock never blocks a sale** (R2). Quantity can go to 0 or negative. `stock_levels` and `stock_movements` are still updated in the same transaction so the ledger and the cache stay exact. After commit, any item at or below its own `stock_alert` is returned in the sale response (`lowStock`) and pushed as a `stock.low` event.
- Receipt numbers come from the `counters` table (`nextRef`), incremented inside the same transaction, so a rolled-back sale gives its number back and numbers are never duplicated. The ETL raises the counter above the highest imported reference.
- Idempotency: `idempotency_keys(key, request_hash, response, created_at)`. Same key + same body returns the stored response. Same key + different body returns 422.
- Isolation: a single writer plus WAL snapshots for readers. Nothing stronger is needed for this workload.

### 4.3 Real-time

SSE endpoint `/api/v1/events` streams `sale.completed`, `stock.changed`, `stock.low`, `register.updated`, `rate.changed`. Low priority with one till: it mainly keeps a manager's second screen current.
The PWA invalidates the matching TanStack Query keys. Heartbeat every 20 s, and `Last-Event-ID` resume.

## 5. Data model (SQLite)

The authoritative schema is `apps/api/src/db/migrations/0001_init.sql`. Conventions: money is an integer (`…_lbp` whole LBP, `…_minor` in the row's currency, USD = cents); quantities are integer **thousandths** (`…_milli`, so 0.350 kg is `350`); timestamps are ISO-8601 UTC text; enums are `CHECK` constraints. The sketch below is the logical model; column names in the migration win.

```
users(id, name, role, password_hash, pin_hash, active, must_reset_password)
store_settings(id, name, address, phone, email, logo_path, lbp_rounding, receipt_footer, printer_name)
payment_methods(code PK, name, active)                       -- cash, whish, omt   (no integration)
exchange_rates(id, rate_lbp_per_usd, effective_from, created_by)
warehouses(id, name, ...)    categories(id,name)   brands(id,name)   units(id,name,fractional)   suppliers(...)
products(id, name, receipt_name, receipt_name_manual bool, barcode (indexed, NOT unique until US-34), cost_minor, price_minor,
         currency ENUM(USD,LBP),                                -- per-product currency (Q1)
         category_id, brand_id, unit_id, supplier_id, stock_alert_milli NULL, expiry_date, image_path, active, legacy_id)
stock_levels(product_id, warehouse_id, qty_milli)        -- cache of the ledger. May be 0 or negative. Informational, never blocks
stock_movements(id, product_id, warehouse_id, qty_delta, reason ENUM(sale,return,purchase,adjustment,transfer),
                ref_type, ref_id, user_id, created_at)           -- append-only
customers(id, name, phone, address, email, balance_lbp, is_walk_in)   -- balance = what they owe; Walk-In always 0
register_sessions(id, terminal_id, opened_by, opened_at, closed_by, closed_at, status ENUM(open,closed))
register_balances(session_id, method, currency, opening, expected, counted, variance)   -- 6 rows: cash/whish/omt × USD/LBP
register_movements(id, session_id, type ENUM(in,out,transfer), from_method, from_currency, to_method, to_currency, amount, reason, user_id)
sales(id, ref BIGINT UNIQUE, session_id, user_id, customer_id, warehouse_id, rate_lbp_per_usd,
      subtotal_lbp, discount_lbp, shipping_lbp, rounding_lbp, total_lbp, paid_lbp, rest_lbp,
      profit_lbp, status ENUM(paid,partial,unpaid,void), notes, created_at, idempotency_key UNIQUE, legacy_id)
      -- no tax column: prices are tax-inclusive (Q5)
sale_items(id, sale_id FK, product_id FK NULL, name_snap, barcode_snap, brand_snap, unit_snap,
           qty, unit_price_lbp, unit_cost_lbp, line_total_lbp)
payments(id, sale_id FK NULL, customer_payment_id FK NULL, method FK payment_methods, currency, amount, rate_snap)
customer_payments(id, customer_id, session_id, user_id, amount_lbp, created_at, idempotency_key)  -- debt settlement
payment_allocations(customer_payment_id, sale_id, amount_lbp)    -- oldest open sale first
returns(id, sale_id FK, ref, user_id, reason, refund_lbp, refund_method, refund_currency, created_at)
return_items(id, return_id, sale_item_id, qty, amount_lbp)
holds(id, user_id, customer_id, created_at)    hold_items(id, hold_id, product_id, qty, price_lbp)
purchases(id, ref, supplier_id, warehouse_id, status ENUM(draft,ordered,received), total_minor, paid_minor, currency, ...)
purchase_items(id, purchase_id, product_id, qty, cost_minor)
expenses(id, category_id, title, amount_minor, currency, session_id, created_at)   service_sales(...)
audit_log(id, user_id, action, entity, entity_id, before_json, after_json, created_at)
idempotency_keys(key PK, request_hash, response_json, created_at)
```

Indexes: `products(barcode)` (non-unique at first), an FTS5 trigram index over name, receipt name and barcode (Latin and Arabic substring search), `sales(created_at)`, `sales(session_id)`,
`sales(customer_id) WHERE rest_lbp > 0`, `sale_items(sale_id)`, `sale_items(product_id)`, `stock_movements(product_id, created_at)`, `customers(phone)`.
No partitioning is needed at ~30k sales/year.

**Money convention.** `*_lbp` columns are integer LBP. USD amounts are integer cents. Each product carries its own `currency`.
The cart converts every line to LBP at the current rate, and the sale stores the LBP totals plus the `rate` snapshot.
Each payment stores its own method and currency, so the register buckets reconcile exactly.

**Customer balance invariant.** `customers.balance_lbp = Σ sales.rest_lbp` over that customer's open sales, maintained in the same transaction as every sale and every customer payment. An integration test asserts it.

**Register buckets.** `expected = opening + payments in (sales + customer payments) − change given (cash only) − refunds ± movements`. Updated in the transaction that causes each change, and re-derivable from the rows for audit.

## 6. Security

| Area | Control |
|---|---|
| Auth | Argon2id, short-lived JWT + rotating httpOnly refresh cookie, lockout (5 fails/15 min), PIN quick-switch for cashiers |
| AuthZ | RBAC permission matrix enforced server-side per route (`docs/06-api-spec.md`) |
| Input | Zod validation on every body/query/param. Parameterized SQL only |
| Transport | API binds to `localhost` only by default, so no network exposure. If a manager phone is enabled, bind to the LAN with TLS (local CA or Caddy) and a CORS allow-list |
| Abuse | Rate limiting on `/auth/*` and write endpoints |
| Data | Passwords never logged. Nightly safe copy of the database file (SQLite online backup, never a plain file copy while the API runs) → age/gpg encrypted → external drive + offsite. Quarterly restore drill |
| Audit | Append-only `audit_log` for sensitive actions |
| Secrets | `.env` outside the repo, never committed |
| Printer | Server-side print endpoint is authenticated. Only the till PC talks to the USB printer |

## 7. Performance targets

| Metric | Target |
|---|---|
| Barcode scan → line shown | < 200 ms (local cache), < 500 ms cold |
| Pay → receipt printed | < 2 s p95 |
| `POST /sales` | < 150 ms p95 at 10 req/s (far above one till's realistic peak) |
| Catalog load | Full ~2k-product catalog cached in the browser, refreshed by `updated_at` delta |
| Dashboard refresh | < 2 s after a sale |

Design headroom: indexed lookups, a local catalog cache, single-statement stock updates, and no N+1 queries. Verified by `npm run test:load` (`tests/load/`), with the results in `docs/09-load-test.md`.

## 8. Deployment & operations

- **Production (till PC):** Windows PC with the Node API as a Windows service owning the SQLite file (auto-start, auto-restart), static web files served by the API. The browser opens `http://localhost:3000` in kiosk mode. The printer is installed with its Windows driver and shared as a local queue.
- **Dev/CI:** nothing to install beyond Node. Tests create a throwaway SQLite file per test file.
- Single point of failure: use a UPS, keep the nightly backup on an external drive **and** offsite, and rehearse a restore onto a second PC.
- Health: `/healthz` (liveness), `/readyz` (DB). Structured JSON logs (pino) to a rotating file.
- Cut-over: freeze the legacy app, take a fresh dump, run ETL, reconcile, switch over, keep the legacy DB read-only for 30 days.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Single PC failure (disk, power) | UPS, nightly backups to two places, documented restore, spare PC |
| Legacy stock numbers are wrong for many products (about 1/3 show 0 yet sell) | Stock never blocks selling, so wrong counts cannot stop the till. Opening stock is imported as-is. The alert list will be noisy at first. The owner sets thresholds per product and optionally runs a stocktake later |
| Dirty barcodes / duplicates | Imported as-is. The picker handles duplicates. Clean-up is the final milestone, then the unique index |
| ASCII-only receipts | `receipt_name` is transliterated automatically and editable. A report lists products with an auto-generated name for review |
| Wallet balances are manual bookkeeping | Counted vs expected variance at every close. No external truth to reconcile against |
| Staff retraining | Keep the layout close to the legacy till. Parallel run for 1-2 weeks |
| Power loss mid-sale | DB transaction atomicity + IndexedDB outbox |
