-- HR: employees and attendance (P6a-1, docs/16). The employee list is HQ's, sent down to each branch the employee is assigned to.
CREATE TABLE employees (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL UNIQUE,         -- typed at the kiosk; never reused
  name       TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  pin_hash   TEXT,                         -- Argon2id of the attendance PIN
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE employee_branches (
  employee_id INTEGER NOT NULL REFERENCES employees (id),
  branch_id   INTEGER NOT NULL REFERENCES branches (id),
  PRIMARY KEY (employee_id, branch_id)
);

-- Mirror of what a branch records.
CREATE TABLE attendance_punches (
  branch_id INTEGER NOT NULL,
  id INTEGER NOT NULL,
  employee_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  user_id INTEGER,
  created_at TEXT NOT NULL,
  hq_received_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, id)
);
CREATE INDEX ix_attendance_punches_employee ON attendance_punches (employee_id, created_at);
CREATE INDEX ix_attendance_punches_branch_created_at ON attendance_punches (branch_id, created_at);

-- A correction over the facts, never an edit: add a missing punch, or cancel one (by branch and punch id).
CREATE TABLE attendance_adjustments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id     INTEGER NOT NULL REFERENCES employees (id),
  action          TEXT NOT NULL CHECK (action IN ('add', 'cancel')),
  kind            TEXT CHECK (kind IN ('in', 'out')),   -- for add
  at              TEXT,                                  -- for add: when it happened
  branch_id       INTEGER,                               -- add: where; cancel: the punch's branch
  punch_id        INTEGER,                               -- cancel: the punch
  reason          TEXT NOT NULL,
  actor           TEXT,
  created_at      TEXT NOT NULL,
  CHECK ((action = 'add' AND kind IS NOT NULL AND at IS NOT NULL AND branch_id IS NOT NULL)
      OR (action = 'cancel' AND branch_id IS NOT NULL AND punch_id IS NOT NULL))
);
CREATE INDEX ix_attendance_adjustments_employee ON attendance_adjustments (employee_id);
CREATE TRIGGER attendance_adjustments_no_update BEFORE UPDATE ON attendance_adjustments BEGIN SELECT RAISE(ABORT, 'attendance_adjustments is append-only'); END;
CREATE TRIGGER attendance_adjustments_no_delete BEFORE DELETE ON attendance_adjustments BEGIN SELECT RAISE(ABORT, 'attendance_adjustments is append-only'); END;
