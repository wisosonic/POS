-- Central purchasing at HQ (docs/15 §6, P5d): the orders HQ makes, what is paid to suppliers, what each stock branch expects (sent down) and what it
-- has received (mirrors of what it writes).
CREATE TABLE purchase_orders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER REFERENCES suppliers (id),
  currency    TEXT NOT NULL CHECK (currency IN ('USD', 'LBP')),
  status      TEXT NOT NULL CHECK (status IN ('draft', 'ordered', 'closed', 'cancelled')),
  note        TEXT,
  created_at  TEXT NOT NULL,
  ordered_at  TEXT,
  closed_at   TEXT
);
-- One line per stock branch and product: the split of an order between stock branches is just several lines of the same product.
CREATE TABLE purchase_order_lines (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id        INTEGER NOT NULL REFERENCES purchase_orders (id),
  stock_branch_id INTEGER NOT NULL REFERENCES branches (id),
  product_id      INTEGER NOT NULL REFERENCES products (id),
  qty_milli       INTEGER NOT NULL CHECK (qty_milli > 0),
  unit_cost_minor INTEGER NOT NULL CHECK (unit_cost_minor >= 0), -- in the order's currency
  UNIQUE (order_id, stock_branch_id, product_id)
);
CREATE INDEX ix_po_lines_order ON purchase_order_lines (order_id);
-- What HQ paid a supplier on an order. Append-only in spirit (nothing edits it); the key makes a repeated request one payment.
CREATE TABLE supplier_payments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id        INTEGER NOT NULL REFERENCES purchase_orders (id),
  amount_minor    INTEGER NOT NULL CHECK (amount_minor > 0),
  note            TEXT,
  idempotency_key TEXT UNIQUE,
  created_at      TEXT NOT NULL
);
CREATE TRIGGER supplier_payments_no_update BEFORE UPDATE ON supplier_payments BEGIN SELECT RAISE(ABORT, 'supplier_payments is append-only'); END;
CREATE TRIGGER supplier_payments_no_delete BEFORE DELETE ON supplier_payments BEGIN SELECT RAISE(ABORT, 'supplier_payments is append-only'); END;

CREATE TABLE po_receipts (
  branch_id INTEGER NOT NULL,
  id INTEGER NOT NULL,
  delivery_id INTEGER NOT NULL,
  note TEXT,
  item_count INTEGER NOT NULL,
  user_id INTEGER,
  created_at TEXT NOT NULL,
  hq_received_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, id)
);
CREATE INDEX ix_po_receipts_branch_created_at ON po_receipts (branch_id, created_at);

CREATE TABLE po_receipt_items (
  branch_id INTEGER NOT NULL,
  id INTEGER NOT NULL,
  receipt_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  qty_milli INTEGER NOT NULL,
  hq_received_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, id)
);
CREATE INDEX ix_po_receipt_items_branch_receipt_id ON po_receipt_items (branch_id, receipt_id);

-- What HQ sends down, to ONE stock branch each (the change-log lines carry its id).
CREATE TABLE expected_deliveries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id        INTEGER NOT NULL,
  stock_branch_id INTEGER NOT NULL,
  supplier_id     INTEGER,
  currency        TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('open', 'closed', 'cancelled')),
  note            TEXT,
  ordered_at      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE (order_id, stock_branch_id)
);
CREATE INDEX ix_expected_deliveries_branch ON expected_deliveries (stock_branch_id, status);
CREATE TABLE expected_delivery_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id     INTEGER NOT NULL,
  line_id         INTEGER NOT NULL,
  product_id      INTEGER NOT NULL,
  qty_milli       INTEGER NOT NULL,
  unit_cost_minor INTEGER NOT NULL
);
CREATE INDEX ix_expected_items_delivery ON expected_delivery_items (delivery_id);
