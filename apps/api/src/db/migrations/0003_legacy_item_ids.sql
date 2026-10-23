-- Remember which legacy line each imported line came from, so the ETL can be re-run safely and so imported returns
-- can point at the exact sale line they belong to. NULL for everything created by the new system.

ALTER TABLE sale_items ADD COLUMN legacy_id INTEGER;
CREATE UNIQUE INDEX ux_sale_items_legacy ON sale_items (legacy_id) WHERE legacy_id IS NOT NULL;

ALTER TABLE purchase_items ADD COLUMN legacy_id INTEGER;
CREATE UNIQUE INDEX ux_purchase_items_legacy ON purchase_items (legacy_id) WHERE legacy_id IS NOT NULL;
