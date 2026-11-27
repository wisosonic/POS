-- A branch has a kind (docs/15 §3, P5a): a SALE branch has tills and sells; a STOCK branch is a warehouse and has no tills. HQ buys for stock
-- branches and sale branches request from them. The kind is chosen when the branch is added and can only change until the branch is enrolled.
ALTER TABLE branches ADD COLUMN kind TEXT NOT NULL DEFAULT 'sale' CHECK (kind IN ('sale', 'stock'));
