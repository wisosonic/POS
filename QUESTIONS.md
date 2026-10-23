# QUESTIONS.md

Questions for the owner. Answer under each one (write after "Answer:"). New questions are added at the bottom of "Open"; answered ones move to "Answered" with the date.

## Open

### 1. Which receipt printer is it?
The model decides how the cash drawer is opened (the drawer pulse command) and how many characters fit on a line (42 is assumed for an 80 mm printer, 32 for 58 mm). Everything else about printing works and is tested.
Answer:

### 2. The 21 shared barcodes: who decides which product stays?
Menu → Duplicate barcodes lists each one with its stock, how often it sold, and its price. For each group you either give one product its own barcode, or keep one and fold the others into it. It is your decision which stays. Do you want to go through them together, or should I print the list with the numbers so you can work through it yourself?
Answer:

### 3. Should cashiers be able to record a service (IT support, a repair) at the till?
I made Services manager-only, following the first design. If a cashier takes the money, they would need it too.
Answer:

### 4. Where should the second backup copy go?
The second folder can be any folder. For it to survive a fire or a stolen PC it has to be a synced or external location. Which should it be: OneDrive, Google Drive, an external drive that is taken home, or something else?
Answer:

### 5. Until when can a sale be cancelled?
Today: only while the register that took it is still open (the drawer has not been counted). After that, a return is the way back. The alternative is to allow it until the end of the day, but that would change a drawer count that was already settled. Is the current limit right?
Answer:

### 6. Will you use any tablets?
Tablets need HTTPS and a certificate made for the PC's name or address. If yes: what is the PC's name or address on the shop network, and how many tablets?
Answer:

### 7. When is the cut-over, and who runs the rehearsal on the real till PC?
`npm run rehearse`, `npm run preflight` and `npm run test:load` have to be run once on the real till PC before the real switch (the steps are in `docs/10-cutover.md`). Do you have a date in mind, and will you run them or should I walk you through it?
Answer:

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

## Answered

_Nothing yet._
