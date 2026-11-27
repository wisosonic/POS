-- The catalog's small lists, owned by HQ and sent DOWN to every branch (docs/12-sync-and-hq.md §15, P3a). A branch uses HQ's id as its own id
-- for these (see DOWN_TABLES `ids: 'same'`), so a product that points at category 7 means the same category everywhere.
-- No delete: a product may still point at one, and renaming covers the real need (as at a branch).
CREATE TABLE categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE brands (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE units (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  -- a fractional unit (KG) may be sold in parts: this decides it, so a unit is never created by an import
  fractional INTEGER NOT NULL DEFAULT 0 CHECK (fractional IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE suppliers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  address    TEXT,
  phone      TEXT,
  email      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The three units every branch starts with (its own seed makes them with the same ids 1 to 3), so a new branch and HQ agree from the start.
INSERT INTO units (id, name, fractional, created_at, updated_at) VALUES
  (1, 'Piece', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  (2, 'KG', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  (3, 'Box', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
INSERT INTO change_log (tbl, pk, op, created_at) VALUES
  ('units', 1, 'u', '2026-01-01T00:00:00.000Z'),
  ('units', 2, 'u', '2026-01-01T00:00:00.000Z'),
  ('units', 3, 'u', '2026-01-01T00:00:00.000Z');
