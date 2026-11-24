-- A stocktake can be deleted from the list, but only in the sense of hiding it: the row, its lines and the adjustments a finished count
-- posted to the stock ledger all stay. The only change a finished (or cancelled) count may still take is gaining a deleted_at.
ALTER TABLE stocktakes ADD COLUMN deleted_at TEXT;

DROP TRIGGER stocktakes_finished_immutable;
CREATE TRIGGER stocktakes_finished_immutable BEFORE UPDATE ON stocktakes
WHEN OLD.status <> 'open' AND NOT (
  OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
  AND NEW.id = OLD.id AND NEW.name = OLD.name AND NEW.status = OLD.status AND NEW.created_by IS OLD.created_by
  AND NEW.created_at = OLD.created_at AND NEW.finished_by IS OLD.finished_by AND NEW.finished_at IS OLD.finished_at
  AND NEW.idempotency_key IS OLD.idempotency_key
)
BEGIN SELECT RAISE(ABORT, 'a finished stocktake cannot be changed'); END;
