# 01 · Legacy Database Analysis (POSDB.sql)

Source: `POSDB.sql`, a SQL Server dump generated 2026-10-18 (157 MB, 76k lines).
The original app was ASP.NET Core + EF Core 7 (53 migrations from 2024-01) with a CRA React front end
(`/static/media/...`, `http://localhost:5220/uploads/...`). Company: **Darwish Market**, Beirut.

## 1. Tables and row counts

| Table | Rows | Role |
|---|---:|---|
| Sales | 22,600 | Sale header (one per checkout) |
| SaleProducts | 44,901 | Sale lines (linked to Sales **by `reference` string**, no FK) |
| Products | 1,721 | Catalog + stock quantity |
| Images | 605 | Binary images (also 709 files in `Uploads/`) |
| Brands / Categorys / Units | 516 / 30 / 7 | Lookups |
| Suppliers | 75 | |
| Purchases / PurchaseProducts | 860 / 3,371 | Goods-received headers / lines (also linked by `reference` string) |
| SaleReturn / SaleReturnProducts | 116 / 132 | Returns; lines duplicated as JSON in `rslist` |
| RegisterLogs / Register | 290 / 1 | Closed cash-drawer sessions / the single open session |
| Customers | 13 | Id 1 = "Walk-In" (default in Settings) |
| Holds | 4 | Parked carts; items stored as JSON in `list` |
| Users | 2 | Roles seen: `Admin`, `Sales` |
| Expenses / ExpenseCategorys | 1 / 4 | |
| Services / ServiceCategory | 2 / 5 | Non-product income (e.g. top-ups) |
| Exchanges | 1 | LBP rate = 90,000 per USD |
| Settings, Warehouses, Durations, ProductStatistics | 1 each / 1 / 1 / 0 | Company info; one warehouse "Main Stock" |

## 2. Business facts the data reveals

- **Volume:** sales run 2025-11-13 → 2026-10-18. About 2,000–2,500 per month, roughly **75–85 per day**.
  Peak hours are unknown (timestamps exist, so measure them during ETL).
  This is a small-to-medium market, not a hyper-scale one. "High volume" means fast, safe checkout, not a distributed system.
- **Basket size:** median 120,000 LBP (~$1.33), p95 590,000 LBP, max 12.34 M LBP. About 2 lines per sale.
- **Dual currency:** every sale is recorded in LBP (`.ل.ل`) with the rate snapshot (`rate`=90000).
  Register columns prefixed `D` and `L` look like USD and LBP cash buckets (inferred from names and values:
  `DcashInHand=70`, `LcashInHand=3,225,000`).
  Products sampled carry USD-scale prices (cost 2.13, price 2.5), while sale lines carry LBP prices (75,000).
  **Decision (owner): each product carries its own currency.** The ETL sets `products.currency` per product (see §5).
- **LBP rounding:** grand totals are multiples of 5,000 LBP in 22,530 of 22,534 sampled sales, so the till rounds to the nearest 5,000.
- **Payments:** effectively cash only. `paymentType` is `cash` on all 22,600 sales. `paymentStatus` says `Paid` on 22,534 and `unPaid` on 66, but those 66 were in fact fully paid (a stale label); only 2 sales have an unpaid balance (see section 6).
  Cheque and bank-transfer buckets exist on the register but no sale uses them. Discount, tax and shipping are almost never used (4 / 1 / 7 sales of 22,600). **Owner decisions:** selling prices are tax-inclusive (no tax in the new system), and payment methods become cash, Whish Money and OMT.
- **Profit is snapshotted:** `Sales.profit` and `SaleProducts.SPcost` capture cost at sale time. Keep this, since margins must not change when costs change.
- **Barcodes:** ~44,850 line items carry a 13-digit code. Mostly EAN-13, but legacy codes also include EAN-8 and arbitrary numbers.
  Checksum validation must be advisory only.

## 3. Structural problems to fix in the new schema

| # | Problem | Evidence | New design |
|---|---|---|---|
| 1 | Money, quantities and dates stored as `nvarchar(50)` | `grandTotal`, `ProductQuantity`, `sDate`, … | Integer minor units, integer thousandths for quantities, ISO-8601 UTC text |
| 2 | No FK between header and lines | `SaleProducts.SPreference` ↔ `Sales.reference` | `sale_items.sale_id` FK |
| 3 | Lines denormalized with no product FK | `SPName`, `SPcode`, `SPbrand` copied | Keep a name/code snapshot **and** add `product_id` FK |
| 4 | Carts and returns held as JSON strings | `Holds.list`, `SaleReturn.rslist` | `holds` + `hold_items`; `return_items` rows |
| 5 | Plaintext passwords in `Users.userPassword` | seen in dump | argon2id hashes; force reset on migration |
| 6 | One global `Register` row, no cashier or terminal | `Register` has 1 row | `register_sessions` + `register_balances` (cash/Whish/OMT × USD/LBP) |
| 7 | Stock is an editable string on Products | `ProductQuantity nvarchar` | `stock_movements` ledger + a derived `stock_levels` cache |
| 8 | Stock looks unreliable | about a third of the products show 0 stock while selling continued, so the numbers were never reliable | Stock is informational only (owner decision): ledger kept, per-product `stock_alert`, never blocks selling or buying |
| 9 | Duplicate barcodes | 21 barcodes shared by 52 products (found by the importer; an early estimate of 316 was wrong) | Imported as-is, non-unique index, unique index in the last milestone (owner decision) |
| 10 | Case-inconsistent enums | `cash` vs `Cash` | `CHECK` constraints |
| 11 | Images as BLOB **and** URLs to `localhost:5220` | `Images` table + `ProdImage` | Files on disk/S3, relative URL; drop BLOBs |
| 12 | Purchase `status`/`tostock` free text | `Pending`/`Received`, `notAdded` | Enum + `received_at`; stock posted via ledger |
| 13 | Reference numbers are strings and are reused in logic | `1001`… | `bigint` sequence per terminal-safe series, unique |
| 14 | Config tables with no purpose | `Durations`, `ProductStatistics` | Drop |

## 4. Mapping (legacy → new)

| Legacy | New (see 04-architecture.md §5) |
|---|---|
| Customers | `customers` |
| Products + Brands/Categorys/Units/Suppliers/Warehouses | `products`, `brands`, `categories`, `units`, `suppliers`, `warehouses` |
| Sales + SaleProducts | `sales` + `sale_items` + `payments` (1 cash payment per legacy sale) |
| SaleReturn(+Products) | `returns` + `return_items` (parse `rslist` JSON, cross-check with `SaleReturnProducts`) |
| Purchases(+Products) | `purchases` + `purchase_items` |
| Holds | `holds` + `hold_items` (parse `list` JSON) |
| Register / RegisterLogs | `register_sessions` (closed sessions imported as history) |
| Exchanges | `exchange_rates` (history, effective-from) |
| Expenses, Services | `expenses`, `service_sales` |
| Users | `users` (+ role enum, password reset flagged) |
| Settings | `store_settings` |

## 5. ETL rules (as built)

Run it with the API stopped: `npm run etl -w @pos/api -- --dump ../../POSDB.sql --db ./data/pos.db`. It writes a JSON report beside the database.

1. **One transaction.** Everything is imported or nothing is. A failure leaves the database exactly as it was, and the same command can be run again after the cause is fixed.
2. **Idempotent.** Every imported row remembers its legacy id, so a second run finds everything already there and adds nothing.
3. **The dump is streamed**, never loaded whole (it is 157 MB, 137 MB of which is the `Images` table, which is skipped without being parsed). Reading takes under a second.
4. **A safety net before saving:** imported revenue less refunds must equal the legacy `SUM(grandTotal)` to the lira, or the whole import is refused.
5. **Never silently fix.** Odd rows are imported as faithfully as the new rules allow and listed in the report.
6. **Dates:** legacy text is Beirut local time and is stored as UTC. A time that happened twice (clock going back) takes the first; one that never happened (clock jumping forward) lands after the jump.
7. **Money:** lira are whole numbers. Dollar amounts become exact cents (`1.005` is settled before multiplying, so it becomes 101 and not 100). Quantities become thousandths.
8. **Sales and returns.** The legacy app *edited* a sale when something was returned: it set the returned lines' quantity and the sale's total to zero, and kept the original quantities only inside the return record. The new system never edits a sale, so the original sale is **rebuilt** (original total = recorded total + refund; original quantity from the return record) and the return is kept as its own row linked to the rebuilt lines. This was verified on all 116 returns before relying on it.
9. **Products:** matched to sale and purchase lines by barcode (the name breaks ties between products that share a barcode), then by exact name; the rest keep their snapshot with no product link. Every legacy price is under 1,000, so the whole catalog is in **dollars**. Opening stock is the quantity the old system holds now (zero and negative kept). A stock-alert threshold of 0 meant "not set", and a negative one is ignored. Placeholder expiry years (0001, 2000) are dropped. Picture links become `/uploads/<file>`; the old app's bundled placeholders become "no picture".
10. **Credit.** Walk-In may not owe money in the new system. The two sales where an unidentified Walk-In still owed money keep their balance on one placeholder customer ("Walk-In debts (from the old system)") so the debt can still be collected.
11. **Users:** the old passwords were plain text and are **not** carried over. Each user gets an unusable password and must be given a new one by an admin.
12. **Registers:** the open register becomes the open session. Each of the 290 closed shifts keeps its cash in hand and the closing total the old app computed. The old app never recorded a physical count, so these are imported with expected = counted and zero variance. Whish and OMT start at zero.
13. **Numbering:** old receipt numbers are kept, and the counters are set above the highest imported number so new sales continue the sequence.
14. **Not imported:** the `Images` table (the pictures products use are copied from `Uploads/` instead, see rule 16), 4 open held carts (transient and days old), the config leftovers `Durations` and `ProductStatistics`.
15. **Duplicate barcodes** are imported as they are and listed. The unique index comes in M7.
16. **Pictures.** The importer **reads** `Uploads/` (never changes it) and copies each picture a product uses into the new system's own pictures folder (`uploads` beside the database, or `--images <folder>`). A picture is judged by its **bytes**, not its name: it is kept as `<24 hex digits>.<real extension>`, made from its content, so a picture used by several products, or present twice under different names, is kept once, and a `.png` that is really WebP is stored as WebP. A file that is not a picture (a saved web page) is **not copied**: the product is imported without one and the file is listed. A picture whose file is missing is listed and the product imported without one. Files in `Uploads/` that no product uses are counted and **not** copied, because nothing says which product they belong to. The importer refuses to run if the new folder and `Uploads/` are the same folder (on Windows `Uploads` and `uploads` are one folder).

## 6. What the real dump contained (checked 2026-10-20)

The importer's first run found these, and several corrected my earlier estimates:

| Finding | Number | What was done |
|---|---:|---|
| Sales | 22,600 | All imported, numbered with their old receipt numbers (1001 to 23669) |
| Sale lines in the dump | 44,901 | 44,887 imported; 14 skipped (see below) |
| Returns | 116 | Imported; the 116 sales they belong to were rebuilt |
| Zero-quantity lines | 121 | 107 belong to a return and were restored to the original quantity; **14 are leftovers** with nothing sold and no return behind them, so they were skipped and counted |
| Sales whose total differs from their lines by 5,000 LBP or more | 5 | Imported as recorded and listed in the report (the till normally rounds by less than 5,000) |
| Sale header with no lines at all | 1 | Imported and listed |
| Sales carrying a tax amount | **1** (not 2) | The amount (1) is kept in the sale's notes |
| Sales labelled "unPaid" | 66 | They were fully paid (paid = total, rest = 0): only the label was stale. Imported as paid |
| Sales with an unpaid balance | **2**, both Walk-In | 145,000 + 75,000 = 220,000 LBP, moved to the placeholder customer |
| Return recorded empty (nothing returned, nothing refunded) | 1 | Imported and listed |
| Return whose header refund differs from its lines | 1 | Return 147: header 200,000, lines 175,000. The header is what was refunded |
| Products | 1,721 | All priced in dollars |
| Products sharing a barcode | 21 barcodes, 52 products | Imported as they are, listed (clean-up is M7) |
| Products with a real stock threshold | 11 | The other 1,710 (threshold 0 or negative) have none |
| Products with negative stock | 4 | Kept (one is -0.608) |
| Arabic product names | 180 | Each got an automatic English receipt name, listed for review |
| Sale lines with no matching product | 958 (61 old barcodes) | Kept with their snapshot. 849 more were matched by name |
| Product pictures referenced | 314 real, 1,407 placeholders | All 314 files exist in `Uploads/`. They are 291 different files; **2 of them are saved web pages, not pictures** (those 2 products import without one); 2 have a name that says one kind of picture and are another; 12 are shared by several products. **289** pictures (26 MB) are copied. **418** of the 709 files in `Uploads/` are used by no product, and only 2 of them are named after a barcode (both belong to products that already have a picture), so they cannot be matched automatically |
| Purchases | 860 (846 received, 14 ordered) | All in dollars, all marked paid; each has its payment on record |
| Registers | 290 closed + 1 open | Open one has $70 and 3,225,000 LBP of cash in hand |
| Users | 2 | Passwords not carried over |
| Unreadable numbers | 0 | |

The whole history fits in a **13 MB** database and imports in about **11 seconds**.
