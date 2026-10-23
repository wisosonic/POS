-- Supplier payments, and the rules that keep purchases honest.
-- Never edit an applied migration: schema changes are new numbered files.

CREATE TABLE purchase_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL REFERENCES purchases (id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0), -- in the purchase's currency
  note TEXT,
  user_id INTEGER REFERENCES users (id),
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX ix_purchase_payments_purchase ON purchase_payments (purchase_id);

CREATE TRIGGER purchase_payments_no_update BEFORE UPDATE ON purchase_payments BEGIN SELECT RAISE(ABORT, 'purchase_payments is append-only'); END;
CREATE TRIGGER purchase_payments_no_delete BEFORE DELETE ON purchase_payments BEGIN SELECT RAISE(ABORT, 'purchase_payments is append-only'); END;

-- Nothing can be paid beyond the total owed to the supplier.
CREATE TRIGGER purchases_cannot_overpay BEFORE UPDATE OF paid_minor ON purchases
WHEN NEW.paid_minor > NEW.total_minor
BEGIN SELECT RAISE(ABORT, 'a purchase cannot be paid beyond its total'); END;

-- Once goods are received the order's money and supplier are fixed. Corrections are new rows (adjustments, returns).
CREATE TRIGGER purchases_received_immutable BEFORE UPDATE OF supplier_id, warehouse_id, currency, total_minor ON purchases
WHEN OLD.status = 'received'
BEGIN SELECT RAISE(ABORT, 'a received purchase cannot be changed'); END;

CREATE TRIGGER purchases_no_delete BEFORE DELETE ON purchases
WHEN OLD.status <> 'draft'
BEGIN SELECT RAISE(ABORT, 'only a draft purchase can be deleted'); END;

-- A line already (partly) received keeps its product, quantity and cost.
CREATE TRIGGER purchase_items_received_immutable BEFORE UPDATE OF product_id, qty_milli, cost_minor ON purchase_items
WHEN OLD.received_milli > 0
BEGIN SELECT RAISE(ABORT, 'a line that has been received cannot be changed'); END;

-- Cannot receive more than was ordered.
CREATE TRIGGER purchase_items_cannot_overreceive BEFORE UPDATE OF received_milli ON purchase_items
WHEN NEW.received_milli > NEW.qty_milli
BEGIN SELECT RAISE(ABORT, 'cannot receive more than was ordered'); END;
