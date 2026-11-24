-- The link between this branch server and HQ (docs/12-sync-and-hq.md §6). No row = not connected (the shop works on its own, as before).
-- The branch token is a secret: it is kept here, used by the sync loop, and NEVER returned by the API, logged or audited.
CREATE TABLE hq_link (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  hq_url         TEXT NOT NULL,
  branch_token   TEXT NOT NULL,
  hq_branch_id   INTEGER NOT NULL,
  hq_branch_code TEXT NOT NULL,
  hq_branch_name TEXT NOT NULL,
  connected_at   TEXT NOT NULL,
  last_ok_at     TEXT,
  last_error     TEXT
);
