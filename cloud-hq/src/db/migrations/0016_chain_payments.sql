-- Paying across branches (P5e step 2, docs/15 §7.2): mirrors of what a branch writes, and what HQ decides.
CREATE TABLE chain_payments (
  branch_id INTEGER NOT NULL,
  id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  customer_payment_id INTEGER NOT NULL,
  phone_key TEXT NOT NULL,
  amount_lbp INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  hq_received_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, id)
);
CREATE INDEX ix_chain_payments_branch_created_at ON chain_payments (branch_id, created_at);

CREATE TABLE payment_order_results (
  branch_id INTEGER NOT NULL,
  id INTEGER NOT NULL,
  order_id INTEGER NOT NULL,
  applied_lbp INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  hq_received_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, id)
);
CREATE INDEX ix_payment_order_results_branch_created_at ON payment_order_results (branch_id, created_at);

-- How much of each chain payment is still to be placed on a sale somewhere (HQ's own bookkeeping).
CREATE TABLE chain_payment_state (
  branch_id INTEGER NOT NULL,
  chain_payment_id INTEGER NOT NULL,
  phone_key TEXT NOT NULL,
  unplaced_lbp INTEGER NOT NULL CHECK (unplaced_lbp >= 0),
  PRIMARY KEY (branch_id, chain_payment_id)
);
CREATE INDEX ix_chain_payment_state_open ON chain_payment_state (unplaced_lbp) WHERE unplaced_lbp > 0;

-- What HQ tells a branch to apply to one of ITS sales (sent down to that branch only, with its change_log line).
CREATE TABLE payment_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  sale_id INTEGER NOT NULL,
  amount_lbp INTEGER NOT NULL,
  from_branch_id INTEGER NOT NULL,
  chain_payment_id INTEGER NOT NULL,
  to_branch_id INTEGER NOT NULL,          -- the branch that owns the sale (the order is sent to it only)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_payment_orders_sale ON payment_orders (to_branch_id, sale_id);
CREATE INDEX ix_payment_orders_payment ON payment_orders (from_branch_id, chain_payment_id);

-- What a person owes at the other branches, per customer record (sent down to that customer's branch).
CREATE TABLE customer_chain (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  others_lbp INTEGER NOT NULL,
  UNIQUE (branch_id, customer_id)
);

-- A payment order whose answer HQ has taken in (so a resent answer is not counted twice).
CREATE TABLE payment_order_settled (
  order_id INTEGER PRIMARY KEY
);
