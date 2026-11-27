-- A branch's own price for a product (docs/12 §20, P3c). HQ owns it. The branch never sees "an override": it receives the product with the price
-- it should sell at (the override if there is one, else the base price), so selling needs no new rule at the branch.
CREATE TABLE branch_prices (
  branch_id   INTEGER NOT NULL REFERENCES branches (id),
  product_id  INTEGER NOT NULL REFERENCES products (id),
  -- in the product's own currency (changing a product's currency while overrides exist is refused)
  price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (branch_id, product_id)
);
CREATE INDEX ix_branch_prices_product ON branch_prices (product_id);

-- A line of the change log can be meant for ONE branch (an override for it). NULL = every branch, as before.
ALTER TABLE change_log ADD COLUMN branch_id INTEGER;
