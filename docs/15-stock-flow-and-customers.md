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

## 5. Slice 5c: requests and routing

- **`stock_requests` + `stock_request_items`** (written by a SALE branch's manager): the items wanted. Mirrored up like any fact.
- **HQ routes at once, no approval.** HQ keeps `supply_routes (sale_branch_id, stock_branch_id, rank)`: **the ordered list of stock branches per sale branch** ("nearest first"). It creates a **pick list** for the first stock branch (all the items) and sends it down to that branch only (`pick_lists` + items, `ids: 'same'`).
- **The stock branch tells HQ what it cannot supply.** It ships what it has (a shipment that references the pick list) and marks each shortfall line **cannot supply**. HQ then makes a new pick list for the **remainder** at the next branch in the list, excluding those that already said no, and so on. When no stock branch is left, the line is closed as **not available**. No backorders.
- **The requester sees the progress** (`request_status` rows down to it: per item, how much is on the way, received, or not available), and HQ keeps the **unmet demand** as a report for central buying.
- Routing is HQ's alone, so it only happens while HQ and the branches can talk; a request waits in the sale branch's outbox until then. Neither selling nor the branch's own stock work depends on it.

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
