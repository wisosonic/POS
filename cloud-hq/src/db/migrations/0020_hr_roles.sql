-- HR roles and employee accounts (P6c, docs/16 §7). hq_users.role gains hr, payroll and employee; SQLite cannot change a CHECK, so the table is rebuilt
-- (with its only child, hq_sessions). An employee account sees only its own attendance and payslips.
CREATE TABLE hq_users_n (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  username            TEXT NOT NULL UNIQUE CHECK (username = lower(username)),
  name                TEXT NOT NULL,
  role                TEXT NOT NULL CHECK (role IN ('admin', 'catalog', 'viewer', 'hr', 'payroll', 'employee')),
  password_hash       TEXT NOT NULL,
  active              INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  must_reset_password INTEGER NOT NULL DEFAULT 0 CHECK (must_reset_password IN (0, 1)),
  failed_attempts     INTEGER NOT NULL DEFAULT 0,
  locked_until        TEXT,
  last_login_at       TEXT,
  created_at          TEXT NOT NULL
);
INSERT INTO hq_users_n (id, username, name, role, password_hash, active, must_reset_password, failed_attempts, locked_until, last_login_at, created_at)
  SELECT id, username, name, role, password_hash, active, must_reset_password, failed_attempts, locked_until, last_login_at, created_at FROM hq_users;
CREATE TABLE hq_sessions_n (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  user_id    INTEGER NOT NULL REFERENCES hq_users_n (id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
INSERT INTO hq_sessions_n (id, token_hash, user_id, created_at, expires_at, revoked_at)
  SELECT id, token_hash, user_id, created_at, expires_at, revoked_at FROM hq_sessions;
DROP TABLE hq_sessions;
DROP TABLE hq_users;
ALTER TABLE hq_users_n RENAME TO hq_users;
ALTER TABLE hq_sessions_n RENAME TO hq_sessions;
CREATE INDEX ix_hq_sessions_user ON hq_sessions (user_id);

-- Which employee an employee account belongs to (one account per employee).
CREATE TABLE employee_accounts (
  employee_id INTEGER PRIMARY KEY REFERENCES employees (id),
  user_id     INTEGER NOT NULL UNIQUE REFERENCES hq_users (id)
);

-- A payslip print link: one use, a short life, one payslip, one language. Only a hash is kept (the link is the credential).
CREATE TABLE print_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT NOT NULL UNIQUE,
  payslip_id  INTEGER NOT NULL REFERENCES payslips (id),
  lang        TEXT NOT NULL CHECK (lang IN ('en', 'ar')),
  actor       TEXT,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL
);
