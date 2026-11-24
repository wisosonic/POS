-- What branches record, copied to HQ (docs/12-sync-and-hq.md §4). Each table has the SAME columns as the branch's own table, plus branch_id and
-- hq_received_at, and its primary key is (branch_id, id): two branches can both have a sale number 1. The column lists are
-- packages/core/src/sync.ts (SYNC_TABLES); tests/db/sync-schema.test.ts checks this file, the branch's tables and that list all agree.
--
-- These are mirrors of what the branch did, not HQ's own records, so they have no foreign keys (a sale's lines may arrive a moment after the
-- sale, and a customer or product may not be known here yet), no defaults (every row arrives complete) and no CHECKs (the branch enforces
-- its rules; HQ checks the shape of each row on the way in). HQ never edits a row: it only stores what the branch sends.
CREATE TABLE sales (
  branch_id        INTEGER NOT NULL,
  id               INTEGER NOT NULL,
  ref              INTEGER NOT NULL,
  session_id       INTEGER,
  user_id          INTEGER,
  customer_id      INTEGER NOT NULL,
  warehouse_id     INTEGER NOT NULL,
  rate_lbp_per_usd INTEGER NOT NULL,
  subtotal_lbp     INTEGER NOT NULL,
  discount_lbp     INTEGER NOT NULL,
  shipping_lbp     INTEGER NOT NULL,
  rounding_lbp     INTEGER NOT NULL,
  total_lbp        INTEGER NOT NULL,
  paid_lbp         INTEGER NOT NULL,
  change_lbp       INTEGER NOT NULL,
  rest_lbp         INTEGER NOT NULL,
  profit_lbp       INTEGER NOT NULL,
  status           TEXT NOT NULL,
  notes            TEXT NOT NULL,
  client_sale_id   TEXT,
  idempotency_key  TEXT,
  legacy_id        INTEGER,
  created_at       TEXT NOT NULL,
  hq_received_at   TEXT NOT NULL,
  PRIMARY KEY (branch_id, id),
  UNIQUE (branch_id, ref)
);
CREATE INDEX ix_sales_branch_created ON sales (branch_id, created_at);

CREATE TABLE sale_items (
  branch_id         INTEGER NOT NULL,
  id                INTEGER NOT NULL,
  sale_id           INTEGER NOT NULL,
  product_id        INTEGER,
  name_snap         TEXT NOT NULL,
  receipt_name_snap TEXT,
  barcode_snap      TEXT NOT NULL,
  brand_snap        TEXT NOT NULL,
  unit_snap         TEXT NOT NULL,
  qty_milli         INTEGER NOT NULL,
  unit_price_lbp    INTEGER NOT NULL,
  unit_cost_lbp     INTEGER NOT NULL,
  line_total_lbp    INTEGER NOT NULL,
  legacy_id         INTEGER,
  hq_received_at    TEXT NOT NULL,
  PRIMARY KEY (branch_id, id)
);
CREATE INDEX ix_sale_items_branch_sale ON sale_items (branch_id, sale_id);

CREATE TABLE payments (
  branch_id           INTEGER NOT NULL,
  id                  INTEGER NOT NULL,
  sale_id             INTEGER,
  customer_payment_id INTEGER,
  method              TEXT NOT NULL,
  currency            TEXT NOT NULL,
  amount              INTEGER NOT NULL,
  rate_snap           INTEGER NOT NULL,
  created_at          TEXT NOT NULL,
  hq_received_at      TEXT NOT NULL,
  PRIMARY KEY (branch_id, id)
);
CREATE INDEX ix_payments_branch_sale ON payments (branch_id, sale_id);

CREATE TABLE stock_movements (
  branch_id       INTEGER NOT NULL,
  id              INTEGER NOT NULL,
  product_id      INTEGER NOT NULL,
  warehouse_id    INTEGER NOT NULL,
  qty_milli_delta INTEGER NOT NULL,
  reason          TEXT NOT NULL,
  ref_type        TEXT,
  ref_id          INTEGER,
  user_id         INTEGER,
  note            TEXT,
  created_at      TEXT NOT NULL,
  hq_received_at  TEXT NOT NULL,
  PRIMARY KEY (branch_id, id)
);
CREATE INDEX ix_stock_movements_branch_product ON stock_movements (branch_id, product_id);
