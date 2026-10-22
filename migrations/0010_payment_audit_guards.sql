-- Additive hardening for Preview databases where 0009 is already installed.
-- Does not rewrite existing payment actions or order amounts.
CREATE TRIGGER IF NOT EXISTS loza_payment_actions_no_update BEFORE UPDATE ON loza_payment_actions
BEGIN
  SELECT RAISE(ABORT,'LOZA_PAYMENT_AUDIT_IMMUTABLE');
END;
CREATE TRIGGER IF NOT EXISTS loza_payment_actions_no_delete BEFORE DELETE ON loza_payment_actions
BEGIN
  SELECT RAISE(ABORT,'LOZA_PAYMENT_AUDIT_IMMUTABLE');
END;
CREATE TRIGGER IF NOT EXISTS loza_payment_action_validate BEFORE INSERT ON loza_payment_actions
BEGIN
  SELECT CASE WHEN typeof(NEW.expected_version)!='integer' OR length(trim(NEW.actor))=0
    THEN RAISE(ABORT,'LOZA_INVALID_PAYMENT_ACTION') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM loza_payment_states WHERE order_id=NEW.order_id AND version=NEW.expected_version AND state=NEW.new_state)
    THEN RAISE(ABORT,'LOZA_PAYMENT_UNCHANGED') END;
END;
INSERT OR IGNORE INTO loza_store_migrations(version) VALUES('0010_payment_audit_guards');
