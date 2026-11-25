# 13 · Cash per till, wallets per branch

**Status:** design note, 2026-11-25, **all choices decided** (§11). **Slices 1 and 2 of §10 are built (2026-11-25)**: migration `0020`, the holder, the ledger and its routing, the till screens, and the wallet routes (`GET /wallets`, counts, branch-only movements, the ledger, the count history, the Z-report `wallets` block, the `wallet.updated` event) with their tests and `docs/06`. Slices 3 and 4 are not. Decided by the product owner (`docs/QUESTIONS.md`, Answered, D2 and D7); this note says how to build it and what it touches. Hard rule 14 in `CLAUDE.md` is replaced by §3 when this is built.

## 1. The problem

Today every register session carries **six balances**: cash, Whish and OMT, each in lira and dollars (`register_balances`, hard rule 14). Opening and closing a till ask for all six, and each till's Z-report compares its own "expected" and "counted" for Whish and OMT.

That is wrong for the shop. A till has its own **cash drawer**, but Whish and OMT are **one wallet per branch**: money paid by Whish at any till goes into the same account, and the only way to know what it holds is to look at that account. Per-till wallet counts are meaningless (nobody can count "till 2's share of the Whish account") and every close forces the cashier to type numbers nobody has.

## 2. What the owner decided

- **Cash belongs to each till.** Opening and closing a till asks for cash only (lira and dollars). The opening is prefilled from that till's last closing.
- **Whish and OMT belong to the branch.** Every till's wallet payments add to one running balance per wallet and currency. A **manager** counts it (reads the wallet account) when the branch opens and closes and at any time they want, and the difference is recorded.
- **Closing a till's cash count is blind for cashiers by default** ("Should hold" shows after the count is typed); a shop can switch that. A manager sees it at once. (D7; unchanged by this note, it now applies to cash only.)

One branch server holds exactly one branch (`docs/11` §1), so "per branch" means "once in this database". No branch id column is needed in the branch's tables; HQ keys what it receives by the branch it came from, as it does for sales.

## 3. The model

**A payment method has a holder.** `payment_methods` gets `holder TEXT NOT NULL DEFAULT 'till' CHECK (holder IN ('till','branch'))`. Cash is `till`; Whish and OMT are `branch`. A method added later chooses. Everything below is written in terms of the holder, so no code says "whish" or "omt".

**Till buckets** are the (method × currency) pairs whose method has holder `till`: with today's methods, `cash/LBP` and `cash/USD`. They stay in `register_balances`, per session, with `opening`, `expected`, `counted`, `variance`, exactly as now (still all-or-nothing on open and close, still immutable once closed).

**Wallet buckets** are the pairs whose method has holder `branch`. They live in a **ledger**, like stock does (hard rule 5):

```sql
CREATE TABLE wallet_entries (            -- append-only, one row per thing that moved a wallet
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  method      TEXT NOT NULL REFERENCES payment_methods (code),
  currency    TEXT NOT NULL CHECK (currency IN ('USD','LBP')),
  amount      INTEGER NOT NULL CHECK (amount <> 0),        -- signed; minor units of the currency
  kind        TEXT NOT NULL CHECK (kind IN ('sale','customer_payment','refund','movement','correction')),
  ref_type    TEXT,  ref_id INTEGER,                        -- the sale, customer payment, return or movement behind it
  session_id  INTEGER REFERENCES register_sessions (id),    -- the till session that caused it; NULL for a branch-only entry
  user_id     INTEGER REFERENCES users (id),
  reason      TEXT,                                         -- required for 'movement' and 'correction'
  created_at  TEXT NOT NULL
);

CREATE TABLE wallet_counts (             -- append-only, one row per bucket per count
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  method      TEXT NOT NULL REFERENCES payment_methods (code),
  currency    TEXT NOT NULL CHECK (currency IN ('USD','LBP')),
  counted     INTEGER NOT NULL CHECK (counted >= 0),
  expected    INTEGER,                                      -- what the ledger said at that moment; NULL for the first count of a bucket
  variance    INTEGER,                                      -- counted - expected; NULL for the first count
  entry_mark  INTEGER NOT NULL,                             -- the largest wallet_entries.id at the moment of the count
  purpose     TEXT NOT NULL CHECK (purpose IN ('opening','closing','check')),
  note        TEXT,
  counted_by  INTEGER NOT NULL REFERENCES users (id),
  counted_at  TEXT NOT NULL
);
```

**Expected balance of a wallet bucket, at any moment** = (`counted` of its latest count) + (sum of its entries with `id >` that count's `entry_mark`). The first count of a bucket has no earlier baseline: it **sets** it (`expected` and `variance` NULL) and is the branch's opening of that wallet. Ordering uses the entry id, never timestamps, so two tills writing in the same millisecond cannot confuse it. Expected may go negative: like stock (rule 17), a wallet figure never blocks a sale.

**Why a ledger and not a column per till.** The cause of every wallet movement is already a row (a payment, a customer payment, a return, a movement). The ledger gives them one ordered line, which is what "since the last count" needs, and it is the same pattern as `stock_movements`: written in the **same transaction** as the cause, append-only, never edited. A test re-derives each wallet's expected from the source rows and fails on any drift (the way `computeBreakdown` guards cash today).

**The single choke point.** Every code path that moves a bucket already calls `bumpExpected`, `recordCashIn` or `recordCashOut` (`modules/registers/service.ts`): sales, voids, returns, customer payments, expenses, services and manual movements. They keep calling it. `bumpExpected(q, sessionId, bucket, delta)` becomes: if the bucket's method has holder `till`, update `register_balances` as now; if `branch`, insert a `wallet_entries` row (with `session_id`). Callers change very little.

## 4. How each flow behaves

| Flow | Cash (till) | Whish / OMT (branch) |
|---|---|---|
| Open a till | cash only; prefilled from this till's last close | nothing asked |
| Sale paid by a wallet | nothing | entry `sale` (+), `session_id` = the till |
| Change | always cash, unchanged | never (a wallet tender cannot exceed the amount due, rule 13) |
| Customer payment | into the till's cash | entry `customer_payment` (+) |
| Return and refund | out of the till's cash | entry `refund` (−) |
| Void (session still open) | reversed in the session | entry `correction` (−), `ref` = the sale |
| Delete a sale for good (rule 4 exception) | the counted session's expected and variance are recomputed, as now | entry `correction` (−): the ledger stays append-only; an earlier count keeps what it recorded, and the next count absorbs the difference |
| Expense paid from a wallet, service income received into a wallet | movement on the till session, as now | entry `movement` |
| Transfer cash → wallet (a float top-up) | `out` of the till's cash (a `register_movements` row) | entry `movement` (+), both rows in one transaction |
| Wallet change with no till (bank top-up, fee) | – | `POST /wallets/movements`, manager, reason required, `session_id` NULL |
| Close a till | cash only; blind for a cashier unless the shop shows it | nothing asked |
| Count the wallets | – | manager: one `wallet_counts` row per wallet bucket, all of them given in one call |

A till-session transfer that crosses holders keeps `register_movements` as the record of the till's side; the wallet side is its ledger entry (`ref_type = 'register_movement'`).

## 5. API

Changed:
- `POST /registers/open`, `/registers/:id/close`: only till buckets are accepted. Giving a wallet bucket answers 400 "…is not a balance of this register" (the check already exists in `completeBalances`). `allBuckets` is split into `tillBuckets` and `walletBuckets`.
- `GET /registers/suggested-opening`: till buckets only.
- `POST /registers/:id/cash-movements`: a bucket may be a wallet; the wallet side becomes a ledger entry.
- Z-report (`zReport`): cash buckets as now, plus a read-only **`wallets`** block: what this till's session added to or took from each wallet (sums of entries with this `session_id`), with no expected or counted. Old closed sessions keep their stored six buckets and print as they always did (history is not rewritten).

New (all manager or admin; every route has a sign-in guard, rule 19, and goes in the RBAC matrix and the allow-list test):
- `GET /wallets`: for each wallet bucket the expected balance now, the latest count (counted, who, when, variance), and what moved since.
- `POST /wallets/counts` `{ purpose, note?, balances: [{method,currency,amount}] }`: every wallet bucket exactly once; one transaction; audited; answers the new state.
- `GET /wallets/counts`: the history. `GET /wallets/entries?bucket&from&to&cursor`: the ledger.
- `POST /wallets/movements` `{ bucket, type: 'in'|'out', amount, reason }`: a branch-only movement.
- `GET /events`: `register.updated` also fires for wallet changes, and a new hint `wallet.updated` for the dashboard tile.

## 6. Screens (`till/web`, later the branch dashboard)

- **Open register dialog** (`OpenRegisterDialog.tsx`): two fields (Cash LBP, Cash USD) instead of six, prefilled from this till's last close.
- **Close register** (`CloseRegisterPage.tsx`): cash only. Blind count for a cashier unless the shop's setting shows it (D7), a manager sees it at once. The Z-report shows the till's wallet activity as information.
- **Cash page** (`CashPage.tsx`): a movement may name a wallet.
- **New: Wallets** (manager, in the Money menu): the two wallets with their expected balance, last count and variance, a **Count the wallets** form, a movement form for branch-only changes, and the ledger. Arabic strings added (rule: every `t()` text has an Arabic entry).
- **Dashboard**: a tile "Wallets: expected / last counted", and a reminder when a wallet has not been counted since yesterday.
- **Pay dialog**: unchanged (a wallet tender is still recorded only, never a call to a third party, rule 13).

## 7. Reports and HQ

- Reports by payment method already read `payments`, so sales by method are unaffected.
- A new report line "wallet balance by branch" reads the ledger. The **register tables are not synced to HQ yet** (`SYNC_TABLES` has no register or wallet table), so this change breaks no sync format. When HQ reporting (P4) syncs registers, it syncs the new shape: `wallet_entries` and `wallet_counts` join `SYNC_TABLES` then (with an HQ mirror migration and capture triggers, per `docs/12` §14). Doing this change first means P4 never syncs the old six-bucket shape.

## 8. Migration and history

One new branch migration (`0020_branch_wallets.sql`):
1. `payment_methods.holder` added; cash `till`, whish and omt `branch`.
2. `wallet_entries`, `wallet_counts` created, with append-only triggers (no update, no delete), except the same narrow unlock the sale deletion already uses for its own correction rows (none are deleted: corrections are new rows, so no unlock is needed).
3. **Existing sessions are not rewritten.** Their six `register_balances` rows stay, closed ones stay immutable, and `zReport` prints whatever rows a session has. An *open* session at migration time keeps its wallet buckets until it is closed; its wallet rows are not carried into the ledger. The system has never run on a real till, so there is no live balance to carry; the first wallet count sets the baseline. (The legacy ETL still imports its old six-bucket sessions as history; those tools move to `legacy/` later.)
4. Tests that rely on six buckets change once, in `tests/helpers/app.ts` (`openRegister` sends two) and the files that build six balances by hand (about 40 test files mention registers; most go through the helper).

## 9. What must not break (tests, extending the existing ones)

- **Ledger = causes.** For every wallet bucket, the expected balance equals the baseline plus the sum of the wallet-method payments of non-void sales, customer payments, minus refunds, ± movements and corrections. Checked after a random mix of sales, returns, voids, deletes and transfers across several tills.
- **Concurrency.** Many tills selling by wallet at once, with a count in the middle: no entry lost, and the count's `entry_mark` splits the line exactly (`tests/integration/concurrent-sales.test.ts` style).
- **A till's close is independent of the wallets**: closing never reads or writes the ledger; a wallet-only sale leaves the till's cash expected untouched.
- **Append-only.** The database refuses UPDATE and DELETE on both new tables.
- **Idempotency** of sale, return and customer payment is unchanged: a replay writes no second entry.
- **Void and delete** write a `correction`, never edit an entry; the sale-delete test is extended (stock, cash register, customer, wallet).
- **Permissions.** A cashier cannot count, move or read the wallets ledger; `POST /wallets/*` is in the RBAC matrix and the open-door allow-list test is unchanged.
- **Browser**: open and close a till with two fields; sell by Whish at two tills; count the wallets as a manager; the Z-report shows wallet activity as information. The sandbox chain test sells by wallet at the till and checks the count.

## 10. Build order (each slice ends green)

1. Migration `0020`, `holder`, the two tables and triggers; `tillBuckets` / `walletBuckets`; `bumpExpected` routes by holder; `computeBreakdown` for till buckets; a ledger-versus-rows checker used by tests. Update `tests/helpers/app.ts` and the integration files.
2. Wallet routes (`GET /wallets`, counts, movements, entries) with their integration and RBAC tests; the cross-holder transfer; void and delete corrections.
3. Screens: two-field open, cash-only close with the blind setting, Wallets page, dashboard tile, Arabic.
4. Docs: `CLAUDE.md` rule 14 replaced, `docs/02` (decision table #1 and #20), `docs/03` (US-11, 12, 13), `docs/06`, `docs/tests-README.md`; the sandbox chain test extended.

## 11. The three choices, decided 2026-11-25 (`docs/QUESTIONS.md` #20)

1. **After a correction, does an earlier wallet count's variance change?** **Decided: no.** A count is a statement made at a moment; a later void or delete is a visible `correction` entry, and the next count absorbs it. (Cash differs, by an earlier decision, because a till session is a closed unit: its figures are recomputed when a sale in it is deleted.)
2. **Is counting the wallets required?** **Decided: no.** Opening and closing counts are the recommended practice, offered with a dashboard reminder, never a block on selling.
3. **Who may count and move wallet money?** **Decided:** managers and admins; cashiers and floor assistants never.
