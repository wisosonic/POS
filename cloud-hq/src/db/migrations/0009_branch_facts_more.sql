-- More of what branches record, copied to HQ (docs/12 Â§22, P4a). The same rules as 0002: the SAME columns as the branch's table plus branch_id and
-- hq_received_at, primary key (branch_id, id), no foreign keys, no defaults, no CHECKs. The column lists are branch-server/core/src/sync.ts
-- (SYNC_TABLES); cloud-hq/tests/system/sync-schema.test.ts checks this file, the branch's tables and that list all agree.

CREATE TABLE returns (
  branch_id INTEGER NOT NULL,
  id INTEGER NOT NULL,
  ref INTEGER NOT NULL,
  sale_id INTEGER NOT NULL,
  session_id INTEGER,
  user_id INTEGER,
  reason TEXT NOT NULL,
  refund_lbp INTEGER NOT NULL,
  balance_reduced_lbp INTEGER NOT NULL,
  refund_method TEXT,
  refund_currency TEXT,
  refund_amount INTEGER,
  idempotency_key TEXT,
  legacy_id INTEGER,
  created_at TEXT NOT NULL,
  hq_received_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, id),
  UNIQUE (branch_id, ref)
);
CREATE INDEX ix_returns_branch_created_at ON returns (branch_id, created_at);

CREATE TABLE return_items (
  branch_id INTEGER NOT NULL,
  id INTEGER NOT NULL,
  return_id INTEGER NOT NULL,
  sale_item_id INTEGER NOT NULL,
  qty_milli INTEGER NOT NULL,
  amount_lbp INTEGER NOT NULL,
  hq_received_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, id)
);
CREATE INDEX ix_return_items_branch_return_id ON return_items (branch_id, return_id);

CREATE TABLE customer_payments (
  branch_id INTEGER NOT NULL,
  id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  session_id INTEGER,
  user_id INTEGER,
  amount_lbp INTEGER NOT NULL,
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  hq_received_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, id)
);
CREATE INDEX ix_customer_payments_branch_created_at ON customer_payments (branch_id, created_at);

CREATE TABLE register_sessions (
  branch_id INTEGER NOT NULL,
  id INTEGER NOT NULL,
  terminal_id TEXT NOT NULL,
  opened_by INTEGER,
  opened_at TEXT NOT NULL,
  closed_by INTEGER,
  closed_at TEXT,
  status TEXT NOT NULL,
  legacy_id INTEGER,
  hq_received_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, id)
);
CREATE INDEX ix_register_sessions_branch_opened_at ON register_sessions (branch_id, opened_at);

CREATE TABLE register_balances (
  branch_id INTEGER NOT NULL,
  id INTEGER NOT NULL,
  session_id INTEGER NOT NULL,
  method TEXT NOT NULL,
  currency TEXT NOT NULL,
  opening INTEGER NOT NULL,
  expected INTEGER NOT NULL,
  counted INTEGER,
  variance INTEGER,
  hq_received_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, id)
);
CREATE INDEX ix_register_balances_branch_session_id ON register_balances (branch_id, session_id);

CREATE TABLE register_movements (
  branch_id INTEGER NOT NULL,
  id INTEGER NOT NULL,
  session_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  from_method TEXT,
  from_currency TEXT,
  to_method TEXT,
  to_currency TEXT,
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  user_id INTEGER,
  created_at TEXT NOT NULL,
  hq_received_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, id)
);
CREATE INDEX ix_register_movements_branch_created_at ON register_movements (branch_id, created_at);

CREATE TABLE expenses (
  branch_id INTEGER NOT NULL,
  id INTEGER NOT NULL,
  category_id INTEGER,
  session_id INTEGER,
  title TEXT NOT NULL,
  reference TEXT NOT NULL,
  note TEXT,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  legacy_id INTEGER,
  created_at TEXT NOT NULL,
  hq_received_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, id)
);
CREATE INDEX ix_expenses_branch_created_at ON expenses (branch_id, created_at);

CREATE TABLE expense_categories (
  branch_id INTEGER NOT NULL,
  id INTEGER NOT NULL,
  name TEXT NOT NULL,
  legacy_id INTEGER,
  hq_received_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, id)
);

CREATE TABLE purchases (
  branch_id INTEGER NOT NULL,
  id INTEGER NOT NULL,
  ref INTEGER NOT NULL,
  supplier_id INTEGER,
  warehouse_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  currency TEXT NOT NULL,
  total_minor INTEGER NOT NULL,
  paid_minor INTEGER NOT NULL,
  payment_type TEXT,
  idempotency_key TEXT,
  legacy_id INTEGER,
  created_at TEXT NOT NULL,
  received_at TEXT,
  hq_received_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, id),
  UNIQUE (branch_id, ref)
);
CREATE INDEX ix_purchases_branch_created_at ON purchases (branch_id, created_at);

CREATE TABLE purchase_items (
  branch_id INTEGER NOT NULL,
  id INTEGER NOT NULL,
  purchase_id INTEGER NOT NULL,
  product_id INTEGER,
  name_snap TEXT NOT NULL,
  qty_milli INTEGER NOT NULL,
  cost_minor INTEGER NOT NULL,
  received_milli INTEGER NOT NULL,
  legacy_id INTEGER,
  hq_received_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, id)
);
CREATE INDEX ix_purchase_items_branch_purchase_id ON purchase_items (branch_id, purchase_id);

CREATE TABLE purchase_payments (
  branch_id INTEGER NOT NULL,
  id INTEGER NOT NULL,
  purchase_id INTEGER NOT NULL,
  amount_minor INTEGER NOT NULL,
  note TEXT,
  user_id INTEGER,
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  hq_received_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, id)
);
CREATE INDEX ix_purchase_payments_branch_purchase_id ON purchase_payments (branch_id, purchase_id);

CREATE TABLE wallet_entries (
  branch_id INTEGER NOT NULL,
  id INTEGER NOT NULL,
  method TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ref_type TEXT,
  ref_id INTEGER,
  session_id INTEGER,
  user_id INTEGER,
  reason TEXT,
  created_at TEXT NOT NULL,
  hq_received_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, id)
);
CREATE INDEX ix_wallet_entries_branch_created_at ON wallet_entries (branch_id, created_at);

CREATE TABLE wallet_counts (
  branch_id INTEGER NOT NULL,
  id INTEGER NOT NULL,
  method TEXT NOT NULL,
  currency TEXT NOT NULL,
  counted INTEGER NOT NULL,
  expected INTEGER,
  variance INTEGER,
  entry_mark INTEGER NOT NULL,
  purpose TEXT NOT NULL,
  note TEXT,
  counted_by INTEGER NOT NULL,
  counted_at TEXT NOT NULL,
  hq_received_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, id)
);
CREATE INDEX ix_wallet_counts_branch_counted_at ON wallet_counts (branch_id, counted_at);

CREATE TABLE service_sales (
  branch_id INTEGER NOT NULL,
  id INTEGER NOT NULL,
  category_id INTEGER,
  customer_id INTEGER,
  user_id INTEGER,
  reference TEXT NOT NULL,
  note TEXT,
  cost_minor INTEGER NOT NULL,
  fee_minor INTEGER NOT NULL,
  profit_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  legacy_id INTEGER,
  created_at TEXT NOT NULL,
  session_id INTEGER,
  hq_received_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, id)
);
CREATE INDEX ix_service_sales_branch_created_at ON service_sales (branch_id, created_at);

CREATE TABLE service_categories (
  branch_id INTEGER NOT NULL,
  id INTEGER NOT NULL,
  name TEXT NOT NULL,
  legacy_id INTEGER,
  hq_received_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, id)
);

-- Looked up by session and bucket for the cash reports (not unique: a row is named by the number its branch gave it, and a restore must never stall the sync).
CREATE INDEX ix_register_balances_bucket ON register_balances (branch_id, session_id, method, currency);
