-- Payroll (P6b, docs/16 §5). HQ only: no pay data is ever sent to a branch. Profiles, rules and loans are dated or appended, never edited. A payroll
-- run goes draft -> calculated -> approved -> paid -> locked; once it is approved its payslips, their lines and its manual inputs can no longer change
-- (triggers), and a locked run is final. A correction is a manual line in the NEXT run.

-- What a person is paid and how: dated, so an old period is always worked out with what was true then.
CREATE TABLE pay_profiles (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id            INTEGER NOT NULL REFERENCES employees (id),
  effective_from         TEXT NOT NULL,                -- a day, YYYY-MM-DD
  type                   TEXT NOT NULL CHECK (type IN ('monthly', 'daily', 'hourly')),
  base_minor             INTEGER NOT NULL CHECK (base_minor >= 0),
  currency               TEXT NOT NULL CHECK (currency IN ('USD', 'LBP')),
  overtime_after_minutes INTEGER CHECK (overtime_after_minutes IS NULL OR overtime_after_minutes >= 0),
  overtime_bp            INTEGER NOT NULL CHECK (overtime_bp >= 0),
  standard_day_minutes   INTEGER NOT NULL CHECK (standard_day_minutes >= 1),
  work_days_per_month    INTEGER NOT NULL CHECK (work_days_per_month >= 1),
  daily_min_minutes      INTEGER NOT NULL CHECK (daily_min_minutes >= 0),
  rule_codes             TEXT NOT NULL DEFAULT '',     -- comma separated codes of payroll_rules that apply
  actor                  TEXT,
  created_at             TEXT NOT NULL
);
CREATE INDEX ix_pay_profiles_employee ON pay_profiles (employee_id, effective_from);

-- Social security and tax as DATA (the accountant owns the rates). The rule in force for a period is the latest of its code from a day on or before the
-- period's last day.
CREATE TABLE payroll_rules (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('percent', 'brackets')),
  side           TEXT NOT NULL CHECK (side IN ('employee', 'employer')),
  base           TEXT NOT NULL CHECK (base IN ('gross', 'taxable')),
  reduces_tax    INTEGER NOT NULL CHECK (reduces_tax IN (0, 1)),
  currency       TEXT NOT NULL CHECK (currency IN ('USD', 'LBP')),
  rate_bp        INTEGER NOT NULL CHECK (rate_bp >= 0),
  cap_base_minor INTEGER CHECK (cap_base_minor IS NULL OR cap_base_minor >= 0),
  effective_from TEXT NOT NULL,
  actor          TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX ix_payroll_rules_code ON payroll_rules (code, effective_from);
CREATE TABLE payroll_rule_brackets (
  rule_id    INTEGER NOT NULL REFERENCES payroll_rules (id),
  from_minor INTEGER NOT NULL CHECK (from_minor >= 0),
  rate_bp    INTEGER NOT NULL CHECK (rate_bp >= 0),
  PRIMARY KEY (rule_id, from_minor)
);

-- Money lent to an employee, repaid by installments at payroll. What is left is the principal less the repayments.
CREATE TABLE loans (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id       INTEGER NOT NULL REFERENCES employees (id),
  principal_minor   INTEGER NOT NULL CHECK (principal_minor > 0),
  currency          TEXT NOT NULL CHECK (currency IN ('USD', 'LBP')),
  installment_minor INTEGER NOT NULL CHECK (installment_minor > 0),
  note              TEXT,
  actor             TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX ix_loans_employee ON loans (employee_id);

CREATE TABLE payroll_runs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  from_day           TEXT NOT NULL,
  to_day             TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('draft', 'calculated', 'approved', 'paid', 'locked')),
  note               TEXT,
  rate_lbp_per_usd   INTEGER,                 -- the exchange rate used, snapshotted when calculated
  warnings_json      TEXT,                    -- what the last calculation says needs a look
  actor              TEXT,
  created_at         TEXT NOT NULL,
  calculated_at      TEXT,
  approved_at        TEXT,
  paid_at            TEXT,
  locked_at          TEXT,
  CHECK (from_day <= to_day)
);
-- Manual lines for one employee in a run (a bonus, an absence deduction): free while the run is not approved.
CREATE TABLE payroll_inputs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER NOT NULL REFERENCES payroll_runs (id),
  employee_id INTEGER NOT NULL REFERENCES employees (id),
  kind        TEXT NOT NULL CHECK (kind IN ('earning', 'deduction')),
  label       TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  created_at  TEXT NOT NULL
);
CREATE INDEX ix_payroll_inputs_run ON payroll_inputs (run_id);

CREATE TABLE payslips (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id              INTEGER NOT NULL REFERENCES payroll_runs (id),
  employee_id         INTEGER NOT NULL REFERENCES employees (id),
  employee_code       TEXT NOT NULL,          -- as it was when the slip was made
  employee_name       TEXT NOT NULL,
  currency            TEXT NOT NULL CHECK (currency IN ('USD', 'LBP')),
  days_worked         INTEGER NOT NULL,
  regular_minutes     INTEGER NOT NULL,
  overtime_minutes    INTEGER NOT NULL,
  gross_minor         INTEGER NOT NULL,
  deductions_minor    INTEGER NOT NULL,
  net_minor           INTEGER NOT NULL,       -- always gross - deductions
  employer_cost_minor INTEGER NOT NULL,
  profile_json        TEXT NOT NULL,          -- the pay profile used (a snapshot)
  rules_json          TEXT NOT NULL,          -- the rules used, with the day each took effect (a snapshot)
  created_at          TEXT NOT NULL,
  UNIQUE (run_id, employee_id),
  CHECK (net_minor = gross_minor - deductions_minor)
);
CREATE TABLE payslip_lines (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  payslip_id   INTEGER NOT NULL REFERENCES payslips (id),
  side         TEXT NOT NULL CHECK (side IN ('earning', 'deduction', 'employer')),
  code         TEXT NOT NULL,
  label        TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  position     INTEGER NOT NULL
);
CREATE INDEX ix_payslip_lines_slip ON payslip_lines (payslip_id);

-- A payment of an installment, made when the run is paid. Append-only.
CREATE TABLE loan_repayments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id      INTEGER NOT NULL REFERENCES loans (id),
  payslip_id   INTEGER NOT NULL REFERENCES payslips (id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  created_at   TEXT NOT NULL
);
CREATE INDEX ix_loan_repayments_loan ON loan_repayments (loan_id);

-- History that is only ever added to.
CREATE TRIGGER pay_profiles_no_update BEFORE UPDATE ON pay_profiles BEGIN SELECT RAISE(ABORT, 'pay_profiles is append-only'); END;
CREATE TRIGGER pay_profiles_no_delete BEFORE DELETE ON pay_profiles BEGIN SELECT RAISE(ABORT, 'pay_profiles is append-only'); END;
CREATE TRIGGER payroll_rules_no_update BEFORE UPDATE ON payroll_rules BEGIN SELECT RAISE(ABORT, 'payroll_rules is append-only'); END;
CREATE TRIGGER payroll_rules_no_delete BEFORE DELETE ON payroll_rules BEGIN SELECT RAISE(ABORT, 'payroll_rules is append-only'); END;
CREATE TRIGGER payroll_rule_brackets_no_update BEFORE UPDATE ON payroll_rule_brackets BEGIN SELECT RAISE(ABORT, 'payroll_rule_brackets is append-only'); END;
CREATE TRIGGER payroll_rule_brackets_no_delete BEFORE DELETE ON payroll_rule_brackets BEGIN SELECT RAISE(ABORT, 'payroll_rule_brackets is append-only'); END;
CREATE TRIGGER loans_no_update BEFORE UPDATE ON loans BEGIN SELECT RAISE(ABORT, 'loans is append-only'); END;
CREATE TRIGGER loans_no_delete BEFORE DELETE ON loans BEGIN SELECT RAISE(ABORT, 'loans is append-only'); END;
CREATE TRIGGER loan_repayments_no_update BEFORE UPDATE ON loan_repayments BEGIN SELECT RAISE(ABORT, 'loan_repayments is append-only'); END;
CREATE TRIGGER loan_repayments_no_delete BEFORE DELETE ON loan_repayments BEGIN SELECT RAISE(ABORT, 'loan_repayments is append-only'); END;

-- A run is never deleted; it only moves forward; once approved its period and note are fixed; a locked run does not change at all.
CREATE TRIGGER payroll_runs_no_delete BEFORE DELETE ON payroll_runs BEGIN SELECT RAISE(ABORT, 'a payroll run is never deleted'); END;
CREATE TRIGGER payroll_runs_forward_only BEFORE UPDATE ON payroll_runs
WHEN (CASE NEW.status WHEN 'draft' THEN 1 WHEN 'calculated' THEN 2 WHEN 'approved' THEN 3 WHEN 'paid' THEN 4 ELSE 5 END)
   < (CASE OLD.status WHEN 'draft' THEN 1 WHEN 'calculated' THEN 2 WHEN 'approved' THEN 3 WHEN 'paid' THEN 4 ELSE 5 END)
BEGIN SELECT RAISE(ABORT, 'a payroll run only moves forward'); END;
CREATE TRIGGER payroll_runs_locked_is_final BEFORE UPDATE ON payroll_runs WHEN OLD.status = 'locked'
BEGIN SELECT RAISE(ABORT, 'a locked payroll run cannot change'); END;
CREATE TRIGGER payroll_runs_fixed_once_approved BEFORE UPDATE ON payroll_runs
WHEN OLD.status IN ('approved', 'paid') AND (NEW.from_day <> OLD.from_day OR NEW.to_day <> OLD.to_day OR NEW.rate_lbp_per_usd IS NOT OLD.rate_lbp_per_usd
  OR NEW.warnings_json IS NOT OLD.warnings_json OR NEW.calculated_at IS NOT OLD.calculated_at)
BEGIN SELECT RAISE(ABORT, 'an approved payroll run is fixed'); END;

-- Once a run is approved its slips, lines and manual inputs are frozen.
CREATE TRIGGER payslips_frozen_i BEFORE INSERT ON payslips
WHEN (SELECT status FROM payroll_runs WHERE id = NEW.run_id) IN ('approved', 'paid', 'locked')
BEGIN SELECT RAISE(ABORT, 'the payslips of an approved payroll run cannot change'); END;
CREATE TRIGGER payslips_frozen_u BEFORE UPDATE ON payslips
WHEN (SELECT status FROM payroll_runs WHERE id = OLD.run_id) IN ('approved', 'paid', 'locked')
BEGIN SELECT RAISE(ABORT, 'the payslips of an approved payroll run cannot change'); END;
CREATE TRIGGER payslips_frozen_d BEFORE DELETE ON payslips
WHEN (SELECT status FROM payroll_runs WHERE id = OLD.run_id) IN ('approved', 'paid', 'locked')
BEGIN SELECT RAISE(ABORT, 'the payslips of an approved payroll run cannot change'); END;
CREATE TRIGGER payslip_lines_frozen_i BEFORE INSERT ON payslip_lines
WHEN (SELECT r.status FROM payslips s JOIN payroll_runs r ON r.id = s.run_id WHERE s.id = NEW.payslip_id) IN ('approved', 'paid', 'locked')
BEGIN SELECT RAISE(ABORT, 'the payslips of an approved payroll run cannot change'); END;
CREATE TRIGGER payslip_lines_frozen_u BEFORE UPDATE ON payslip_lines
WHEN (SELECT r.status FROM payslips s JOIN payroll_runs r ON r.id = s.run_id WHERE s.id = OLD.payslip_id) IN ('approved', 'paid', 'locked')
BEGIN SELECT RAISE(ABORT, 'the payslips of an approved payroll run cannot change'); END;
CREATE TRIGGER payslip_lines_frozen_d BEFORE DELETE ON payslip_lines
WHEN (SELECT r.status FROM payslips s JOIN payroll_runs r ON r.id = s.run_id WHERE s.id = OLD.payslip_id) IN ('approved', 'paid', 'locked')
BEGIN SELECT RAISE(ABORT, 'the payslips of an approved payroll run cannot change'); END;
CREATE TRIGGER payroll_inputs_frozen_i BEFORE INSERT ON payroll_inputs
WHEN (SELECT status FROM payroll_runs WHERE id = NEW.run_id) IN ('approved', 'paid', 'locked')
BEGIN SELECT RAISE(ABORT, 'the inputs of an approved payroll run cannot change'); END;
CREATE TRIGGER payroll_inputs_frozen_u BEFORE UPDATE ON payroll_inputs
WHEN (SELECT status FROM payroll_runs WHERE id = OLD.run_id) IN ('approved', 'paid', 'locked')
BEGIN SELECT RAISE(ABORT, 'the inputs of an approved payroll run cannot change'); END;
CREATE TRIGGER payroll_inputs_frozen_d BEFORE DELETE ON payroll_inputs
WHEN (SELECT status FROM payroll_runs WHERE id = OLD.run_id) IN ('approved', 'paid', 'locked')
BEGIN SELECT RAISE(ABORT, 'the inputs of an approved payroll run cannot change'); END;
