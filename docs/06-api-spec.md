# 06 · API Specification

Base URL `/api/v1` · JSON · UTF-8 · Zod schemas in `packages/shared` are the source of truth. OpenAPI is generated from them at build time
(`npm run api:openapi` → `apps/api/openapi.json`). This document defines the contract.

## Conventions

| Topic | Rule |
|---|---|
| Auth | `Authorization: Bearer <access JWT>`. Refresh via httpOnly cookie. |
| Roles | `cashier` < `manager` < `admin`. Matrix below. |
| Money | Integers. LBP in whole LBP, USD in cents. Fields end in `Lbp`, with an explicit `currency` where mixed. Products carry their own currency. **No tax fields exist: prices are tax-inclusive.** |
| Quantities | Decimal strings or numbers with ≤ 3 decimals. |
| Dates | ISO-8601 UTC (`2026-10-19T10:42:00Z`). |
| Idempotency | `Idempotency-Key: <uuid>` **required** on `POST /sales`, `/returns`, `/customers/{id}/payments`, `/purchases/{id}/receive`. |
| Pagination | `?limit=50&cursor=…` → `{ data: [], nextCursor }`. Max limit 200. |
| Errors | RFC 7807 as `application/problem+json`: `{ type, title, status, detail, code, errors? }`. Codes: `VALIDATION`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `LOCKED` (423, with `Retry-After`), `RATE_LIMITED`, `CONFLICT`, `INVALID_REFERENCE` (422), `USERNAME_TAKEN`, `CANNOT_DEMOTE_SELF`, `PIN_CASHIER_ONLY` (422, a PIN can only be set on a cashier), `HOST_NOT_ALLOWED` and `ORIGIN_NOT_ALLOWED` (403), `DUPLICATE_NAME` (409, lists), `BACKUP_NOT_CONFIGURED` (409) and `BACKUP_FAILED` (500), `PRINTER_NOT_CONFIGURED` and the printer's own codes (503); register: `NO_OPEN_REGISTER`, `REGISTER_CLOSED`, `REGISTER_ALREADY_OPEN`, `REGISTER_ALREADY_CLOSED`, `SAME_BUCKET`, `CURRENCY_MISMATCH`; sales: `PRICE_MISMATCH`, `DISCOUNT_OVER_LIMIT`, `DISCOUNT_EXCEEDS_SUBTOTAL`, `CREDIT_REQUIRES_CUSTOMER`, `WALLET_EXCEEDS_TOTAL`, `FRACTIONAL_NOT_ALLOWED`, `PRODUCT_INACTIVE`, `VOID_NEEDS_APPROVAL` (403), `SALE_NOT_VOIDABLE`, `SALE_ALREADY_VOID`, `SALE_HAS_RETURNS`, `SALE_HAS_ACCOUNT_PAYMENTS`, `STOCKTAKE_NOT_OPEN`, `PASSWORD_RESET_REQUIRED` (403), `DUPLICATES_REMAIN` (409), `NOT_DUPLICATES`, `IMPORT_INVALID_FILE` (422, product import), `PAYMENT_METHOD_DISABLED`; returns: `RETURN_NEEDS_APPROVAL` (403), `RETURN_EXCEEDS_SOLD`, `REFUND_REQUIRED`, `REFUND_MISMATCH`, `REFUND_NOT_ALLOWED`; purchases: `RECEIVE_EXCEEDS_ORDERED`, `PURCHASE_RECEIVED`, `PURCHASE_PARTLY_RECEIVED`, `PURCHASE_NOT_DRAFT`, `PURCHASE_NOT_ORDERED`, `PAYMENT_EXCEEDS_TOTAL`; holds: `TOO_MANY_HOLDS`; accounts: `PAYMENT_EXCEEDS_BALANCE`, `WALK_IN_NO_ACCOUNT`, `WALK_IN_PROTECTED`; `IDEMPOTENCY_CONFLICT`; `DUPLICATE_BARCODE` (only once US-34 clean-up is done). Database errors are translated, and SQL or table names never reach the client. |
| Versioning | URL prefix. Breaking changes → `/v2`. |
| Rate limits | `/auth/*` 10/min/IP, writes 120/min/user. 429 with `Retry-After`. |

## Endpoints

### Auth
Access token: JWT, 15 minutes, carries only the user id. The role and active flag are read from the database on every request, so deactivating a user or changing a role takes effect immediately. Refresh token: random, stored hashed, httpOnly + SameSite=Strict cookie scoped to `/api/v1/auth`, valid 7 days, **rotated on every use**. Presenting an already-used refresh token revokes all of that user's sessions (theft detection).

| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/auth/login` | public | `{ username, password }` (username is case-insensitive) → `{ accessToken, expiresIn, user }` + refresh cookie. Wrong username and wrong password give the same 401. After **5 failures in 15 minutes** the account is locked: `423 LOCKED` with `Retry-After`. Attempts made while locked are not counted. |
| POST | `/auth/pin` | public (till) | `{ userId, pin }` (4 to 8 digits) quick cashier switch. **Cashiers only**: for a manager or admin it is the same `401` as a wrong PIN, even if an old account still has one stored. Same lockout, tracked per user and separately from the password. |
| POST | `/auth/approve` | any (signed in) | A manager types their name and password at the cashier's till to allow something a cashier may not do alone. Four scopes: `{ username, password, scope: "discount", pct }` (a discount above the cashier's limit; `pct` is the discount, as a percent of the sale, that the manager is being shown) and `{ username, password, scope: "return", saleId, maxLbp }` (taking goods back from that sale; `maxLbp`, a positive integer, is the value the manager is being shown; `404` for an unknown sale), `{ username, password, scope: "void", saleId }` (cancelling that sale) and `{ username, password, scope: "price", productId, priceLbp }` (selling that product at exactly that unit price in whole LBP; `404` for an unknown product). Answers `{ approvalToken, expiresAt, approvedBy: { id, name }, ...the scope and limits granted }`. The token works **once**, for **that cashier only**, for a discount **up to `pct`** or a return **of that sale up to `maxLbp`** (never more), for **10 minutes**, and only for its own scope; only its hash is stored. Not a PIN: a short secret must not carry a manager's authority. Wrong name, wrong password, an inactive account and a non-manager all give the same `401`. Five failures lock approvals for that name for 15 minutes, counted apart from signing in (`423 LOCKED`), so a cashier cannot lock a manager out of signing in. Audited as `approval.grant` |
| POST | `/auth/refresh` | cookie | Rotate the refresh token and return a new access token |
| POST | `/auth/logout` | any | Revoke the refresh token and clear the cookie. `204` |
| POST | `/auth/change-password` | any | `{ currentPassword, newPassword (min 8) }`. Ends all other sessions, clears `mustResetPassword`, returns a fresh session. Audited without the password. |
| GET | `/me` | any | `{ user, capabilities }` |

Per-IP rate limit on `/auth/login`, `/auth/pin` and `/auth/refresh`: 10 per minute, enabled in production.

**The only routes that answer without a sign-in** are `GET /healthz`, `GET /readyz`, `POST /auth/login`, `/auth/pin`, `/auth/refresh` and `/auth/logout`. A test lists every registered route and fails if any other one answers an anonymous request.

**Address and origin checks.** The server answers only to `localhost`, `127.0.0.1` and `[::1]` (and names in the `ALLOWED_HOSTS` setting): another `Host` is `403 HOST_NOT_ALLOWED`, which blocks DNS rebinding. A request with an `Origin` from any other site, or one that cannot be read (`null`), is `403 ORIGIN_NOT_ALLOWED`. No CORS headers are sent, so no other site can read an answer.

**Headers on every answer:** `Content-Security-Policy` (`default-src 'self'; script-src 'self'` plus inline styles only; no framing, no plugins), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy: same-origin`. API answers are `Cache-Control: no-store`. See `docs/08-security-review.md`.

### Catalog
| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/products?q=&categoryId=&brandId=&active=true\|false\|all&limit=&cursor=` | cashier | Search and list, paged by id. `q` of 3+ characters uses the trigram index (substring match on Latin and Arabic names, receipt names, barcodes); shorter queries use a plain match. Quotes, `%`, `_` and FTS operators in `q` are plain text |
| GET | `/products/by-barcode/{code}` | cashier | Always `{ data: [products] }`. More than one entry means the code is shared (legacy duplicates), so the till shows a picker. Trims scanner CR/LF. Active products only. `404` if none |
| GET | `/products/sync?since=<iso>` | cashier | Delta of changed/deleted products for the till's local catalog. Product JSON includes `unitName` and `fractional` (true for items sold by weight, so the till accepts decimal quantities only for those) |
| POST | `/products/import` | manager | Products from a spreadsheet's CSV: `{ csv: string (max 3 MB, 5,000 products), dryRun = true, createMissing = false }`. Columns (first row, any case, spaces or hyphens allowed): `name` (needed), `price` (needed for a new product), `barcode`, `cost`, `currency` (LBP or USD), `category`, `brand`, `unit`, `supplier`, `stock_alert`, `receipt_name`; other columns are listed in `ignoredColumns` and not used. A row is about an existing product when its barcode matches exactly one product (or, with no barcode in the row, its name matches exactly one, ignoring case); otherwise it creates one. **Only filled-in cells change anything**: an empty cell leaves the product as it is. Lira are whole numbers and dollars take up to two decimals, read exactly (no thousands separators, signs or exponents; a barcode a spreadsheet turned into `7.6E+12` is refused). Lists are matched by name (ignoring case); a missing category, brand or supplier is an error unless `createMissing`, and a missing **unit** is always an error. Answers `{ dryRun, applied, summary: {create, update, unchanged, errors}, ignoredColumns, newLookups, rows: [{row, action: create|update|unchanged|error, name, barcode, changes[], errors[], warnings[]}] }` with `row` as a spreadsheet numbers it (the header is row 1). **A file with any error writes nothing** (`applied: false`, every problem listed); a clean file is applied in one transaction. The same file twice changes nothing the second time. A file that cannot be read at all is `422 IMPORT_INVALID_FILE`. Audited per product (`product.create`, `product.price.update`, `product.update`, each marked `via: import`) and once as `product.import`. |
| POST | `/products` | manager | Create. Defaults: `currency` LBP, `costMinor` 0, `barcode` empty. `receiptName` is auto-transliterated from `name` if omitted. A duplicate barcode is allowed while the rule is off and reported as `warnings: ["DUPLICATE_BARCODE"]`; once the rule is on it is `409 DUPLICATE_BARCODE` (the same for editing a barcode, and for bringing a hidden product back) |
| GET | `/barcodes/status` | manager | `{ enforced, duplicateGroups, duplicateProducts }` |
| GET | `/barcodes/duplicates` | manager | Every barcode shared by **active** products, with each product's price, stock, number of sale lines and when it last sold, to help choose which one stays |
| POST | `/barcodes/enforce` | manager to turn on, admin to turn off | `{ enabled }`. Turning on is refused while anything is shared (`409 DUPLICATES_REMAIN`). From then on the database refuses a second active product with the same barcode (migration 0010). Hidden products may keep an old code. Audited |
| POST | `/products/merge` | manager | `{ keepId, retireIds: [..] }`, Idempotency-Key required. Folds products that share a barcode into one: their stock moves to `keepId` as `transfer` movements (`refType: merge`), they are hidden and their barcode freed. **History is not rewritten**: old sales still point at the product they sold. `422 NOT_DUPLICATES` when a product does not share the barcode. Audited as `product.merge` |
| PATCH | `/products/{id}` | manager | Partial update: **only the fields sent change**. A price/cost/currency change is audited as `product.price.update` with before and after, other changes as `product.update`. `stockAlert` = per-product low-stock threshold (≥ 0, up to 3 decimals, or `null` for none). Sending `receiptName` marks it manual so later name edits never overwrite it; `null` returns to automatic |
| DELETE | `/products/{id}` | manager | Soft delete (`active=false`) |
| POST | `/products/{id}/image` | manager | The picture **as the request body** (not a form), with `Content-Type` an image type or `application/octet-stream`. The sender's type and file name are **not trusted**: the bytes decide (JPEG, PNG, GIF, WebP or AVIF; SVG and web pages are refused, `422 UNSUPPORTED_IMAGE`). Up to 5 MB (`413 PAYLOAD_TOO_LARGE`); a non-picture content type is `415 UNSUPPORTED_MEDIA_TYPE`. The file is kept as `<24 hex digits>.<real extension>`, made from its content, so the same picture is stored once. Answers the product with its new `imagePath` (`/uploads/<name>`). Bumps `updatedAt`, so every till's next catalog update carries it. Audited as `product.image.update` |
| DELETE | `/products/{id}/image` | manager | Take the picture off the product (the file stays: another product may use it). Answers the product. Repeating it is harmless and is not audited twice (`product.image.remove`) |
| GET | `/uploads/{name}` | **public** (not under `/api/v1`) | A product picture, so an `<img>` can load it. Only names of the exact shape the server makes (`<24 lowercase hex>.<jpg\|png\|gif\|webp\|avif>`) are served; anything else, including a file dropped into the folder by hand, a path with `..`, or a `.html`, is `404`. Served with its real image type, `Cache-Control: public, max-age=31536000, immutable` (the name is its content, so it never changes), `nosniff`. The Host and Origin checks still apply |
| GET/POST/PATCH | `/categories` `/brands` `/units` `/suppliers` | manager (GET: cashier) | Lookups: list (sorted by name), create, rename. No delete, since products still point at them. Names are unique ignoring case (`409 DUPLICATE_NAME`). Units carry `fractional`; suppliers carry `address`, `phone`, `email` |

### Registers (one till)
Balances are **buckets**: `method` ∈ `cash | whish | omt` × `currency` ∈ `USD | LBP` (6 buckets). Nothing here calls a third-party service. Amounts are integers in the bucket's own minor unit (USD cents, whole LBP). `expected` for a bucket is `opening + received for sales - change given + account payments - refunds ± movements`.

| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/registers/open` | cashier | `{ terminalId = "T1", openingBalances: [{method, currency, amount}×6] }`. All six are required, each exactly once. `409 REGISTER_ALREADY_OPEN` if the till already has an open session (checked before the body). `400` lists the missing or invalid balances. `201` returns the session. |
| GET | `/registers/suggested-opening` | cashier | `{ source: "last-close"\|"default", sessionId, balances: [{method, currency, amount}] }`: the last closing counts, or zeros |
| GET | `/registers/current` | cashier | The open session with `balances: [{method, currency, opening, expected}]`, updated live. `404 NO_OPEN_REGISTER` if none |
| POST | `/registers/{id}/cash-movements` | manager | `{ type: "in"\|"out"\|"transfer", from?, to?, amount (> 0), reason (required) }`. `in` needs `to`, `out` needs `from`, `transfer` needs both, in the **same currency** and not the same balance (`422 SAME_BUCKET`, `CURRENCY_MISMATCH`). A balance may go negative: it is bookkeeping. `409` if the session is closed. Audited. |
| POST | `/registers/{id}/close` | cashier | `{ countedBalances: [{method, currency, amount}×6] }` (every balance exactly once). Recomputes `expected` from the rows, stores `counted` and `variance = counted - expected`, closes the session, and returns the Z-report. `409 REGISTER_ALREADY_CLOSED` if already closed (checked before the body). A closed session can never change (enforced by database triggers). |
| GET | `/registers?from=&to=&limit=&cursor=` | manager | History, newest first |
| GET | `/reports/register/{id}` | manager | **Z-report**: for each bucket `opening, salesIn, changeOut, customerPaymentsIn, refundsOut, movementsNet, expected, counted, variance`, plus `totals: { salesCount, salesTotalLbp, salesProfitLbp, owedOnAccountLbp, customerPaymentsCount, refundsCount, movementsCount }` |

Any logged-in user can sell in the till's open session. Each sale stores `userId` and `sessionId`. The running `expected` figures are kept up to date in the same transaction as each sale, payment, refund and movement, and the Z-report recomputes them from the rows, so a drifted running total can never reach a closing report.

### Sales
| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/sales` | cashier | Create and complete a sale (see below) |
| GET | `/sales?from=&to=&customerId=&userId=&ref=&limit=&cursor=` | cashier (own sales only) / manager (all) | List, newest first, each with `customerName` and `userName` (the cashier). A cashier cannot widen it with `userId`, and a receipt number that is someone else's finds nothing |
| GET | `/sales/{id}` | any | Detail with items and payments |
| GET | `/sales/by-ref/{ref}` | any | Lookup by receipt number (returns, reprints). Each item carries `returnedQty`, how much of it has already been taken back (so a cashier, who cannot read the returns list, can see what is left) |
| POST | `/sales/{id}/print` | cashier | Print on the USB printer via the Windows spooler: `{ copies?, openDrawer?, duplicate? }`. The first print of a sale is the original. **Every later print, or one the till flags with `duplicate: true`, is a DUPLICATE**: marked `*** DUPLICATE ***` at the top and the bottom of the receipt, and it **never opens the cash drawer** (`openDrawer` is ignored). Only prints that reached the printer count, so a first print that failed is still the first. Each successful print is audited as `sale.print` (who, copies, duplicate, drawer). Answers `{ printed, copies, duplicate }` |
| POST | `/sales/queued-discard` | manager | A manager throws away a sale that waited on a till and was refused: `{ clientSaleId, reason, summary }`. Deletes nothing (the sale never reached the server); it leaves a note, audited as `sale.queued.discard` with the reason and what the sale was, so a sale cannot vanish silently. `409 SALE_ALREADY_RECORDED` (with the receipt number) if the server did record it after all. `204` |
| GET | `/sales/{id}/receipt?format=json\|text&duplicate=true\|false` | any | `json`: the receipt model. `text`: the 42-column ASCII receipt exactly as printed. (`escpos` arrives with the printing milestone.) Prices and names are those at the time of sale. `duplicate=true` marks it as a reprint (`*** DUPLICATE ***` top and bottom; `duplicate: true` in the model): the till uses it for a browser print of a sale already given out. Nothing is recorded for a browser print, which the server cannot see |
| POST | `/sales/{id}/void` | any (signed in); a cashier needs a manager's approval | `{ reason (required), approvalToken? }`, Idempotency-Key required. Cancels a sale **while the register that took it is still open** (`422 SALE_NOT_VOIDABLE` otherwise, and for imported sales: use a return). Refused after part of it was returned (`SALE_HAS_RETURNS`), after the customer paid part of it from their account (`SALE_HAS_ACCOUNT_PAYMENTS`), or twice (`SALE_ALREADY_VOID`). One transaction: the goods go back on the shelf (`adjustment` movements with `refType: void`), every payment leaves the balance it went into and the change comes back (the register's running figures stay equal to the rebuilt ones), the customer's balance drops by what they owed, and the sale becomes `void` with nothing owed on it. **Its lines and payments are kept**; reports and the register ignore it, and its receipt says `*** VOIDED SALE ***`. A cashier gets `403 VOID_NEEDS_APPROVAL` (with `saleId`, `saleRef`, `totalLbp`) unless `approvalToken` is a `void` approval for this sale. Audited as `sale.void` with the reason and `approvedBy` |

**POST /sales request**
```json
{
  "clientSaleId": "7c0f…",
  "customerId": 1,
  "items": [
    { "productId": 132, "qty": "1",   "unitPriceLbp": 75000 },
    { "productId": 578, "qty": "2",   "unitPriceLbp": 50000 }
  ],
  "discount": { "type": "percent", "value": 0 },
  "payments": [
    { "method": "cash", "currency": "LBP", "amount": 100000 },
    { "method": "whish", "currency": "LBP", "amount": 75000 }
  ],
  "notes": ""
}
```
**201 response**
```json
{
  "id": 24087, "ref": 24087, "status": "paid", "rateLbpPerUsd": 90000,
  "subtotalLbp": 175000, "roundingLbp": 0, "totalLbp": 175000,
  "paidLbp": 175000, "changeLbp": 0, "restLbp": 0, "profitLbp": 25000, "userId": 5, "sessionId": 12, "lowStock": [],
  "items": [ … ], "payments": [ … ], "createdAt": "2026-10-19T10:42:00Z"
}
```
Server rules (all in **one write transaction** with no gaps: the sale, lines, payments, stock ledger and cache, customer balance, register balances and idempotency record commit together or not at all):
- The server prices the cart itself. The client's totals are ignored. Each product is priced in **its own currency** and converted to LBP at the current rate. `unitPriceLbp` is what the till displayed: if it differs from the catalog, a cashier gets `422 PRICE_MISMATCH` (with `expectedUnitPriceLbp`, `sentUnitPriceLbp`, `productId`), and a manager's own price is used and audited as `sale.price.override`. A cashier can sell at another price when the item carries `approvalToken`, a `price` approval for **that product at exactly that price**: it is checked and used inside the sale's transaction (a sale that fails afterwards does not use it up), and the audit entry records `approvedBy`.
- Totals round to `lbpRounding` (5,000 by default). `roundingLbp` shows the adjustment. **No tax is added**: prices are tax-inclusive.
- Discounts: `percent` (0 to 100) or `amount` (whole LBP), never above the subtotal (`DISCOUNT_EXCEEDS_SUBTOTAL`). A cashier is limited to `cashierDiscountLimitPct` of the subtotal: above it, `403 DISCOUNT_OVER_LIMIT` (with `limitPct` and `requestedPct`) **unless** the body carries an `approvalToken` from `POST /auth/approve` that covers this percent. The token is checked and used inside the sale's transaction, so a sale that fails afterwards does not use it up, and a retry of the same sale (same `Idempotency-Key`) replays the first answer without needing it again. The override is audited as `sale.discount.override` with the manager's id. Managers and admins give any discount and need no token.
- Open register required (`409 REGISTER_CLOSED`).
- `payments` may be empty or short **only for a registered customer** (`status: unpaid | partial`, the rest goes on their account). For Walk-In: `422 CREDIT_REQUIRES_CUSTOMER`. Change is cash only: a wallet (`whish`, `omt`) payment above the amount due is `422 WALLET_EXCEEDS_TOTAL`. Repeated tenders of the same method and currency are merged.
- Quantities are strings with up to 3 decimals. Items sold by the piece cannot be split (`FRACTIONAL_NOT_ALLOWED`). Inactive products are refused (`PRODUCT_INACTIVE`).
- **Stock never blocks a sale.** There is no stock error and no override flag. The response includes `lowStock: [{productId, name, qty, threshold}]` for items now at or below their own threshold.
- Response fields: `paidLbp` is the amount applied to the sale (never above the total), `receivedLbp` is what the customer handed over, `changeLbp` is what went back in cash. `profitLbp` = total less cost at the time of sale.
- Receipt numbers (`ref`) rise by one with no gaps, even under parallel load, and a rejected sale does not use one up. `clientSaleId` must be unique (`409`).
- `Idempotency-Key` (1 to 128 printable characters) is required. Same key and same body returns the original answer with `200` and `Idempotent-Replay: true`. Same key and a different body is `422 IDEMPOTENCY_CONFLICT`. A **rejected** request does not use up its key, so the corrected request can reuse it.

### Returns
| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/returns` | any (signed in); a cashier needs a manager's approval | `{ saleId, items: [{saleItemId, qty}], reason?, refund?: {method, currency, amount}, approvalToken? }`. Idempotency-Key required. **A cashier's return is refused with `403 RETURN_NEEDS_APPROVAL`** (carrying `saleId`, `saleRef` and `valueLbp`, what the server worked out the return is worth) unless `approvalToken` is a `return` approval (`POST /auth/approve`) for this sale that covers that value. It is checked and used inside the return's transaction, before the refund is looked at, so a return that fails afterwards (say `REFUND_REQUIRED`) does not use it up. The audit entry `sale.return` records `approvedBy`. A manager or admin needs none. Needs an open register. Each line can be returned only up to what was sold less what was already returned (`422 RETURN_EXCEEDS_SOLD`, with `returnable`). The value of a line is its share of what was paid (a discounted sale refunds the discounted amount). **For an unpaid or part-paid sale the value first reduces what the customer still owes** (`balanceReducedLbp`), and only the remainder (`refundLbp`) is handed back: `refund` is then required (`REFUND_REQUIRED`, which carries `refundLbp` and `balanceReducedLbp` so a screen can offer the amount), must equal it (`REFUND_MISMATCH`, also carrying `refundLbp`; a USD refund may differ by up to one cent), and is refused when there is nothing to hand back (`REFUND_NOT_ALLOWED`). Stock goes back as a `return` movement and the refund leaves the chosen register balance. The sale is never edited except for how much of it is settled. |
| GET | `/returns?from=&to=&saleId=&limit=&cursor=` | manager | List with items |

### Holds
A held cart is a cart parked while the cashier serves someone else. There is one till, so every held cart is visible to whoever is signed in. A hold reserves nothing and promises no price: it never touches stock, and the till re-prices through `POST /sales`.

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/holds` | any | All held carts, newest first, each with who held it, the customer, a note, its items and its value |
| POST | `/holds` | any | `{ customerId?, note?, items: [{productId, qty, priceLbp}] }` (1 to 200 items). At most 100 open holds (`422 TOO_MANY_HOLDS`) |
| POST | `/holds/{id}/recall` | any | Returns the cart **and removes the hold in one step**, so two requests cannot both recall it (the second is `404`). Each item carries `priceLbp` (as held), `currentPriceLbp`, `priceChanged` and `active`, so the till can warn |
| DELETE | `/holds/{id}` | any | Discard. `404` if already gone |

### Inventory & purchasing
| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/stock?productId=&lowOnly=` | cashier (read) | Levels (may be 0 or negative) |
| GET | `/stock/alerts` | cashier (read) | Products with `qty <= stockAlert` (threshold not null), most urgent first: `[{productId, name, qty, threshold}]` |
| GET | `/stock/{productId}/movements?limit=&cursor=` | manager | The ledger behind a quantity, newest first: `qtyDelta`, `reason` (`sale`, `return`, `purchase`, `adjustment`, `transfer`), `refType`, `refId`, `userId`. The sum of the ledger always equals the quantity |
| POST | `/stock/adjustments` | manager | `{ productId, qtyDelta, reason }`. `qtyDelta` is a non-zero number (a string is exact), plus or minus, up to 3 decimals. A reason is required. Written to the ledger as an `adjustment`, never as an edit of history. May take a product below zero. Audited |
| GET / POST | `/stocktakes` | manager | List counts (newest first, with how many products were counted and how many differ) / start one `{ name? }` |
| GET | `/stocktakes/{id}` | manager | The count with its lines: `systemQty` (what the system held when that product was counted), `countedQty`, `differenceQty` |
| PUT | `/stocktakes/{id}/lines` | manager | `{ productId, qty, mode: "set"\|"add" = "set" }`. Counts one product (`add` counts more of it: a scan adds one). Quantities are zero or more with at most 3 decimals; a product sold by the piece cannot be split (`FRACTIONAL_NOT_ALLOWED`). `422 STOCKTAKE_NOT_OPEN` once finished or cancelled |
| DELETE | `/stocktakes/{id}/lines/{productId}` | manager | Take a product out of an open count |
| POST | `/stocktakes/{id}/commit` | manager | Finish: Idempotency-Key required. Each counted product whose count differs from what the system held **when it was counted** gets one `adjustment` (`refType: stocktake`), so selling that went on meanwhile is not undone. Products not counted are untouched. A finished count can never change (database triggers). Audited as `stocktake.commit` |
| POST | `/stocktakes/{id}/cancel` | manager | Drop an open count; nothing is posted |
| POST | `/purchases` | manager | `{ supplierId?, currency = "LBP", status = "draft"\|"ordered", items: [{productId, qty, costMinor}] }`. Totals each line (`cost x qty`). **Never depends on stock on hand**: any product can be ordered, including at zero or negative stock or with no stock history. Numbered 1, 2, 3 ... |
| GET | `/purchases?status=&supplierId=&limit=&cursor=` | manager | Newest first, with items, `paidMinor` and `owedMinor` |
| GET | `/purchases/{id}` | manager | One purchase. Each line shows `received` and `outstanding` |
| PATCH | `/purchases/{id}` | manager | Change supplier, currency, status (`draft`/`ordered`) or replace the lines. Only while **nothing has arrived** (`409 PURCHASE_PARTLY_RECEIVED`, `PURCHASE_RECEIVED`) |
| DELETE | `/purchases/{id}` | manager | Draft only (`409 PURCHASE_NOT_DRAFT`) |
| POST | `/purchases/{id}/receive` | manager | `{ items?: [{purchaseItemId, qty}], updateCost = true }`, Idempotency-Key required. Omit `items` to receive everything outstanding; give them to receive **in parts** (the order stays `ordered` until every line is complete). One transaction: stock goes up through the ledger as `purchase` movements, each line records what arrived, and with `updateCost` each product's cost follows what was paid (converted if the product is priced in the other currency; reported in `costUpdates` and audited like a price change; the selling price is untouched). `422 RECEIVE_EXCEEDS_ORDERED` (nothing is applied if any line is refused). `409 PURCHASE_RECEIVED` once complete. Returns `200` with `receivedNow` |
| POST | `/purchases/{id}/payments` | manager | `{ amountMinor, note? }` in the purchase's currency, Idempotency-Key required. Part payments allowed, also after receipt. `422 PAYMENT_EXCEEDS_TOTAL` beyond what is owed, `422 PURCHASE_NOT_ORDERED` for a draft. This is bookkeeping on the purchase: if the money came out of the till, also record a cash movement |

### Customers and credit
| Method | Path | Role | Description |
|---|---|---|---|
| GET/POST | `/customers` | cashier | Search (phone/name) and create. Walk-In (id 1) is protected |
| GET | `/customers/{id}` | cashier | Includes `balanceLbp` (what they owe) |
| PATCH | `/customers/{id}` | manager | Edit |
| GET | `/customers/{id}/sales?limit=&cursor=` | cashier | History, newest first |
| GET | `/customers/{id}/open-sales` | cashier | Sales with `restLbp > 0`, oldest first (the order payments are applied in) |
| POST | `/customers/{id}/payments` | cashier | `{ method, currency, amount }`. Idempotency-Key required, open register required. Reduces the balance, is applied to the **oldest open sale first** (`allocations: [{saleId, ref, amountLbp}]`), and goes into the register balance of the method used. `422 PAYMENT_EXCEEDS_BALANCE` if more than owed, `422 WALK_IN_NO_ACCOUNT` for Walk-In. A USD payment is converted at the current rate. |

Invariants (tested after every kind of change): `balanceLbp` = sum of `restLbp` of the customer's open sales, and for every sale `paidLbp + restLbp = totalLbp`. Walk-In always has a balance of 0.

### Expenses, services
| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/expenses` | manager | `{ title, amountMinor (> 0), currency, categoryId?, reference?, note?, payFrom?: { method } }`. With `payFrom` the expense is paid out of that register balance **in the expense's currency**: it needs an open register (`409 REGISTER_CLOSED`, and nothing is recorded), and in the same transaction a cash-out movement `Expense: <title>` is written, so the closing count still agrees. Without it the expense is only recorded. Expenses are never edited or deleted |
| GET | `/expenses?from=&to=&categoryId=&limit=&cursor=` | manager | Newest first, with `totals: { USD, LBP }` for everything the filters match (not only the page) |
| GET/POST/PATCH | `/expense-categories` | manager (GET: any) | The same lookup rules as the other lists (rename only, names unique ignoring case) |
| GET | `/registers/{id}/cash-movements` | manager | The session's cash in / out / transfer movements, newest first, expenses paid from the till included |

| POST | `/services` | manager | Service income (IT support, a repair): `{ categoryId?, customerId?, note?, costMinor (>= 0), feeMinor (> 0, what the customer paid), currency, receivedInto?: { method } }`, Idempotency-Key required. Profit is `fee - cost` (may be negative). The reference continues the old app's numbering (5003, 5004, ...). With `receivedInto` the fee goes into that register balance in the service's currency (a cash-in movement, so the closing count agrees) and needs an open register (`REGISTER_CLOSED`); without it the service is only recorded. Never edited or deleted (migration 0009). Audited as `service.create` |
| GET | `/services?from=&to=&categoryId=&limit=&cursor=` | manager | Newest first, with `totals` per currency (`fee`, `cost`, `profit`) over everything the filter matches |
| GET / POST / PATCH | `/service-categories` | any / manager | The service types, like the other lists |

### Reports (manager)
| Path | Description |
|---|---|
| `GET /reports/dashboard` | `today`: `salesCount`, `grossLbp`, `returnsCount`, `returnedLbp`, **`netLbp`** (returns taken off), `profitLbp` (net of the profit the returns lost), `averageBasketLbp`. Also `hourly` (24 entries, shop-local hours), `topItems` (today's top 5 by takings, before returns), `owedByCustomersLbp`, `owedToSuppliers { USD, LBP }`, `lowStockCount`, `openRegisters`. `salesToday` keeps the older **gross** figures. Today starts at local midnight (Asia/Beirut) |
| `GET /reports/sales?from=&to=&groupBy=day\|cashier\|category` | Rows `{ key, label, count, grossLbp, returnedLbp, netLbp, profitLbp }` plus `totals`. `from` and `to` are inclusive instants (default: today until now). A sale counts on the day it was made, a **return on the day it was taken back**; a return is charged to the cashier of the original sale. Voided sales never count. By category, a sale with lines in two categories counts once in each (the grand `totals` are still right). `400` for an unreadable date |
| `GET /reports/products?from=&to=&sort=qty\|revenue\|profit&order=desc\|asc&limit=` | Per product `{ productId, name, qty, revenueLbp, costLbp, profitLbp }`, net of returns. Line values before any discount given on a whole sale. Slowest first with `order=asc` |
| `GET /reports/register/{sessionId}` | Z-report with every bucket: opening, expected, counted, variance |
| `GET /reports/receivables` | Customers who owe, largest first: `{ customerId, name, phone, balanceLbp, oldestUnpaidAt, openSales }`, plus `totalOwedLbp` |
| `GET /reports/payables` | Every ordered or received purchase not fully paid, oldest first, with `owedMinor` and `totalOwed: { USD, LBP }` |
| Any report | `&format=csv` |

### Settings & admin
| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/settings/public` | any | Shop name, address, phone, `lbpRounding`, receipt footer and width, cashier discount limit, and `printerConfigured` (whether a USB printer name is set, so the till knows to print on it or fall back to the browser). No internal fields |
| GET/PATCH | `/settings` | admin | Full settings. Changes are audited with before and after |
| POST | `/settings/printer-test` | admin | `{ openDrawer? }`. Prints a short ASCII slip to the saved printer at the saved width: the shop header, a name long enough to wrap, an Arabic name (transliterated), and a ruler as wide as the receipt. `503 PRINTER_NOT_CONFIGURED` with no printer name, or the printer's own code (`PRINTER_OFFLINE`, ...) with the reason |
| GET | `/exchange-rates/current` | any | `{ rateLbpPerUsd, effectiveFrom }` |
| GET/POST | `/exchange-rates` | admin | History (newest start first) / add `{ rateLbpPerUsd (whole number), effectiveFrom? }`. A future date does not apply yet. New sales use the rate in force when they are made; **old sales keep theirs forever**. Audited with old and new rate |
| GET | `/users` | admin | List. Never includes a password, PIN or hash, only `hasPin` |
| POST | `/users` | admin | `{ username, name, role, password (min 8), pin?, phone?, email? }`. `409 USERNAME_TAKEN` (case-insensitive) |
| PATCH | `/users/{id}` | admin | Name, role, active, phone, email, password, PIN (`null` removes it), `mustResetPassword`. A password change or deactivation ends the user's sessions. An admin cannot deactivate or demote themselves (`422 CANNOT_DEMOTE_SELF`) |
| GET | `/users/pin-list` | any | `[{ id, name }]` of active users with a PIN, for the PIN screen |
| GET | `/audit?entity=&entityId=&userId=&action=&from=&to=&limit=&cursor=` | admin | Newest first, paged. Read-only: there is no way to change or delete audit rows |
| GET | `/events` | any | **SSE** stream: `sale.completed`, `stock.changed`, `register.updated`, `rate.changed` |
| GET | `/healthz`, `/readyz` | public | Liveness / readiness |
| GET | `/backups/status` | manager | `{ configured, encrypted, hasSecondCopy, at, keep, lastBackupAt, stale, lastRunOk }`. `stale` is true when backups are set up and the newest file is more than 36 hours old (or there is none). The till shows a "Backup overdue" chip from it. Never includes the passphrase |
| GET | `/backups` | admin | The same, plus `lastRun` (`at`, `ok`, `trigger`, `file`, `error`) and `files` (`file`, `bytes`, `modifiedAt`, `encrypted`), newest first |
| POST | `/backups` | admin | Make a backup now. `201 { file, bytes, encrypted, copiedTo, copyError }` (a second copy that fails does not fail the backup). `409 BACKUP_NOT_CONFIGURED` without `BACKUP_DIR`. `500 BACKUP_FAILED` with the reason. A request while one is running shares its result. Audited |

Backups are made with SQLite's online backup, verified (`integrity_check`, `foreign_key_check`), converted to a single self-contained file, then optionally encrypted. Settings are environment variables (`BACKUP_DIR`, `BACKUP_COPY_DIR`, `BACKUP_PASSPHRASE`, `BACKUP_AT`, `BACKUP_KEEP`); see `.env.example` and `docs/07-operations.md`.

When `WEB_DIST` points at the built web app, the same server serves it: assets under `/assets/` are cached for a year (their names carry a hash), pages are always re-checked, and an address of the app (for example a refresh on `/products`) that is asked for as HTML gets the app. Everything under `/api/` keeps its JSON answers and is never cached.

## Permission matrix

| Capability | cashier | manager | admin |
|---|:-:|:-:|:-:|
| Sell (incl. credit to registered customer), hold, scan, view products | ✔ | ✔ | ✔ |
| Receive customer payments | ✔ | ✔ | ✔ |
| Own register open/close | ✔ | ✔ | ✔ |
| Discount ≤ limit | ✔ | ✔ | ✔ |
| Discount over limit | a manager's approval (their name and password at the till) | ✔ | ✔ |
| Void a sale, take goods back, sell at another price | a manager's approval each time (their name and password at the till; for that sale, that value, or that product at that price) | ✔ | ✔ |
| Products/purchases/stock/customers edit | – | ✔ | ✔ |
| Reports, all-cashier sales | – | ✔ | ✔ |
| Users, settings, rate, audit | – | – | ✔ |

## Integrations

| Integration | Interface | Notes |
|---|---|---|
| **Barcode scanner** | Browser `ScanDetector` (keyboard wedge: bursts of keys < 35 ms apart ending in Enter). Optional camera via `BarcodeDetector`/ZXing | No server call. Lookup hits the local cache first, then `/products/by-barcode` |
| **Receipt printer** | `ReceiptPrinter` interface: `WindowsSpoolerPrinter` (raw ESC/POS bytes to the installed USB printer's queue, **ASCII only**), `BrowserPrinter` (80 mm CSS fallback) | Printer name in `store_settings.printer_name`. `/sales/{id}/print` returns `202` with a job status. Failure never rolls back the sale |
| **Cash drawer** | ESC/POS pulse via the printer's drawer port on sales with a cash tender | Only if the drawer is connected to the printer |
| **Payment methods** | `cash`, `whish`, `omt`: **recorded only, no third-party service is called**. A `payment_methods` table lets the owner rename or hide them | The cashier confirms receipt of a wallet payment. Reconciled through the closing count |
| **Backups** | Scheduled task using the SQLite online backup → encrypted → external drive + offsite | Not an API |
| **CSV import/export** | `/products/import`, report `format=csv` | |
| **Legacy migration** | CLI `npm run etl -- --dump POSDB.sql` | See 01-data-analysis.md §5 |
