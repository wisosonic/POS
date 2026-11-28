# QUESTIONS.md

Questions for the owner. Answer under each one (write after "Answer:"). New questions are added at the bottom of "Open"; answered ones move to "Answered" with the date.

## Open

### 33. How should the owner be told when something in the chain is wrong?

Context (P7, 2026-11-28): HQ now answers "is the chain healthy?" (`GET /monitoring/branches`, docs/17 §5): a branch that never connected, went silent, stopped pulling or disagrees with HQ, and HQ's own backup. Today it is only an answer someone has to ask for: nothing is sent.
- **A. A screen at HQ** that shows it (needs an HQ screen, which does not exist yet: HQ is API only). The owner looks each morning.
- **B. A message** (e-mail or WhatsApp/SMS) when a problem appears or a backup is overdue. Needs an outside service and its credentials, which is a decision of its own (what to send, to whom, how often).
- **C. Both.**
**Recommended:** **A first**, because HQ needs a screen anyway for orders, employees, payroll and this, and a screen costs no outside service. Add B when the chain has more branches than the owner can check by eye.
Answer:

### 21. Once branches are connected to HQ, who creates the branch staff (cashiers, managers)?

Context (P3d, 2026-11-27): HQ now has its own staff accounts (name, password, role: viewer, catalog, admin). The people who work at a branch (cashiers, branch managers, the branch admin) are still made **at each branch**, in its own database, with ids of its own. The catalog already comes from HQ (P3a to P3c); this is the last thing the old plan said HQ would own.

- **A. Stay local (as now).** Each branch makes and closes its own accounts. Simple, nothing to design, works offline. Cost: HQ cannot see who works where, and a person who leaves must be closed at every branch they could sign in at.
- **B. HQ owns them and sends them down** (name, role, branch, the password hash, the PIN hash). One place to close an account, and a person can work in two branches. Cost: password hashes travel to every branch (they are already hashes, over HTTPS, but it is a new place they sit); the branch's own ids for users must become HQ's (like the catalog), so a branch must connect with no accounts of its own except one local break-glass admin; a bigger change that touches sign-in at the till.
- **C. A mix:** HQ owns managers and admins, each branch keeps its own cashiers.

**Recommended:** **A until P6 (HR).** HR needs an `employees` list at HQ anyway (not every employee signs in), and linking an employee to a sign-in is the natural moment to decide B. Nothing built so far makes A harder to leave.

Answer:

## Answered

### Branch kinds and requests (P5; owner's idea, answered 2026-11-27)

The owner proposed splitting branches into two kinds. Four details were asked one by one.

- **#28 A branch has a kind: sale or stock.** A *sale branch* has tills and sells to customers. A *stock branch* is a warehouse: **it has no tills** (the server refuses adding tills, opening a register and selling there). Both are ordinary branch servers with their own database and stock ledger, so a stock branch works offline too. HQ stores the kind and the branch learns it when it connects. Supersedes #25.
- **#29 HQ buys centrally and delivers to stock branches ONLY.** HQ makes the purchase orders and splits the quantities between the stock branches; a sale branch never receives from a supplier and has no purchasing at all (refines #26 and #27).
- **#30 A sale branch makes a stock request; HQ routes it.** HQ sends it to the nearest stock branch (**nearest = an ordered list of stock branches per sale branch, set at HQ**: first choice, second choice, and so on; this reading was stated to the owner, who did not object). **The stock branch tells HQ what it cannot supply:** it ships what it has and marks the rest *cannot supply*; HQ then sends the remainder to the next stock branch in the list, and so on. **When every stock branch in the list is out of an item, the line is closed as "not available"** (the sale branch sees it and can ask again); HQ keeps the unmet demand as a report so central buying can see what to order. No backorders. Stock leaves the stock branch when shipped and enters the sale branch when it is received (HQ shows what is in transit); a short or damaged count at receiving becomes an adjustment with a reason (#24).
- **#31 Directions: stock to sale, and stock to stock** (to rebalance warehouses). **Sale to stock is allowed too, see #32.** Sale to sale is not allowed: the stock branch is the hub.

- **#32 A sale branch may send surplus stock back to a stock branch (the owner's idea, to move stock from a slow branch to a busy one through the hub).** It is the shipment cycle in reverse: the sale branch's manager ships, the stock branch's manager **just confirms what arrived** (no approval before shipping; the warehouse cannot refuse goods already on the way), and a difference at receiving is an adjustment at the receiver with a reason. **Only the branch manager starts a return; HQ shows suggestions** (slow here, fast at another branch) **but never forces or orders one.** Only sellable stock goes back: damaged or expired stock is an adjustment (a write-off) at the branch, and every return needs a reason. Rebalancing then needs no special rule: the next request of the busy branch is filled from the stock branch.

**Assumptions, to confirm when this is built:** requests are made by a branch manager (not a cashier), and HQ routes a request at once with no approval step; a returned item carries its cost and the receiving branch blends it into its own cost by quantity.

**P5 order of work:** (1) branch kind and its enforcement; (2) the request, ship and receive cycle with HQ routing and fallback; (3) central purchasing delivering to stock branches; (4) shared customers by phone (independent of the others); (5) the central stock view with reorder suggestions, **rebalancing suggestions (slow at one branch, fast at another)** and the unmet-demand report. The request/ship/receive cycle (2) works in both directions from the start (stock to sale, stock to stock, sale to stock).

### Shared customers, transfers and buying (P5; answered 2026-11-27)

Asked one by one. All as recommended, except buying (#26), which the owner decided the other way.

- **#22 How a customer is recognised across branches: the phone number.** The same phone at two branches is one customer with one balance. A customer with no phone stays branch-only and cannot buy on account (a shared balance needs an identity).
- **#23 One company, one cash pool.** No settlement between branches. A sale is reported under the branch that made it and cash under the branch that received it; a customer payment at branch B on a debt from branch A needs no transfer between them.
- **#24 Transfers: the shipping branch's manager ships, the receiving branch's manager confirms (refined by #28 to #31: shipping is by stock branches).** HQ sees everything and approves nothing. A short or damaged count at receiving is recorded as an adjustment at the receiving branch with a reason.
- **#25 No central warehouse for now. SUPERSEDED by #28:** a warehouse is a stock branch, a first-class kind.
- **#26 HQ buys centrally.** HQ makes the purchase orders and splits the delivery between the branches (different from the recommendation, which was branches buying for themselves). This puts central purchasing INTO P5.
- **#27 (follow-up to #26) A connected branch cannot make its own purchases: HQ only (refined by #29: deliveries go to stock branches only).** A branch only receives what HQ ordered for it. The branch's own purchase screens and routes are switched off while it is connected (like the catalog, `HQ_OWNS_...`); a branch that is not connected works as before. HQ pays the suppliers.

**What this changes in the plan:** P5 is now four things, not three: (1) shared customers and one balance (payments applied oldest-sale-first at HQ), (2) stock transfers, (3) **central purchasing** (HQ purchase orders, delivery split per branch, branch receiving, supplier payments at HQ), (4) the central stock view with low-stock alerts. The branch's `purchases`, `purchase_items` and `purchase_payments` (sent up since P4a) become receiving records of an HQ order rather than the branch's own orders; the design is written before any code.

### Connection and the till's backend (answered 2026-11-27)
Design note: `docs/14-connection-and-till-backend.md`. (1) **A till stops taking sales while the branch server is unreachable**, shows a message, keeps checking and resumes by itself (no offline selling, no queue). (2) **No WebSocket:** a ping every few seconds, whose answer carries the latest version of each topic, is the heartbeat and the change detector (branch to HQ the same way). (3) **The till's Node backend keeps a copy of the items and prices on disk.** (4) **Users stay on the branch server; sign-in is a JWT there** (as built). Proposed and adopted with them: the branch server never calls a till (no till IP, no push), and the enrolment wizard has no IP field (a till is its device token).

### 20. Wallets per branch: three choices (answered 2026-11-25, all as proposed)
Design note: `docs/13-branch-wallets.md`.
- **After a void or a delete, an earlier wallet count's variance does not change.** A count is a statement made at a moment; the void or delete is a visible correction entry and the next count absorbs it.
- **Counting the wallets is never required.** Opening and closing counts are the recommended practice, with a dashboard reminder when a wallet has not been counted since yesterday; nothing blocks selling or opening a till.
- **Managers and admins** count the wallets and record wallet-only movements; cashiers and floor assistants never see or change the wallet ledger.

### 19. Assisted selling on tablets: the details (answered 2026-11-25, all as proposed)
- **Sign-in:** the employee signs in on the tablet with their own name and PIN or password. A new role, **floor assistant**, may build carts and send them to a till but cannot take payment, open a register or see reports. Cashiers keep PIN sign-in; a PIN is never allowed for managers or admins (hard rule 20 stays).
- **Seller recorded:** the sale records both the employee who built the cart (`assisted_by`) and the cashier who took the payment.
- **Busy or closed till:** only tills with an open register are offered. The cart waits at that till; the cashier finishes the current sale first. If the cashier refuses it, or the till closes, the tablet is told and can send the cart to another till.
- **Waiting time:** 30 minutes, then the cart returns to the employee as a held cart (a held cart never touches stock or money).
- **Prices, discounts, credit:** the tablet shows the same prices; discounts, price changes and credit sales stay with the cashier at the till, with a manager's approval where needed.

### Product decisions (2026-11-25): the system is a product with no customer waiting
Each was proposed as a default and approved one by one, except where a change is noted. Build items are in `docs/PLAN-MULTI-BRANCH.md`.

- **#9 Arabic.** English and Arabic both ship. Order: Sales and Returns, then closing the register, then the back office. Digits stay 0-9; receipts stay English. A native speaker who works a till reads `till/web/src/lib/ar.ts` before any release or marketing.
- **#12 payroll rules.** No legal rates built in: NSSF and tax are dated tables the customer's accountant fills in, with a "check the first run" warning. HR is built after the core and the pilot.
- **#13 delivery zones.** Customer data: named zones with fee, minimum order and hours, entered by the customer, none seeded. Built with the marketplace, after the pilot.
- **#18 changing a till's branch server address.** The first address needs no password; changing a saved one needs a manager's or admin's name and password, checked by the branch server. If the old server is gone, the way out is deleting the till's settings file (documented).
- **D0 look.** Keep warm paper, white cards, deep teal, IBM Plex Sans, big touch targets.
- **D1 sign in.** A plain panel showing the company name and logo set in the first-run wizard; none of the invented text.
- **D2 the register: changed from the proposal.** **Cash belongs to each till; Whish and OMT belong to the branch** (all tills share them). A till's open and close ask for cash only (lira and dollars), prefilled from the last closing. Whish and OMT are one running balance per branch: every till's wallet payments add to it, and a manager counts it once (for example when the branch opens and closes) and any time they want to check it, with the difference recorded. **This changes hard rule 14** (register balances are no longer six buckets per session) **and the data model, the register screens, the Z-report, the sync tables and the reports.** It must be built before the sync format is frozen.
- **D3 the till.** Quick buttons are products a manager pins (none by default); pictures shown when a product has one.
- **D4, D5, D6, D8, D11, D12, D13.** Keep as built.
- **D7 closing: changed from the proposal.** A **setting per shop**: blind count for cashiers by default ("Should hold" appears after the count is entered), or show it while counting. A manager sees it at once either way. Cash only, after D2.
- **D9 menu.** Keep the slide-in panel, no permanent sidebar.
- **D10 dashboard.** Top-left: today's net sales; then the cash in the drawers, what is owed, sales by hour, best sellers.
- **D14 more drawn pages.** The design canvas is dropped: review the real screens instead.

### 2. Shared barcodes (answered 2026-11-25)
**Approved default:** the question was about the Darwish legacy data, so it is closed. A fresh install starts with the unique-barcode rule **ON**; the CSV import already refuses duplicates; the *Duplicate barcodes* screen stays as a clean-up tool for messy imports. (Build: make "on" the default of `store_settings.barcode_unique` for a new install.)

### 6. Tablets (answered 2026-11-25)
**Not the proposed default: a new feature.** Tablets are **staff tools for assisted selling**: an employee walks the store with a tablet, scans the customer's items into a cart, then **sends the cart to a specific till** where the cashier takes the payment. The tablet never takes money and never opens a register.
- **Scanning is with the tablet's camera.** A browser only allows the camera on a secure (HTTPS) page, so **the branch server must have an HTTPS certificate for its name** wherever tablets are used. The product needs a guided way to set that up (docs/07), and tablets are not offered without it.
- **The employee picks the till.** The tablet lists the tills that have an open register; the chosen till shows an alert and the cart waits there until the cashier opens it.
- Built on what exists: held carts, the live-update stream, and tills identified by their device token. Plan: `docs/PLAN-MULTI-BRANCH.md` ("Assisted selling on tablets"). Still to decide (proposed defaults to follow): the employee's sign-in and role, who is recorded as the seller, what a busy till or a rejected cart does, and how long a sent cart waits.

### Fresh customer (2026-11-24): the multi-branch system is for a new customer, not a migration of Darwish
Answers: same rules as Darwish (Lebanon, LBP and USD, Whish/OMT, no tax); a separate install per customer (own HQ, own branch servers, own data); the legacy import tools are kept but moved out of the main flow; the customer starts from a product list in a spreadsheet (the CSV import is the first-run path). Recorded in `docs/PLAN-MULTI-BRANCH.md`.
Answer: **Decided** (2026-11-24).

### 7. When is the cut-over, and who runs the rehearsal on the real till PC?
`npm run rehearse`, `npm run preflight` and `npm run test:load` have to be run once on the real till PC before the real switch (the steps are in `docs/10-cutover.md`). Do you have a date in mind, and will you run them or should I walk you through it?
Answer: **Not applicable to the new system** (2026-11-24). The new system is for a fresh customer with no old data, so there is no cut-over to date. The rehearsal and the load test on the legacy dump only matter if the Darwish shop itself ever moves to it; the owner called the old system "a one-customer system".

**14. How many tills per branch, and which branches come first?** Used to size the first multi-till test and to decide which branch becomes "branch #1" (today's till).
Answer: **10 or more tills per branch** (2026-11-24). The multi-till load test will run with 20 tills (needs POSDB.sql). Which branch is first is still to say: tell me when you know. At this size the branch server's headroom matters: the earlier test (50 sales a second, p95 32 ms) is far above 20 tills, but it is re-run before the first real branch.

**16. A sale waited in the till's queue while the branch server was unreachable, and a product's price changed in the meantime. What should happen when the till finally sends it?** Today the server refuses it (`PRICE_MISMATCH`) and a person has to deal with it. The alternative is to accept the price the customer was actually shown (the sale was already made and paid at that price). Which do you want?
Answer: **Accept the price the customer was shown** (2026-11-24). The sale was already paid. Implementation note (to check when built): the server still computes every total itself from the quantities and unit prices, never from a total the till sends; for a queued sale it accepts a unit price only if the catalog had that price at some moment while the sale waited (needs dated price history at the branch), otherwise it keeps refusing, so a tampered request cannot choose any price. The sale is recorded with a note that the price differed from today's.

**17. Which code may be shared between the five projects?** Only the money, pricing, barcode and receipt code needs to be the same at the till and the branch server (the screen total must equal the server's). The sync format between a branch and HQ could instead be a written contract with a test, and HQ could have its own database plumbing instead of a copy. Fewer copies means less to keep in step, at the cost of a little duplication. Copy only the money/pricing code, or keep copying the sync format and the database layer too?
Answer: **Only money, pricing, barcode and receipt code is copied** (2026-11-24), into the till from the branch server. The sync format becomes a written contract with a contract test; HQ has its own database plumbing.

### 3. Should cashiers be able to record a service (IT support, a repair) at the till?
I made Services manager-only, following the first design. If a cashier takes the money, they would need it too.
Answer: **Yes, cashiers too** (2026-11-24). Services are manager-only in the code today: to be opened to cashiers.

### 4. Where should the second backup copy go?
The second folder can be any folder. For it to survive a fire or a stolen PC it has to be a synced or external location. Which should it be: OneDrive, Google Drive, an external drive that is taken home, or something else?
Answer: **A cloud-synced folder** (OneDrive or Google Drive) (2026-11-24). Point the second backup folder at it on the till PC.

### 5. Until when can a sale be cancelled?
Today: only while the register that took it is still open (the drawer has not been counted). After that, a return is the way back. The alternative is to allow it until the end of the day, but that would change a drawer count that was already settled. Is the current limit right?
Answer: **Keep the current limit** (2026-11-24): a sale can be cancelled only while its register is still open.

**10. Online stock: leave the shelf at dispatch or at settlement?** The design posts stock out when the branch records the sale at delivery settlement. Between dispatch and settlement a till could sell an item that is already in the customer's bag. The alternative posts stock out when the order is dispatched and puts it back if delivery fails. Which do you want?
Answer: **At dispatch** (2026-11-24): stock leaves the shelf when the order is dispatched and is put back if the delivery fails. Changes the P9b design (docs/11).

**11. Customer sign-up for the online shop: phone + password only, or a code by SMS/WhatsApp?** A code needs an outside messaging service (cost, and the customer's number is sent to it). Phone + password needs no outside service.
Answer: **Phone + password only** (2026-11-24), no outside service.

### 15. Once branches are connected to HQ, who may add or change products, prices and categories?
(Design: `docs/12-sync-and-hq.md`.) The catalog is owned by HQ so that a product number means the same thing in every branch. Today a manager can add and edit products at the till. Options: **A)** only at HQ; the products screens at a branch become read-only (simplest, no clashes, but a branch that is offline cannot add a new product it just received on the shelf). **B)** a branch can *propose* a product or a price change; HQ approves it. **C)** a branch can add a new product locally with a temporary number and HQ adopts it later (works offline, but two branches can add the same product twice and someone has to merge them).
Answer: **A) Only at HQ** (2026-11-23). The products, categories, brands, units and suppliers screens become read-only at a branch once it is connected to HQ; HQ is the only place a product or a price is added or changed. (Until a branch is connected, it works as before.)

### 1. Which receipt printer is it?
The model decides how the cash drawer is opened (the drawer pulse command) and how many characters fit on a line (42 is assumed for an 80 mm printer, 32 for 58 mm).
Answer: **Buerotika BP110N** (2026-10-26, from a photo of its label): thermal receipt printer, 80 mm paper, 230 mm/s, interfaces RJ11 (cash drawer) + USB + LAN. So the width is 42 characters. Still to confirm on the real PC with "Print a test slip": that it prints the slip correctly (ESC/POS) and that the drawer opens on "Also open the cash drawer" (the app sends the standard pulse on pin 2).


### 8. Delete a voided sale, or a sale with returns, permanently? 
Asked for: a button to delete a **voided** sale permanently, and let a **cashier** delete a sale that has **returned items** completely.

Why I have not built it yet: the rule since the first design is that sales, their items, payments, stock movements and the audit log are never deleted, only added to (CLAUDE.md rule 4). The database enforces it with triggers, so a delete fails. Deleting a sale for good would also: change the takings of a register that was already counted and closed (the Z-report would no longer match the cash that was counted), take the sale out of the day's reports and the dashboard, remove the audit trail of what happened (a void or a return is exactly what an owner checks when cash is missing), and put the stock back out of step with its own history. A cashier who can erase a sale can also erase a theft. The cut-over check "revenue less refunds equals the old total" would no longer hold either.

What I suggest instead (gives the tidy list you probably want, keeps the records):
- **A. Hide it.** A voided sale, or a fully returned one, gets a **Hide** button. It disappears from the Sales list (a "Show hidden" switch brings it back) but stays in the database, the reports and the audit log. Cashiers may hide their own; the action is recorded.
- **B. Delete for real, managers only, with limits.** Only an admin, only a voided sale (no money moved), only while the register that took it is still open, with a typed confirmation. A sale with returns would still not be deletable (its refund already left the drawer).
- **C. Delete for real, as you described** (a button for voided sales, and for cashiers on sales with returns). I would remove the delete-blocking triggers for sales, items, payments, returns and stock movements, rebuild the register's expected balances, and accept that closed days can change. I would not do this without you confirming you accept those effects.

Which one? If C, also tell me: may a cashier delete a sale made by another cashier, and does it need a manager's name and password (the same approval used for returns and voids)?

Answer: **Option C** (2026-10-25): delete for real. Built as `POST /sales/{id}/delete`. Two details were left open and I chose the careful default: a cashier may delete only a sale they made, and only with a manager's name and password for that sale (a manager or admin needs no approval). To drop the approval for cashiers, change `deleteSale` in `branch-server/src/modules/sales/delete.ts`.



