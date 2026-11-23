-- Branches and terminals (docs/11-multi-branch.md §3.4). A branch server serves one branch with several tills ("terminals"). Each
-- terminal has its own register session (the one-open-session-per-terminal index already exists in 0001), and may be given its own
-- warehouse. A terminal is identified by a device token made when someone with the admin role enrols the till with a one-time code;
-- only hashes are stored. Until a till is enrolled, a server with exactly ONE terminal keeps working as before (legacy single-till mode).
CREATE TABLE branches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 1 AND 8), -- printed in receipt numbers, e.g. B2-004711
  name        TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at  TEXT NOT NULL
);

CREATE TABLE terminals (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id        INTEGER NOT NULL REFERENCES branches (id),
  warehouse_id     INTEGER REFERENCES warehouses (id), -- NULL = the shop's first warehouse
  code             TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 1 AND 32), -- what register_sessions.terminal_id holds
  name             TEXT NOT NULL,
  token_hash       TEXT UNIQUE,        -- sha256 of the device token; NULL until the till is enrolled
  enrol_hash       TEXT UNIQUE,        -- sha256 of the one-time enrolment code; NULL when none is pending
  enrol_expires_at TEXT,
  enrolled_at      TEXT,
  active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at       TEXT NOT NULL
);

-- The till that exists today becomes branch B1, terminal T1 (the legacy import and every existing register session use 'T1').
INSERT INTO branches (code, name, created_at) VALUES ('B1', 'Main branch', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
INSERT INTO terminals (branch_id, code, name, created_at) VALUES (1, 'T1', 'Till 1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
