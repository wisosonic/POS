# Stock flow, central buying and shared customers (P5)

Design written 2026-11-27, before any code of P5. The owner's decisions are in `docs/QUESTIONS.md` #22 to #32; the phase in `docs/PLAN-MULTI-BRANCH.md`; the sync machinery it builds on in `docs/12-sync-and-hq.md`. **Read this before touching stock transfers, purchasing or customers at a connected branch, and update it when something here changes.**

## 1. What the chain looks like

- **A branch has a kind.** A **sale branch** has tills and sells to customers. A **stock branch** is a warehouse: **no tills** (the server refuses adding a till, opening a register and selling). Both are ordinary branch servers with their own database and stock ledger, so both keep working when HQ is unreachable.
- **HQ buys.** HQ makes the purchase orders and delivers them to **stock branches only**. A connected branch makes no purchases of its own.
- **Sale branches ask, stock branches ship.** A sale branch makes a stock request; HQ routes it to a stock branch; the stock branch ships; the sale branch receives. A sale branch may also send surplus back to a stock branch. Stock never moves sale-to-sale.
- **Customers are shared** by phone number, with one balance across branches.

## 2. Rules that carry over from the existing system (do not break them)

- **One writer per row.** Everything a branch writes is a branch-owned fact (append-only, mirrored up, §3 of `docs/12`); everything HQ writes comes down in HQ's change log (§5). A document that two parties act on is **split into one document per party**, each written by its own party, and HQ relays between them. Nobody edits a row another party owns.
- **Stock is a ledger.** A transfer changes stock only through `stock_movements`, in the same transaction as the document that causes it (rule 5). Stock never blocks anything (rule 17): shipping more than the system thinks is there is allowed (the count catches it).
- **History is append-only** (rule 4). A cancelled or corrected shipment is a new row, never an edit.
- **Idempotency** on every command that creates a document (rule 6).
- **Ids belong to a branch** at HQ: every join between mirror tables also joins on `branch_id` (`docs/12` §23).

## 3. Slice 5a: the branch kind (built first)

`branches.kind` at HQ (`'sale'` default, or `'stock'`), set when the branch is added, **changeable only until it is enrolled** (a branch that has traded cannot become a warehouse). The branch learns its kind when it connects (the enrol answer and the ping carry `{ id, code, name, kind }`) and stores it in its own `branches.kind`. A stock branch refuses, with `409 NOT_A_SALE_BRANCH`: adding or enrolling a till, and every route that needs a till (`withTerminal`: sales, holds, returns, registers, customer payments, expenses, services). `GET /settings/public` says `branchKind` so the screens can show a stock branch's own pages. **A branch can only be connected as a stock branch from a fresh install** (no sales, register sessions or tills enrolled): otherwise `409 BRANCH_HAS_SALES`. The chain reports already work (a stock branch simply has no sales; the stock report covers every branch; the overview names each branch's kind).

## 4. Slice 5b: shipments and receipts (the mechanics, between any two branches)

Two documents, each written by one party, mirrored up like any fact:

- **`shipments` + `shipment_items`** (written by the SENDING branch): `to_branch_id` (HQ's branch id), a reason (`supply`, `rebalance`, `return`), and per item `product_id`, `qty_milli`, `unit_cost`. Creating one writes a `stock_movements` row **out** per item (`reason = 'transfer'`, `ref_type = 'shipment'`) in the same transaction. Stock is now "in transit".
- **`receipts` + `receipt_items`** (written by the RECEIVING branch): references the **incoming shipment** (§ below), and per item `qty_expected` (what was shipped), `qty_counted` (what arrived) and a reason for a difference. Creating one writes the movements **in** at the expected quantity and, for each difference, an **adjustment** of `counted - expected` with the reason (decision #24: the shortfall or surplus is visible in the receiver's books). The receiving branch blends the shipped `unit_cost` into its own cost of the product by quantity (an assumption of #32).
- **Relay.** HQ turns each mirrored shipment into an `incoming_shipments` row (+ items) that goes **down to the receiving branch only** (the branch-scoped change log of P3c, `ids: 'same'`: these tables are only ever filled from HQ, so HQ's id is safe as the branch's own). The receiver sees a list of shipments on the way and confirms each. HQ derives the state (`shipped` → `received`, with the difference) from the mirrored receipt, and the **in-transit quantity** per product and branch.
- **Directions:** stock to sale, stock to stock, **sale to stock** (decision #32: the sale branch's manager ships, the stock branch confirms on arrival, no approval before shipping). **Never sale to sale** (the server of a sale branch refuses a shipment to another sale branch; HQ refuses to relay one). A sale branch returns only sellable stock (a reason is required; damaged stock is an adjustment).
- **Who:** a branch **manager** ships and receives (not a cashier). A shipment cannot be edited; a mistake is corrected by the receiver's count.

### 4.1 What was built (2026-11-28) and where it differs from the sketch above

- **Branch** (migration 0025, `modules/transfers/`): `shipments`, `shipment_items`, `receipts`, `receipt_items` (append-only by trigger, sent up like any fact, in the daily control too) and, filled only from HQ, `incoming_shipments`, `incoming_shipment_items` and `branch_directory` (HQ's ids are the ids here). `POST /shipments` (manager, `Idempotency-Key`) takes `{ toBranchId, note?, items: [{ productId, qty }] }`; **the reason is derived by the server from the two kinds** (stock to shop `supply`, stock to stock `rebalance`, shop to stock `return`), never chosen by the client, and **a return needs a note** (`RETURN_NEEDS_REASON`). Sale to sale is `422 DIRECTION_NOT_ALLOWED`; to itself `SAME_BRANCH`; an unknown or switched-off branch `UNKNOWN_BRANCH`; the same product twice `DUPLICATE_PRODUCT`; a branch that is not connected `409 NOT_CONNECTED`. Stock leaves in the same transaction (`reason 'transfer'`, `ref_type 'shipment'`), with the sender's cost of each product on the line.
- **The header says how many lines there are** (`shipments.item_count`): a batch of facts can end between a header and its lines, and HQ relays a shipment only when it holds all of them.
- **`POST /receipts`** (manager, idempotent) takes `{ incomingId, note?, items: [{ productId, counted, reason? }] }`, listing only the lines whose count differs (a line left out arrived as shipped). The shipment comes in at the quantity shipped, and **each difference is booked as an `adjustment` movement with its reason** (`DIFFERENCE_NEEDS_REASON` without one, `NOT_IN_SHIPMENT` for a product that is not on it, `ALREADY_RECEIVED` the second time, `UNKNOWN_PRODUCT` if the catalog has not reached the branch yet). The **received cost is blended into the receiver's cost by quantity** (`blendedCost`: the stock already there keeps its cost; with nothing on the shelves the sender's cost becomes the cost). `GET /incoming`, `/incoming/:id`, `/shipments`, `/receipts` list them; `GET /transfers/destinations` says where this branch may send, with whether the direction is allowed.
- **HQ** (migration 0012, `modules/facts/relay.ts`): the mirrors of the four tables; `relayShipments` runs inside `applyFacts` and turns a complete shipment into `incoming_shipments` + items whose change-log lines carry the **receiver's** id (so only the receiver is told, the header first). A shipment HQ cannot deliver (an unknown or switched-off branch, or the sender itself) is **recorded** (so it is not tried again), sent to nobody, audited once (`shipment.undeliverable`) and shown as undeliverable. `branch_directory` (every branch, told to every branch) is kept up to date by the code that adds or changes a branch. `GET /reports/transfers` lists each shipment as `in_transit`, `received` (with the net difference) or `undeliverable`, and `GET /reports/stock` now shows each branch's **in-transit** quantity beside what is on its shelves.
- **Screens:** the manager's **Transfers** page (*Coming in* with a confirm dialog that asks for a reason on any difference, *Send stock*, *History*), in the menu and on a stock branch's home. Live: a relayed shipment raises the `stock` number of the ping.
- **Not yet:** the sender does not see whether its shipment was received (status relay comes with 5c's request status), a cancelled or corrected shipment (a mistake is the receiver's count), and a browser at a stock branch has no live updates (no till, no device token, no ping).

## 5. Slice 5c: requests and routing

- **`stock_requests` + `stock_request_items`** (written by a SALE branch's manager): the items wanted. Mirrored up like any fact.
- **HQ routes at once, no approval.** HQ keeps `supply_routes (sale_branch_id, stock_branch_id, rank)`: **the ordered list of stock branches per sale branch** ("nearest first"). It creates a **pick list** for the first stock branch (all the items) and sends it down to that branch only (`pick_lists` + items, `ids: 'same'`).
- **The stock branch tells HQ what it cannot supply.** It ships what it has (a shipment that references the pick list) and marks each shortfall line **cannot supply**. HQ then makes a new pick list for the **remainder** at the next branch in the list, excluding those that already said no, and so on. When no stock branch is left, the line is closed as **not available**. No backorders.
- **The requester sees the progress** (`request_status` rows down to it: per item, how much is on the way, received, or not available), and HQ keeps the **unmet demand** as a report for central buying.
- Routing is HQ's alone, so it only happens while HQ and the branches can talk; a request waits in the sale branch's outbox until then. Neither selling nor the branch's own stock work depends on it.

### 5.1 What was built (2026-11-28) and where it differs from the sketch above

- **A request** (branch, migration 0026, `modules/requests/`): `stock_requests` + `stock_request_items` (the header says how many lines there are), written by a SHOP's manager (`POST /stock-requests`, idempotent; a stock branch gets `409 ONLY_A_SHOP_REQUESTS`). It moves no stock. `GET /stock-requests` shows each line's progress from `request_status`.
- **The list of stock branches per shop** (HQ, migration 0013): `supply_routes` (admin: `PUT /branches/:id/supply-routes { stockBranchIds }`, in order, "nearest first"; the shop must be a sale branch and every entry a stock branch, each once). It is HQ's alone, not sent to branches. Setting it routes the requests that were waiting for one.
- **Routing** (`cloud-hq/src/modules/facts/routing.ts`, inside `applyFacts`): when a request is complete HQ writes a `request_status` row per line ("waiting") and `advance`s it: each waiting line goes to the **first stock branch in the list that has not been asked about that product**; the lines for one stock branch become ONE pick list, sent down to that branch only (header first). **HQ does not look at its own stock figures** (decided: the stock branch tells it). A shop with no list yet keeps its lines "waiting".
- **Filling a pick list** is ONE command at the stock branch, `POST /pick-lists/:id/fill { items: [{ productId, shipped }] }`: **every line must be answered** (0 up to the quantity asked: `ANSWER_EVERY_LINE`, `SHIPPED_EXCEEDS_ASKED`), in one transaction it ships what was answered (an ordinary shipment of P5b, reason `supply`) and writes `pick_results` + `pick_result_items` (what was asked and what was shipped; one answer per list, `ALREADY_ANSWERED`). **"Cannot supply" is a line shipped short**; no separate mark. Only a stock branch fills (`ONLY_A_STOCK_BRANCH_FILLS`). The screen starts each line at what is on the shelves.
- **Fallback:** when the answer is complete HQ adds what was shipped to each line, marks the pick list answered (the stock branch stops showing it), and the shortfall goes back to "waiting": `advance` sends it to the next stock branch. **When no stock branch is left the line is closed as "not available"** (no backorder), counted in the unmet demand. The shop sees every step (`waiting`, `picking`, `done` with what was shipped and what was not available).
- **HQ reports:** `GET /reports/requests` (each request: routing, open or closed, with its lines) and `GET /reports/unmet-demand` (by product: what shops asked for that no stock branch could supply, the demand central buying can see).
- **Screens:** the Transfers page by kind: a shop has *Requests* (ask, and follow each line), a stock branch has *To pick* (fill a pick list); both have *Coming in*, *Send* (a shop's is *Send back*) and *History*.
- **Not yet:** cancelling a request, HQ-made requests or reorder suggestions from the low-stock alerts (5f), a screen at HQ for the lists (API only), and the shop being told, line by line, when each shipment is received (it sees what was shipped).

## 6. Slice 5d: central purchasing

- **HQ-owned purchase orders** (`purchase_orders` + lines, with the quantity per stock branch, the supplier, the price and the currency). HQ pays the suppliers (supplier payments are HQ's).
- The order goes **down to each stock branch** as an expected delivery; the stock branch **receives** it (a branch-owned receiving fact with the quantities that really arrived: stock in, cost set as today by a received purchase). HQ tracks ordered against received per branch.
- **A connected branch's own purchase routes answer `409 HQ_OWNS_PURCHASING`** (decision #27), like the catalog. A branch that is not connected works as before. The branch's old `purchases`, `purchase_items` and `purchase_payments` keep going up for what was done before; new receiving of HQ orders uses its own tables (decided when 5d is built).

## 7. Slice 5e: shared customers

- **Identity is the phone number** (decision #22), normalised. A customer made at a branch goes up as a fact; HQ matches by phone and keeps one HQ customer. A customer without a phone stays branch-only and cannot buy on account.
- **One balance (rule 15 becomes chain-wide):** `balance = Σ open sales' rest across branches`. HQ is the authority. A customer's payment received at any branch is applied **oldest sale first across the whole chain** by HQ; each branch then reduces the `rest` of ITS OWN sales when HQ tells it to (a down message, applied in the branch's own transaction: one writer per row). A branch shows "last synced balance plus what happened here since" and reconciles on sync. No credit limit (a standing decision), so a stale balance is a bookkeeping reconcile, not a block.
- **One company** (decision #23): no settlement between branches. A sale belongs to the branch that made it; cash to the branch that received it.

## 8. Slice 5f: the central stock view

Stock per product per branch and **in transit** (from the movements and the shipments); low stock against HQ's alerts; **reorder suggestions** for stock branches; **rebalancing suggestions** (slow at one sale branch, fast at another: HQ only suggests, never forces, decision #32); the **unmet-demand** report.

## 9. Order of work

5a branch kind (built) → 5b shipments and receipts → 5c requests and routing → 5d central purchasing → 5e shared customers → 5f the central stock view. Each slice ends with the suites green, the sandbox chain passing and the docs updated.

## 10. Not decided yet (confirm when the slice is built)

Requests are made by a branch manager (not a cashier); HQ routes a request without an approval step; a received item's cost is blended into the receiver's by quantity; a stock branch's own screens (receiving, shipping, counts) are built with 5b.
