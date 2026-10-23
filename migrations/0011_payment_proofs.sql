-- Checkout requires a buyer-submitted receipt. It never establishes that money reached the bank.
-- Apply to Preview and Production *before* deploying the new checkout code.
CREATE TABLE IF NOT EXISTS order_payment_proofs (
  order_id TEXT PRIMARY KEY NOT NULL REFERENCES orders(id),
  reported_amount_kop INTEGER NOT NULL CHECK (reported_amount_kop > 0),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','application/pdf')),
  file_sha256 TEXT NOT NULL CHECK (length(file_sha256) = 64),
  file_content BLOB NOT NULL CHECK (length(file_content) BETWEEN 32 AND 600000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER IF NOT EXISTS loza_payment_proof_no_update BEFORE UPDATE ON order_payment_proofs
BEGIN SELECT RAISE(ABORT, 'LOZA_PROOF_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS loza_payment_proof_no_delete BEFORE DELETE ON order_payment_proofs
BEGIN SELECT RAISE(ABORT, 'LOZA_PROOF_IMMUTABLE'); END;
INSERT OR IGNORE INTO loza_store_migrations(version) VALUES('0011_payment_proofs');
