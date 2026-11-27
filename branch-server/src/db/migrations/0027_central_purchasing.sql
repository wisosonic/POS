-- Central purchasing (docs/15 §6, P5d). HQ buys; the goods are delivered to STOCK branches only. HQ sends each stock branch what it expects
-- (expected_deliveries + items, filled only from HQ) and the stock branch RECEIVES against it, in parts if the goods come in parts (po_receipts +
-- items, written by the stock branch and sent up like any fact): stock enters through the ledger and the product's cost follows the price paid, as for
-- any received purchase. HQ pays the suppliers. A connected branch makes no purchases of its own (modules/purchases refuses: HQ_OWNS_PURCHASING).
CREATE TABLE po_receipts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id INTEGER NOT NULL,                   -- HQ's expected delivery this receives against
  note        TEXT,
  item_count  INTEGER NOT NULL CHECK (item_count > 0), -- HQ takes the receipt in once it holds this many lines
  user_id     INTEGER REFERENCES users (id),
  created_at  TEXT NOT NULL
);
CREATE TABLE po_receipt_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id INTEGER NOT NULL REFERENCES po_receipts (id),
  item_id    INTEGER NOT NULL,                    -- HQ's expected_delivery_items id
  product_id INTEGER NOT NULL REFERENCES products (id),
  qty_milli  INTEGER NOT NULL CHECK (qty_milli > 0)
);
CREATE INDEX ix_po_receipt_items_receipt ON po_receipt_items (receipt_id);

CREATE TRIGGER po_receipts_no_update BEFORE UPDATE ON po_receipts BEGIN SELECT RAISE(ABORT, 'po_receipts is append-only'); END;
CREATE TRIGGER po_receipts_no_delete BEFORE DELETE ON po_receipts BEGIN SELECT RAISE(ABORT, 'po_receipts is append-only'); END;
CREATE TRIGGER po_receipt_items_no_update BEFORE UPDATE ON po_receipt_items BEGIN SELECT RAISE(ABORT, 'po_receipt_items is append-only'); END;
CREATE TRIGGER po_receipt_items_no_delete BEFORE DELETE ON po_receipt_items BEGIN SELECT RAISE(ABORT, 'po_receipt_items is append-only'); END;

-- What HQ sends down to the stock branch that must receive (HQ's id is the id here: only ever filled from HQ).
CREATE TABLE expected_deliveries (
  id              INTEGER PRIMARY KEY,
  order_id        INTEGER NOT NULL,
  stock_branch_id INTEGER NOT NULL,
  supplier_id     INTEGER,                         -- a supplier of the catalog (the same ids at every branch)
  currency        TEXT NOT NULL,                   -- the order's currency: the unit costs are in it
  status          TEXT NOT NULL,                   -- open | closed | cancelled
  note            TEXT,
  ordered_at      TEXT NOT NULL
);
CREATE TABLE expected_delivery_items (
  id              INTEGER PRIMARY KEY,
  delivery_id     INTEGER NOT NULL,
  line_id         INTEGER NOT NULL,                -- HQ's order line
  product_id      INTEGER NOT NULL,
  qty_milli       INTEGER NOT NULL,
  unit_cost_minor INTEGER NOT NULL
);
CREATE INDEX ix_expected_items_delivery ON expected_delivery_items (delivery_id);

-- po_receipts
CREATE TRIGGER sync_po_receipts_ai AFTER INSERT ON po_receipts WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('po_receipts', NEW.id, 'u'); END;
CREATE TRIGGER sync_po_receipts_au AFTER UPDATE ON po_receipts WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('po_receipts', NEW.id, 'u'); END;
CREATE TRIGGER sync_po_receipts_ad AFTER DELETE ON po_receipts WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('po_receipts', OLD.id, 'd'); END;

-- po_receipt_items
CREATE TRIGGER sync_po_receipt_items_ai AFTER INSERT ON po_receipt_items WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('po_receipt_items', NEW.id, 'u'); END;
CREATE TRIGGER sync_po_receipt_items_au AFTER UPDATE ON po_receipt_items WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('po_receipt_items', NEW.id, 'u'); END;
CREATE TRIGGER sync_po_receipt_items_ad AFTER DELETE ON po_receipt_items WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('po_receipt_items', OLD.id, 'd'); END;

-- A branch that is connected right now: the rows that exist (none yet) are the snapshot's job, the triggers above cover everything new.
INSERT INTO sync_snapshot (tbl, upto) SELECT 'po_receipts', COALESCE(MAX(id), 0) FROM po_receipts WHERE (SELECT capture FROM sync_control WHERE id = 1) = 1;
INSERT INTO sync_snapshot (tbl, upto) SELECT 'po_receipt_items', COALESCE(MAX(id), 0) FROM po_receipt_items WHERE (SELECT capture FROM sync_control WHERE id = 1) = 1;
