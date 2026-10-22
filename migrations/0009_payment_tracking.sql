-- LOZA: separate administrator-verified payment status (Preview first).
-- No bank API, no payment collection, no card data. All new states require a verified admin action.
-- Additive to 0005 and compatible with untouched legacy orders and unrelated draft migrations.
CREATE TABLE IF NOT EXISTS loza_payment_states (
  order_id TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE RESTRICT,
  state TEXT NOT NULL DEFAULT 'awaiting' CHECK(state IN ('awaiting','reported','confirmed','not_paid')),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Existing orders with a recorded payment preference receive a distinct unpaid state.
-- No historic order is inferred to be paid.
INSERT OR IGNORE INTO loza_payment_states(order_id)
  SELECT c.order_id FROM order_checkout c
  WHERE c.comment LIKE '[LOZA_PAYMENT:full] %' OR c.comment LIKE '[LOZA_PAYMENT:deposit_cod] %';

CREATE TRIGGER IF NOT EXISTS loza_payment_state_new_order AFTER INSERT ON order_checkout
WHEN NEW.comment LIKE '[LOZA_PAYMENT:full] %' OR NEW.comment LIKE '[LOZA_PAYMENT:deposit_cod] %'
BEGIN
  INSERT OR IGNORE INTO loza_payment_states(order_id) VALUES(NEW.order_id);
END;

-- Each change is an immutable, idempotent, attributable action; a database trigger
-- performs an atomic optimistic-version check and the actual state update.
CREATE TABLE IF NOT EXISTS loza_payment_actions (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES loza_payment_states(order_id) ON DELETE RESTRICT,
  actor TEXT NOT NULL,
  expected_version INTEGER NOT NULL CHECK(expected_version>=0),
  new_state TEXT NOT NULL CHECK(new_state IN ('awaiting','reported','confirmed','not_paid')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS loza_payment_actions_order_idx ON loza_payment_actions(order_id,created_at);
CREATE TRIGGER IF NOT EXISTS loza_payment_action_apply AFTER INSERT ON loza_payment_actions
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM loza_payment_states WHERE order_id=NEW.order_id AND version=NEW.expected_version
  ) THEN RAISE(ABORT,'LOZA_PAYMENT_VERSION_CONFLICT') END;
  UPDATE loza_payment_states SET state=NEW.new_state,version=version+1,
    updated_by=NEW.actor,updated_at=CURRENT_TIMESTAMP WHERE order_id=NEW.order_id;
END;
INSERT OR IGNORE INTO loza_store_migrations(version) VALUES('0009_payment_tracking');
