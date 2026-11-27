-- A branch has a kind (docs/15 §3, P5a): a SALE branch has tills and sells; a STOCK branch is a warehouse with no tills. HQ says which when the branch
-- connects; until then every branch is a sale branch (as before). A stock branch refuses what needs a till (see modules/branch/kind.ts).
ALTER TABLE branches ADD COLUMN kind TEXT NOT NULL DEFAULT 'sale' CHECK (kind IN ('sale', 'stock'));
