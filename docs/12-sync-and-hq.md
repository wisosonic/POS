# 12 · Branch ↔ HQ sync: the P2 design

Status: **P2a is built and tested (2026-11-23): the HQ server, enrolment, the branch link and the loop that notices an outage and a recovery. Everything from §3 on (moving data in either direction) is still a proposal.** It turns `docs/11-multi-branch.md` §3.1-3.3 into something that can be built and tested. If this document and `docs/11` disagree, this one is newer.

## 1. What P2 must prove

A branch server and the HQ server, running as separate programs on the dev machine (different ports and data folders), exchange data **in both directions, automatically, and safely over a bad connection**:

- a branch sells while HQ is unreachable, and when the connection returns **everything arrives at HQ exactly once, with no manual step**;
- HQ changes a price or the exchange rate, and the branch gets it, also automatically;
- killing the connection in the middle of a batch, repeating a batch, or restarting either side never loses, duplicates or corrupts anything.

To keep the first slice small, P2 proves the protocol on **one table each way** (the exchange rate going down, sales going up). P3 widens what goes down (catalog, prices, users). P4 widens what goes up (everything a branch records) and builds the HQ reports.

## 2. Who owns what (decided in `docs/11` §3.1, repeated because everything depends on it)

- **HQ owns** the catalog (products, categories, brands, units, suppliers), prices, exchange rates, payment methods, users and roles, settings. They flow **down**.
- **A branch owns** everything it records: sales, returns, registers, stock movements, expenses, purchases received, audit rows. They flow **up** and are **never edited by sync**.
- Because each thing has exactly one owner, **there are no conflicts to resolve**.

## 3. Going up: capturing a branch's changes

**Proposal: row-level change capture with database triggers.** Each branch-owned table gets `AFTER INSERT`, `AFTER UPDATE` and `AFTER DELETE` triggers that write one small row to a `sync_outbox` table: `(seq, table, row id, operation)`. The row is written by the database in the same statement as the change, so it commits or rolls back together with the sale (rule 3).

Why triggers and not code in each service:
- **It cannot be forgotten.** A new module, the legacy import, a void and a permanent delete are all captured without anyone remembering to.
- **It needs no change to the money code**, which is already tested.
- The existing append-only triggers are unaffected.

How it ships:
- The outbox holds only *which row changed*. The sender reads the **current** row when it sends, so ten updates of the same sale become one message, and a deleted row becomes a tombstone.
- Messages go in batches of up to 200, oldest first. HQ **upserts** each row by `(branch, table, row id)`, which makes every message **idempotent**: sending it twice is harmless. HQ answers with the highest sequence number it applied, and the branch then deletes outbox rows up to it. A batch that fails is simply sent again.
- A sale is a cluster of rows (sale, lines, payments, stock movements, audit). Rows arrive in the order they were written, in one batch where possible, and HQ applies each batch in one transaction, so HQ never shows half a sale.

What is **not** captured: held carts, idempotency keys, approvals, print jobs, sessions (operational scratch data with no meaning at HQ).

The existing till's **history** (the 180,000 sales it already holds) does not go through the triggers. A one-off **snapshot** sends each table in key order, in resumable batches, tracked per table, then live capture takes over.

## 4. Where HQ keeps it

HQ has its own tables for each branch-owned table, with the same columns plus a leading `branch_id`, and the primary key `(branch_id, id)`. They are ordinary relational tables, so HQ reports are plain SQL aggregates (this is also what lets the heavy reports move off the JavaScript loops, see `docs/09`). A test compares every HQ table's columns with the branch's, so the two cannot drift apart.

## 5. Going down: HQ's changes

HQ-owned tables get the same trigger capture into a `change_log` on HQ. A branch asks `GET /sync/changes?cursor=<last seq>&limit=500`, applies the page in one transaction (upsert or delete by id), stores the new cursor, and asks again until there is nothing left. The first sync of 8,000 products is about 16 pages and is resumable.

- **Ids are HQ's.** A branch stores HQ-owned rows under the id HQ gave them (no local auto-numbering), so "product 4711" means the same thing everywhere. The first branch's existing catalog is adopted by HQ **with its current ids**, so nothing already sold is renumbered.
- When a batch changes the catalog, the branch publishes `catalog.changed` inside the server, which moves the `catalog` number in its ping, so every till refreshes within a few seconds.

## 6. Connecting a branch (enrolment)

HQ admin adds a branch (code, name) and gets a one-time code. At the branch, the admin enters HQ's address and the code (Settings → HQ). HQ answers with a long-lived **branch token**, stored hashed at HQ; the branch keeps it in its own database and never shows it again. Every sync call carries it. HQ accepts rows for **its own** branch only. The token can be revoked at HQ. (The same pattern as the till and the print agent.)

## 7. Automatic reconnect

The sync loop runs inside the branch server. While online it syncs every few seconds and right after each sale. When a call fails it goes quiet and **probes** HQ (`GET /sync/ping`, a few seconds apart, backing off to 30 s). **The first probe that succeeds starts a full catch-up**: push the backlog, then pull everything since the cursor. Each batch is its own short transaction, so a long catch-up never delays a sale. Nothing needs a person.

## 8. How we know it is right

- **Digests.** Periodically the branch sends, per table, a count and a checksum for a window of recent rows; HQ compares with its copy. A mismatch is shown on HQ's dashboard and makes the branch resend that range.
- **A three-process test** (HQ and two branches, real HTTP, temporary files): sell offline on both, reconnect, and check HQ equals each branch; repeat batches; cut the connection mid-batch; restart each side; check totals add up and nothing appears twice.
- **Invariants at HQ** after every test: Σ branch sales = HQ sales, stock = Σ movements, `customer balance = Σ open rest`, per branch.

## 9. Phases

| Step | Content |
|---|---|
| **P2a** | `cloud-hq` (Fastify, SQLite through the adapter, its own migrations), HQ branches table and enrolment, `/sync/ping`, a dev command that starts HQ (:4000) and two branches (:3000, :3001) with their own data folders |
| **P2b** | Up, proven on sales: triggers, outbox, sender, HQ ingest and mirror tables for the sale cluster, the snapshot of existing history, digests |
| **P2c** | Down, proven on the exchange rate: HQ change log, branch puller and applier, `catalog.changed`/`rate.changed` events |
| **P2d** | The automatic reconnect loop and the chaos tests (three processes) |
| **P3** | Widen down: catalog, prices, branch price overrides, users, settings |
| **P4** | Widen up: every branch-owned table; HQ reports and dashboard; reconciliation screen |

## 10. Decisions for the owner

1. **Who may add or change products, prices and categories once a branch is connected?** **Decided 2026-11-23 (`docs/QUESTIONS.md` #15): only at HQ.** At a connected branch the products, categories, brands, units and suppliers screens become read-only (P3 does this); HQ is the only place a product or a price changes. A branch that is not connected works as before. This is what makes the down path (§5) conflict-free.
2. Everything else in this document is a technical choice I will make unless you object: row-level capture by triggers, HQ mirror tables with `branch_id`, HQ adopting the first branch's catalog and ids, and starting with one table each way.

## 11. Risks

- **Triggers are SQLite-specific.** On PostgreSQL later they are rewritten once (plpgsql), like the append-only triggers, and the schema-parity test (`docs/11` §4) covers them.
- **Write cost.** A sale writes about 15 extra small outbox rows. Measured on the load test before it is trusted on the shop PC.
- **The snapshot of 180,000 sales** is a long first upload; it is resumable and runs in the background at low priority.
- **Clock differences** between branches: HQ stores both its own receipt time and the row's own time.
- **Security:** HQ is the first internet-facing part. TLS, rate limits, token rotation, and rule 21 (no secret in a log line) from day one; reviewed before any real branch connects.

## 12. What P2a built (2026-11-23)

**The HQ server** (`cloud-hq`, run with `npm run dev --prefix cloud-hq` / `start`; port 4000 by default). Its own SQLite database through the shared adapter (`branch-server/core`, `@pos/core`), its own migrations folder. Configuration: `HQ_ADMIN_TOKEN` (optional break-glass credential, at least 24 characters if set; §21), `UPLOADS_DIR`, `PORT`, `HOST` (localhost unless set), `DATABASE_PATH`, `ALLOWED_HOSTS`. HQ refuses a request for any host name or web page origin that is not its own or listed, sends no-store / no-sniff / no-frame headers, and rate-limits the open door in production.

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/api/v1/healthz` | open | `{ status: "ok" }` |
| GET/POST | `/api/v1/branches` | HQ staff | list / add `{ code (1-8 letters or digits), name }` → `201 { branch, enrolCode, expiresAt }` (the one-time code is shown once) |
| PATCH | `/api/v1/branches/{id}` | HQ staff | `{ name?, active? }` |
| POST | `/api/v1/branches/{id}/enrol-code` | HQ staff | a fresh one-time code (30 minutes, works once) |
| POST | `/api/v1/branches/{id}/revoke` | HQ staff | `204`; the branch's token stops working at once |
| POST | `/api/v1/sync/enrol` | **open, rate limited** | `{ code }` → `{ token, branch }`, the token shown once; `422 ENROL_CODE_INVALID` |
| GET | `/api/v1/sync/ping` | branch (`X-Branch-Token`) | `{ ok, serverTime, branch, changeSeq }` (`changeSeq` = HQ's latest change number, docs/14 §6); `401 BRANCH_UNKNOWN` |

HQ staff sign in with their own accounts (§21: name, password, role). Everything HQ changes is written to an append-only `hq_audit` that says who made the change, never a code, a password or a token. Only hashes of codes, passwords and tokens are stored. The only open doors are `/healthz`, `/sync/enrol` and `/auth/login`; `cloud-hq/tests/hq.test.ts` proves every other route refuses an anonymous request and a garbage token.

**The branch side** (`branch-server`, migration `0017_hq_link.sql`, `modules/sync/`). An admin connects the branch with HQ's address and the one-time code. The branch trades it for its token, stores it in `hq_link` (**never returned, logged or audited**), and takes HQ's branch code and name for its own local branch row (printed on receipts later).

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/api/v1/sync/status` | admin | `{ linked, hqUrl, branch: { code, name }, connectedAt, state, since, lastOkAt, lastError }`; `state` is `unlinked`, `online`, `offline` or `refused` |
| POST | `/api/v1/sync/connect` | admin | `{ url, code }`; `400` for an address that is not `http(s)://host`, `422 ENROL_CODE_INVALID`, `502 HQ_UNREACHABLE` |
| POST | `/api/v1/sync/disconnect` | admin | back to working alone |

**The loop** (`modules/sync/agent.ts`, inside the branch server, never on the sale path): while HQ answers it pings every 5 s and pulls changes only when the ping's `changeSeq` is ahead of what it applied (or every 60 s as a safety net); when a call fails the state becomes `offline` and it asks again after 3 s, 6 s, 12 s ... up to 30 s; **the first answer after an outage starts the catch-up** (`onReconnect`, where P2b/P2c plug in); if HQ says the branch is no longer accepted the state is `refused` and it only checks once a minute. Each state change publishes `sync.changed` (the `sync` number of the ping). The loop stops at once when the server closes (`preClose`).

**Run the whole thing on one machine:** `npm run dev:chain` starts HQ (:4000) and branches A (:3000) and B (:3001), each with its own data folder under `data/chain/`. With `CHAIN_ADMIN_PASSWORD=<any password for this throw-away data>` set it also creates an `admin` in each branch, adds the branches at HQ and connects them. It was run for real: both branches online, HQ saw both, no secret reached the output. To look at a branch's screen: `API_URL=http://127.0.0.1:3000 npm run dev --prefix till/web`.

**Not built yet:** the Settings > HQ screen (connect and status are API-only for now), HQ users (P3), and the chaos tests (P2d). Going up is P2b, §14; going down is P2c, §15.

## 14. What P2b built (2026-11-24): the sale cluster goes up

**Which rows:** `sales`, `sale_items`, `payments`, `stock_movements`, listed once in `branch-server/core/src/sync.ts` (column names, whether each may be empty). That list is the contract: the sender, HQ's checks, the digests and a parity test (`branch-server/tests/db/sync-schema.test.ts`) all read it, so a column added to a branch table fails the test until HQ's table and the list know it too.

**Capturing (branch, migration 0018).** Three triggers per table (insert, update, delete) write `(table, id, 'u' or 'd')` to `sync_outbox` **in the same statement**, so a sale that rolls back leaves nothing. They fire only while `sync_control.capture = 1`, which `saveLink` sets when the branch connects and `clearLink` clears (and empties the outbox), so a shop that is not connected records nothing. The outbox says WHICH row changed; the sender reads the row as it is now, so ten changes to a sale are one message and a row deleted since goes out as a deletion. History that existed before connecting is covered by `sync_snapshot` (per table: the highest id at connecting, how far it got, done).

**Sending (`modules/sync/up.ts`).** `pushOnce` sends one batch (default 200 rows): the outbox first, oldest first, then the snapshot table by table. The outbox is cleared **only after HQ answers OK**, so a failure or a lost answer sends the same batch again. The agent calls it after every successful ping (up to 40 batches a round, then takes a breath), and a sale wakes it after 250 ms. It never runs inside a sale's transaction and its network calls are outside any transaction.

**Storing (HQ, migration 0002).** Mirror tables with the same columns plus `branch_id` and `hq_received_at`, keyed `(branch_id, id)`, no foreign keys (a sale's lines may arrive in another batch). `POST /sync/facts` checks the whole batch, then applies it in one transaction with `INSERT ... ON CONFLICT DO UPDATE` or `DELETE`. A batch with any bad row is refused whole (`422 FACTS_INVALID`), so a version mismatch is loud, not a silent loss. The branch id comes from the token, never the body.

**Proof.** `digestRows` gives `{ count, maxPk, checksum }` (the checksum is order-independent: the sum of 48-bit SHA-256 prefixes of each row). `GET /sync/verify` at the branch compares its tables with HQ's `GET /sync/digest`; `inSync` is true only when nothing is waiting and every table matches. The integration test uses it after every scenario.

**Known limits.** A sale's rows can land at HQ in different batches, so HQ may briefly show a sale without its lines (it heals on the next batch; reports at HQ must wait for P4's reconciliation before they trust a recent minute). Only the sale cluster goes up. The cost of the triggers on a busy till is not measured yet.

## 15. What P2c built (2026-11-24): HQ's changes go down, starting with the exchange rate

**At HQ (migration 0003).** `exchange_rates` and an append-only `change_log` (never edited or deleted, by trigger). Adding a rate (`POST /exchange-rates`, HQ staff) writes the rate, the log line and an audit row in ONE transaction; the code writes the log line, not a trigger, so it is the same on PostgreSQL later. `GET /sync/changes?cursor=&limit=` (branch token) returns the next page of the log with each row **as it is now** (a row deleted since goes out as a deletion), `next` and `more`.

**At the branch (migration 0019).** `sync_control.down_cursor` remembers how far it got; `exchange_rates.hq_id` keeps HQ's id apart from ids the branch made itself (unique). `modules/sync/down.ts` `pullOnce` asks for the page after the cursor, checks the WHOLE page (known table, well-formed rows, increasing numbers), applies it and moves the cursor in ONE short transaction, and says whether there is more. A bad page is refused whole and the cursor does not move; applying a page twice changes nothing (upsert on `hq_id`). The loop pulls **before** it pushes after every ping (a new rate matters before the next sale) and tells the screens with `rate.changed`. Connecting or disconnecting resets the cursor, so a new HQ is read from its beginning.

**Rule:** while a branch is connected it cannot set its own rate (`409 HQ_OWNS_RATES`): two sources would fight. If HQ is unreachable the branch keeps selling at the last rate it received. Not connected, it works as before.

**How fast:** the branch asks every 10 s, so a new rate reaches every branch within about ten seconds. There is no push from HQ yet (a stream from HQ is an option if that is ever too slow).

**Same pattern for what comes next (P3):** add the table to `DOWN_TABLES` (`branch-server/core/src/sync.ts`, copied to `cloud-hq/core`), a table at HQ with a `change_log` line written by its service, and either `ids: 'mapped'` (a `hq_id` column at the branch and a case in `applyChange`: the rate) or `ids: 'same'` (§17: the branch uses HQ's id as its own, no branch code needed). `cloud-hq/tests/system/sync-schema.test.ts` checks the lists agree.

## 16. What P2d proved (2026-11-24): two branches and HQ under failure

`branch-server/tests/integration/sync-chaos.test.ts` runs HQ and TWO real branch servers over real HTTP. Both branches are seeded the same way, so they have the same ids and the same receipt numbers, which HQ must keep apart. Proven: the two add up at HQ (sales, lines, payments, stock movements: counts and sums, per branch and in total); a rate set at HQ reaches both; both sell while HQ is gone and catch up by themselves when it returns; with 30% of calls failing and 30% of answers lost (a seeded generator, so a failure can be repeated) while both sell at the same time, HQ ends with every row once; and a branch server stopped and started again in the middle of a backlog stays connected and finishes sending.

**Not covered:** a crash in the middle of a database write (SQLite and the transactions cover it, but it is not simulated), clock differences between machines, a branch that is away for weeks with a very large backlog, and anything over a real internet link (everything here is one machine).

## 17. What P3a built (2026-11-27): the catalog's lists go down with HQ's ids

**What:** categories, brands, units and suppliers. HQ owns them (migration 0004, `cloud-hq/src/modules/catalog/`): `GET/POST /categories|/brands|/units|/suppliers` and `PATCH /<list>/:id` (HQ staff). A name is unique per list (case-insensitive, `409 DUPLICATE_NAME`). **There is no delete** (a product may point at one; renaming covers the need, as at a branch). Every create or rename writes its `change_log` line and an `hq_audit` row in the same transaction. A new HQ already holds the three units every branch starts with (Piece, KG, Box: ids 1 to 3), with their log lines.

**One id everywhere (the decision of P3a).** Unlike the rate, a connected branch stores these rows **under HQ's id as its own id** (`DOWN_TABLES` `ids: 'same'`; an upsert on `id`, applied in the same page transaction as everything else). So a product that will point at category 7 means the same category at HQ and at every branch, and HQ's reports need no id translation. **This only works if the branch had no catalog of its own when it connected**, so:

- `POST /sync/connect` is refused with `409 CATALOG_NOT_EMPTY` if the branch has any product, category, brand or supplier, or a unit besides its three starting ones. The check runs **before** the one-time code is spent, so a refusal wastes nothing. A fresh install passes; the products are then added at HQ.
- Exception: a branch whose catalog already came from **this HQ** (`sync_control.catalog_hq_url`, migration 0022) may connect again with a new code (a lost token). A different HQ is refused. To move a branch with a catalog to another HQ, start it from a fresh data folder.
- While connected the branch cannot change these four lists (`409 HQ_OWNS_CATALOG`, as `HQ_OWNS_RATES` for the rate). Expense categories and service types stay the branch's own.
- The screens are told with `catalog.changed` (the `catalog` number of the ping).
- Tests that connect the seeded test branch (it has a catalog) switch the check off with `sync: { catalogGate: false }`; `startCtx` does that by default. `cloud-hq/tests/system/catalog-lists.test.ts` leaves it on.

**Next:** P3b2 (pictures and the CSV import at HQ), then P3c.

## 18. What P3b built (2026-11-27): the products go down

**At HQ (migration 0005, `cloud-hq/src/modules/catalog/products.ts`, `productRoutes.ts`).** `products` with the same columns as a branch's (no picture yet). `GET/POST /products`, `GET/PATCH /products/:id`, `DELETE /products/:id` (HQ staff). **There is no real delete**: `DELETE` retires (`active = 0`); a retired product still goes down so the branches hide it, and its history stays whole. **One active product per barcode, from the start** (a partial unique index, plus a clear `409 DUPLICATE_BARCODE` first): a new chain has no legacy duplicates, so unlike a branch (rule 18) HQ does not start with the rule off. A link (category, brand, unit, supplier) must exist at HQ (`422`). The receipt name is made from the name as at a branch (`cloud-hq/shared`, a copy of `branch-server/shared`, the master), and a manual one sticks. A patch changes only the fields it names, and **a patch that changes nothing writes nothing** (no log line, `updated_at` unchanged). Each change writes the product, its `change_log` line and an `hq_audit` row in one transaction.

**At the branch (`modules/sync/down.ts` `applyProduct`).** An upsert on HQ's id, with two deliberate differences from the lists:
- **`cost_minor` is HQ's starting cost only.** It is taken when the product first arrives and never overwritten after, because the branch's own purchases set the cost (`purchases/service.ts`) and an HQ change would otherwise erase it. (A cost that HQ should push is a later decision, P3c.)
- **`updated_at` is the branch's own clock and moves only when something really changed** (`WHERE ... IS DISTINCT FROM`). The till's catalog feed (`/products/sync`, `/terminal/catalog`) follows `updated_at`: an HQ timestamp older than the till's last sync would be skipped for ever, and moving it on a repeated page would make every till download all its products again.

**Read-only at a connected branch.** `POST /products`, `PATCH` and `DELETE /products/:id`, `POST /products/import`, `POST /products/merge` and `POST /barcodes/enforce` answer `409 HQ_OWNS_CATALOG` while the branch is connected (`modules/catalog/hqOwned.ts`, shared with the four lists). Product **pictures** are not covered yet: they stay a branch matter until P3b2 brings them down. Stock, purchases (and so cost) and everything else are untouched.

**First sync:** the existing paged log does it: about 8,000 products are 16 pages of 500, each applied in one transaction. `cloud-hq/tests/system/catalog-products.test.ts` connects a fresh branch to an HQ holding 1,200 products and checks the two end with the same count, sum of prices, ids and name lengths.

**Not covered yet:** the HQ screens (everything is API only), HQ-side stock alerts per branch. (Pictures and the CSV import are §19.)

## 19. What P3b2 built (2026-11-27): the CSV import at HQ, pictures, and read-only screens

**The CSV import at HQ** (`cloud-hq/src/modules/catalog/import.ts`, `POST /products/import`, HQ staff). The same rules as the branch's import had (US-15), ported to HQ's adapter: nothing is guessed, every row is checked, **a file with any error writes nothing**, `dryRun` defaults to true, an empty cell leaves a product as it is, units are never created, a barcode shortened by a spreadsheet (`7.6E+12`) is refused, the same barcode or product twice in one file is an error. Applying is **one transaction**: every product, every new list entry (`createMissing`), every `change_log` line and audit row commit together. Differences from the branch's: only **active** products are matched by barcode or name (a retired product's barcode is free, so a row with it adds a new product), and the limits are bigger (20,000 rows, 8 MB) because HQ holds the whole chain. The branch's own import and its screen stay for a branch that is not connected.

**Pictures.** HQ keeps a picture under a name made from its own content (`<24 hex digits>.<ext>`, judged by its bytes, never SVG; `cloud-hq/src/modules/catalog/images.ts` is a copy of the branch's), in `UPLOADS_DIR` (default `uploads` next to the HQ database). `POST /products/:id/image` (the file as the body) and `DELETE /products/:id/image`, HQ staff; a no-op writes nothing. `image_path` is a column of the down list, so it reaches the branch with the product. **The file is fetched by the branch** (`modules/sync/images.ts`, after each pull round): for each picture a product names and the branch does not have, `GET /sync/images/:name` (branch token; only names of that one shape are served), at most 100 per round. **The name is made from the content, so what arrives is checked against it**: a file whose content does not give the name is not kept under it (a damaged or swapped file), and it is asked for again at the next round until HQ's copy is right. A picture that cannot be fetched now never blocks the loop and never fails the product: it shows without its picture until it arrives. The branch serves it from its own `/uploads/<name>` as before (so the tills load it from there).

**Read-only screens.** `GET /settings/public` now says `hqOwnsCatalog` (true while connected; nothing secret). The till's **Products** screen hides *New product*, *Import CSV* and *Edit* (the *Stock* button stays: stock is the branch's), **Lists** hides the add form, *Rename* and the weight checkbox for the four HQ lists (expense and service types stay editable), and **Duplicate barcodes** says HQ keeps every barcode unique; each shows a note "Managed at HQ" (`components/HqNotice.tsx`, Arabic included). The connect or disconnect reaches the screens through the `sync` number of the ping. Branch picture upload and removal answer `409 HQ_OWNS_CATALOG` too.

**Tests:** `cloud-hq/tests/system/catalog-import.test.ts`, `catalog-pictures.test.ts` (new), `till/tests/e2e/hq-owns-catalog.spec.ts` (the screens, with the branch's answer changed on the way).

**Not covered yet:** the HQ screens themselves (the API is all there is), picture resizing, and cleaning pictures nothing points at any more (they stay in the folder, as at a branch).

## 20. What P3c built (2026-11-27): a branch's own price for a product

**The idea.** A branch may sell a product at its own price. HQ keeps the override; **the branch is never told "there is an override"**. It receives the product with the price it should sell at (the override if there is one, else the base price), and stores that in its ordinary `price_minor`. So selling needs **no new rule at the branch**: `createSale`, the till catalog feed, receipts and reports all already read `products.price_minor`. The rule "price from the override first, the base price second" lives in one place, HQ's change feed.

**At HQ (migration 0007).** `branch_prices (branch_id, product_id, price_minor)`, one row per branch and product, the price in the **product's own currency** (a cost and a price in two currencies would make a profit meaningless). `PUT /branches/:id/prices/:productId { priceMinor }`, `DELETE` the same (back to the base price), `GET /branches/:id/prices` (with the product name, its base price and the override), `GET /products/:id/prices` (which branches have their own). HQ staff only. Setting the price a branch already has, or removing one that is not there, **writes nothing**. A product's currency cannot be changed while any branch has an override for it (`409 PRICE_OVERRIDES_EXIST`).

**The change log can be meant for one branch.** `change_log.branch_id` (NULL = every branch, as before). An override writes a line for THAT branch only (with the row, the line and an audit row in one transaction). When a branch reads the log (`changesAfter`), it sees the lines for everyone and for itself, and each product row is built **for that branch**: `COALESCE(its override, the base price)`. So a change of the BASE price (a line for everyone) reaches every branch at the right price for each, and an override stays where it is. A branch that connects later gets its own price from the start (rows are read as they are now).

**Another branch's override must not make a branch ask again and again.** The ping's `changeSeq` and the page's `next` are both computed over only the lines this branch can see (`branch_id IS NULL OR = its id`), so branch B's cursor never falls behind a line it will never receive. `catalog-prices.test.ts` proves B's "news" number and cursor do not move when A's price changes.

**Not covered yet:** a screen at HQ (API only), an import of overrides from a CSV, a price per branch GROUP, a cost per branch from HQ, and a scheduled start (an override takes effect when it reaches the branch; a price change in the middle of a sale does not touch the sale, which is priced once on the server).

## 21. What P3d built (2026-11-27): HQ staff accounts

**Why.** HQ is the first part reachable from the internet, and until now one long-lived token opened everything and said nobody. Now people have their own accounts, and every change says who made it.

**Accounts (`cloud-hq/src/modules/staff/`, migration 0008).** `hq_users`: a lower-case name (3 to 40 characters), a display name, a role, an **Argon2id** password hash (`@node-rs/argon2`, same settings as a branch), `active`, `must_reset_password`. Roles are ranked: **viewer** (reads everything), **catalog** (also changes products, their lists, prices, the import and the exchange rate), **admin** (also branches and people). A password has **at least 12 characters**. `POST /users` (admin) makes an account with a password the admin chose and `must_reset_password`: **the server stops that person from doing anything but `/auth/me`, `/auth/password` and `/auth/logout`** (`403 PASSWORD_RESET_REQUIRED`) until they choose their own. `PATCH /users/:id` changes name, role or `active`; a changed role or a closed account signs the person out at once; **HQ always keeps one active admin** (`409 LAST_ADMIN`). `POST /users/:id/password` (admin) resets a password (and the person must choose a new one).

**Signing in (the third open door).** `POST /auth/login { username, password }` answers `{ token, expiresAt, user }`. The token is an opaque 256-bit value, **shown once and stored only as a hash** (`hq_sessions`), valid 8 hours, ended by `POST /auth/logout`, a password change, a changed role or a closed account. The sign-in is rate limited (10 a minute per address, in production), **five wrong passwords lock the account for 15 minutes** (`429 ACCOUNT_LOCKED`, cleared by an admin's reset), and a wrong name, a wrong password and a closed account **answer the same** (`401 INVALID_CREDENTIALS`) and take the same time (an unknown name is checked against a dummy hash), so the answer does not say which names exist. Hashing is done before a transaction is opened (the adapter forbids waiting inside one). `GET /auth/me`, `POST /auth/password { current, password }` (closes every session and returns a fresh one).

**The audit says who.** `hq_audit.actor`: `user:<name>`, `token` (the break-glass token) or empty (a branch enrolling, a script). It is set by `asStaff` (`app.staffTx(req, fn)`) in the same transaction as the change, through a one-row `hq_context` that is cleared again inside it, so the code that writes an audit row (`writeAudit`, the only way) knows nothing about people, and a failed transaction never leaves a stale name behind.

**The first admin, and the old token.** `npm run create-admin --prefix cloud-hq -- <name> <password>` makes (or resets) an admin without any token. `HQ_ADMIN_TOKEN` is now **optional**: if set it still works as an admin (for a first start or an emergency), audited as `token`; **leave it unset once the admins have accounts**. The sandbox chain test runs HQ without it. A locked-out admin can be reset with `create-admin` too.

**Not covered yet:** HQ screens (everything is API), two-factor sign-in, a password-expiry rule, per-branch permissions for HQ staff (a catalog person sees every branch), and **the people who work at a branch** (`docs/QUESTIONS.md` #21: they stay local to each branch until HR, P6). A locked account is also an easy way to lock a real admin out (known trade-off of any lockout); `create-admin` is the way back in.

## 13. Shared code (`branch-server/core`, `@pos/core`)

The branch server and HQ share the database adapter and its SQLite driver, the migrations runner (each server has its own folder), RFC 7807 errors, input validation, and the credential helpers (one-time codes, tokens, constant-time compare). The old file locations in `branch-server` are one-line re-exports, so no import in the branch server changed; the full test suite passed unchanged after the move.
