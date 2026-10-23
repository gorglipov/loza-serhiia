-- No changes to existing orders, proofs or payments. Guards only validate future mutations.
CREATE TRIGGER IF NOT EXISTS loza_proof_exact_amount BEFORE INSERT ON order_payment_proofs
BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM orders o JOIN order_checkout c ON c.order_id=o.id WHERE o.id=NEW.order_id AND
    ((c.comment LIKE '[LOZA_PAYMENT:full] %' AND NEW.reported_amount_kop=o.amount_kop) OR
     (c.comment LIKE '[LOZA_PAYMENT:deposit_cod] %' AND o.amount_kop>=10000 AND NEW.reported_amount_kop=10000))
  ) THEN RAISE(ABORT,'LOZA_PROOF_AMOUNT_CHANGED') END;
END;
CREATE TRIGGER IF NOT EXISTS loza_proof_order_confirmation BEFORE UPDATE OF status ON orders
WHEN NEW.status='confirmed' AND EXISTS(SELECT 1 FROM order_payment_proofs WHERE order_id=NEW.id)
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM loza_payment_states WHERE order_id=NEW.id AND state='confirmed')
    THEN RAISE(ABORT,'LOZA_RECEIPT_PAYMENT_UNVERIFIED') END;
END;
INSERT OR IGNORE INTO loza_store_migrations(version) VALUES('0013_payment_confirmation_guards');
