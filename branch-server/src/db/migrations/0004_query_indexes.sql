-- Indexes found missing by the load test (docs/09-load-test.md): each of these listings scanned the whole sales or returns table.
-- None of them mattered at the shop's size today, and all of them grow with it.

-- A customer's purchase history, newest first (customer accounts, US-32).
CREATE INDEX ix_sales_customer ON sales (customer_id, id);

-- A cashier's own sales, newest first (a cashier may only list their own).
CREATE INDEX ix_sales_user ON sales (user_id, id);

-- Returns inside a date range (the dashboard and the sales report take them off the takings).
CREATE INDEX ix_returns_created ON returns (created_at);
