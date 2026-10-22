-- Additive migration after 0002_store_cart. Never deletes orders or bank events.
CREATE TABLE IF NOT EXISTS admin_product_versions(product_id TEXT PRIMARY KEY REFERENCES products(id), version INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO admin_product_versions(product_id) SELECT id FROM products;
CREATE TRIGGER IF NOT EXISTS loza_product_version_insert AFTER INSERT ON products BEGIN
  INSERT INTO admin_product_versions(product_id) VALUES(NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS loza_product_version_update AFTER UPDATE ON products BEGIN
  UPDATE admin_product_versions SET version=version+1 WHERE product_id=NEW.id;
END;
CREATE TABLE IF NOT EXISTS admin_order_versions(order_id TEXT PRIMARY KEY REFERENCES orders(id), version INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO admin_order_versions(order_id) SELECT id FROM orders;
CREATE TRIGGER IF NOT EXISTS loza_order_version_insert AFTER INSERT ON orders BEGIN
  INSERT INTO admin_order_versions(order_id) VALUES(NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS loza_order_version_update AFTER UPDATE OF status ON orders BEGIN
  UPDATE admin_order_versions SET version=version+1 WHERE order_id=NEW.id;
END;
CREATE TABLE IF NOT EXISTS admin_stock_returns(
  order_id TEXT PRIMARY KEY REFERENCES orders(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER IF NOT EXISTS loza_stock_return_once AFTER INSERT ON admin_stock_returns BEGIN
  SELECT CASE WHEN (SELECT status FROM orders WHERE id=NEW.order_id) <> 'cancelled'
    THEN RAISE(ABORT,'LOZA_INVALID_TRANSITION') END;
  UPDATE products SET stock=stock+(SELECT quantity FROM order_items WHERE order_id=NEW.order_id AND product_id=products.id)
    WHERE id IN (SELECT product_id FROM order_items WHERE order_id=NEW.order_id);
END;
CREATE TABLE IF NOT EXISTS telegram_settings(
  id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN(0,1)),
  version INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO telegram_settings(id) VALUES(1);
CREATE TABLE IF NOT EXISTS admin_mutations(
  id TEXT PRIMARY KEY, actor TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN('product','status','telegram')),
  target TEXT NOT NULL, expected_version INTEGER NOT NULL CHECK(expected_version>=0),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS admin_audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, mutation_id TEXT NOT NULL UNIQUE REFERENCES admin_mutations(id),
  actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,
  before_json TEXT NOT NULL CHECK(json_valid(before_json)), after_json TEXT NOT NULL CHECK(json_valid(after_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER IF NOT EXISTS loza_admin_product AFTER INSERT ON admin_mutations WHEN NEW.kind='product' BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM admin_product_versions WHERE product_id=NEW.target AND version=NEW.expected_version)
    THEN RAISE(ABORT,'LOZA_VERSION_CONFLICT') END;
  INSERT INTO admin_audit_log(mutation_id,actor,action,target,before_json,after_json)
    SELECT NEW.id,NEW.actor,NEW.kind,NEW.target,
      json_object('name',name,'priceKop',price_kop,'stock',stock,'available',available,'details',json(details_json)),NEW.payload_json
      FROM products WHERE id=NEW.target;
  UPDATE products SET name=json_extract(NEW.payload_json,'$.name'), price_kop=json_extract(NEW.payload_json,'$.priceKop'),
    stock=json_extract(NEW.payload_json,'$.stock'), available=json_extract(NEW.payload_json,'$.available'),
    details_json=json_extract(NEW.payload_json,'$.detailsJson') WHERE id=NEW.target;
END;
CREATE TRIGGER IF NOT EXISTS loza_admin_status AFTER INSERT ON admin_mutations WHEN NEW.kind='status' BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM admin_order_versions WHERE order_id=NEW.target AND version=NEW.expected_version)
    THEN RAISE(ABORT,'LOZA_VERSION_CONFLICT') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM orders WHERE id=NEW.target AND (
    (status='pending' AND json_extract(NEW.payload_json,'$.status') IN('confirmed','cancelled')) OR
    (status='confirmed' AND json_extract(NEW.payload_json,'$.status') IN('shipped','cancelled')) OR
    (status='shipped' AND json_extract(NEW.payload_json,'$.status')='completed')))
    THEN RAISE(ABORT,'LOZA_INVALID_TRANSITION') END;
  INSERT INTO admin_audit_log(mutation_id,actor,action,target,before_json,after_json)
    SELECT NEW.id,NEW.actor,NEW.kind,NEW.target,json_object('status',status),NEW.payload_json FROM orders WHERE id=NEW.target;
  UPDATE orders SET status=json_extract(NEW.payload_json,'$.status') WHERE id=NEW.target;
  INSERT OR IGNORE INTO admin_stock_returns(order_id)
    SELECT NEW.target WHERE json_extract(NEW.payload_json,'$.status')='cancelled';
END;
CREATE TRIGGER IF NOT EXISTS loza_admin_telegram AFTER INSERT ON admin_mutations WHEN NEW.kind='telegram' BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM telegram_settings WHERE id=1 AND version=NEW.expected_version)
    THEN RAISE(ABORT,'LOZA_VERSION_CONFLICT') END;
  INSERT INTO admin_audit_log(mutation_id,actor,action,target,before_json,after_json)
    SELECT NEW.id,NEW.actor,NEW.kind,'telegram',json_object('enabled',enabled),NEW.payload_json FROM telegram_settings WHERE id=1;
  UPDATE telegram_settings SET enabled=json_extract(NEW.payload_json,'$.enabled'),version=version+1 WHERE id=1;
END;
CREATE TABLE IF NOT EXISTS telegram_outbox(
  id INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE,
  order_id TEXT REFERENCES orders(id), kind TEXT NOT NULL CHECK(kind IN('order','test')),
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN('queued','sending','retry','sent','failed','uncertain')),
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT, lease_until INTEGER, message_id INTEGER, last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_telegram_due ON telegram_outbox(state,next_attempt);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_log(id DESC);
CREATE TABLE IF NOT EXISTS admin_notification_actions(
  id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN('test','retry')),
  event_key TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER IF NOT EXISTS loza_notification_retry AFTER INSERT ON admin_notification_actions WHEN NEW.action='retry' BEGIN
  UPDATE telegram_outbox SET state='queued',next_attempt=0,attempts=0,last_error=NULL
    WHERE event_key=NEW.event_key AND state IN('retry','failed','uncertain');
END;
INSERT OR IGNORE INTO loza_store_migrations(version) VALUES('0003_admin_telegram');
