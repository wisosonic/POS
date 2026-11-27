-- Moving stock between branches (docs/15 §4, P5b). Two documents, each written by ONE party and sent up like any fact:
--   shipments + shipment_items   written by the SENDING branch: stock leaves it, in the same transaction
--   receipts  + receipt_items    written by the RECEIVING branch: stock enters it, any difference becomes an adjustment
-- HQ relays each shipment to the receiver as incoming_shipments + incoming_shipment_items (under HQ's own ids: they are only ever filled from HQ),
-- and tells every branch who the other branches are (branch_directory). History is append-only (rule 4): a mistake is corrected by the receiver's count.
CREATE TABLE shipments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  to_branch_id  INTEGER NOT NULL,             -- HQ's id of the receiving branch (branch_directory)
  reason        TEXT NOT NULL CHECK (reason IN ('supply', 'rebalance', 'return')),
  note          TEXT,
  item_count    INTEGER NOT NULL CHECK (item_count > 0), -- HQ relays the shipment once it holds this many lines
  user_id       INTEGER REFERENCES users (id),
  created_at    TEXT NOT NULL
);
CREATE TABLE shipment_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id INTEGER NOT NULL REFERENCES shipments (id),
  product_id  INTEGER NOT NULL REFERENCES products (id),
  qty_milli   INTEGER NOT NULL CHECK (qty_milli > 0),
  unit_cost   INTEGER NOT NULL CHECK (unit_cost >= 0) -- the sender's cost of the product (in the product's currency) when it left
);
CREATE INDEX ix_shipment_items_shipment ON shipment_items (shipment_id);

CREATE TABLE receipts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  incoming_id    INTEGER NOT NULL UNIQUE,     -- the incoming shipment confirmed: one receipt each
  from_branch_id INTEGER NOT NULL,
  user_id        INTEGER REFERENCES users (id),
  note           TEXT,
  created_at     TEXT NOT NULL
);
CREATE TABLE receipt_items (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id         INTEGER NOT NULL REFERENCES receipts (id),
  product_id         INTEGER NOT NULL REFERENCES products (id),
  qty_expected_milli INTEGER NOT NULL CHECK (qty_expected_milli > 0),
  qty_counted_milli  INTEGER NOT NULL CHECK (qty_counted_milli >= 0),
  reason             TEXT                       -- required when counted differs from expected
);
CREATE INDEX ix_receipt_items_receipt ON receipt_items (receipt_id);

CREATE TRIGGER shipments_no_update BEFORE UPDATE ON shipments BEGIN SELECT RAISE(ABORT, 'shipments is append-only'); END;
CREATE TRIGGER shipments_no_delete BEFORE DELETE ON shipments BEGIN SELECT RAISE(ABORT, 'shipments is append-only'); END;
CREATE TRIGGER shipment_items_no_update BEFORE UPDATE ON shipment_items BEGIN SELECT RAISE(ABORT, 'shipment_items is append-only'); END;
CREATE TRIGGER shipment_items_no_delete BEFORE DELETE ON shipment_items BEGIN SELECT RAISE(ABORT, 'shipment_items is append-only'); END;
CREATE TRIGGER receipts_no_update BEFORE UPDATE ON receipts BEGIN SELECT RAISE(ABORT, 'receipts is append-only'); END;
CREATE TRIGGER receipts_no_delete BEFORE DELETE ON receipts BEGIN SELECT RAISE(ABORT, 'receipts is append-only'); END;
CREATE TRIGGER receipt_items_no_update BEFORE UPDATE ON receipt_items BEGIN SELECT RAISE(ABORT, 'receipt_items is append-only'); END;
CREATE TRIGGER receipt_items_no_delete BEFORE DELETE ON receipt_items BEGIN SELECT RAISE(ABORT, 'receipt_items is append-only'); END;

-- What HQ sends down. Filled only from HQ, so HQ's id is the id here (no collision with ids this branch made).
CREATE TABLE branch_directory (
  id     INTEGER PRIMARY KEY,
  code   TEXT NOT NULL,
  name   TEXT NOT NULL,
  kind   TEXT NOT NULL,
  active INTEGER NOT NULL
);
CREATE TABLE incoming_shipments (
  id             INTEGER PRIMARY KEY,
  from_branch_id INTEGER NOT NULL,
  to_branch_id   INTEGER NOT NULL,
  shipment_id    INTEGER NOT NULL,
  reason         TEXT NOT NULL,
  note           TEXT,
  shipped_at     TEXT NOT NULL
);
CREATE TABLE incoming_shipment_items (
  id          INTEGER PRIMARY KEY,
  incoming_id INTEGER NOT NULL,
  product_id  INTEGER NOT NULL,
  qty_milli   INTEGER NOT NULL,
  unit_cost   INTEGER NOT NULL
);
CREATE INDEX ix_incoming_items_incoming ON incoming_shipment_items (incoming_id);

-- shipments
CREATE TRIGGER sync_shipments_ai AFTER INSERT ON shipments WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('shipments', NEW.id, 'u'); END;
CREATE TRIGGER sync_shipments_au AFTER UPDATE ON shipments WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('shipments', NEW.id, 'u'); END;
CREATE TRIGGER sync_shipments_ad AFTER DELETE ON shipments WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('shipments', OLD.id, 'd'); END;

-- shipment_items
CREATE TRIGGER sync_shipment_items_ai AFTER INSERT ON shipment_items WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('shipment_items', NEW.id, 'u'); END;
CREATE TRIGGER sync_shipment_items_au AFTER UPDATE ON shipment_items WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('shipment_items', NEW.id, 'u'); END;
CREATE TRIGGER sync_shipment_items_ad AFTER DELETE ON shipment_items WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('shipment_items', OLD.id, 'd'); END;

-- receipts
CREATE TRIGGER sync_receipts_ai AFTER INSERT ON receipts WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('receipts', NEW.id, 'u'); END;
CREATE TRIGGER sync_receipts_au AFTER UPDATE ON receipts WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('receipts', NEW.id, 'u'); END;
CREATE TRIGGER sync_receipts_ad AFTER DELETE ON receipts WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('receipts', OLD.id, 'd'); END;

-- receipt_items
CREATE TRIGGER sync_receipt_items_ai AFTER INSERT ON receipt_items WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('receipt_items', NEW.id, 'u'); END;
CREATE TRIGGER sync_receipt_items_au AFTER UPDATE ON receipt_items WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('receipt_items', NEW.id, 'u'); END;
CREATE TRIGGER sync_receipt_items_ad AFTER DELETE ON receipt_items WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('receipt_items', OLD.id, 'd'); END;

-- A branch that is connected right now: the rows that exist (none yet) are the snapshot's job, the triggers above cover everything new.
INSERT INTO sync_snapshot (tbl, upto) SELECT 'shipments', COALESCE(MAX(id), 0) FROM shipments WHERE (SELECT capture FROM sync_control WHERE id = 1) = 1;
INSERT INTO sync_snapshot (tbl, upto) SELECT 'shipment_items', COALESCE(MAX(id), 0) FROM shipment_items WHERE (SELECT capture FROM sync_control WHERE id = 1) = 1;
INSERT INTO sync_snapshot (tbl, upto) SELECT 'receipts', COALESCE(MAX(id), 0) FROM receipts WHERE (SELECT capture FROM sync_control WHERE id = 1) = 1;
INSERT INTO sync_snapshot (tbl, upto) SELECT 'receipt_items', COALESCE(MAX(id), 0) FROM receipt_items WHERE (SELECT capture FROM sync_control WHERE id = 1) = 1;
