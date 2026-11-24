-- POS schema v1 (SQLite). See docs/04-architecture.md §5.
-- Conventions:
--   money      INTEGER whole LBP (…_lbp) or minor units of the row's currency (…_minor, USD = cents)
--   quantities INTEGER thousandths (…_milli): 0.350 kg is stored as 350
--   timestamps TEXT ISO-8601 UTC
--   history is append-only, enforced by triggers at the bottom of this file

-- ------------------------------------------------------------------ settings & reference data

CREATE TABLE store_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  address TEXT,
  phone TEXT,
  email TEXT,
  logo_path TEXT,
  lbp_rounding INTEGER NOT NULL DEFAULT 5000 CHECK (lbp_rounding >= 1),
  receipt_footer TEXT NOT NULL DEFAULT 'Thank you!',
  receipt_width INTEGER NOT NULL DEFAULT 42 CHECK (receipt_width BETWEEN 20 AND 80),
  printer_name TEXT,
  cashier_discount_limit_pct INTEGER NOT NULL DEFAULT 10 CHECK (cashier_discount_limit_pct BETWEEN 0 AND 100)
);

CREATE TABLE payment_methods (
  code TEXT PRIMARY KEY CHECK (code IN ('cash', 'whish', 'omt')),
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('cashier', 'manager', 'admin')),
  password_hash TEXT NOT NULL,
  pin_hash TEXT,
  phone TEXT,
  email TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  must_reset_password INTEGER NOT NULL DEFAULT 0 CHECK (must_reset_password IN (0, 1)),
  legacy_id INTEGER UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE refresh_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users (id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX ix_refresh_tokens_user ON refresh_tokens (user_id);

CREATE TABLE login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL COLLATE NOCASE,
  success INTEGER NOT NULL CHECK (success IN (0, 1)),
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX ix_login_attempts_user_at ON login_attempts (username, at);

CREATE TABLE exchange_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rate_lbp_per_usd INTEGER NOT NULL CHECK (rate_lbp_per_usd > 0),
  effective_from TEXT NOT NULL,
  created_by INTEGER REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX ix_exchange_rates_effective ON exchange_rates (effective_from);

CREATE TABLE warehouses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  address TEXT,
  phone TEXT,
  email TEXT,
  legacy_id INTEGER UNIQUE
);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  legacy_id INTEGER UNIQUE
);

CREATE TABLE brands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  legacy_id INTEGER UNIQUE
);

CREATE TABLE units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  fractional INTEGER NOT NULL DEFAULT 0 CHECK (fractional IN (0, 1)),
  legacy_id INTEGER UNIQUE
);

CREATE TABLE suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  address TEXT,
  phone TEXT,
  email TEXT,
  legacy_id INTEGER UNIQUE
);

-- ------------------------------------------------------------------ catalog & stock

CREATE TABLE products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  receipt_name TEXT,
  receipt_name_manual INTEGER NOT NULL DEFAULT 0 CHECK (receipt_name_manual IN (0, 1)),
  barcode TEXT NOT NULL DEFAULT '',
  cost_minor INTEGER NOT NULL DEFAULT 0 CHECK (cost_minor >= 0),
  price_minor INTEGER NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'LBP' CHECK (currency IN ('USD', 'LBP')),
  category_id INTEGER REFERENCES categories (id),
  brand_id INTEGER REFERENCES brands (id),
  unit_id INTEGER REFERENCES units (id),
  supplier_id INTEGER REFERENCES suppliers (id),
  -- low-stock threshold in thousandths. NULL = never alert. Stock never blocks a sale (decision R2).
  stock_alert_milli INTEGER CHECK (stock_alert_milli IS NULL OR stock_alert_milli >= 0),
  expiry_date TEXT,
  image_path TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  legacy_id INTEGER UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- NOT unique: legacy data contains duplicate barcodes. The unique index arrives in the last milestone (US-34).
CREATE INDEX ix_products_barcode ON products (barcode);
CREATE INDEX ix_products_category ON products (category_id);
CREATE INDEX ix_products_updated ON products (updated_at);

-- Substring search over Latin and Arabic names and barcodes (trigram needs >= 3 characters; shorter queries use LIKE).
CREATE VIRTUAL TABLE products_fts USING fts5 (
  name, receipt_name, barcode,
  content = 'products', content_rowid = 'id', tokenize = 'trigram'
);
CREATE TRIGGER products_fts_ai AFTER INSERT ON products BEGIN
  INSERT INTO products_fts (rowid, name, receipt_name, barcode) VALUES (new.id, new.name, coalesce(new.receipt_name, ''), new.barcode);
END;
CREATE TRIGGER products_fts_ad AFTER DELETE ON products BEGIN
  INSERT INTO products_fts (products_fts, rowid, name, receipt_name, barcode) VALUES ('delete', old.id, old.name, coalesce(old.receipt_name, ''), old.barcode);
END;
CREATE TRIGGER products_fts_au AFTER UPDATE OF name, receipt_name, barcode ON products BEGIN
  INSERT INTO products_fts (products_fts, rowid, name, receipt_name, barcode) VALUES ('delete', old.id, old.name, coalesce(old.receipt_name, ''), old.barcode);
  INSERT INTO products_fts (rowid, name, receipt_name, barcode) VALUES (new.id, new.name, coalesce(new.receipt_name, ''), new.barcode);
END;

-- Cache of the ledger below. May be zero or negative: stock is informational and never blocks.
CREATE TABLE stock_levels (
  product_id INTEGER NOT NULL REFERENCES products (id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses (id),
  qty_milli INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, warehouse_id)
) WITHOUT ROWID;

CREATE TABLE stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products (id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses (id),
  qty_milli_delta INTEGER NOT NULL CHECK (qty_milli_delta <> 0),
  reason TEXT NOT NULL CHECK (reason IN ('sale', 'return', 'purchase', 'adjustment', 'transfer')),
  ref_type TEXT,
  ref_id INTEGER,
  user_id INTEGER REFERENCES users (id),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX ix_stock_movements_product ON stock_movements (product_id, created_at);

-- ------------------------------------------------------------------ customers

CREATE TABLE customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  email TEXT,
  -- what the customer owes us = sum of rest_lbp over their open sales. Maintained in the same transaction as every change.
  balance_lbp INTEGER NOT NULL DEFAULT 0 CHECK (balance_lbp >= 0),
  is_walk_in INTEGER NOT NULL DEFAULT 0 CHECK (is_walk_in IN (0, 1)),
  legacy_id INTEGER UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (is_walk_in = 0 OR balance_lbp = 0) -- Walk-In can never owe money
);
CREATE UNIQUE INDEX ux_customers_one_walk_in ON customers (is_walk_in) WHERE is_walk_in = 1;
CREATE INDEX ix_customers_phone ON customers (phone);

-- ------------------------------------------------------------------ register (one till)

CREATE TABLE register_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  terminal_id TEXT NOT NULL,
  opened_by INTEGER REFERENCES users (id),
  opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  closed_by INTEGER REFERENCES users (id),
  closed_at TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  legacy_id INTEGER UNIQUE,
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);
-- One open session per terminal, whoever opens it.
CREATE UNIQUE INDEX ux_register_one_open_per_terminal ON register_sessions (terminal_id) WHERE status = 'open';

-- One row per (method × currency) bucket: cash/whish/omt × USD/LBP.
CREATE TABLE register_balances (
  session_id INTEGER NOT NULL REFERENCES register_sessions (id),
  method TEXT NOT NULL REFERENCES payment_methods (code),
  currency TEXT NOT NULL CHECK (currency IN ('USD', 'LBP')),
  opening INTEGER NOT NULL CHECK (opening >= 0),
  expected INTEGER NOT NULL,
  counted INTEGER,
  variance INTEGER,
  PRIMARY KEY (session_id, method, currency)
) WITHOUT ROWID;

CREATE TABLE register_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES register_sessions (id),
  type TEXT NOT NULL CHECK (type IN ('in', 'out', 'transfer')),
  from_method TEXT REFERENCES payment_methods (code),
  from_currency TEXT CHECK (from_currency IN ('USD', 'LBP')),
  to_method TEXT REFERENCES payment_methods (code),
  to_currency TEXT CHECK (to_currency IN ('USD', 'LBP')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  user_id INTEGER REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    (type = 'in' AND to_method IS NOT NULL AND to_currency IS NOT NULL AND from_method IS NULL) OR
    (type = 'out' AND from_method IS NOT NULL AND from_currency IS NOT NULL AND to_method IS NULL) OR
    (type = 'transfer' AND from_method IS NOT NULL AND from_currency IS NOT NULL AND to_method IS NOT NULL AND to_currency IS NOT NULL)
  )
);

-- ------------------------------------------------------------------ sales

CREATE TABLE sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref INTEGER NOT NULL UNIQUE,
  session_id INTEGER REFERENCES register_sessions (id), -- NULL only for imported legacy sales
  user_id INTEGER REFERENCES users (id),
  customer_id INTEGER NOT NULL REFERENCES customers (id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses (id),
  rate_lbp_per_usd INTEGER NOT NULL CHECK (rate_lbp_per_usd > 0),
  subtotal_lbp INTEGER NOT NULL CHECK (subtotal_lbp >= 0),
  discount_lbp INTEGER NOT NULL DEFAULT 0 CHECK (discount_lbp >= 0),
  shipping_lbp INTEGER NOT NULL DEFAULT 0 CHECK (shipping_lbp >= 0),
  rounding_lbp INTEGER NOT NULL DEFAULT 0, -- no tax column: prices are tax-inclusive
  total_lbp INTEGER NOT NULL CHECK (total_lbp >= 0),
  paid_lbp INTEGER NOT NULL DEFAULT 0 CHECK (paid_lbp >= 0), -- amount applied to this sale (never above the total)
  change_lbp INTEGER NOT NULL DEFAULT 0 CHECK (change_lbp >= 0), -- cash handed back
  rest_lbp INTEGER NOT NULL DEFAULT 0 CHECK (rest_lbp >= 0), -- still owed by the customer
  profit_lbp INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('paid', 'partial', 'unpaid', 'void')),
  notes TEXT NOT NULL DEFAULT '',
  client_sale_id TEXT UNIQUE,
  idempotency_key TEXT UNIQUE,
  legacy_id INTEGER UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (paid_lbp + rest_lbp = total_lbp OR status = 'void')
);
CREATE INDEX ix_sales_created ON sales (created_at);
CREATE INDEX ix_sales_session ON sales (session_id);
CREATE INDEX ix_sales_customer_open ON sales (customer_id, created_at) WHERE rest_lbp > 0;

CREATE TABLE sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales (id),
  product_id INTEGER REFERENCES products (id), -- NULL when a legacy line matched no product
  name_snap TEXT NOT NULL,
  receipt_name_snap TEXT,
  barcode_snap TEXT NOT NULL DEFAULT '',
  brand_snap TEXT NOT NULL DEFAULT '',
  unit_snap TEXT NOT NULL DEFAULT '',
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
  unit_price_lbp INTEGER NOT NULL CHECK (unit_price_lbp >= 0),
  unit_cost_lbp INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost_lbp >= 0),
  line_total_lbp INTEGER NOT NULL CHECK (line_total_lbp >= 0)
);
CREATE INDEX ix_sale_items_sale ON sale_items (sale_id);
CREATE INDEX ix_sale_items_product ON sale_items (product_id);

CREATE TABLE customer_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers (id),
  session_id INTEGER REFERENCES register_sessions (id),
  user_id INTEGER REFERENCES users (id),
  amount_lbp INTEGER NOT NULL CHECK (amount_lbp > 0),
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX ix_customer_payments_customer ON customer_payments (customer_id);

CREATE TABLE payment_allocations (
  customer_payment_id INTEGER NOT NULL REFERENCES customer_payments (id),
  sale_id INTEGER NOT NULL REFERENCES sales (id),
  amount_lbp INTEGER NOT NULL CHECK (amount_lbp > 0),
  PRIMARY KEY (customer_payment_id, sale_id)
) WITHOUT ROWID;

-- What was received, per method and currency. Belongs to a sale or to a customer payment.
CREATE TABLE payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER REFERENCES sales (id),
  customer_payment_id INTEGER REFERENCES customer_payments (id),
  method TEXT NOT NULL REFERENCES payment_methods (code),
  currency TEXT NOT NULL CHECK (currency IN ('USD', 'LBP')),
  amount INTEGER NOT NULL CHECK (amount > 0), -- minor units of `currency`
  rate_snap INTEGER NOT NULL CHECK (rate_snap > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((sale_id IS NULL) <> (customer_payment_id IS NULL))
);
CREATE INDEX ix_payments_sale ON payments (sale_id);
CREATE INDEX ix_payments_customer_payment ON payments (customer_payment_id);

-- ------------------------------------------------------------------ returns, holds

CREATE TABLE returns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref INTEGER NOT NULL UNIQUE,
  sale_id INTEGER NOT NULL REFERENCES sales (id),
  session_id INTEGER REFERENCES register_sessions (id),
  user_id INTEGER REFERENCES users (id),
  reason TEXT NOT NULL DEFAULT '',
  refund_lbp INTEGER NOT NULL DEFAULT 0 CHECK (refund_lbp >= 0), -- value returned to the customer
  balance_reduced_lbp INTEGER NOT NULL DEFAULT 0 CHECK (balance_reduced_lbp >= 0), -- part applied against what they owe
  refund_method TEXT REFERENCES payment_methods (code),
  refund_currency TEXT CHECK (refund_currency IN ('USD', 'LBP')),
  refund_amount INTEGER CHECK (refund_amount IS NULL OR refund_amount > 0),
  idempotency_key TEXT UNIQUE,
  legacy_id INTEGER UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE return_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id INTEGER NOT NULL REFERENCES returns (id),
  sale_item_id INTEGER NOT NULL REFERENCES sale_items (id),
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
  amount_lbp INTEGER NOT NULL CHECK (amount_lbp >= 0)
);
CREATE INDEX ix_return_items_sale_item ON return_items (sale_item_id);

CREATE TABLE holds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users (id),
  customer_id INTEGER REFERENCES customers (id),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE hold_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hold_id INTEGER NOT NULL REFERENCES holds (id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products (id),
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
  price_lbp INTEGER NOT NULL CHECK (price_lbp >= 0)
);

-- ------------------------------------------------------------------ purchasing, expenses, services

CREATE TABLE purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref INTEGER NOT NULL UNIQUE,
  supplier_id INTEGER REFERENCES suppliers (id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses (id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ordered', 'received')),
  currency TEXT NOT NULL DEFAULT 'LBP' CHECK (currency IN ('USD', 'LBP')),
  total_minor INTEGER NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  paid_minor INTEGER NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
  payment_type TEXT,
  idempotency_key TEXT UNIQUE,
  legacy_id INTEGER UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  received_at TEXT
);

CREATE TABLE purchase_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL REFERENCES purchases (id),
  product_id INTEGER REFERENCES products (id),
  name_snap TEXT NOT NULL DEFAULT '',
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
  cost_minor INTEGER NOT NULL DEFAULT 0 CHECK (cost_minor >= 0),
  received_milli INTEGER NOT NULL DEFAULT 0 CHECK (received_milli >= 0)
);
CREATE INDEX ix_purchase_items_purchase ON purchase_items (purchase_id);

CREATE TABLE expense_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  legacy_id INTEGER UNIQUE
);

CREATE TABLE expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER REFERENCES expense_categories (id),
  session_id INTEGER REFERENCES register_sessions (id),
  title TEXT NOT NULL,
  reference TEXT NOT NULL DEFAULT '',
  note TEXT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'LBP' CHECK (currency IN ('USD', 'LBP')),
  legacy_id INTEGER UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE service_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  legacy_id INTEGER UNIQUE
);

CREATE TABLE service_sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER REFERENCES service_categories (id),
  customer_id INTEGER REFERENCES customers (id),
  user_id INTEGER REFERENCES users (id),
  reference TEXT NOT NULL DEFAULT '',
  note TEXT,
  cost_minor INTEGER NOT NULL DEFAULT 0,
  fee_minor INTEGER NOT NULL DEFAULT 0,
  profit_minor INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'LBP' CHECK (currency IN ('USD', 'LBP')),
  legacy_id INTEGER UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ------------------------------------------------------------------ audit & idempotency

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users (id),
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX ix_audit_entity ON audit_log (entity, entity_id);
CREATE INDEX ix_audit_action ON audit_log (action, created_at);

CREATE TABLE idempotency_keys (
  key TEXT NOT NULL,
  scope TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (scope, key)
) WITHOUT ROWID;

-- ------------------------------------------------------------------ append-only history (CLAUDE.md rule 4)
-- Corrections are new rows (returns, adjustments, voids). The database refuses edits even if application code has a bug.

CREATE TRIGGER stock_movements_no_update BEFORE UPDATE ON stock_movements BEGIN SELECT RAISE(ABORT, 'stock_movements is append-only'); END;
CREATE TRIGGER stock_movements_no_delete BEFORE DELETE ON stock_movements BEGIN SELECT RAISE(ABORT, 'stock_movements is append-only'); END;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER payments_no_update BEFORE UPDATE ON payments BEGIN SELECT RAISE(ABORT, 'payments is append-only'); END;
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments BEGIN SELECT RAISE(ABORT, 'payments is append-only'); END;
CREATE TRIGGER sale_items_no_update BEFORE UPDATE ON sale_items BEGIN SELECT RAISE(ABORT, 'sale_items is append-only'); END;
CREATE TRIGGER sale_items_no_delete BEFORE DELETE ON sale_items BEGIN SELECT RAISE(ABORT, 'sale_items is append-only'); END;
CREATE TRIGGER customer_payments_no_update BEFORE UPDATE ON customer_payments BEGIN SELECT RAISE(ABORT, 'customer_payments is append-only'); END;
CREATE TRIGGER customer_payments_no_delete BEFORE DELETE ON customer_payments BEGIN SELECT RAISE(ABORT, 'customer_payments is append-only'); END;
CREATE TRIGGER payment_allocations_no_update BEFORE UPDATE ON payment_allocations BEGIN SELECT RAISE(ABORT, 'payment_allocations is append-only'); END;
CREATE TRIGGER payment_allocations_no_delete BEFORE DELETE ON payment_allocations BEGIN SELECT RAISE(ABORT, 'payment_allocations is append-only'); END;
CREATE TRIGGER returns_no_update BEFORE UPDATE ON returns BEGIN SELECT RAISE(ABORT, 'returns is append-only'); END;
CREATE TRIGGER returns_no_delete BEFORE DELETE ON returns BEGIN SELECT RAISE(ABORT, 'returns is append-only'); END;
CREATE TRIGGER return_items_no_update BEFORE UPDATE ON return_items BEGIN SELECT RAISE(ABORT, 'return_items is append-only'); END;
CREATE TRIGGER return_items_no_delete BEFORE DELETE ON return_items BEGIN SELECT RAISE(ABORT, 'return_items is append-only'); END;
CREATE TRIGGER register_movements_no_update BEFORE UPDATE ON register_movements BEGIN SELECT RAISE(ABORT, 'register_movements is append-only'); END;
CREATE TRIGGER register_movements_no_delete BEFORE DELETE ON register_movements BEGIN SELECT RAISE(ABORT, 'register_movements is append-only'); END;

-- A sale header may only change how much of it has been paid (customer pays later), its status (void) and notes.
CREATE TRIGGER sales_no_delete BEFORE DELETE ON sales BEGIN SELECT RAISE(ABORT, 'sales is append-only'); END;
CREATE TRIGGER sales_immutable_fields BEFORE UPDATE OF
  ref, session_id, user_id, customer_id, warehouse_id, rate_lbp_per_usd, subtotal_lbp, discount_lbp,
  shipping_lbp, rounding_lbp, total_lbp, change_lbp, profit_lbp, client_sale_id, idempotency_key, legacy_id, created_at
ON sales BEGIN SELECT RAISE(ABORT, 'sale totals are immutable; use a return or a void'); END;

-- No sale may be recorded against a closed register session.
CREATE TRIGGER sales_session_must_be_open BEFORE INSERT ON sales
WHEN NEW.session_id IS NOT NULL AND (SELECT status FROM register_sessions WHERE id = NEW.session_id) <> 'open'
BEGIN SELECT RAISE(ABORT, 'REGISTER_CLOSED'); END;

-- A closed session is immutable (Z-report).
CREATE TRIGGER register_balances_closed_immutable BEFORE UPDATE ON register_balances
WHEN (SELECT status FROM register_sessions WHERE id = OLD.session_id) = 'closed'
BEGIN SELECT RAISE(ABORT, 'a closed register session cannot be changed'); END;
CREATE TRIGGER register_sessions_closed_immutable BEFORE UPDATE ON register_sessions
WHEN OLD.status = 'closed'
BEGIN SELECT RAISE(ABORT, 'a closed register session cannot be changed'); END;
