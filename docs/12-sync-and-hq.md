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

**The HQ server** (`cloud-hq`, run with `npm run dev --prefix cloud-hq` / `start`; port 4000 by default). Its own SQLite database through the shared adapter (`branch-server/core`, `@pos/core`), its own migrations folder. Configuration: `HQ_ADMIN_TOKEN` (required, at least 24 characters), `PORT`, `HOST` (localhost unless set), `DATABASE_PATH`, `ALLOWED_HOSTS`. HQ refuses a request for any host name or web page origin that is not its own or listed, sends no-store / no-sniff / no-frame headers, and rate-limits the open door in production.

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/api/v1/healthz` | open | `{ status: "ok" }` |
| GET/POST | `/api/v1/branches` | HQ staff | list / add `{ code (1-8 letters or digits), name }` → `201 { branch, enrolCode, expiresAt }` (the one-time code is shown once) |
| PATCH | `/api/v1/branches/{id}` | HQ staff | `{ name?, active? }` |
| POST | `/api/v1/branches/{id}/enrol-code` | HQ staff | a fresh one-time code (30 minutes, works once) |
| POST | `/api/v1/branches/{id}/revoke` | HQ staff | `204`; the branch's token stops working at once |
| POST | `/api/v1/sync/enrol` | **open, rate limited** | `{ code }` → `{ token, branch }`, the token shown once; `422 ENROL_CODE_INVALID` |
| GET | `/api/v1/sync/ping` | branch (`X-Branch-Token`) | `{ ok, serverTime, branch, changeSeq }` (`changeSeq` = HQ's latest change number, docs/14 §6); `401 BRANCH_UNKNOWN` |

HQ staff sign in with the **interim admin token** (`Authorization: Bearer <HQ_ADMIN_TOKEN>`, compared in constant time). That is deliberately temporary: HQ users with their own passwords and roles come with P3. Everything HQ changes is written to an append-only `hq_audit`, never a code or a token. Only hashes of codes and tokens are stored. The only open doors are `/healthz` and `/sync/enrol`; `cloud-hq/tests/hq.test.ts` proves every other route refuses an anonymous request and a garbage token.

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

**Next:** P3b, the products themselves (prices, barcodes, pictures, a paged first sync of about 8,000, the CSV import at HQ, and the branch's product screens read-only while connected: `docs/QUESTIONS.md` #15).

## 13. Shared code (`branch-server/core`, `@pos/core`)

The branch server and HQ share the database adapter and its SQLite driver, the migrations runner (each server has its own folder), RFC 7807 errors, input validation, and the credential helpers (one-time codes, tokens, constant-time compare). The old file locations in `branch-server` are one-line re-exports, so no import in the branch server changed; the full test suite passed unchanged after the move.
