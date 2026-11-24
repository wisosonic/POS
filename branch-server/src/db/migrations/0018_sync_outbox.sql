-- Sending a branch's records to HQ (docs/12-sync-and-hq.md §3). Row-level change capture by database triggers: when a row of a synced table
-- is inserted, changed or deleted, the database itself writes one small line to sync_outbox in the same statement, so the line commits or
-- rolls back together with the sale and cannot be forgotten by any code path (a sale, a void, a permanent delete, an import).
--
-- Capture is ON only while this branch is connected to HQ (sync_control.capture): a shop that is not connected collects nothing. When the
-- branch connects, the rows that already exist are sent by a resumable snapshot (sync_snapshot) while the triggers cover everything new.
--
-- The outbox says WHICH row changed, not what it contains: the sender reads the row as it is when it sends, so ten updates of one sale
-- go out as one message and a deleted row goes out as a tombstone. HQ stores each message with an upsert, so sending one twice is harmless.
-- Rows travel in the order they were written. The tables listed here are the ones in packages/core/src/sync.ts (SYNC_TABLES): a test
-- checks the two agree. A table added later gets its own migration with its own three triggers.
CREATE TABLE sync_control (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  capture      INTEGER NOT NULL DEFAULT 0 CHECK (capture IN (0, 1)),
  last_push_at TEXT
);
INSERT INTO sync_control (id) VALUES (1);

CREATE TABLE sync_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, -- AUTOINCREMENT: a number is never used twice, even after rows are cleared
  tbl TEXT NOT NULL,
  pk  INTEGER NOT NULL,
  op  TEXT NOT NULL CHECK (op IN ('u', 'd'))
);

-- Where the one-off send of the rows that existed when the branch connected has got to, per table.
CREATE TABLE sync_snapshot (
  tbl     TEXT PRIMARY KEY,
  upto    INTEGER NOT NULL,           -- the highest id when the branch connected: later rows are the triggers' job
  next_pk INTEGER NOT NULL DEFAULT 0, -- everything up to here has been sent
  done    INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1))
);

-- sales
CREATE TRIGGER sync_sales_ai AFTER INSERT ON sales WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('sales', NEW.id, 'u'); END;
CREATE TRIGGER sync_sales_au AFTER UPDATE ON sales WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('sales', NEW.id, 'u'); END;
CREATE TRIGGER sync_sales_ad AFTER DELETE ON sales WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('sales', OLD.id, 'd'); END;

-- sale_items
CREATE TRIGGER sync_sale_items_ai AFTER INSERT ON sale_items WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('sale_items', NEW.id, 'u'); END;
CREATE TRIGGER sync_sale_items_au AFTER UPDATE ON sale_items WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('sale_items', NEW.id, 'u'); END;
CREATE TRIGGER sync_sale_items_ad AFTER DELETE ON sale_items WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('sale_items', OLD.id, 'd'); END;

-- payments
CREATE TRIGGER sync_payments_ai AFTER INSERT ON payments WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('payments', NEW.id, 'u'); END;
CREATE TRIGGER sync_payments_au AFTER UPDATE ON payments WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('payments', NEW.id, 'u'); END;
CREATE TRIGGER sync_payments_ad AFTER DELETE ON payments WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('payments', OLD.id, 'd'); END;

-- stock_movements
CREATE TRIGGER sync_stock_movements_ai AFTER INSERT ON stock_movements WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('stock_movements', NEW.id, 'u'); END;
CREATE TRIGGER sync_stock_movements_au AFTER UPDATE ON stock_movements WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('stock_movements', NEW.id, 'u'); END;
CREATE TRIGGER sync_stock_movements_ad AFTER DELETE ON stock_movements WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('stock_movements', OLD.id, 'd'); END;
