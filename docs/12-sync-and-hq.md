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
- When a batch changes the catalog, the branch publishes `catalog.changed` on its live-updates stream, so every till refreshes within a second or two.

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
| **P2a** | `apps/central` (Fastify, SQLite through the adapter, its own migrations), HQ branches table and enrolment, `/sync/ping`, a dev command that starts HQ (:4000) and two branches (:3000, :3001) with their own data folders |
| **P2b** | Up, proven on sales: triggers, outbox, sender, HQ ingest and mirror tables for the sale cluster, the snapshot of existing history, digests |
| **P2c** | Down, proven on the exchange rate: HQ change log, branch puller and applier, `catalog.changed`/`rate.changed` events |
| **P2d** | The automatic reconnect loop and the chaos tests (three processes) |
| **P3** | Widen down: catalog, prices, branch price overrides, users, settings |
| **P4** | Widen up: every branch-owned table; HQ reports and dashboard; reconciliation screen |

## 10. Decisions for the owner

1. **Who may add or change products, prices and categories once a branch is connected?** **Decided 2026-11-23 (`QUESTIONS.md` #15): only at HQ.** At a connected branch the products, categories, brands, units and suppliers screens become read-only (P3 does this); HQ is the only place a product or a price changes. A branch that is not connected works as before. This is what makes the down path (§5) conflict-free.
2. Everything else in this document is a technical choice I will make unless you object: row-level capture by triggers, HQ mirror tables with `branch_id`, HQ adopting the first branch's catalog and ids, and starting with one table each way.

## 11. Risks

- **Triggers are SQLite-specific.** On PostgreSQL later they are rewritten once (plpgsql), like the append-only triggers, and the schema-parity test (`docs/11` §4) covers them.
- **Write cost.** A sale writes about 15 extra small outbox rows. Measured on the load test before it is trusted on the shop PC.
- **The snapshot of 180,000 sales** is a long first upload; it is resumable and runs in the background at low priority.
- **Clock differences** between branches: HQ stores both its own receipt time and the row's own time.
- **Security:** HQ is the first internet-facing part. TLS, rate limits, token rotation, and rule 21 (no secret in a log line) from day one; reviewed before any real branch connects.

## 12. What P2a built (2026-11-23)

**The HQ server** (`apps/central`, run with `npm run dev -w @pos/central` / `start`; port 4000 by default). Its own SQLite database through the shared adapter (`packages/core`, `@pos/core`), its own migrations folder. Configuration: `HQ_ADMIN_TOKEN` (required, at least 24 characters), `PORT`, `HOST` (localhost unless set), `DATABASE_PATH`, `ALLOWED_HOSTS`. HQ refuses a request for any host name or web page origin that is not its own or listed, sends no-store / no-sniff / no-frame headers, and rate-limits the open door in production.

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/api/v1/healthz` | open | `{ status: "ok" }` |
| GET/POST | `/api/v1/branches` | HQ staff | list / add `{ code (1-8 letters or digits), name }` → `201 { branch, enrolCode, expiresAt }` (the one-time code is shown once) |
| PATCH | `/api/v1/branches/{id}` | HQ staff | `{ name?, active? }` |
| POST | `/api/v1/branches/{id}/enrol-code` | HQ staff | a fresh one-time code (30 minutes, works once) |
| POST | `/api/v1/branches/{id}/revoke` | HQ staff | `204`; the branch's token stops working at once |
| POST | `/api/v1/sync/enrol` | **open, rate limited** | `{ code }` → `{ token, branch }`, the token shown once; `422 ENROL_CODE_INVALID` |
| GET | `/api/v1/sync/ping` | branch (`X-Branch-Token`) | `{ ok, serverTime, branch }`; `401 BRANCH_UNKNOWN` |

HQ staff sign in with the **interim admin token** (`Authorization: Bearer <HQ_ADMIN_TOKEN>`, compared in constant time). That is deliberately temporary: HQ users with their own passwords and roles come with P3. Everything HQ changes is written to an append-only `hq_audit`, never a code or a token. Only hashes of codes and tokens are stored. The only open doors are `/healthz` and `/sync/enrol`; `tests/central/hq.test.ts` proves every other route refuses an anonymous request and a garbage token.

**The branch side** (`apps/api`, migration `0017_hq_link.sql`, `modules/sync/`). An admin connects the branch with HQ's address and the one-time code. The branch trades it for its token, stores it in `hq_link` (**never returned, logged or audited**), and takes HQ's branch code and name for its own local branch row (printed on receipts later).

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/api/v1/sync/status` | admin | `{ linked, hqUrl, branch: { code, name }, connectedAt, state, since, lastOkAt, lastError }`; `state` is `unlinked`, `online`, `offline` or `refused` |
| POST | `/api/v1/sync/connect` | admin | `{ url, code }`; `400` for an address that is not `http(s)://host`, `422 ENROL_CODE_INVALID`, `502 HQ_UNREACHABLE` |
| POST | `/api/v1/sync/disconnect` | admin | back to working alone |

**The loop** (`modules/sync/agent.ts`, inside the branch server, never on the sale path): while HQ answers it asks every 10 s; when a call fails the state becomes `offline` and it asks again after 3 s, 6 s, 12 s ... up to 30 s; **the first answer after an outage starts the catch-up** (`onReconnect`, where P2b/P2c plug in); if HQ says the branch is no longer accepted the state is `refused` and it only checks once a minute. Each state change publishes `sync.changed` on the live-updates stream. The loop stops at once when the server closes (`preClose`).

**Run the whole thing on one machine:** `npm run dev:chain` starts HQ (:4000) and branches A (:3000) and B (:3001), each with its own data folder under `data/chain/`. With `CHAIN_ADMIN_PASSWORD=<any password for this throw-away data>` set it also creates an `admin` in each branch, adds the branches at HQ and connects them. It was run for real: both branches online, HQ saw both, no secret reached the output. To look at a branch's screen: `API_URL=http://127.0.0.1:3000 npm run dev -w @pos/web`.

**Not built yet:** the Settings > HQ screen (connect and status are API-only for now), HQ users (P3), and any data moving either way (P2b, P2c, P2d).

## 13. Shared code (`packages/core`, `@pos/core`)

The branch server and HQ share the database adapter and its SQLite driver, the migrations runner (each server has its own folder), RFC 7807 errors, input validation, and the credential helpers (one-time codes, tokens, constant-time compare). The old file locations in `apps/api` are one-line re-exports, so no import in the branch server changed; the full test suite passed unchanged after the move.
