-- A deleted customer is hidden from lists and cannot be chosen for a new sale, but the row stays: their past sales and payments point at it.
ALTER TABLE customers ADD COLUMN deleted_at TEXT;
