CREATE TABLE IF NOT EXISTS loza_support_requests (
  id TEXT PRIMARY KEY,
  request_key_hash TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN ('site','order','content','other')),
  comment TEXT NOT NULL CHECK(length(comment)<=1000),
  contact_type TEXT NOT NULL CHECK(contact_type IN ('phone','telegram')),
  contact TEXT NOT NULL CHECK(length(contact)<=40),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS loza_support_created ON loza_support_requests(created_at);
INSERT OR IGNORE INTO loza_store_migrations(version) VALUES('0012_support_requests');
