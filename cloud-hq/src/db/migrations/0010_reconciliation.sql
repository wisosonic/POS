-- The daily reconciliation (docs/12 §24, P4c): a branch says what it holds per table and day; HQ compares with its own copy and keeps the latest
-- result for each (branch, day). `diff_json` lists the tables that differ, each with the branch's figures and HQ's.
CREATE TABLE reconciliations (
  branch_id  INTEGER NOT NULL REFERENCES branches (id),
  day        TEXT NOT NULL,       -- YYYY-MM-DD (UTC): the date of the rows' own time
  status     TEXT NOT NULL CHECK (status IN ('ok', 'mismatch')),
  checked_at TEXT NOT NULL,
  diff_json  TEXT,
  PRIMARY KEY (branch_id, day)
);
CREATE INDEX ix_reconciliations_day ON reconciliations (day);
