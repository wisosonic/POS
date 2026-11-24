-- Deleting a sale for good (decision: QUESTIONS.md #8, option C). History stays append-only for everything else: the only way a sale's rows
-- can be deleted is while that sale has a row in sale_delete_unlock, which the delete routine inserts and removes inside its own
-- transaction. The unlock is per sale: it opens only the rows that belong to that sale (its lines, payments, returns and the stock
-- movements it and its returns caused). Nothing else becomes deletable, and the audit log is never touched.
CREATE TABLE sale_delete_unlock (sale_id INTEGER PRIMARY KEY);

DROP TRIGGER sales_no_delete;
CREATE TRIGGER sales_no_delete BEFORE DELETE ON sales
WHEN NOT EXISTS (SELECT 1 FROM sale_delete_unlock WHERE sale_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'sales is append-only'); END;

DROP TRIGGER sale_items_no_delete;
CREATE TRIGGER sale_items_no_delete BEFORE DELETE ON sale_items
WHEN NOT EXISTS (SELECT 1 FROM sale_delete_unlock WHERE sale_id = OLD.sale_id)
BEGIN SELECT RAISE(ABORT, 'sale_items is append-only'); END;

DROP TRIGGER payments_no_delete;
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments
WHEN OLD.sale_id IS NULL OR NOT EXISTS (SELECT 1 FROM sale_delete_unlock WHERE sale_id = OLD.sale_id)
BEGIN SELECT RAISE(ABORT, 'payments is append-only'); END;

DROP TRIGGER returns_no_delete;
CREATE TRIGGER returns_no_delete BEFORE DELETE ON returns
WHEN NOT EXISTS (SELECT 1 FROM sale_delete_unlock WHERE sale_id = OLD.sale_id)
BEGIN SELECT RAISE(ABORT, 'returns is append-only'); END;

DROP TRIGGER return_items_no_delete;
CREATE TRIGGER return_items_no_delete BEFORE DELETE ON return_items
WHEN NOT EXISTS (SELECT 1 FROM returns r JOIN sale_delete_unlock u ON u.sale_id = r.sale_id WHERE r.id = OLD.return_id)
BEGIN SELECT RAISE(ABORT, 'return_items is append-only'); END;

-- Only the movements a sale (or its void) and its returns caused. COALESCE keeps a movement with no reference undeletable.
DROP TRIGGER stock_movements_no_delete;
CREATE TRIGGER stock_movements_no_delete BEFORE DELETE ON stock_movements
WHEN NOT COALESCE(
  (OLD.ref_type IN ('sale', 'void') AND EXISTS (SELECT 1 FROM sale_delete_unlock WHERE sale_id = OLD.ref_id))
  OR (OLD.ref_type = 'return' AND EXISTS (SELECT 1 FROM returns r JOIN sale_delete_unlock u ON u.sale_id = r.sale_id WHERE r.id = OLD.ref_id)),
  0)
BEGIN SELECT RAISE(ABORT, 'stock_movements is append-only'); END;

-- A counted register's expected figure and variance are recomputed when a sale taken in it is deleted.
DROP TRIGGER register_balances_closed_immutable;
CREATE TRIGGER register_balances_closed_immutable BEFORE UPDATE ON register_balances
WHEN (SELECT status FROM register_sessions WHERE id = OLD.session_id) = 'closed'
  AND NOT EXISTS (SELECT 1 FROM sale_delete_unlock)
BEGIN SELECT RAISE(ABORT, 'a closed register session cannot be changed'); END;

-- A manager's approval can also cover deleting one sale for good (scope 'delete'). The table is rebuilt to widen its CHECK, as in 0006 and 0007.
CREATE TABLE approvals_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK (scope IN ('discount', 'return', 'void', 'price', 'delete')),
  requested_by INTEGER NOT NULL REFERENCES users (id),
  approved_by INTEGER NOT NULL REFERENCES users (id),
  max_pct REAL CHECK (max_pct IS NULL OR (max_pct >= 0 AND max_pct <= 100)),
  sale_id INTEGER REFERENCES sales (id), -- return, void and delete: the one sale it is for
  max_lbp INTEGER CHECK (max_lbp IS NULL OR max_lbp > 0),
  product_id INTEGER REFERENCES products (id),
  price_lbp INTEGER CHECK (price_lbp IS NULL OR price_lbp >= 0),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    (scope = 'discount' AND max_pct IS NOT NULL AND sale_id IS NULL AND max_lbp IS NULL AND product_id IS NULL AND price_lbp IS NULL)
    OR (scope = 'return' AND max_pct IS NULL AND sale_id IS NOT NULL AND max_lbp IS NOT NULL AND product_id IS NULL AND price_lbp IS NULL)
    OR (scope IN ('void', 'delete') AND max_pct IS NULL AND sale_id IS NOT NULL AND max_lbp IS NULL AND product_id IS NULL AND price_lbp IS NULL)
    OR (scope = 'price' AND max_pct IS NULL AND sale_id IS NULL AND max_lbp IS NULL AND product_id IS NOT NULL AND price_lbp IS NOT NULL)
  )
);
INSERT INTO approvals_new (id, token_hash, scope, requested_by, approved_by, max_pct, sale_id, max_lbp, product_id, price_lbp, expires_at, used_at, created_at)
  SELECT id, token_hash, scope, requested_by, approved_by, max_pct, sale_id, max_lbp, product_id, price_lbp, expires_at, used_at, created_at FROM approvals;
DROP TABLE approvals;
ALTER TABLE approvals_new RENAME TO approvals;
