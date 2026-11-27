-- Requests and routing (docs/15 §5, P5c). A SALE branch's manager asks for items (stock_requests); HQ routes the request down that branch's ordered list of
-- STOCK branches and sends a pick list to the first one (pick_lists, filled only from HQ). The stock branch fills it with ONE command: it ships what it has
-- (a shipment, as in P5b) and records, line by line, what it asked and what it shipped (pick_results). The shortfall is "cannot supply": HQ sends the
-- remainder to the next stock branch, and so on; when none is left the line is closed as not available. request_status tells the requester where each
-- line stands. One writer per document; history is append-only.
CREATE TABLE stock_requests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  note       TEXT,
  item_count INTEGER NOT NULL CHECK (item_count > 0), -- HQ routes the request once it holds this many lines
  user_id    INTEGER REFERENCES users (id),
  created_at TEXT NOT NULL
);
CREATE TABLE stock_request_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES stock_requests (id),
  product_id INTEGER NOT NULL REFERENCES products (id),
  qty_milli  INTEGER NOT NULL CHECK (qty_milli > 0)
);
CREATE INDEX ix_stock_request_items_request ON stock_request_items (request_id);

CREATE TABLE pick_results (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  pick_list_id INTEGER NOT NULL UNIQUE,              -- HQ's pick list this answers: one answer each
  shipment_id  INTEGER REFERENCES shipments (id),    -- NULL when nothing at all could be shipped
  item_count   INTEGER NOT NULL CHECK (item_count > 0),
  user_id      INTEGER REFERENCES users (id),
  created_at   TEXT NOT NULL
);
CREATE TABLE pick_result_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  result_id         INTEGER NOT NULL REFERENCES pick_results (id),
  product_id        INTEGER NOT NULL REFERENCES products (id),
  qty_asked_milli   INTEGER NOT NULL CHECK (qty_asked_milli > 0),
  qty_shipped_milli INTEGER NOT NULL CHECK (qty_shipped_milli >= 0)
);
CREATE INDEX ix_pick_result_items_result ON pick_result_items (result_id);

CREATE TRIGGER stock_requests_no_update BEFORE UPDATE ON stock_requests BEGIN SELECT RAISE(ABORT, 'stock_requests is append-only'); END;
CREATE TRIGGER stock_requests_no_delete BEFORE DELETE ON stock_requests BEGIN SELECT RAISE(ABORT, 'stock_requests is append-only'); END;
CREATE TRIGGER stock_request_items_no_update BEFORE UPDATE ON stock_request_items BEGIN SELECT RAISE(ABORT, 'stock_request_items is append-only'); END;
CREATE TRIGGER stock_request_items_no_delete BEFORE DELETE ON stock_request_items BEGIN SELECT RAISE(ABORT, 'stock_request_items is append-only'); END;
CREATE TRIGGER pick_results_no_update BEFORE UPDATE ON pick_results BEGIN SELECT RAISE(ABORT, 'pick_results is append-only'); END;
CREATE TRIGGER pick_results_no_delete BEFORE DELETE ON pick_results BEGIN SELECT RAISE(ABORT, 'pick_results is append-only'); END;
CREATE TRIGGER pick_result_items_no_update BEFORE UPDATE ON pick_result_items BEGIN SELECT RAISE(ABORT, 'pick_result_items is append-only'); END;
CREATE TRIGGER pick_result_items_no_delete BEFORE DELETE ON pick_result_items BEGIN SELECT RAISE(ABORT, 'pick_result_items is append-only'); END;

-- What HQ sends down (HQ's id is the id here: these are only ever filled from HQ).
CREATE TABLE pick_lists (
  id              INTEGER PRIMARY KEY,
  for_branch_id   INTEGER NOT NULL,   -- the shop that asked: where the shipment goes
  stock_branch_id INTEGER NOT NULL,   -- the stock branch asked to fill it
  request_id      INTEGER NOT NULL,   -- the shop's own number of its request
  status          TEXT NOT NULL,      -- open | answered
  note            TEXT,
  opened_at       TEXT NOT NULL
);
CREATE TABLE pick_list_items (
  id           INTEGER PRIMARY KEY,
  pick_list_id INTEGER NOT NULL,
  product_id   INTEGER NOT NULL,
  qty_milli    INTEGER NOT NULL
);
CREATE INDEX ix_pick_list_items_list ON pick_list_items (pick_list_id);
CREATE TABLE request_status (
  id                INTEGER PRIMARY KEY,
  for_branch_id     INTEGER NOT NULL,
  request_id        INTEGER NOT NULL,
  product_id        INTEGER NOT NULL,
  wanted_milli      INTEGER NOT NULL,
  shipped_milli     INTEGER NOT NULL,   -- shipped so far by the stock branches (on the way or already received)
  unavailable_milli INTEGER NOT NULL,   -- no stock branch in the list could supply it
  status            TEXT NOT NULL       -- waiting | picking | done
);
CREATE INDEX ix_request_status_request ON request_status (request_id);

-- stock_requests
CREATE TRIGGER sync_stock_requests_ai AFTER INSERT ON stock_requests WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('stock_requests', NEW.id, 'u'); END;
CREATE TRIGGER sync_stock_requests_au AFTER UPDATE ON stock_requests WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('stock_requests', NEW.id, 'u'); END;
CREATE TRIGGER sync_stock_requests_ad AFTER DELETE ON stock_requests WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('stock_requests', OLD.id, 'd'); END;

-- stock_request_items
CREATE TRIGGER sync_stock_request_items_ai AFTER INSERT ON stock_request_items WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('stock_request_items', NEW.id, 'u'); END;
CREATE TRIGGER sync_stock_request_items_au AFTER UPDATE ON stock_request_items WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('stock_request_items', NEW.id, 'u'); END;
CREATE TRIGGER sync_stock_request_items_ad AFTER DELETE ON stock_request_items WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('stock_request_items', OLD.id, 'd'); END;

-- pick_results
CREATE TRIGGER sync_pick_results_ai AFTER INSERT ON pick_results WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('pick_results', NEW.id, 'u'); END;
CREATE TRIGGER sync_pick_results_au AFTER UPDATE ON pick_results WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('pick_results', NEW.id, 'u'); END;
CREATE TRIGGER sync_pick_results_ad AFTER DELETE ON pick_results WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('pick_results', OLD.id, 'd'); END;

-- pick_result_items
CREATE TRIGGER sync_pick_result_items_ai AFTER INSERT ON pick_result_items WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('pick_result_items', NEW.id, 'u'); END;
CREATE TRIGGER sync_pick_result_items_au AFTER UPDATE ON pick_result_items WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('pick_result_items', NEW.id, 'u'); END;
CREATE TRIGGER sync_pick_result_items_ad AFTER DELETE ON pick_result_items WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('pick_result_items', OLD.id, 'd'); END;

-- A branch that is connected right now: the rows that exist (none yet) are the snapshot's job, the triggers above cover everything new.
INSERT INTO sync_snapshot (tbl, upto) SELECT 'stock_requests', COALESCE(MAX(id), 0) FROM stock_requests WHERE (SELECT capture FROM sync_control WHERE id = 1) = 1;
INSERT INTO sync_snapshot (tbl, upto) SELECT 'stock_request_items', COALESCE(MAX(id), 0) FROM stock_request_items WHERE (SELECT capture FROM sync_control WHERE id = 1) = 1;
INSERT INTO sync_snapshot (tbl, upto) SELECT 'pick_results', COALESCE(MAX(id), 0) FROM pick_results WHERE (SELECT capture FROM sync_control WHERE id = 1) = 1;
INSERT INTO sync_snapshot (tbl, upto) SELECT 'pick_result_items', COALESCE(MAX(id), 0) FROM pick_result_items WHERE (SELECT capture FROM sync_control WHERE id = 1) = 1;
