-- Print agent (docs/11-multi-branch.md §3.4). When the server is not on the till's own PC, the receipt printer cannot be reached
-- by the server. A small program on the till PC (the print agent) connects OUT to the server, asks for its terminal's print jobs,
-- prints them and says whether they reached the printer. The server still builds every receipt and decides what is a duplicate and
-- whether the drawer opens; the agent only prints what it is given.
--   print_mode 'server' = the server prints on its own printer (today's shop), 'agent' = a job is queued for the agent.
--   The agent has its OWN credential, made by a one-time code the admin asks for, so the till's browser token is never copied around.
ALTER TABLE terminals ADD COLUMN print_mode TEXT NOT NULL DEFAULT 'server' CHECK (print_mode IN ('server', 'agent'));
ALTER TABLE terminals ADD COLUMN agent_token_hash TEXT;
ALTER TABLE terminals ADD COLUMN agent_enrol_hash TEXT;
ALTER TABLE terminals ADD COLUMN agent_enrol_expires_at TEXT;
ALTER TABLE terminals ADD COLUMN agent_seen_at TEXT;
CREATE UNIQUE INDEX ux_terminals_agent_token ON terminals (agent_token_hash) WHERE agent_token_hash IS NOT NULL;
CREATE UNIQUE INDEX ux_terminals_agent_enrol ON terminals (agent_enrol_hash) WHERE agent_enrol_hash IS NOT NULL;

-- A queue, not history: finished jobs are cleared after two days (the audit log keeps who printed what). The bytes hold the receipt,
-- including a customer's name, so they are not kept longer than that.
CREATE TABLE print_jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  terminal_id INTEGER NOT NULL REFERENCES terminals (id),
  sale_id     INTEGER, -- no foreign key: a sale can be deleted for good (migration 0014) and its old jobs must not block that
  user_id     INTEGER REFERENCES users (id),
  kind        TEXT NOT NULL CHECK (kind IN ('receipt')),
  bytes       BLOB NOT NULL,
  duplicate   INTEGER NOT NULL DEFAULT 0 CHECK (duplicate IN (0, 1)),
  drawer      INTEGER NOT NULL DEFAULT 0 CHECK (drawer IN (0, 1)),
  status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'printed', 'failed', 'cancelled', 'expired')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  created_at  TEXT NOT NULL,
  sent_at     TEXT,
  finished_at TEXT
);
CREATE INDEX ix_print_jobs_queue ON print_jobs (terminal_id, status, id);
CREATE INDEX ix_print_jobs_sale ON print_jobs (sale_id);
