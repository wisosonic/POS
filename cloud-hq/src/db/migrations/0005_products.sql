-- The products, owned by HQ and sent DOWN to every branch with HQ's id as the branch's own id (docs/12-sync-and-hq.md §17, P3b).
-- HQ is the only place a product or its price changes once a branch is connected (docs/QUESTIONS.md #15).
CREATE TABLE products (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT NOT NULL,
  receipt_name        TEXT,
  receipt_name_manual INTEGER NOT NULL DEFAULT 0 CHECK (receipt_name_manual IN (0, 1)),
  barcode             TEXT NOT NULL DEFAULT '',
  -- HQ's starting cost; each branch keeps its own after that (a purchase received there sets it)
  cost_minor          INTEGER NOT NULL DEFAULT 0 CHECK (cost_minor >= 0),
  price_minor         INTEGER NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
  currency            TEXT NOT NULL DEFAULT 'LBP' CHECK (currency IN ('USD', 'LBP')),
  category_id         INTEGER REFERENCES categories (id),
  brand_id            INTEGER REFERENCES brands (id),
  unit_id             INTEGER REFERENCES units (id),
  supplier_id         INTEGER REFERENCES suppliers (id),
  -- low-stock threshold in thousandths; NULL = never alert. Stock never blocks a sale (rule 17).
  stock_alert_milli   INTEGER CHECK (stock_alert_milli IS NULL OR stock_alert_milli >= 0),
  expiry_date         TEXT,
  active              INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX ix_hq_products_barcode ON products (barcode);
CREATE INDEX ix_hq_products_category ON products (category_id);
-- A new chain has no legacy duplicates, so unlike a branch (rule 18) HQ enforces it from the start: one ACTIVE product per barcode.
-- A retired product may keep its code. A partial unique index works the same way on PostgreSQL later.
CREATE UNIQUE INDEX ux_hq_products_barcode_active ON products (barcode) WHERE barcode <> '' AND active = 1;
