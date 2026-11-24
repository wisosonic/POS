-- Stocktake (US-18): counting what is on the shelf and correcting the quantities that have drifted. A count is a list of
-- "this product, this many": the quantity the system held at the moment of counting is kept with each line, so selling goes on
-- while counting and only the real difference is posted when the count is finished. Posting adds adjustment movements to the
-- ledger; nothing is ever overwritten. A finished count cannot be changed (database triggers).
CREATE TABLE stocktakes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'committed', 'cancelled')),
  created_by INTEGER REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_by INTEGER REFERENCES users (id),
  finished_at TEXT,
  idempotency_key TEXT UNIQUE,
  CHECK ((status = 'open') = (finished_at IS NULL))
);

CREATE TABLE stocktake_lines (
  stocktake_id INTEGER NOT NULL REFERENCES stocktakes (id),
  product_id INTEGER NOT NULL REFERENCES products (id),
  -- what the system said was on hand when this product was counted, and what was counted, in thousandths
  system_milli INTEGER NOT NULL,
  counted_milli INTEGER NOT NULL CHECK (counted_milli >= 0),
  counted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (stocktake_id, product_id)
) WITHOUT ROWID;

-- A count that is finished or cancelled is history.
CREATE TRIGGER stocktakes_no_delete BEFORE DELETE ON stocktakes BEGIN SELECT RAISE(ABORT, 'stocktakes is append-only'); END;
CREATE TRIGGER stocktakes_finished_immutable BEFORE UPDATE ON stocktakes
WHEN OLD.status <> 'open'
BEGIN SELECT RAISE(ABORT, 'a finished stocktake cannot be changed'); END;
CREATE TRIGGER stocktake_lines_insert_open BEFORE INSERT ON stocktake_lines
WHEN (SELECT status FROM stocktakes WHERE id = NEW.stocktake_id) <> 'open'
BEGIN SELECT RAISE(ABORT, 'a finished stocktake cannot be changed'); END;
CREATE TRIGGER stocktake_lines_update_open BEFORE UPDATE ON stocktake_lines
WHEN (SELECT status FROM stocktakes WHERE id = OLD.stocktake_id) <> 'open'
BEGIN SELECT RAISE(ABORT, 'a finished stocktake cannot be changed'); END;
CREATE TRIGGER stocktake_lines_delete_open BEFORE DELETE ON stocktake_lines
WHEN (SELECT status FROM stocktakes WHERE id = OLD.stocktake_id) <> 'open'
BEGIN SELECT RAISE(ABORT, 'a finished stocktake cannot be changed'); END;
