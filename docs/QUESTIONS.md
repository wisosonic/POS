# QUESTIONS.md

Questions for the owner. Answer under each one (write after "Answer:"). New questions are added at the bottom of "Open"; answered ones move to "Answered" with the date.

## Open

### 2. The 21 shared barcodes: who decides which product stays?
Menu → Duplicate barcodes lists each one with its stock, how often it sold, and its price. For each group you either give one product its own barcode, or keep one and fold the others into it. It is your decision which stays. Do you want to go through them together, or should I print the list with the numbers so you can work through it yourself?
Answer: **Later** (2026-11-24). Not settled; the barcode rule stays off.

### 6. Will you use any tablets?
Tablets need HTTPS and a certificate made for the PC's name or address. If yes: what is the PC's name or address on the shop network, and how many tablets?
Answer: **Answered with a question** (2026-11-24): tills (PC or tablet) talk to the branch server over plain local HTTP; only the branch server talks HTTPS to HQ. That is the design. The one catch: a browser on another device treats a plain-HTTP address as not secure, so a tablet could not install the app or keep its offline cache until the branch server has a certificate for its name. Selling itself works. Open: is that acceptable, and how many tablets?

### Design (the canvas "Darwish POS Design", https://claude.ai/artifact/UB7D2ukCGYY5api7ThZLge)
Twelve pages are drawn. Decide page by page; write your choice after each "Answer:" (or tell me in chat and I will write it here).

**D0. The overall look.** Warm paper background, white cards, deep teal for the main action, IBM Plex Sans (it has Arabic too), big touch targets. Keep teal and this feel, or another direction (darker till, more colour, plainer)?
Answer:

**D1. Sign in.** Split screen: brand panel on the left, form on the right. The panel text is a placeholder I invented: "Scan. Pay. Done.", "the shop on Hamra Street" and the Arabic name. What are the real shop address and Arabic name, or should the panel be plain?
Answer:

**D2. Open the register.** Six numbers (cash, Whish, OMT, each in lira and dollars) in one dialog. Fine, or only cash first and the wallets on request?
Answer:

**D3. The till.** Search on top, a big "Just scanned" card, quick buttons for items without a barcode, cart on the right with the big Pay button. Which quick items should those buttons be, and do you want product pictures shown on the till?
Answer:

**D4. Taking payment.** One dialog with Cash / Whish / OMT tabs, quick amounts, change in large type. Anything missing (for example the customer's name on credit sales)?
Answer:

**D5. Sales and receipts.** List on the left, the receipt and its actions on the right. Right order and wording of the actions (Print again, Return items, Cancel this sale)?
Answer:

**D6. Returns.** Find the sale, type what comes back, then Ask a manager. Good as it is?
Answer:

**D7. Closing the register.** The count table with the difference as you type, and today's totals on the right. Should the cashier see "Should hold" before counting, or only after (so counting stays honest)?
Answer:

**D8. Manager approval.** The same dialog for returns, cancelling, price and discount. OK?
Answer:

**D9. Menu for the back office.** Built as a slide-in panel (grouped, with icons) from the Menu button, with Settings behind a gear and the account on the right, as you asked. The permanent left sidebar I drew on the canvas is NOT built: it needs more room than the till has. Keep the panel, or do you want the sidebar on the back-office pages only?
Answer:

**D10. Dashboard.** Four tiles, sales by the hour, best sellers, what is owed. What does the owner look at first each morning, so that goes top-left?
Answer:

**D11. Products, D12. Reports, D13. Users.** Look right? Anything to add or remove?
Answer:

**D14. Pages not drawn yet:** discount dialog, switch cashier (PIN), held carts, customer accounts, purchases, stocktake, services, expenses, cash in/out, settings, exchange rate, backups, duplicate barcodes, CSV import, product edit. Which should I draw next?
Answer:

### 9. Arabic: who checks the wording, and which screens next?
I wrote the Arabic myself. The till flow is done (header, menu, sign-in, settings, checkout, cart, payment, held carts, customers at the till, opening the register). Please have someone who works the till read it (`till/web/src/lib/ar.ts`, or just switch the screen to Arabic) and tell me the words you would change: for example "Walk-In" is **زبون عابر**, "Debts" is **الديون**, "Hold" is **تعليق**. Which screens should be translated next: Sales and Returns, closing the register, or the back office (products, purchases, reports, users)? Digits stay 0-9; say if you want Arabic-Indic digits (٠١٢) on screen instead. Receipts stay English because the printer cannot print Arabic.
Answer: **Sales and Returns next** (2026-11-24). Still open: someone who works the till to read the existing Arabic.

### Multi-branch, HR and online marketplace (design in `docs/11-multi-branch.md`)

**12. What are the real NSSF and income-tax rules, and who confirms them?** Payroll takes them as dated settings, not code. Someone (your accountant) must give the rates, caps and brackets, and check the first payroll run against their own figures before anyone is paid from it.
Answer:

**13. Delivery zones: which areas does each branch cover, and what are the fee, minimum order and delivery hours?** Named areas first (maps later). Needed before the online shop can route an order.
Answer:

## Answered

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



