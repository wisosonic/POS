-- HQ staff accounts (docs/12 §21, P3d): people sign in with their own name and password, with a role, and every change HQ records says who made it.
-- Argon2id hashes only. A session is an opaque token shown once and stored only as a hash, so it can be revoked (sign-out, deactivation, a new password).
CREATE TABLE hq_users (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  username            TEXT NOT NULL UNIQUE CHECK (username = lower(username)), -- stored lower-case (no COLLATE NOCASE: it must work the same on PostgreSQL)
  name                TEXT NOT NULL,
  -- viewer: reads. catalog: also changes products, their lists, prices and rates. admin: also branches and people.
  role                TEXT NOT NULL CHECK (role IN ('admin', 'catalog', 'viewer')),
  password_hash       TEXT NOT NULL,
  active              INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  -- an account an admin made has a password the admin chose: the person must pick their own before doing anything else (enforced by the server)
  must_reset_password INTEGER NOT NULL DEFAULT 0 CHECK (must_reset_password IN (0, 1)),
  failed_attempts     INTEGER NOT NULL DEFAULT 0,
  locked_until        TEXT,
  last_login_at       TEXT,
  created_at          TEXT NOT NULL
);

CREATE TABLE hq_sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE, -- sha256 of the token
  user_id    INTEGER NOT NULL REFERENCES hq_users (id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX ix_hq_sessions_user ON hq_sessions (user_id);

-- Who is making the change that is being written right now. Set at the start of a staff transaction and cleared at its end (inside it), so an
-- audit row written by a service that knows nothing about people still says who did it. NULL = nobody (a branch enrolling, a script).
CREATE TABLE hq_context (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  actor TEXT
);
INSERT INTO hq_context (id, actor) VALUES (1, NULL);

ALTER TABLE hq_audit ADD COLUMN actor TEXT;
