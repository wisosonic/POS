-- A manager's approval can now also cover cancelling a sale (void) and selling one product at a price other than the catalogue's
-- (price). A void approval is for one sale. A price approval is for one product at one unit price in LBP. SQLite cannot change a
-- CHECK in place, so the table is rebuilt (as in 0006).
CREATE TABLE approvals_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK (scope IN ('discount', 'return', 'void', 'price')),
  requested_by INTEGER NOT NULL REFERENCES users (id), -- the cashier who may use it
  approved_by INTEGER NOT NULL REFERENCES users (id), -- the manager who gave it
  max_pct REAL CHECK (max_pct IS NULL OR (max_pct >= 0 AND max_pct <= 100)), -- discount: the percent approved
  sale_id INTEGER REFERENCES sales (id), -- return and void: the one sale it is for
  max_lbp INTEGER CHECK (max_lbp IS NULL OR max_lbp > 0), -- return: the most value that may be taken back
  product_id INTEGER REFERENCES products (id), -- price: the one product
  price_lbp INTEGER CHECK (price_lbp IS NULL OR price_lbp >= 0), -- price: the unit price in LBP that was approved
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    (scope = 'discount' AND max_pct IS NOT NULL AND sale_id IS NULL AND max_lbp IS NULL AND product_id IS NULL AND price_lbp IS NULL)
    OR (scope = 'return' AND max_pct IS NULL AND sale_id IS NOT NULL AND max_lbp IS NOT NULL AND product_id IS NULL AND price_lbp IS NULL)
    OR (scope = 'void' AND max_pct IS NULL AND sale_id IS NOT NULL AND max_lbp IS NULL AND product_id IS NULL AND price_lbp IS NULL)
    OR (scope = 'price' AND max_pct IS NULL AND sale_id IS NULL AND max_lbp IS NULL AND product_id IS NOT NULL AND price_lbp IS NOT NULL)
  )
);
INSERT INTO approvals_new (id, token_hash, scope, requested_by, approved_by, max_pct, sale_id, max_lbp, expires_at, used_at, created_at)
  SELECT id, token_hash, scope, requested_by, approved_by, max_pct, sale_id, max_lbp, expires_at, used_at, created_at FROM approvals;
DROP TABLE approvals;
ALTER TABLE approvals_new RENAME TO approvals;
