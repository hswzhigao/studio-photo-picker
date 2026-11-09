CREATE TABLE customer_new (
  id INTEGER PRIMARY KEY,
  studio_id INTEGER NOT NULL REFERENCES studio(id),
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  created_by INTEGER REFERENCES staff(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  password_version INTEGER NOT NULL DEFAULT 0,
  UNIQUE(studio_id, phone)
);
INSERT INTO customer_new(id, studio_id, name, phone, password_hash, must_change_password, status, failed_attempts, locked_until, last_login_at, created_by, created_at, updated_at, password_version)
SELECT id, studio_id, name, phone, password_hash, must_change_password, status, failed_attempts, locked_until, last_login_at, created_by, created_at, updated_at, password_version FROM customer;
DROP TABLE customer;
ALTER TABLE customer_new RENAME TO customer;
CREATE INDEX IF NOT EXISTS idx_customer_phone ON customer(phone);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_studio_phone ON customer(studio_id, phone);
