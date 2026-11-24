-- Service income (US-36): money the shop earns that is not a product, such as IT support or a repair. A service says what it cost
-- the shop, what the customer paid, and whether the payment went into a register balance (then the closing count still agrees).
-- Like the other money records it is never edited or deleted. Legacy rows keep session_id NULL.
ALTER TABLE service_sales ADD COLUMN session_id INTEGER REFERENCES register_sessions (id);
CREATE INDEX ix_service_sales_created ON service_sales (created_at);
INSERT OR IGNORE INTO counters (name, value) VALUES ('service_ref', 5002); -- the old app's last reference was 5002
CREATE TRIGGER service_sales_no_update BEFORE UPDATE ON service_sales BEGIN SELECT RAISE(ABORT, 'service_sales is append-only'); END;
CREATE TRIGGER service_sales_no_delete BEFORE DELETE ON service_sales BEGIN SELECT RAISE(ABORT, 'service_sales is append-only'); END;
