# 03 · User Stories

Decisions applied: one till and one PC (Q3), USB English-only printer (Q2), tax-inclusive prices (Q5), credit for registered customers (Q4), Cash/Whish/OMT recorded without integration (Q6).

Personas: **Cashier** (Sales role), **Manager/Owner** (Admin role), **Stock clerk** (Admin or a scoped role), **Customer** (indirect).
Priority: **M** must-have for go-live, **S** should, **C** could. IDs are referenced by tests (`tests/` use `US-xx` in test names).

## Epic 1 · Checkout

| ID | Story | Acceptance criteria | P |
|---|---|---|:-:|
| US-01 | As a cashier, I scan a barcode so the item is added without typing. | Scan adds the line in < 200 ms (local cache). Scanning the same code increments qty. Focus never needs a click. Unknown code gives an audible and visual error. | M |
| US-02 | As a cashier, I search by name/code when an item has no barcode. | Type-ahead over the local product index, Arabic and Latin, tolerant of partial words. Result list is keyboard-navigable. A **Browse catalog** button beside the search shows the whole catalog as a grid of category squares (an icon, the name, the number of products; A to Z, "No category" last); pressing a square shows that category's products with an **All categories** link back. Picking a product adds it and leaves the category open. | M |
| US-03 | As a cashier, I change a line's quantity, including weighed items (KG). | Qty accepts 3 decimals for units flagged `fractional`. Line total recalculates live. | M |
| US-04 | As a cashier, I see totals in LBP with the USD equivalent. | Both shown. LBP total is rounded to 5,000 (configurable). Rate shown on screen. | M |
| US-05 | As a cashier, I take payment by **cash (USD/LBP), Whish Money or OMT**, singly or split, and see the change. | Method tabs in the pay dialog. Each tender keeps its method and currency. Change is shown prominently and is always paid in cash. A wallet tender cannot exceed the amount due. No third-party call is made, so the cashier confirms the wallet payment was received. | M |
| US-06 | As a cashier, a receipt prints when payment completes. | Prints on the **USB 80 mm printer** in < 2 s via the server (print spooler). **English/ASCII only**: the product `receipt_name` is used, or the name is transliterated from Arabic. Truly unprintable characters (e.g. emoji) become `?`. A "Reprint" button is available. A print failure never blocks or loses the sale, and browser print is the fallback. | M |
| US-07 | As a cashier, I park (hold) a cart and recall it later. | Holds are visible on all terminals. Recalling removes the hold. | S |
| US-08 | As a cashier, I attach a registered customer to a sale. Walk-In is the default. | Search or create a customer inline. Credit is only offered once a registered customer is selected (US-31). | S |
| US-09 | As a cashier, I apply a discount within my limit. | Over-limit discounts need a manager's approval: the manager types their own name and password at the till (not a PIN), sees the discount they approve, and the approval works once, for that cashier, up to that discount, for ten minutes. | S |
| US-10 | As a cashier, I keep selling if the API restarts. | Sales queue in IndexedDB, show a "Pending N" badge, and sync automatically with idempotency keys. No duplicate sales. (Server and browser share one PC, so this is a safety net, not a main path.) | S |

## Epic 2 · Register & cash

| ID | Story | Acceptance criteria | P |
|---|---|---|:-:|
| US-11 | As a cashier, I open the register and enter **opening balances for cash, Whish and OMT, each in USD and LBP**. | No sale without an open session. **One open session per till.** Any logged-in user can sell in it, and each sale records who sold. Fields default to the last closing counts. | M |
| US-12 | As a cashier, I close the register and enter what I count in each balance. | For cash, Whish and OMT in USD and LBP the Z-report shows opening, + sales, + customer payments, − refunds, ± cash movements, **expected, counted, variance**. Wallet balances are shown explicitly. Z-report prints. A closed session is immutable. | M |
| US-13 | As a manager, I record money moved in a session: cash out, expenses, and transfers between balances (for example cash → OMT float). | Reason required. Source and destination bucket chosen. Appears in the Z-report. | S |

## Epic 3 · Returns

| ID | Story | Acceptance criteria | P |
|---|---|---|:-:|
| US-14 | As a manager, I return items from a past sale. A cashier can start one, with a manager's approval. | Look up by receipt number or scan the receipt barcode. Cannot return more than was sold. Stock goes back. Refund is recorded in the register. A cashier's return needs the manager's own name and password at the till (single-use, for that sale and the value shown, ten minutes). | M |

## Epic 4 · Inventory & purchasing

| ID | Story | Acceptance criteria | P |
|---|---|---|:-:|
| US-15 | As a stock clerk, I create/edit products with barcode, cost, price **and currency (USD or LBP) per product**, category, brand, unit, image, and an English `receipt_name` that is **auto-transliterated** from an Arabic name and can be edited by hand (a manual edit is never overwritten). | Duplicate barcodes are warned about now and rejected once clean-up is done (US-34). Price edits are audit-logged. Products can also be brought in from a spreadsheet's CSV: the file is checked first and shown row by row, a file with any problem imports nothing, and an empty cell never overwrites. | M |
| US-16 | As a stock clerk, I receive a purchase from a supplier. | Allowed whatever the current quantity is (0 or negative included). Receiving posts stock movements and can update cost. Partial receipts are supported. Receiving twice does not add stock twice. | M |
| US-17 | As the owner, I get notified when a product is running low, using **each product's own threshold**. | `stock_alert` per product, set as **Low stock threshold** in the product form: a number input, with a **No alert for this product** tick box that switches it off (or `stock_alert` in the CSV import; empty = never alert; **0 is a real threshold**: alert when none are left, not "no alert"; shown as **Low at** in the product list). Alert when quantity ≤ threshold. A non-blocking "Low stock" notice at the till when a sale crosses it, a badge and a **Low stock** list (most urgent first) for managers, and the dashboard count. Near-expiry list from `expiry_date`. Selling is **never** blocked by stock. | M |
| US-18 | As a stock clerk, I correct counts when they drift (optional stocktake). | Menu → Stocktake: scan or search products to count them (a scan adds one) or type the quantity; finishing posts only the differences as adjustments with a note. The quantity the system held when each product was counted is kept, so selling during the count is not undone. Products not counted are untouched. A finished count cannot change. Never required, never blocks a sale. | C |
| US-19 | As a manager, I print shelf labels with barcodes. | Select products, choose a label template, print. | C |

## Epic 5 · Reporting & analytics

| ID | Story | Acceptance criteria | P |
|---|---|---|:-:|
| US-20 | As an owner, I see today's sales, count, profit and average basket live. | Tiles update within 2 s of a sale (SSE). | M |
| US-21 | As an owner, I see sales by hour, day, category and cashier. | Date-range filter, CSV export. | S |
| US-22 | As an owner, I see top and slow movers and margin per product. | Uses the cost snapshot, not the current cost. | S |
| US-23 | As an owner, I see what suppliers are owed. | Unpaid purchases are listed with aging. (Customer receivables are US-33.) | C |

## Epic 6 · Customers

| ID | Story | Acceptance criteria | P |
|---|---|---|:-:|
| US-24 | As a manager, I manage customers and see their history. | Phone is searchable. History links to receipts. Walk-In is protected: it cannot be deleted or carry a balance. The **Customer accounts** page lists every customer (owing or not) with **Sales**, **Edit** and **Delete** buttons and a **New customer** button (a cashier may add; edit and delete are for managers). Delete hides the customer and keeps their past sales; a customer who still owes cannot be deleted. | S |

## Epic 7 · Security & admin 

| ID | Story | Acceptance criteria | P |
|---|---|---|:-:|
| US-25 | As a user, I log in securely. | Argon2id hashes. Lockout after repeated failures. Cashiers can PIN-switch at the till. | M |
| US-26 | As an owner, I control who can do what. | Roles: `admin`, `manager`, `cashier`. Server enforces permissions on every endpoint. | M |
| US-27 | As an owner, every sensitive action is audited. | Price change, discount override, void, return, stock adjust, rate change: who, when, before/after. | M |
| US-28 | As an owner, backups run automatically and I can restore. | Nightly encrypted dump, a restore drill documented and tested. | M |
| US-29 | As the owner, my historical data moves to the new system. | ETL per 01-data-analysis.md §5. Totals reconcile. | M |
| US-30 | As an owner, I set the exchange rate and store info. | Rate is dated and applies to new sales only. | M |
| US-31 | As a cashier, I sell on credit to a **registered** customer: they pay part now (**partial**) or nothing now (**pay later**). | Credit is only possible with a registered customer. Walk-In is blocked with a clear message. With a registered customer chosen, a **Put it all on account** button in the Pay window completes the sale with nothing paid. The rest is added to the customer's balance. The receipt shows paid, **Remaining** and account balance. | M |
| US-32 | As a cashier, I receive a payment on a customer's account by cash, Whish or OMT. | Cannot exceed the balance. Applied to the oldest open sale first. Goes into the register bucket for the chosen method and prints a payment receipt. Each customer row has a **Sales** button: the sales behind the debt (the unpaid ones, oldest first, adding up to what the customer owes) or all their sales, each opening to its items. | M |
| US-33 | As an owner, I see which customers owe me money and which sales are still open. | List by customer with balance, oldest unpaid date and open sales. Balance always equals the sum of open sale rests. CSV export. | M |
| US-34 | As the owner, I clean up duplicate barcodes after go-live. | A report lists every duplicated barcode with the products sharing it. Merge (fold the others into the one that stays: stock moves across, the others are hidden, history is not rewritten) or re-code each, then the rule is turned on and the database refuses a second active product with the same barcode. **Last milestone** (Q7). Menu → Duplicate barcodes. | S |
| US-14b | As a cashier, I cancel a sale I just rang up wrongly. | Only while the register that took it is open. A reason is required and a manager approves with their own name and password. Everything the sale did is undone with new rows (stock, drawer, customer balance); the sale stays in the records as cancelled and a reprint says so. After the drawer is counted, a return is the way back. | M |
| US-36 | As the manager, I record what the shop earns from services (IT support, a repair). | Type, what it cost, what the customer paid (profit is the difference), and whether the money went into the drawer or a wallet (then the closing count still agrees). Never edited. Menu → Services. | C |
