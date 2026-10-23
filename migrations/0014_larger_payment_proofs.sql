-- Increase private receipt capacity without altering existing receipt bytes or orders.
-- D1 rows are limited to 2,000,000 bytes; keep headroom for all metadata.
DROP TRIGGER IF EXISTS loza_payment_proof_no_update;
DROP TRIGGER IF EXISTS loza_payment_proof_no_delete;
DROP TRIGGER IF EXISTS loza_proof_exact_amount;
DROP TRIGGER IF EXISTS loza_proof_order_confirmation;
ALTER TABLE order_payment_proofs RENAME TO order_payment_proofs_600k;
CREATE TABLE order_payment_proofs (
  order_id TEXT PRIMARY KEY NOT NULL REFERENCES orders(id),
  reported_amount_kop INTEGER NOT NULL CHECK (reported_amount_kop > 0),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','application/pdf')),
  file_sha256 TEXT NOT NULL CHECK (length(file_sha256) = 64),
  file_content BLOB NOT NULL CHECK (length(file_content) BETWEEN 32 AND 1500000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO order_payment_proofs SELECT * FROM order_payment_proofs_600k;
DROP TABLE order_payment_proofs_600k;
CREATE TRIGGER loza_payment_proof_no_update BEFORE UPDATE ON order_payment_proofs
BEGIN SELECT RAISE(ABORT, 'LOZA_PROOF_IMMUTABLE'); END;
CREATE TRIGGER loza_payment_proof_no_delete BEFORE DELETE ON order_payment_proofs
BEGIN SELECT RAISE(ABORT, 'LOZA_PROOF_IMMUTABLE'); END;
CREATE TRIGGER loza_proof_exact_amount BEFORE INSERT ON order_payment_proofs
BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM orders o JOIN order_checkout c ON c.order_id=o.id WHERE o.id=NEW.order_id AND
    ((c.comment LIKE '[LOZA_PAYMENT:full] %' AND NEW.reported_amount_kop=o.amount_kop) OR
     (c.comment LIKE '[LOZA_PAYMENT:deposit_cod] %' AND o.amount_kop>=10000 AND NEW.reported_amount_kop=10000))
  ) THEN RAISE(ABORT,'LOZA_PROOF_AMOUNT_CHANGED') END;
END;
CREATE TRIGGER loza_proof_order_confirmation BEFORE UPDATE OF status ON orders
WHEN NEW.status='confirmed' AND EXISTS(SELECT 1 FROM order_payment_proofs WHERE order_id=NEW.id)
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM loza_payment_states WHERE order_id=NEW.id AND state='confirmed')
    THEN RAISE(ABORT,'LOZA_RECEIPT_PAYMENT_UNVERIFIED') END;
END;
INSERT OR IGNORE INTO loza_store_migrations(version) VALUES('0014_larger_payment_proofs');
