-- The catalog's lists (categories, brands, units, suppliers) come from HQ and use HQ's ids as this branch's own (docs/12 §15, P3a). That only
-- works if this branch had no catalog of its own when it connected, so the connect step checks, and remembers WHICH HQ the catalog came from:
-- connecting again to the same HQ (a new one-time code after a lost token) is fine, a different HQ with a catalog already here is refused.
ALTER TABLE sync_control ADD COLUMN catalog_hq_url TEXT;
