-- A deleted user is hidden and can no longer sign in, but the row stays: sales, returns, approvals and the audit log point at it.
ALTER TABLE users ADD COLUMN deleted_at TEXT;
