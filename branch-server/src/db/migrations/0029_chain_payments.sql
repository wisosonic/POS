-- Paying across branches (P5e step 2, docs/15 §7.2). A customer who owes at several branches pays at one. This branch applies the payment to its OWN
-- open sales for that customer first; what is left over (chain_payments, written in the same transaction, sent up) HQ spreads over the person's
-- open sales at OTHER branches, oldest first, and tells each of them (payment_orders, down). A branch applies an order to its own sale in its own
-- transaction and answers with payment_order_results (up): how much it really applied. One writer per row, history append-only.
CREATE TABLE chain_payments (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id         INTEGER NOT NULL REFERENCES customers (id),
  customer_payment_id INTEGER NOT NULL REFERENCES customer_payments (id),
  phone_key           TEXT NOT NULL,
  amount_lbp          INTEGER NOT NULL CHECK (amount_lbp > 0),   -- what is left for the other branches
  created_at          TEXT NOT NULL
);
CREATE TRIGGER chain_payments_no_update BEFORE UPDATE ON chain_payments BEGIN SELECT RAISE(ABORT, 'chain_payments is append-only'); END;
CREATE TRIGGER chain_payments_no_delete BEFORE DELETE ON chain_payments BEGIN SELECT RAISE(ABORT, 'chain_payments is append-only'); END;

CREATE TABLE payment_order_results (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL UNIQUE,                            -- HQ's payment order
  applied_lbp INTEGER NOT NULL CHECK (applied_lbp >= 0),          -- less than asked when the sale had less owing than HQ thought
  created_at  TEXT NOT NULL
);
CREATE TRIGGER payment_order_results_no_update BEFORE UPDATE ON payment_order_results BEGIN SELECT RAISE(ABORT, 'payment_order_results is append-only'); END;
CREATE TRIGGER payment_order_results_no_delete BEFORE DELETE ON payment_order_results BEGIN SELECT RAISE(ABORT, 'payment_order_results is append-only'); END;

-- What HQ sends down (HQ's id is the id here; only ever filled from HQ).
CREATE TABLE payment_orders (
  id               INTEGER PRIMARY KEY,
  customer_id      INTEGER NOT NULL,       -- this branch's customer
  sale_id          INTEGER NOT NULL,       -- this branch's sale
  amount_lbp       INTEGER NOT NULL,
  from_branch_id   INTEGER NOT NULL,       -- the branch that took the money
  chain_payment_id INTEGER NOT NULL,
  to_branch_id     INTEGER NOT NULL        -- this branch
);
CREATE INDEX ix_payment_orders_sale ON payment_orders (sale_id);

-- What the same person owes at the OTHER branches, as HQ last knew it (shown at the till; only a hint, never a limit).
CREATE TABLE customer_chain (
  id          INTEGER PRIMARY KEY,
  branch_id   INTEGER NOT NULL,
  customer_id INTEGER NOT NULL UNIQUE,
  others_lbp  INTEGER NOT NULL
);

-- chain_payments
CREATE TRIGGER sync_chain_payments_ai AFTER INSERT ON chain_payments WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('chain_payments', NEW.id, 'u'); END;
CREATE TRIGGER sync_chain_payments_au AFTER UPDATE ON chain_payments WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('chain_payments', NEW.id, 'u'); END;
CREATE TRIGGER sync_chain_payments_ad AFTER DELETE ON chain_payments WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('chain_payments', OLD.id, 'd'); END;

-- payment_order_results
CREATE TRIGGER sync_payment_order_results_ai AFTER INSERT ON payment_order_results WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('payment_order_results', NEW.id, 'u'); END;
CREATE TRIGGER sync_payment_order_results_au AFTER UPDATE ON payment_order_results WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('payment_order_results', NEW.id, 'u'); END;
CREATE TRIGGER sync_payment_order_results_ad AFTER DELETE ON payment_order_results WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('payment_order_results', OLD.id, 'd'); END;
