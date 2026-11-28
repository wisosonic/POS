-- Monitoring (P7, docs/12 §32): how far each branch has applied HQ's change log, and when it last said so. Written when the branch pulls; read by
-- GET /monitoring/branches to tell a branch that is behind from one that is simply quiet.
ALTER TABLE branches ADD COLUMN down_cursor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE branches ADD COLUMN down_cursor_at TEXT;
