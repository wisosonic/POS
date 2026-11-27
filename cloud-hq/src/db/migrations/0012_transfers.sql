-- Moving stock between branches at HQ (docs/15 §4, P5b). The mirror tables of what branches write (same rules as 0002 and 0009), and what HQ writes:
-- the relay of each shipment to its receiver (incoming_shipments + items) and the directory of branches every branch is told about.

CREATE TABLE shipments (
  branch_id INTEGER NOT NULL,
  id INTEGER NOT NULL,
  to_branch_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  note TEXT,
  item_count INTEGER NOT NULL,
  user_id INTEGER,
  created_at TEXT NOT NULL,
  hq_received_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, id)
);
CREATE INDEX ix_shipments_branch_created_at ON shipments (branch_id, created_at);

CREATE TABLE shipment_items (
  branch_id INTEGER NOT NULL,
  id INTEGER NOT NULL,
  shipment_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  qty_milli INTEGER NOT NULL,
  unit_cost INTEGER NOT NULL,
  hq_received_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, id)
);
CREATE INDEX ix_shipment_items_branch_shipment_id ON shipment_items (branch_id, shipment_id);

CREATE TABLE receipts (
  branch_id INTEGER NOT NULL,
  id INTEGER NOT NULL,
  incoming_id INTEGER NOT NULL,
  from_branch_id INTEGER NOT NULL,
  user_id INTEGER,
  note TEXT,
  created_at TEXT NOT NULL,
  hq_received_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, id)
);
CREATE INDEX ix_receipts_branch_created_at ON receipts (branch_id, created_at);

CREATE TABLE receipt_items (
  branch_id INTEGER NOT NULL,
  id INTEGER NOT NULL,
  receipt_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  qty_expected_milli INTEGER NOT NULL,
  qty_counted_milli INTEGER NOT NULL,
  reason TEXT,
  hq_received_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, id)
);
CREATE INDEX ix_receipt_items_branch_receipt_id ON receipt_items (branch_id, receipt_id);

-- One receipt per incoming shipment, whoever the receiving branch is.
CREATE UNIQUE INDEX ux_receipts_incoming ON receipts (branch_id, incoming_id);

-- What HQ relays. Under HQ's own ids (a branch stores them as its own: they are only ever filled from HQ). The lines of the change log for these
-- are meant for the receiving branch only (change_log.branch_id).
CREATE TABLE incoming_shipments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  from_branch_id INTEGER NOT NULL,
  to_branch_id   INTEGER NOT NULL,
  shipment_id    INTEGER NOT NULL,
  reason         TEXT NOT NULL,
  note           TEXT,
  shipped_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  UNIQUE (from_branch_id, shipment_id)
);
CREATE INDEX ix_incoming_shipments_to ON incoming_shipments (to_branch_id);
CREATE TABLE incoming_shipment_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  incoming_id INTEGER NOT NULL,
  product_id  INTEGER NOT NULL,
  qty_milli   INTEGER NOT NULL,
  unit_cost   INTEGER NOT NULL
);
CREATE INDEX ix_incoming_items_incoming ON incoming_shipment_items (incoming_id);

-- Who the branches are, told to every branch (so a manager can choose where to send). Kept up to date by the code that adds or changes a branch.
CREATE TABLE branch_directory (
  id     INTEGER PRIMARY KEY,
  code   TEXT NOT NULL,
  name   TEXT NOT NULL,
  kind   TEXT NOT NULL,
  active INTEGER NOT NULL
);
INSERT INTO branch_directory (id, code, name, kind, active) SELECT id, code, name, kind, active FROM branches;
INSERT INTO change_log (tbl, pk, op, created_at) SELECT 'branch_directory', id, 'u', strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM branches;
