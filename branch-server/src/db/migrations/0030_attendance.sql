-- Attendance (P6a-1, docs/16): HQ owns the employees and sends each branch the ones assigned to it (employees, HQ's id is the id here: only ever
-- filled from HQ); the branch records clock-ins and clock-outs (attendance_punches, append-only, sent up like any fact). Pay data is never sent here.
CREATE TABLE employees (
  id       INTEGER PRIMARY KEY,
  code     TEXT NOT NULL,
  name     TEXT NOT NULL,
  active   INTEGER NOT NULL,
  pin_hash TEXT                           -- Argon2id of the attendance PIN (clock in/out only); NULL until HQ sets one. Never returned by any route.
);
CREATE INDEX ix_employees_code ON employees (code);

CREATE TABLE attendance_punches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,           -- HQ's employee id (no foreign key: the employee may be removed from this branch, the history stays)
  kind        TEXT NOT NULL CHECK (kind IN ('in', 'out')),
  user_id     INTEGER REFERENCES users (id), -- the signed-in person whose screen it was punched on
  created_at  TEXT NOT NULL
);
CREATE INDEX ix_attendance_punches_employee ON attendance_punches (employee_id, created_at);
CREATE TRIGGER attendance_punches_no_update BEFORE UPDATE ON attendance_punches BEGIN SELECT RAISE(ABORT, 'attendance_punches is append-only'); END;
CREATE TRIGGER attendance_punches_no_delete BEFORE DELETE ON attendance_punches BEGIN SELECT RAISE(ABORT, 'attendance_punches is append-only'); END;

-- Wrong code or PIN, counted by the code as typed (an unknown code and a known one look the same), for the lockout.
CREATE TABLE attendance_failures (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  at   TEXT NOT NULL
);
CREATE INDEX ix_attendance_failures_code ON attendance_failures (code, at);

CREATE TRIGGER sync_attendance_punches_ai AFTER INSERT ON attendance_punches WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('attendance_punches', NEW.id, 'u'); END;
CREATE TRIGGER sync_attendance_punches_au AFTER UPDATE ON attendance_punches WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('attendance_punches', NEW.id, 'u'); END;
CREATE TRIGGER sync_attendance_punches_ad AFTER DELETE ON attendance_punches WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('attendance_punches', OLD.id, 'd'); END;
