-- A manager's approval for one thing a cashier is not allowed to do alone (today: a discount above the cashier's limit).
-- The manager types their password at the till and sees the discount they are approving; the server answers with a token
-- that works once, for that cashier only, up to that much, for a few minutes. Only a hash of the token is kept.
CREATE TABLE approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK (scope IN ('discount')),
  requested_by INTEGER NOT NULL REFERENCES users (id), -- the cashier who may use it
  approved_by INTEGER NOT NULL REFERENCES users (id), -- the manager who gave it
  max_pct REAL NOT NULL CHECK (max_pct >= 0 AND max_pct <= 100), -- the discount, as a percent of the sale, that was approved
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
