-- Shifts, rosters, holidays and leave (P6a-2, docs/16 §6). HQ only. A roster says who should work when; the attendance the branches record says who did.
-- The view that sets the two side by side (late, early, absent, on leave) is derived, never stored.

CREATE TABLE shift_templates (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL UNIQUE,
  start_minute   INTEGER NOT NULL CHECK (start_minute BETWEEN 0 AND 1439), -- from the shop's midnight
  length_minutes INTEGER NOT NULL CHECK (length_minutes BETWEEN 1 AND 1440), -- a night shift runs past midnight
  grace_minutes  INTEGER NOT NULL DEFAULT 5 CHECK (grace_minutes >= 0),     -- later or earlier than this by less is not late or early
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at     TEXT NOT NULL
);

-- One shift per employee per day, at one branch. It is a plan, so it can be changed (audited); history of pay is frozen elsewhere.
CREATE TABLE rosters (
  employee_id INTEGER NOT NULL REFERENCES employees (id),
  day         TEXT NOT NULL,                                   -- the shop day, YYYY-MM-DD
  shift_id    INTEGER NOT NULL REFERENCES shift_templates (id),
  branch_id   INTEGER NOT NULL REFERENCES branches (id),
  PRIMARY KEY (employee_id, day)
);
CREATE INDEX ix_rosters_day ON rosters (day);

CREATE TABLE holidays (
  day  TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE leave_types (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  paid       INTEGER NOT NULL CHECK (paid IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE leave_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees (id),
  type_id     INTEGER NOT NULL REFERENCES leave_types (id),
  from_day    TEXT NOT NULL,
  to_day      TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  reason      TEXT,
  decided_by  TEXT,
  decided_at  TEXT,
  created_at  TEXT NOT NULL,
  CHECK (from_day <= to_day)
);
CREATE INDEX ix_leave_requests_employee ON leave_requests (employee_id, from_day);
-- A decision is final apart from cancelling an approved leave; the dates and the person never change.
CREATE TRIGGER leave_requests_fixed BEFORE UPDATE ON leave_requests
WHEN NEW.employee_id <> OLD.employee_id OR NEW.type_id <> OLD.type_id OR NEW.from_day <> OLD.from_day OR NEW.to_day <> OLD.to_day
  OR (OLD.status <> 'pending' AND NOT (OLD.status = 'approved' AND NEW.status = 'cancelled') AND NEW.status <> OLD.status)
BEGIN SELECT RAISE(ABORT, 'a leave request is fixed once decided'); END;
CREATE TRIGGER leave_requests_no_delete BEFORE DELETE ON leave_requests BEGIN SELECT RAISE(ABORT, 'a leave request is never deleted'); END;
