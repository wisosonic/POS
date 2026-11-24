-- Receiving what HQ owns (docs/12-sync-and-hq.md §5, §15). The branch remembers how far through HQ's change log it has applied, and keeps
-- HQ's id for each row it received in `hq_id`, so HQ's numbers never collide with ids this branch made itself.
ALTER TABLE sync_control ADD COLUMN down_cursor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE exchange_rates ADD COLUMN hq_id INTEGER;
CREATE UNIQUE INDEX ux_exchange_rates_hq ON exchange_rates (hq_id) WHERE hq_id IS NOT NULL;
