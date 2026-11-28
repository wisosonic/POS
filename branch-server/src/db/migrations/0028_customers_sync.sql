-- Customers go up to HQ (P5e, docs/15 §7): HQ recognises the same person at several branches by phone and shows one balance.
-- A customer is edited in place (a balance moves with every credit sale and payment), so all three triggers capture.
CREATE TRIGGER sync_customers_ai AFTER INSERT ON customers WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('customers', NEW.id, 'u'); END;
CREATE TRIGGER sync_customers_au AFTER UPDATE ON customers WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('customers', NEW.id, 'u'); END;
CREATE TRIGGER sync_customers_ad AFTER DELETE ON customers WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('customers', OLD.id, 'd'); END;
