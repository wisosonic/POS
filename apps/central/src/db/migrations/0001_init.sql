-- The HQ server's own database (docs/12-sync-and-hq.md). HQ knows every branch; each branch connects with a token it got by trading a
-- one-time code, and HQ stores only hashes of both. The tables for what branches record, and for what HQ owns, come in later migrations.
CREATE TABLE branches (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  code             TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 1 AND 8), -- printed in receipt numbers, e.g. B2
  name             TEXT NOT NULL,
  active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  token_hash       TEXT,    -- sha256 of the branch's token; NULL until the branch is connected
  enrol_hash       TEXT,    -- sha256 of the one-time code; NULL when none is pending
  enrol_expires_at TEXT,
  enrolled_at      TEXT,
  last_seen_at     TEXT,    -- the last time the branch reached HQ
  created_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_branches_token ON branches (token_hash) WHERE token_hash IS NOT NULL;
CREATE UNIQUE INDEX ux_branches_enrol ON branches (enrol_hash) WHERE enrol_hash IS NOT NULL;

-- What was done at HQ and by whom. Never edited or deleted. (Never holds a code or a token.)
CREATE TABLE hq_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  action      TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   TEXT,
  detail_json TEXT,
  created_at  TEXT NOT NULL
);
CREATE TRIGGER hq_audit_no_update BEFORE UPDATE ON hq_audit BEGIN SELECT RAISE(ABORT, 'hq_audit is append-only'); END;
CREATE TRIGGER hq_audit_no_delete BEFORE DELETE ON hq_audit BEGIN SELECT RAISE(ABORT, 'hq_audit is append-only'); END;
