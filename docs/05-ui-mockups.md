# 05 · UI Mockups

A clickable static prototype of the checkout screen is in [mockups/checkout.html](mockups/checkout.html). Open it in a browser.
The wireframes below define layout and behaviour. Target: 1366×768 touch/keyboard till, responsive down to a 10" tablet and a phone for the manager views.

**Design rules:** large hit targets (≥ 48 px), high contrast, no modal for the happy path, every action reachable from the keyboard, RTL-ready (Arabic product names exist in the data), LBP shown as the primary currency with the USD equivalent.

## 0. The interface as built (visual refresh, 2026-10-22)

The mockups below were the starting point. This section says what the interface is now; where they differ, this section wins.

**The header** (every signed-in screen). Left: a **Menu** button (hamburger icon only, no text), the shop name, the register and cashier chip and the backup-overdue warning. Right, in this order: **Holds**, the **low-stock** indicator, the connection group (sales waiting to be sent, sales that need attention, and the **Online / Offline** indicator), a **gear** (admin only: Settings, Exchange rate, Users, Backups) and the **account button** (a compact one: initials, name and a dropdown with who you are and your role, Change my password, Switch cashier, Sign out). The exchange rate is not shown in the header any more: the admin changes it under the gear, and it is on every receipt and in the payment dialog. Settings no longer sit in the main menu.

**The menu** is a panel that slides in from the left, on every screen size (a native `<dialog>`, so focus stays inside and Escape closes it). It is grouped Till / Shop / Money, every place has an icon, the current page is highlighted, and a person sees only what their role allows (`apps/web/src/lib/nav.ts`, tested in `tests/web/nav.test.ts`). Cashier: Checkout, Sales, Returns, Customer accounts, Low stock, Close register. Manager adds Dashboard, Products, Lists, Duplicate barcodes, Purchases, Stocktake, Reports, Expenses, Services, Cash in and out.

**Look:** warm paper background, white cards with soft corners, teal for the one main action on a screen, IBM Plex Sans (with Arabic) served by the app itself, tabular figures for money, tokens for colour, spacing (4, 8, 12, 16, 24, 32 px), small corner radii (6 px for buttons, fields and chips, 8 px for cards and dialogs) and type in `apps/web/src/styles.css`; dark mode redefines the colour tokens. Icons are one small set drawn in `components/Icon.tsx` (nothing is downloaded); an icon always sits next to a word, or the button has an `aria-label`.

**Sizes:** the till is laid out for 1366 x 768 and a 1024 x 768 touch tablet, and stacks on a phone (cart under the search, status chips on their own row, tables scroll inside their own box). Lower-priority chips (register, rate) wait below 1180 px so the header never wraps on a tablet.

**Speed:** only the till and the sign-in are in the first download (about 340 kB, 106 kB compressed, down from 443 kB); every other screen is fetched the first time it is opened and is kept for offline use by the service worker. Fonts are two Latin and Arabic families, woff2 only.

## 1. Checkout (main till)

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ Darwish Market   ● Online   Register #3 · Sara   Rate 1$ = 90,000 LL        [Hold▾2] [Menu ☰]│
├───────────────────────────────────────────────┬──────────────────────────────────────────────┤
│ 🔍 Scan or search product…  (F2)   [Customer: Walk-In ▾]                                     │
│───────────────────────────────────────────────┤  CART                                        │
│  Quick categories                             │  # Item                 Qty    Price   Total │
│ [Grocery][Snacks][Drinks][Dairy][Hygiene]…    │  1 Cedars silver towel   1 −+  75,000  75,000│
│                                               │  2 Crispy chocolate      2 −+  50,000 100,000│
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ │  3 Uno laban 1kg         1 −+ 160,000 160,000│
│  │ img    │ │ img    │ │ img    │ │ img    │ │                                              │
│  │Starbuck│ │Master  │ │Uno     │ │Laziza  │ │ ─────────────────────────────────────────── │
│  │2.5$    │ │50,000  │ │160,000 │ │…       │ │  Subtotal                         335,000    │
│  └────────┘ └────────┘ └────────┘ └────────┘ │  Discount (F6)                          0    │
│  (tap to add; hidden on small screens)        │  Rounding                           +0       │
│                                               │  ┌────────────────────────────────────────┐ │
│                                               │  │ TOTAL        335,000 LL     ≈ $3.72    │ │
│                                               │  └────────────────────────────────────────┘ │
│                                               │  [ Clear (Esc) ]  [ Hold (F4) ]  [PAY (F9)] │
└───────────────────────────────────────────────┴──────────────────────────────────────────────┘
```

Behaviour: scanner input is captured globally (no focus needed). A beep sounds on success and an error tone on failure. The last scanned item is highlighted. Qty `−/+` and tap-to-type are supported. A swipe or `Del` removes a line.

## 2. Payment dialog

```
┌──────────────────────── PAY ────────────────────────┐
│ Total due            335,000 LL        ≈ $3.72       │
│ Customer: [ Walk-In ▾ ]   (credit needs a registered │
│                            customer)                 │
│ ┌ Cash ┐ ┌ Whish ┐ ┌ OMT ┐        (use several)      │
│  Cash LBP  [  200,000 ]  quick: [335,000] [500,000]  │
│  Cash USD  [        0 ]  quick: [$1] [$5] [$10]      │
│  Whish LBP [  100,000 ]                              │
│  OMT LBP   [   35,000 ]                              │
│                                                      │
│ Received          335,000 LL                         │
│ CHANGE (cash)           0 LL                         │
│ REMAINING (on account)  0 LL                         │
│                                                      │
│        [ Cancel ]            [ COMPLETE (Enter) ]    │
└──────────────────────────────────────────────────────┘
```

- Short or empty payment with **Walk-In**: inline error "Select a registered customer", and Complete is disabled.
- Short or empty payment with a **registered** customer: a "Remaining 135,000 LL goes on account" line appears and Complete is enabled.
- Change is cash only. A Whish/OMT amount above the total is flagged.
- Customer accounts screen: list with balance, **Receive payment** (method + amount), open sales per customer.

## 3. After-sale

```
┌───────────────────────────────┐
│ ✔ Sale 24087 completed        │
│ Change: 65,000 LL             │
│ Receipt: ● Printed            │
│ [Reprint] [New sale (Enter)]  │
└───────────────────────────────┘
```

If any item is now at or below its own low-stock threshold, a non-blocking "Low stock: Uno laban 1kg (2 left)" notice appears here. It never stops the sale. If the printer fails, a non-blocking warning appears with **Retry** or **Use browser print**. The sale is already saved.

## 4. Receipt (80 mm, 42 columns, English/ASCII only)

The USB printer has no Arabic code page, so lines use each product's English `receipt_name`. Anything else non-ASCII prints as `?`. Prices are tax-inclusive and no tax line is printed. The example below is a part-paid sale to a registered customer.

```
        DARWISH MARKET
     lebanon , Beirut
        Tel 71479893
------------------------------------------
Receipt #24087       2026-10-19 13:42
Cashier: Sara        Register: 3
Customer: ahmad darwish
------------------------------------------
Cedars silver towel
   1 x 75,000                     75,000
Crispy chocolate
   2 x 50,000                    100,000
Uno laban 1kg
   1 x 160,000                   160,000
------------------------------------------
Subtotal                         335,000
TOTAL (LL)                       335,000
          ≈ USD 3.72  @ 90,000
Cash LBP                         200,000
Whish                            100,000
Remaining                         35,000
Account balance                   35,000
------------------------------------------
            Thank you!
       ||||||||||||||||||||||||
              24087
```

## 5. Register open / close

```
OPEN REGISTER  (one till)                CLOSE REGISTER
 Opening balances        USD     LBP      Balance        Expected     Counted    Variance
 Cash                  [  70] [3,225,000] Cash USD          182.50   [ 182.50 ]      0.00
 Whish Money           [  10] [  500,000] Cash LBP     4,870,000 [4,860,000 ]  −10,000 ⚠
 OMT                   [  20] [1,000,000] Whish USD          10.00   [  10.00 ]      0.00
 (pre-filled from last close)             Whish LBP       575,000   [ 575,000 ]      0
 [ Open ]                                 OMT USD            20.00   [  20.00 ]      0.00
                                          OMT LBP       1,200,000 [1,200,000 ]      0
                                          Sales 80 · Customer payments 3 · Refunds 1
                                          Movements: cash → OMT 200,000
                                          [ Print Z-report ]   [ Close ]
```

Opening and closing are per method **and** currency, because wallets and cash each hold USD and LBP. Whish and OMT balances are bookkeeping. Nothing is read from those services.

## 6. Manager screens

```
DASHBOARD (live)
┌────────────┬────────────┬────────────┬────────────┐
│ Sales today│ Orders     │ Avg basket │ Profit     │
│ 9.8 M LL   │ 84         │ 116,700    │ 1.6 M LL   │
├────────────┴────────────┴────────────┴────────────┤
│ Sales by hour  ▁▂▃▅▇█▆▅▃▂      │ Top items         │
│                                  │ 1 Master chips …  │
├─────────────────────────────────┼───────────────────┤
│ Low stock (12)  Near expiry (5) │ Open registers (1)│
└─────────────────────────────────┴───────────────────┘

PRODUCTS                                 [ + New product ] [ Import CSV ]
 Search…  Category ▾  Brand ▾  Stock ▾   ☐ Low stock only
 ┌───┬──────────────────────┬──────────────┬────────┬───────┬──────┐
 │img│ Name                 │ Barcode      │ Price  │ Stock │ ⋮    │
 └───┴──────────────────────┴──────────────┴────────┴───────┴──────┘

LOW STOCK (most urgent first): Product · Qty · Threshold · Supplier · [ + Purchase ]   (threshold is edited per product)
PURCHASE: supplier ▾ · scan items to add · qty/cost per line · [ Receive stock ]
REPORTS: Sales · Items · Categories · Cashiers · Register Z · Margin · Receivables  [CSV]
```

## 7. States to design

Empty cart · unknown barcode · duplicate-barcode picker · out of stock (blocked, manager override) · pending-sync badge ·
printer error · session expired (PIN re-entry, cart preserved) · manager approval prompt (name and password) · loading skeletons · credit blocked for Walk-In · customer account screen · RTL layout for the screen (receipts stay English).
