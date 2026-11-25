-- Cash belongs to each till, wallets (Whish, OMT) belong to the branch (docs/13-branch-wallets.md).
--
-- A payment method has a HOLDER. Cash is held by the till: it stays a per-session balance in register_balances. A wallet is held by the
-- branch: one running balance per wallet and currency, kept as a ledger (wallet_entries) with manager counts (wallet_counts), like stock.
-- Old register sessions are not rewritten: they keep the wallet balances they have.
ALTER TABLE payment_methods ADD COLUMN holder TEXT NOT NULL DEFAULT 'till' CHECK (holder IN ('till', 'branch'));
UPDATE payment_methods SET holder = 'branch' WHERE code IN ('whish', 'omt');

-- One row per thing that moved a wallet: a sale paid by it, a customer payment, a refund, a movement, or a correction (a void or a
-- deleted sale puts a negative row; nothing is ever edited). `amount` is signed, in the minor units of the currency.
CREATE TABLE wallet_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  method TEXT NOT NULL REFERENCES payment_methods (code),
  currency TEXT NOT NULL CHECK (currency IN ('USD', 'LBP')),
  amount INTEGER NOT NULL CHECK (amount <> 0),
  kind TEXT NOT NULL CHECK (kind IN ('sale', 'customer_payment', 'refund', 'movement', 'correction')),
  ref_type TEXT,
  ref_id INTEGER,
  session_id INTEGER REFERENCES register_sessions (id), -- the till session that caused it; NULL for a branch-only entry
  user_id INTEGER REFERENCES users (id),
  reason TEXT,
  created_at TEXT NOT NULL,
  CHECK (kind NOT IN ('movement', 'correction') OR length(trim(coalesce(reason, ''))) > 0)
);
CREATE INDEX ix_wallet_entries_bucket ON wallet_entries (method, currency, id);
CREATE INDEX ix_wallet_entries_session ON wallet_entries (session_id) WHERE session_id IS NOT NULL;

-- A manager's reading of a wallet. The first count of a bucket sets its baseline (expected and variance are NULL); every later one
-- records what the ledger said at that moment and the difference. `entry_mark` is the largest wallet_entries.id at the time of the
-- count, so "everything since" is an exact split by id, never by clock.
CREATE TABLE wallet_counts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  method TEXT NOT NULL REFERENCES payment_methods (code),
  currency TEXT NOT NULL CHECK (currency IN ('USD', 'LBP')),
  counted INTEGER NOT NULL CHECK (counted >= 0),
  expected INTEGER,
  variance INTEGER,
  entry_mark INTEGER NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('opening', 'closing', 'check')),
  note TEXT,
  counted_by INTEGER NOT NULL REFERENCES users (id),
  counted_at TEXT NOT NULL,
  CHECK ((expected IS NULL) = (variance IS NULL))
);
CREATE INDEX ix_wallet_counts_bucket ON wallet_counts (method, currency, id);

CREATE TRIGGER wallet_entries_no_update BEFORE UPDATE ON wallet_entries BEGIN SELECT RAISE(ABORT, 'wallet_entries is append-only'); END;
CREATE TRIGGER wallet_entries_no_delete BEFORE DELETE ON wallet_entries BEGIN SELECT RAISE(ABORT, 'wallet_entries is append-only'); END;
CREATE TRIGGER wallet_counts_no_update BEFORE UPDATE ON wallet_counts BEGIN SELECT RAISE(ABORT, 'wallet_counts is append-only'); END;
CREATE TRIGGER wallet_counts_no_delete BEFORE DELETE ON wallet_counts BEGIN SELECT RAISE(ABORT, 'wallet_counts is append-only'); END;
