# 14 · Connection, ping and the till's own backend

**Status:** design note, 2026-11-27. **Steps 1 to 3 of §9 are built (the ping on the branch server; the link monitor and the block on selling; the till's catalog copy on disk); the rest is not**. Decided by the product owner on 2026-11-27 (see §1). It changes how a till behaves when the branch server is unreachable, replaces the live-update stream with a ping, and gives the till a real Node backend that keeps its own copy of the items. Read `docs/11-multi-branch.md` §8.4 (the till's own server today) and `docs/12-sync-and-hq.md` first.

## 1. What the owner decided (2026-11-27)

1. **A till stops taking sales while the branch server is unreachable.** It shows a message that says so, keeps checking, and starts again by itself when the server answers. There is no offline selling and no queue of sales (this reverses US-10, see §8).
2. **No WebSocket.** A **ping** replaces it: a small request, every few seconds, whose answer carries the latest version of what the till keeps a copy of. The same ping is the heartbeat and the change detector.
3. **The till has a backend of its own** (the Node program in `till/agent`, today a thin proxy) and **it keeps a copy of the items and prices** on disk.
4. **Users stay on the branch server** and people sign in there with a **JWT**. The till backend never stores a password, a hash or a user list.
5. Prices are changed **only at HQ** (already decided, `docs/QUESTIONS.md` #15). A branch with no HQ link keeps editing its own prices (the branch locks an HQ-owned row only while connected, as now).

Not taken from the owner's first sketch, and why:
- **No push to a till's IP address.** A till is a browser plus a Node process that opens connections *out* to the branch server. The branch server never calls a till, so it never needs a till's IP, and DHCP, firewalls and `127.0.0.1` stop mattering.
- **No "till IP" field in the enrolment wizard.** A till is identified by its device token (a one-time code, stored only as a hash), not by an address that changes and can be shared. The server may record the address it saw, for display only.

## 2. The three links

```
 browser (screens)  ──localhost──▶  till backend (Node, till/agent)  ──LAN, ping + calls──▶  branch server  ──internet, ping + pull──▶  HQ
```

- **Browser to till backend:** same PC, always reachable. The browser asks its own backend for the connection state, so a screen can say *which* link is down: "this till program is not answering" or "the branch server is not answering".
- **Till backend to branch server:** the ping (§3), plus every call the screens make, passed through. The till backend decides no money and no stock.
- **Branch server to HQ:** the same ping pattern (§6). The branch always connects *out*.

## 3. The ping

`GET /api/v1/ping`, called by the till backend every **3 seconds** (a 2-second timeout; two misses in a row mean "down", so one slow answer does not flicker the till).

- **Who may call it:** a till with a device token (`X-Terminal-Token`), so it is **not** a new open door (rule 19). A caller with an unknown token gets the usual `401 TERMINAL_UNKNOWN`. (`/healthz` stays the one open check.)
- **The answer is small and has no business data:**

```json
{ "ok": true, "serverTime": "2026-11-27T09:00:00.000Z", "epoch": "b7e1c0…", "versions": { "catalog": 4812, "rate": 7, "settings": 3, "register": 912, "wallets": 40 } }
```

- **A version is a number that only goes up, not a timestamp.** Two edits in one millisecond, or a clock that moves, would fool a timestamp. The branch server keeps one counter per topic **in memory** (`events/versions.ts`, no table and no migration) and raises it every time the live-update bus publishes the matching event, from whatever source (a request through the `eventsFor` hook in `app.ts`, or the sync loop applying an HQ change). `epoch` is a random id made when the server starts; if it differs from the one the till last saw, the till refetches everything, whatever the numbers say (a restored backup can make a counter go backwards).
- **The till compares for *different*, not *greater*,** and fetches only the topics that differ: the catalog by its existing cursor feed (`/products/sync`), the rate, the settings, the register, the wallets.
- **Cost:** 50 tills every 3 seconds is about 17 tiny requests a second. A price change reaches a till within one interval (3 to 5 seconds), which is fine for prices.

`GET /events` (SSE) and the code that closes it on shutdown go away once the ping covers every topic the stream carries today. Until then both exist.

## 4. The till backend (`till/agent`)

Today it serves the screens, passes `/api` through, runs the print agent and keeps the branch server's address. It gains:

1. **A link monitor.** Does the ping, keeps the state `connected | down`, and exposes it to the browser (`GET /till/link`, this PC only) with the reason. It also reports the last time the server answered.
2. **A copy of the catalog, on disk.** A SQLite file in the till's data folder (`better-sqlite3`, like the other projects; the till still imports nothing from another project): every product and price, the units, the cursor. It is filled and kept current by the ping (§3) using the existing paged feed. The screens read it through the same `/api/v1/products/sync` route, which the till backend now answers itself from its copy, so the browser code barely changes and the browser's own IndexedDB copy can go. **The copy is read-only: it never changes a price and never prices a sale** (rule 2: the server decides totals).
3. **The sale in doubt.** When the cashier presses Complete, the till backend writes the sale (its `clientSaleId`, which is also its idempotency key) to a journal on disk *before* it forwards it, and removes the entry when the server answers. If the link drops with a sale unanswered, the journal keeps it and the till backend **retries with the same key** when the server is back. The screen says "this sale is not confirmed yet" and blocks new sales until it is (at most one per till). This is not an offline queue: it only protects the one sale that was in flight, and a replay is harmless (rule 6).
4. **Everything it already does,** unchanged: the screens, the pass-through and its `X-Till-Proxy-Error` failure marks, printing, the address setting, the Host/Origin checks.

**What stays on the branch server and is never copied:** stock levels and the ledger, customer balances, register figures, the wallet ledger, users, approvals.

## 5. Signing in (JWT, unchanged, kept on the branch server)

Already built: `POST /auth/login` returns a **15-minute access token** (`@fastify/jwt`, carrying only the user id) and sets a rotating, hashed **refresh cookie** (`pos_refresh`); the role and the active flag are read from the database on every request, so removing a user or changing a role works at once. **Nothing here changes.** What the till backend adds:

- It **forwards** the sign-in and the refresh unchanged (it is the proxy it already is) and **never reads, stores or logs** a password, a PIN, an access token or the refresh cookie (rules 11 and 21). The refresh cookie stays an HttpOnly cookie held by the browser.
- Every call still carries two things: **who** (the JWT) and **which till** (the device token). The server checks both, as now.
- **Sign-in needs the branch server.** With it down nobody can sign in, and nobody can sell anyway. A person already signed in stays signed in on screen; they cannot complete a sale until the server is back.

## 6. Branch to HQ

The branch's sync loop (`modules/sync/agent.ts`) keeps its rules (short transactions, network calls outside any transaction, never blocks a sale or a shutdown) and changes in one way: it calls **`GET /sync/ping`** every 5 seconds with its branch token, and HQ answers with its latest `change_log` sequence number. The branch pulls only when that number differs from its `down_cursor`, and keeps a slow safety pull (once a minute). Pushing facts up is unchanged (after each commit, and on reconnect). **A lost HQ never blocks selling:** the branch keeps selling with the last prices it has, exactly as now.

## 7. The first-run wizard (one flow)

Built from what exists (*Settings → Tills* enrols a device; the connection page takes an address and tests it). In one guided flow on a new till: **1** the branch server's address, tested with *Test connection* before going on; **2** the one-time code the admin made for this till (name and code come from *Settings → Tills* on the branch); **3** done: the till has its device token and starts its catalog copy. No IP field. The first-run wizard for the whole product (company name, branches, first admin, product CSV; docs/QUESTIONS.md, product decisions) is a separate, later piece.

## 8. What this changes in what we already wrote

- **US-10 and the decision table** (offline selling, the queue in the browser, "Pending N" badge): replaced by "a till stops selling while the branch server is unreachable" (§1). `docs/03` and `docs/02` are updated when step 2 is built.
- **The sales queue in the browser (`lib/outbox.ts`) and `POST /sales/queued-discard`:** go away after the sale-in-doubt journal exists, and after any sale already queued in a browser at upgrade time has been sent (the upgrade sends first and refuses to remove a non-empty queue).
- **`CLAUDE.md`:** the pitfall that says a queued sale is "not in the system" and the live-updates pitfall (`GET /events`) are rewritten; the `X-Till-Proxy-Error` pitfall stays but now means "block selling", not "queue the sale".
- **Browser catalog cache (`lib/catalog.ts` + IndexedDB):** replaced by the till backend's copy.
- **Sandbox chain test:** the step "the branch server goes away" now expects selling to stop and to come back; a step is added for a price changed at HQ reaching the till's copy.

## 9. Build order (each step ends green and updates this note and the plan's Progress)

1. **`GET /api/v1/ping`** on the branch server. **Built (2026-11-27):** `events/versions.ts` (`TopicVersions`, in memory, fed by `bus.tap`), `modules/ping/routes.ts` (device-token guard, no legacy no-token shortcut), `docs/06`; tests `unit/versions` (4) and `integration/ping` (12: who may ping, the shape, the epoch, numbers that only rise and only for a real change); the existing anonymous and garbage-token security tests cover the new route without an edit. **Decision while building:** the counters are in memory with the `epoch`, not a table, because a restart already forces a refetch through the epoch (and a restore happens at a restart), so a table would add a migration and nothing else. **Consequence for step 2:** the till backend must be enrolled (it needs a device token to ping); a shop still in legacy single-till mode (no token) is "not enrolled" to the link monitor and the wizard (§7) is how it gets enrolled.
2. **The link monitor** in the till backend and its `GET /till/link`. **Built (2026-11-27):** `till/agent/src/link.ts` (`createLinkMonitor`: ping every 3 s with a 2 s timeout, `down` after 2 misses in a row, `connected` again on the first good answer, never two questions at once, stops with the server) and `GET /till/link` in `tillServer.ts` (this PC only; it returns the state, `blocked`, the reason and, when pinging, the epoch and versions, never the token). **The token:** the browser keeps the device token (`lib/terminal.ts`); it sends it on its `/till/link` poll and on every passed-through call, and the monitor holds it **in memory only** (never on disk or in a log). A poll with no token puts the heartbeat on the open `GET /api/v1/healthz` (legacy single-till shop, or not enrolled yet), which still stops selling when the server is gone. A server that answers `TERMINAL_UNKNOWN`/`TERMINAL_REQUIRED` is reachable (`not_a_till`, not blocked). **The screens:** `store/link.ts` polls every 2 s; `TillLayout` shows the banner (`selling-stopped`, with the reason in plain words); `CartPanel` PAY, `openPay` (so F9 too) and `PayDialog` Complete and On account are off while stopped; the cart is kept; a page served by the branch server itself (no `/till/link`) has no heartbeat and nothing is stopped. Tests: `till/agent/tests/link.test.ts`, `web/tests/link.test.ts`, browser `e2e/link` (2), and a step in the sandbox chain test. **Not yet:** the one-sale journal and the removal of the browser outbox (step 4), so `US-10`'s old queue still exists; sign-in and the other money screens (returns, customer payments) simply fail as before while the server is away. the screens block selling and show the message while it is down (cart kept, sign-in and checkout buttons explain why); heartbeat tests with a fake server (two misses, recovery, no flicker). `docs/02`, `docs/03` updated.
3. **The disk catalog** in the till backend, filled by the ping and served on `/api/v1/products/sync`; the browser's IndexedDB copy removed; tests with 8,000 products and a restart in the middle of a sync. **Built (2026-11-27):**
   - **Branch server:** `GET /terminal/catalog` (`modules/ping/routes.ts`), guarded by the device token alone (a till has no signed-in person when it copies), the same paged feed as `/products/sync` but with cost, stock quantity, supplier, alert and expiry **withheld** (the copy holds prices only).
   - **Till backend:** `till/agent/src/catalogStore.ts` (one SQLite file, `catalog.db` in the till's data folder, `better-sqlite3`: the products as the feed carried them, and `meta`: `complete`, `watermark`, the resume `cursor`, the `source` branch server, the hash of the till's token), `catalogCopy.ts` (the loop) and a hook in `link.ts` (`onPing`). Each good ping hands the copy the token (in memory), the epoch and the catalog version; the copy pulls when the epoch or version differs from the one it last filled for, when it is not complete, when a pull was cut short, when the address or token changed, and anyway once a minute (safety net). One pull at a time, 500 products per page, never throws out of the loop.
   - **A page and its place to continue from are written in one transaction.** A restart in the middle of the first fill resumes at the next page (tested with 8,000 products; the second run asks for 13 of the 16 pages). A half-filled copy is never served: `complete` turns on with the last page. The next pull starts from the moment the first page of the last pull was asked for, like the screens' own sync.
   - **Served by the till backend:** `GET /api/v1/products/sync` (`tillServer.ts`, `serveCatalog`) answers from the disk copy only when the copy is complete, came from THIS branch server (a changed address empties it and fills it again) and the screen sends the same till's token (only its SHA-256 is on disk, never the token). In every other case the call goes through to the branch server as before, so a legacy single-till shop (no token) and a till before its first fill work unchanged. `GET /till/catalog` (this PC only) reports `ready`, `products`, `watermark`, `pulling`, `lastPullAt`, `lastError`.
   - **The browser** keeps the catalog in memory only (`lib/catalog.ts`, `memoryKV`); the old IndexedDB database `till` is deleted once. A reload costs a few small local answers.
   - **A damaged file is put aside** (`catalog.db.broken-<time>`) and a new copy is started: it is disposable.
   - Tests: `till/agent/tests/catalog-copy.test.ts` (19: 8,000 products in 16 pages, readback in order, no token on disk, resume after a cut-short fill, a failed pull keeps what it had, deltas and deactivation, no double pulls, a changed address, a damaged file, and the till server answering from disk with the branch server gone, passing through for a screen with no or another token, and before the first fill is whole), `branch-server/tests/integration/terminal-catalog.test.ts` (7), a step in the sandbox chain test (the copy fills by itself, follows a price change and the change back, and still answers while the branch server is away).
   - **Not yet:** the browser still asks `/events` and its own sale queue (steps 4 and 6); the copy does not yet follow a change faster than the ping (3 s) and is not shown on a till status screen.
4. **The sale-in-doubt journal**, then removal of the outbox and `queued-discard` (with the safe upgrade step).
5. **`GET /sync/ping`** for branch to HQ; the loop pings instead of pulling every 10 s; `cloud-hq` tests and the system test.
6. **Remove `GET /events`** once every topic is in the ping; the one-flow wizard (§7); sandbox chain test updated.

## 10. Risks and answers

- **Blocking is strict.** A dead branch server PC stops every till in that shop, and in a power cut the tills are down anyway. The answer is operational: the branch server PC on a UPS, its service set to restart by itself (`docs/07-operations.md`). If real shops find it too strict, a narrow mode (cash only, Walk-In only, a short limit) can be added behind a setting later; the sale-in-doubt journal is already the building block. It is a product decision, kept reversible.
- **A sale in flight when the link drops** is the one case that must not be lost or doubled: the journal plus the idempotency key cover it, and the screen never shows it as failed, only "not confirmed".
- **A restored backup can make a counter go backwards.** The `epoch` forces a full refetch.
- **The catalog copy can be wrong for a moment** (up to one ping interval). A sale is always priced by the server, so a stale copy can show an old price on screen but never charge one.
- **More code in the till backend** means more to keep in step with the branch server. It stays read-only and decides nothing about money.
