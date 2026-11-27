-- Requests and routing at HQ (docs/15 §5, P5c): the mirrors of what branches write, and what HQ writes: the ordered list of stock branches per shop
-- (supply_routes), the pick lists it sends to stock branches, and the status of every requested line it tells the shop about.

CREATE TABLE stock_requests (
  branch_id INTEGER NOT NULL,
  id INTEGER NOT NULL,
  note TEXT,
  item_count INTEGER NOT NULL,
  user_id INTEGER,
  created_at TEXT NOT NULL,
  hq_received_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, id)
);
CREATE INDEX ix_stock_requests_branch_created_at ON stock_requests (branch_id, created_at);

CREATE TABLE stock_request_items (
  branch_id INTEGER NOT NULL,
  id INTEGER NOT NULL,
  request_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  qty_milli INTEGER NOT NULL,
  hq_received_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, id)
);
CREATE INDEX ix_stock_request_items_branch_request_id ON stock_request_items (branch_id, request_id);

CREATE TABLE pick_results (
  branch_id INTEGER NOT NULL,
  id INTEGER NOT NULL,
  pick_list_id INTEGER NOT NULL,
  shipment_id INTEGER,
  item_count INTEGER NOT NULL,
  user_id INTEGER,
  created_at TEXT NOT NULL,
  hq_received_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, id)
);
CREATE INDEX ix_pick_results_branch_created_at ON pick_results (branch_id, created_at);

CREATE TABLE pick_result_items (
  branch_id INTEGER NOT NULL,
  id INTEGER NOT NULL,
  result_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  qty_asked_milli INTEGER NOT NULL,
  qty_shipped_milli INTEGER NOT NULL,
  hq_received_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, id)
);
CREATE INDEX ix_pick_result_items_branch_result_id ON pick_result_items (branch_id, result_id);

-- One answer per pick list, whoever answers.
CREATE UNIQUE INDEX ux_pick_results_list ON pick_results (branch_id, pick_list_id);

-- Who supplies whom: for each SALE branch, the STOCK branches in order ("nearest first"), set by an admin. Not sent to branches.
CREATE TABLE supply_routes (
  sale_branch_id  INTEGER NOT NULL REFERENCES branches (id),
  stock_branch_id INTEGER NOT NULL REFERENCES branches (id),
  rank            INTEGER NOT NULL CHECK (rank >= 1),
  PRIMARY KEY (sale_branch_id, stock_branch_id),
  UNIQUE (sale_branch_id, rank)
);

-- What HQ sends down. The change-log lines for these are meant for ONE branch (the stock branch for a pick list, the shop for a request's status).
CREATE TABLE pick_lists (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  for_branch_id   INTEGER NOT NULL,
  stock_branch_id INTEGER NOT NULL,
  request_id      INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('open', 'answered')),
  note            TEXT,
  opened_at       TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX ix_pick_lists_request ON pick_lists (for_branch_id, request_id);
CREATE INDEX ix_pick_lists_stock ON pick_lists (stock_branch_id, status);
CREATE TABLE pick_list_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  pick_list_id INTEGER NOT NULL,
  product_id   INTEGER NOT NULL,
  qty_milli    INTEGER NOT NULL
);
CREATE INDEX ix_pick_list_items_list ON pick_list_items (pick_list_id);
CREATE TABLE request_status (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  for_branch_id     INTEGER NOT NULL,
  request_id        INTEGER NOT NULL,
  product_id        INTEGER NOT NULL,
  wanted_milli      INTEGER NOT NULL,
  shipped_milli     INTEGER NOT NULL,
  unavailable_milli INTEGER NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('waiting', 'picking', 'done')),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (for_branch_id, request_id, product_id)
);
