# 10 · Cut-over: moving the shop from the old app to the new one

Written for the owner and whoever sets up the till PC. Plain steps, in order. Nothing here needs programming knowledge, but a few steps are typed commands: they are given exactly.

The idea in one line: **practise on a copy until it passes, then do the same thing for real on a quiet evening, and keep the old app untouched so there is a way back.**

## 1. The two commands that make this safe

| Command | What it does | Touches the real data? |
|---|---|---|
| `npm run rehearse -w @pos/api -- --dump ../../POSDB.sql` | Imports the dump into a **throwaway** database, checks that it holds the same shop, sells something on it, and proves a backup of it can be restored. About 30 seconds. | **No.** Everything is in a temporary folder, deleted at the end |
| `npm run preflight -w @pos/api -- --env C:\POS\service.env` | Looks at the **real** PC and database (read-only) and says what is missing for opening day: printer, backups, exchange rate, users, pictures, the app. | Reads only |

`rehearse` ends with `N of N checks passed` and exits 0, or lists what failed and exits 1. `preflight` marks each line PASS, WARN (works, but know it) or FAIL (do not open the shop like this).

### What the rehearsal checks (and what it found on the real dump, 2026-10-21)

1. **The import.** Revenue less refunds equals the old app's total (4,661,347,950 LBP less 14,435,000 LBP of refunds, for 22,600 sales); every sale arrived.
2. **The shop adds up.** Database not damaged; no broken references; no two sales with one receipt number; every sale paid + owed = total; every customer's balance equals what their open sales add up to; every product's stock equals the sum of its movements; every paid sale has its payment.
3. **The till works on it.** The server starts on the imported data, the manager can sign in, the Arabic product names are found by searching, the dashboard and sales list open, a new register opens, a real sale goes through, sending the same sale twice records it once, its receipt prints in plain ASCII, and the register closes with no difference.
4. **Still adds up after that sale.**
5. **A backup restores.** An encrypted backup is made and verified, restored to a new file, and the restored copy is the same shop (same row counts, ids, sales totals and balances). A wrong passphrase restores nothing.

On the real dump: **41 of 41 checks passed**, in about 30 seconds (the import itself takes about 10).

### What the rehearsal showed that you need to act on

These are facts about your data, not failures. Each has an owner decision or a step below.

| Found | What it means | What to do |
|---|---|---|
| The old app's **register is still open** in the dump | The new app cannot open a register while another is open | Cut-over step 9: count and close it first (the rehearsal does this and it works) |
| **Every one of the 1,721 products is priced in dollars** (`D*` columns) | Correct and expected: the till converts to lira at the day's rate | Nothing; but the **rate must be right** on day one (step 8) |
| The imported **exchange rate is dated 2000-01-01** (90,000) | A placeholder date | Set today's rate on the first morning (step 8) |
| **2 users** need a new password (`atom.support`, `sale`) | Old passwords were plain text in the dump and are deliberately not carried over | Step 7 (Menu → Users). The admin gives each a first password; they choose their own on first sign-in |
| **9 active products have a price of 0** | They would sell for nothing | Owner: fix the price or hide the product (Products screen) before opening |
| **21 barcodes** are shared by several products | A scan finds both and the cashier picks | Fine for go-live. The tool to clean them up is built (Menu → Duplicate barcodes: re-code one, or keep one and fold the others into it; then turn the rule on). Do it with the owner, product by product, when there is time: it is the owner's decision which product stays |
| **180 Arabic product names** got an automatic English receipt name | The printer cannot print Arabic | Owner: skim the list in the report; fix any that read badly (Products → Edit → Receipt name) |
| **958 sale lines** matched no product | History only: they keep their name and price on the old receipts | Nothing |
| **5 sales** whose total differs from their lines by 5,000 LBP or more; **1 sale** with no lines | Imported exactly as they were | Nothing; listed in the report in case the owner wants to look |
| **2 Walk-In debts** (220,000 LBP) | The new app forbids Walk-In owing money, so the debt moved to a placeholder customer | Owner: decide who really owes it, and rename or merge that customer |
| **2 product pictures** are saved web pages; **418 old pictures** belong to no product | Those 2 products have no picture; the others are not copied | Owner: nothing, or give those products a picture |
| **4 products** with negative stock | Allowed; stock never blocks a sale | Nothing |
| **No receipt printer** chosen | Receipts would print from the browser | Settings → printer (step 6) |

## 2. Before cut-over day

Do these in the days before, on the till PC. None of them touches the old app.

1. **Install** the server: `scripts\windows\install-service.ps1 -DryRun` first, then for real (`docs/07-operations.md` §2). Set the backup folder, a second copy folder (an external drive), and a backup passphrase.
2. **Run the rehearsal on this PC** with the latest dump you have. It must pass here, not only on the developer's machine (different disk, different speed).
3. **Run `npm run test:load`** on this PC once (about 5 minutes) and keep the result: it shows this PC is fast enough (`docs/09-load-test.md`).
4. **Printer.** Install it in Windows, choose it in Settings, press **Test slip**, and check the receipt reads well, with an Arabic-named product too. Check the cash drawer opens on a cash sale (and **does not** open on a reprint).
5. **Train the cashiers** (half an hour each): scan, pay, change, hold and recall, credit sale for a registered customer, customer payment, reprint from Sales, what to do when the screen says "Offline" (keep selling; they send themselves). Train the manager: approve a discount, a return, a cancelled sale and a changed price at the till with their own name and password, open and close the register, count the drawer. Everyone: **Menu → Change my password**.
6. **Restore drill.** Take a backup, restore it to a spare file (`docs/07-operations.md` §4), look at a recent sale. Do this once before cut-over, not for the first time on a bad day.
7. **Agree the rollback trigger** (section 5) with whoever will be in the shop.

## 3. Cut-over day

Pick a quiet evening after closing. Allow two hours. Write down the time of each step.

1. **Freeze the old app.** Close the shift in the old app and count the drawer. Note the last receipt number. Nothing is sold in the old app from now on.
2. **Make the final dump** of the old database, the same way `POSDB.sql` was made. Copy it, and the `Uploads` folder, to the till PC. Keep the old database file as it is.
3. **Rehearse on the final dump:** `npm run rehearse -w @pos/api -- --dump <final dump>`. If any check fails, **stop**, and go to the rollback section (nothing has changed yet, so rolling back is just opening the old app again).
4. **Stop the service** (the import needs the database to itself).
5. **Back up the empty new database** if it holds anything (a fresh install holds only settings).
6. **Import for real:** `npm run etl -w @pos/api -- --dump <final dump> --uploads <Uploads folder>`. It is one transaction: a failure changes nothing. Read the counts it prints; the numbers must match the rehearsal's.
7. **Start the service and set passwords.** Create the admin if there is none (`npm run create-admin -w @pos/api -- <name> <password>`; it makes that name an **admin**, so use it only for the owner's own account). Sign in as the admin, open **Menu → Users**, and give each imported person a first password (and a PIN for cashiers who will switch at the till). Leave "They choose their own password the first time they sign in" ticked: each person is stopped at a *Choose your password* screen on their first sign-in, and the admin never needs to know the final password.
8. **Set today's exchange rate** (Menu → Exchange rate). It is not the imported 2000-01-01 placeholder.
9. **Count and close the imported register** (the old app's open session) in Menu → Close register, with the drawer count from step 1. Then the first cashier opens a new one.
10. **Run `npm run preflight`.** No FAILs. Read the WARNs and decide each.
11. **Sell, reprint, return** one real thing (a manager's approval for the return), then check: the receipt prints, the drawer opened on the cash sale only, the dashboard shows it, and the register close shows no difference. Ring up one more and **cancel** it (Sales → the receipt → Cancel this sale, with the manager's approval) to see the drawer figure come back. Both stay in the records either way.
12. **Take a backup now** and check it appears in both folders.
13. **Open for business.** Keep the old app closed but installed.

## 4. The first two weeks (the parallel period)

"Parallel" here means **the old app stays installed and read-only, and every sale is made in the new one.** Nothing is entered twice.

Every evening, for 14 days:

- **Close the register** and look at the Z-report: counted against expected, for all six balances. A difference is a person's mistake or a problem to report; write it down either way.
- **Look at the backup status** (Menu → Backups, or the badge in the header). A missing backup is the thing to fix first.
- On days 1, 2, 3, 7 and 14, **compare with the cash and the till tape**: the dashboard's net sales for the day against the money counted.
- **Low stock list:** quantities after the import are the old app's last figures. Counting a few fast-moving shelves in the first week and adjusting (Products → Stock) is enough; a full stocktake is not required.
- Keep a list of anything that surprised a cashier. Fixing a screen is easy; hearing about it is the hard part.

After day 14 with no unexplained differences, the old database is kept read-only for 30 days from cut-over, then archived (do not delete it).

## 5. Rolling back

**Decide before, so nobody decides under pressure.** Go back to the old app if, in the first week:

- the till cannot sell for **more than 15 minutes** and the cause is not understood;
- the **money does not add up** (a register difference you cannot explain, or the dashboard disagreeing with the cash on two days);
- the **printer or the cash drawer** cannot be made to work and the owner will not accept browser printing.

What rolling back costs depends on **when**:

| When | What to do | Cost |
|---|---|---|
| Before step 13 (nothing sold in the new app) | Open the old app again. Delete nothing. | None |
| After sales were made in the new app | Export the new sales (Reports → Sales → CSV), re-enter them in the old app, then open the old app. The new database is kept as it is (the backups hold it) for later. | Manual re-entry of every sale since cut-over. **This grows every hour, so decide in the first day.** |

The new system never changes the old database, so going back never loses old data.

## 6. Sign-off

Tick each, with the date and who checked.

- [ ] Rehearsal passed on the final dump (`N of N checks passed`)
- [ ] The real import's counts match the rehearsal's
- [ ] Preflight shows no FAIL; each WARN has a decision
- [ ] Every user can sign in; managers can approve at the till
- [ ] Today's exchange rate is set
- [ ] The imported register is closed and a new one opened
- [ ] Receipt prints; drawer opens on cash, not on a reprint
- [ ] A backup exists in both folders and a restore was practised
- [ ] The 9 zero-price products are fixed or hidden
- [ ] Cashiers and the manager are trained
- [ ] Rollback trigger agreed
- [ ] Old app installed, closed, and its database copied somewhere safe
