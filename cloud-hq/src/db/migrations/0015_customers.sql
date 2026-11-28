-- Customers of every branch (P5e, docs/15 §7): the mirror of the branch's table, and the phone key that says which of them are one person.
CREATE TABLE customers (
  branch_id INTEGER NOT NULL,
  id INTEGER NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  email TEXT,
  balance_lbp INTEGER NOT NULL,
  is_walk_in INTEGER NOT NULL,
  legacy_id INTEGER,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  hq_received_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, id)
);
CREATE INDEX ix_customers_branch_created_at ON customers (branch_id, created_at);

-- phone_key is derived (shared phoneKey()) from the customer's phone each time the customer arrives; a customer with no usable phone has no row.
CREATE TABLE customer_keys (
  branch_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  phone_key TEXT NOT NULL,
  PRIMARY KEY (branch_id, customer_id)
);
CREATE INDEX ix_customer_keys_phone ON customer_keys (phone_key);
