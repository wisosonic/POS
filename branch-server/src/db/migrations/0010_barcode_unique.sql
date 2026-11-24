-- Duplicate barcodes (US-34, the last milestone). The legacy data has barcodes shared by several products, so the rule starts OFF.
-- Once the shop has cleaned them up, an admin turns it on (Menu -> Duplicate barcodes) and from then on the database itself refuses
-- a second ACTIVE product with the same barcode. Hidden (inactive) products may keep an old code: the till only finds active ones.
-- A trigger with a switch instead of a unique index, because an index cannot be switched on only after the clean-up.
ALTER TABLE store_settings ADD COLUMN barcode_unique INTEGER NOT NULL DEFAULT 0 CHECK (barcode_unique IN (0, 1));

CREATE TRIGGER products_barcode_unique_insert BEFORE INSERT ON products
WHEN NEW.barcode <> '' AND NEW.active = 1
  AND (SELECT barcode_unique FROM store_settings WHERE id = 1) = 1
  AND EXISTS (SELECT 1 FROM products WHERE barcode = NEW.barcode AND active = 1)
BEGIN SELECT RAISE(ABORT, 'DUPLICATE_BARCODE'); END;

CREATE TRIGGER products_barcode_unique_update BEFORE UPDATE OF barcode, active ON products
WHEN NEW.barcode <> '' AND NEW.active = 1
  AND (SELECT barcode_unique FROM store_settings WHERE id = 1) = 1
  AND EXISTS (SELECT 1 FROM products WHERE barcode = NEW.barcode AND active = 1 AND id <> NEW.id)
BEGIN SELECT RAISE(ABORT, 'DUPLICATE_BARCODE'); END;
