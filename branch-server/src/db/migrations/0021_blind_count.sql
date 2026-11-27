-- Whether a cashier is shown the "expected" figure while counting the drawer at close (docs/13 §6, decision D7).
-- 1 = blind (the default): a cashier counts first and sees the expectation only in the closed report. Managers always see it.
ALTER TABLE store_settings ADD COLUMN cashier_blind_count INTEGER NOT NULL DEFAULT 1 CHECK (cashier_blind_count IN (0, 1));
