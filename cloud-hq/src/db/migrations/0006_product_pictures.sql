-- A product's picture (docs/12 §19, P3b2). The file lives in HQ's pictures folder under a name made from its own content
-- (`<24 hex digits>.<ext>`); the product keeps `/uploads/<name>`. Branches fetch the file by that name (`GET /sync/images/:name`).
ALTER TABLE products ADD COLUMN image_path TEXT;
