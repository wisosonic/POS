-- More of what a branch records goes up to HQ (docs/12 §22, P4a): returns, customer payments, registers, expenses, purchases, wallets and services.
-- The same capture as for the sale cluster (0018): three triggers per table write one line to sync_outbox in the statement itself, while this branch
-- is connected. A branch that is ALREADY connected when it upgrades gets a snapshot row per new table, so its history goes up too.
--
-- register_balances had a composite key and no `id` (WITHOUT ROWID), and the sync model names a row by one integer. It is rebuilt with a surrogate
-- `id` and a UNIQUE (session_id, method, currency), which is what every statement already addresses it by (ON CONFLICT, WHERE).
CREATE TABLE register_balances_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES register_sessions (id),
  method     TEXT NOT NULL REFERENCES payment_methods (code),
  currency   TEXT NOT NULL CHECK (currency IN ('USD', 'LBP')),
  opening    INTEGER NOT NULL CHECK (opening >= 0),
  expected   INTEGER NOT NULL,
  counted    INTEGER,
  variance   INTEGER,
  UNIQUE (session_id, method, currency)
);
INSERT INTO register_balances_new (session_id, method, currency, opening, expected, counted, variance)
  SELECT session_id, method, currency, opening, expected, counted, variance FROM register_balances ORDER BY session_id, method, currency;
DROP TABLE register_balances;
ALTER TABLE register_balances_new RENAME TO register_balances;
-- A closed session is immutable (Z-report), except while a sale taken in it is being deleted (0014).
CREATE TRIGGER register_balances_closed_immutable BEFORE UPDATE ON register_balances
WHEN (SELECT status FROM register_sessions WHERE id = OLD.session_id) = 'closed'
  AND NOT EXISTS (SELECT 1 FROM sale_delete_unlock)
BEGIN SELECT RAISE(ABORT, 'a closed register session cannot be changed'); END;

-- returns
CREATE TRIGGER sync_returns_ai AFTER INSERT ON returns WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('returns', NEW.id, 'u'); END;
CREATE TRIGGER sync_returns_au AFTER UPDATE ON returns WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('returns', NEW.id, 'u'); END;
CREATE TRIGGER sync_returns_ad AFTER DELETE ON returns WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('returns', OLD.id, 'd'); END;

-- return_items
CREATE TRIGGER sync_return_items_ai AFTER INSERT ON return_items WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('return_items', NEW.id, 'u'); END;
CREATE TRIGGER sync_return_items_au AFTER UPDATE ON return_items WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('return_items', NEW.id, 'u'); END;
CREATE TRIGGER sync_return_items_ad AFTER DELETE ON return_items WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('return_items', OLD.id, 'd'); END;

-- customer_payments
CREATE TRIGGER sync_customer_payments_ai AFTER INSERT ON customer_payments WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('customer_payments', NEW.id, 'u'); END;
CREATE TRIGGER sync_customer_payments_au AFTER UPDATE ON customer_payments WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('customer_payments', NEW.id, 'u'); END;
CREATE TRIGGER sync_customer_payments_ad AFTER DELETE ON customer_payments WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('customer_payments', OLD.id, 'd'); END;

-- register_sessions
CREATE TRIGGER sync_register_sessions_ai AFTER INSERT ON register_sessions WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('register_sessions', NEW.id, 'u'); END;
CREATE TRIGGER sync_register_sessions_au AFTER UPDATE ON register_sessions WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('register_sessions', NEW.id, 'u'); END;
CREATE TRIGGER sync_register_sessions_ad AFTER DELETE ON register_sessions WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('register_sessions', OLD.id, 'd'); END;

-- register_balances
CREATE TRIGGER sync_register_balances_ai AFTER INSERT ON register_balances WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('register_balances', NEW.id, 'u'); END;
CREATE TRIGGER sync_register_balances_au AFTER UPDATE ON register_balances WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('register_balances', NEW.id, 'u'); END;
CREATE TRIGGER sync_register_balances_ad AFTER DELETE ON register_balances WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('register_balances', OLD.id, 'd'); END;

-- register_movements
CREATE TRIGGER sync_register_movements_ai AFTER INSERT ON register_movements WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('register_movements', NEW.id, 'u'); END;
CREATE TRIGGER sync_register_movements_au AFTER UPDATE ON register_movements WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('register_movements', NEW.id, 'u'); END;
CREATE TRIGGER sync_register_movements_ad AFTER DELETE ON register_movements WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('register_movements', OLD.id, 'd'); END;

-- expenses
CREATE TRIGGER sync_expenses_ai AFTER INSERT ON expenses WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('expenses', NEW.id, 'u'); END;
CREATE TRIGGER sync_expenses_au AFTER UPDATE ON expenses WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('expenses', NEW.id, 'u'); END;
CREATE TRIGGER sync_expenses_ad AFTER DELETE ON expenses WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('expenses', OLD.id, 'd'); END;

-- expense_categories
CREATE TRIGGER sync_expense_categories_ai AFTER INSERT ON expense_categories WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('expense_categories', NEW.id, 'u'); END;
CREATE TRIGGER sync_expense_categories_au AFTER UPDATE ON expense_categories WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('expense_categories', NEW.id, 'u'); END;
CREATE TRIGGER sync_expense_categories_ad AFTER DELETE ON expense_categories WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('expense_categories', OLD.id, 'd'); END;

-- purchases
CREATE TRIGGER sync_purchases_ai AFTER INSERT ON purchases WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('purchases', NEW.id, 'u'); END;
CREATE TRIGGER sync_purchases_au AFTER UPDATE ON purchases WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('purchases', NEW.id, 'u'); END;
CREATE TRIGGER sync_purchases_ad AFTER DELETE ON purchases WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('purchases', OLD.id, 'd'); END;

-- purchase_items
CREATE TRIGGER sync_purchase_items_ai AFTER INSERT ON purchase_items WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('purchase_items', NEW.id, 'u'); END;
CREATE TRIGGER sync_purchase_items_au AFTER UPDATE ON purchase_items WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('purchase_items', NEW.id, 'u'); END;
CREATE TRIGGER sync_purchase_items_ad AFTER DELETE ON purchase_items WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('purchase_items', OLD.id, 'd'); END;

-- purchase_payments
CREATE TRIGGER sync_purchase_payments_ai AFTER INSERT ON purchase_payments WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('purchase_payments', NEW.id, 'u'); END;
CREATE TRIGGER sync_purchase_payments_au AFTER UPDATE ON purchase_payments WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('purchase_payments', NEW.id, 'u'); END;
CREATE TRIGGER sync_purchase_payments_ad AFTER DELETE ON purchase_payments WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('purchase_payments', OLD.id, 'd'); END;

-- wallet_entries
CREATE TRIGGER sync_wallet_entries_ai AFTER INSERT ON wallet_entries WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('wallet_entries', NEW.id, 'u'); END;
CREATE TRIGGER sync_wallet_entries_au AFTER UPDATE ON wallet_entries WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('wallet_entries', NEW.id, 'u'); END;
CREATE TRIGGER sync_wallet_entries_ad AFTER DELETE ON wallet_entries WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('wallet_entries', OLD.id, 'd'); END;

-- wallet_counts
CREATE TRIGGER sync_wallet_counts_ai AFTER INSERT ON wallet_counts WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('wallet_counts', NEW.id, 'u'); END;
CREATE TRIGGER sync_wallet_counts_au AFTER UPDATE ON wallet_counts WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('wallet_counts', NEW.id, 'u'); END;
CREATE TRIGGER sync_wallet_counts_ad AFTER DELETE ON wallet_counts WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('wallet_counts', OLD.id, 'd'); END;

-- service_sales
CREATE TRIGGER sync_service_sales_ai AFTER INSERT ON service_sales WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('service_sales', NEW.id, 'u'); END;
CREATE TRIGGER sync_service_sales_au AFTER UPDATE ON service_sales WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('service_sales', NEW.id, 'u'); END;
CREATE TRIGGER sync_service_sales_ad AFTER DELETE ON service_sales WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('service_sales', OLD.id, 'd'); END;

-- service_categories
CREATE TRIGGER sync_service_categories_ai AFTER INSERT ON service_categories WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('service_categories', NEW.id, 'u'); END;
CREATE TRIGGER sync_service_categories_au AFTER UPDATE ON service_categories WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('service_categories', NEW.id, 'u'); END;
CREATE TRIGGER sync_service_categories_ad AFTER DELETE ON service_categories WHEN (SELECT capture FROM sync_control WHERE id = 1) = 1
BEGIN INSERT INTO sync_outbox (tbl, pk, op) VALUES ('service_categories', OLD.id, 'd'); END;

-- A branch that is connected right now: the rows that exist are sent by the snapshot, the triggers above cover everything new.
INSERT INTO sync_snapshot (tbl, upto) SELECT 'returns', COALESCE(MAX(id), 0) FROM returns WHERE (SELECT capture FROM sync_control WHERE id = 1) = 1;
INSERT INTO sync_snapshot (tbl, upto) SELECT 'return_items', COALESCE(MAX(id), 0) FROM return_items WHERE (SELECT capture FROM sync_control WHERE id = 1) = 1;
INSERT INTO sync_snapshot (tbl, upto) SELECT 'customer_payments', COALESCE(MAX(id), 0) FROM customer_payments WHERE (SELECT capture FROM sync_control WHERE id = 1) = 1;
INSERT INTO sync_snapshot (tbl, upto) SELECT 'register_sessions', COALESCE(MAX(id), 0) FROM register_sessions WHERE (SELECT capture FROM sync_control WHERE id = 1) = 1;
INSERT INTO sync_snapshot (tbl, upto) SELECT 'register_balances', COALESCE(MAX(id), 0) FROM register_balances WHERE (SELECT capture FROM sync_control WHERE id = 1) = 1;
INSERT INTO sync_snapshot (tbl, upto) SELECT 'register_movements', COALESCE(MAX(id), 0) FROM register_movements WHERE (SELECT capture FROM sync_control WHERE id = 1) = 1;
INSERT INTO sync_snapshot (tbl, upto) SELECT 'expenses', COALESCE(MAX(id), 0) FROM expenses WHERE (SELECT capture FROM sync_control WHERE id = 1) = 1;
INSERT INTO sync_snapshot (tbl, upto) SELECT 'expense_categories', COALESCE(MAX(id), 0) FROM expense_categories WHERE (SELECT capture FROM sync_control WHERE id = 1) = 1;
INSERT INTO sync_snapshot (tbl, upto) SELECT 'purchases', COALESCE(MAX(id), 0) FROM purchases WHERE (SELECT capture FROM sync_control WHERE id = 1) = 1;
INSERT INTO sync_snapshot (tbl, upto) SELECT 'purchase_items', COALESCE(MAX(id), 0) FROM purchase_items WHERE (SELECT capture FROM sync_control WHERE id = 1) = 1;
INSERT INTO sync_snapshot (tbl, upto) SELECT 'purchase_payments', COALESCE(MAX(id), 0) FROM purchase_payments WHERE (SELECT capture FROM sync_control WHERE id = 1) = 1;
INSERT INTO sync_snapshot (tbl, upto) SELECT 'wallet_entries', COALESCE(MAX(id), 0) FROM wallet_entries WHERE (SELECT capture FROM sync_control WHERE id = 1) = 1;
INSERT INTO sync_snapshot (tbl, upto) SELECT 'wallet_counts', COALESCE(MAX(id), 0) FROM wallet_counts WHERE (SELECT capture FROM sync_control WHERE id = 1) = 1;
INSERT INTO sync_snapshot (tbl, upto) SELECT 'service_sales', COALESCE(MAX(id), 0) FROM service_sales WHERE (SELECT capture FROM sync_control WHERE id = 1) = 1;
INSERT INTO sync_snapshot (tbl, upto) SELECT 'service_categories', COALESCE(MAX(id), 0) FROM service_categories WHERE (SELECT capture FROM sync_control WHERE id = 1) = 1;
