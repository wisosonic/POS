-- What HQ owns and sends DOWN to the branches (docs/12-sync-and-hq.md §5). First: the exchange rate.
-- Every change to an HQ-owned row also writes one line to change_log, in the same transaction (written by the code that makes the change,
-- not by a trigger, so it is the same on any database). A branch asks "what happened after number N?" and applies the answer in order.
CREATE TABLE exchange_rates (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  rate_lbp_per_usd INTEGER NOT NULL CHECK (rate_lbp_per_usd > 0),
  effective_from   TEXT NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX ix_hq_exchange_rates_effective ON exchange_rates (effective_from);

CREATE TABLE change_log (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT, -- never reused
  tbl        TEXT NOT NULL,
  pk         INTEGER NOT NULL,
  op         TEXT NOT NULL CHECK (op IN ('u', 'd')),
  created_at TEXT NOT NULL
);
-- The log only grows (a branch that was away for a month still gets everything): never edited or deleted.
CREATE TRIGGER change_log_no_update BEFORE UPDATE ON change_log BEGIN SELECT RAISE(ABORT, 'change_log is append-only'); END;
CREATE TRIGGER change_log_no_delete BEFORE DELETE ON change_log BEGIN SELECT RAISE(ABORT, 'change_log is append-only'); END;
