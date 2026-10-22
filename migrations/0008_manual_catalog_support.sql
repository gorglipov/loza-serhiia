-- Apply after 0007 (which only widens historical order quantities for this release).
-- 0006 monobank monitoring is independent. Preserve all existing rows and ledgers.
DROP TRIGGER IF EXISTS loza_checkout_validate_inventory;
DROP TRIGGER IF EXISTS loza_checkout_snapshot_inventory;
DROP TRIGGER IF EXISTS loza_stock_return_once;
DROP TRIGGER IF EXISTS loza_manual_stock_guard;
DROP TRIGGER IF EXISTS loza_inventory_price_guard;
DROP TRIGGER IF EXISTS loza_manual_price_guard;
DROP TRIGGER IF EXISTS loza_checkout_validate_manual;
DROP TRIGGER IF EXISTS loza_checkout_snapshot_manual;
DROP TRIGGER IF EXISTS loza_checkout_validate_manual_v8;
DROP TRIGGER IF EXISTS loza_checkout_snapshot_manual_v8;

CREATE TRIGGER loza_checkout_validate_manual_v8 BEFORE INSERT ON order_checkout BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.items_json) j
    LEFT JOIN products p ON p.id=json_extract(j.value,'$.productId')
    LEFT JOIN product_catalog c ON c.product_id=p.id LEFT JOIN product_availability a ON a.product_id=p.id
    WHERE p.id IS NULL OR p.is_demo<>0 OR COALESCE(a.in_stock,0)<>1 OR p.price_kop IS NULL
      OR c.confirmed_price_kop IS NULL OR c.confirmed_price_kop<>p.price_kop
      OR json_type(j.value,'$.quantity') IS NOT 'integer' OR json_extract(j.value,'$.quantity') NOT BETWEEN 1 AND 20)
    THEN RAISE(ABORT,'LOZA_STOCK_UNAVAILABLE') END;
  SELECT CASE WHEN (SELECT COUNT(DISTINCT json_extract(value,'$.productId')) FROM json_each(NEW.items_json))
    <>json_array_length(NEW.items_json) THEN RAISE(ABORT,'LOZA_DUPLICATE_ITEM') END;
  SELECT CASE WHEN (SELECT SUM(json_extract(value,'$.quantity')) FROM json_each(NEW.items_json))>100
    THEN RAISE(ABORT,'LOZA_QUANTITY_LIMIT') END;
END;
CREATE TRIGGER loza_checkout_snapshot_manual_v8 AFTER INSERT ON order_checkout BEGIN
  INSERT INTO order_items(order_id,product_id,product_name,quantity,unit_price_kop,line_total_kop)
    SELECT NEW.order_id,p.id,p.name,json_extract(j.value,'$.quantity'),p.price_kop,p.price_kop*json_extract(j.value,'$.quantity')
    FROM json_each(NEW.items_json) j JOIN products p ON p.id=json_extract(j.value,'$.productId');
  SELECT CASE WHEN (SELECT COUNT(*) FROM order_items WHERE order_id=NEW.order_id)<>json_array_length(NEW.items_json)
    OR (SELECT COALESCE(SUM(line_total_kop),0) FROM order_items WHERE order_id=NEW.order_id)
      <>(SELECT amount_kop FROM orders WHERE id=NEW.order_id) THEN RAISE(ABORT,'LOZA_TOTAL_MISMATCH') END;
  -- No inventory reservations, deductions, availability updates or product-version updates.
END;
CREATE TRIGGER loza_manual_price_guard BEFORE UPDATE ON products WHEN NEW.available=1 AND
  (NEW.is_demo=1 OR NOT EXISTS(SELECT 1 FROM product_catalog c JOIN product_availability a ON a.product_id=c.product_id
    WHERE c.product_id=NEW.id AND a.in_stock=1 AND c.confirmed_price_kop=NEW.price_kop)) BEGIN
  SELECT RAISE(ABORT,'LOZA_PRICE_NOT_CONFIRMED');
END;

DROP TRIGGER IF EXISTS loza_admin_product;
CREATE TRIGGER loza_admin_product AFTER INSERT ON admin_mutations WHEN NEW.kind='product' BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM admin_product_versions WHERE product_id=NEW.target AND version=NEW.expected_version)
    THEN RAISE(ABORT,'LOZA_VERSION_CONFLICT') END;
  INSERT INTO admin_audit_log(mutation_id,actor,action,target,before_json,after_json)
    SELECT NEW.id,NEW.actor,NEW.kind,NEW.target,json_object('name',p.name,'priceKop',p.price_kop,
      'inStock',COALESCE(a.in_stock,0),'available',p.available,'details',json(p.details_json),
      'priceConfirmed',CASE WHEN c.confirmed_price_kop=p.price_kop THEN 1 ELSE 0 END,
      'characteristicsConfirmed',c.characteristics_confirmed),json_set(NEW.payload_json,'$.inStock',json_extract(NEW.payload_json,'$.available'))
    FROM products p LEFT JOIN product_catalog c ON c.product_id=p.id LEFT JOIN product_availability a ON a.product_id=p.id WHERE p.id=NEW.target;
  UPDATE product_catalog SET confirmed_price_kop=CASE WHEN json_extract(NEW.payload_json,'$.priceConfirmed')=1 THEN json_extract(NEW.payload_json,'$.priceKop') ELSE NULL END,
    characteristics_confirmed=COALESCE(json_extract(NEW.payload_json,'$.characteristicsConfirmed'),0) WHERE product_id=NEW.target;
  UPDATE product_availability SET in_stock=json_extract(NEW.payload_json,'$.available') WHERE product_id=NEW.target;
  UPDATE products SET name=json_extract(NEW.payload_json,'$.name'),price_kop=json_extract(NEW.payload_json,'$.priceKop'),
    available=CASE WHEN EXISTS(SELECT 1 FROM product_availability a JOIN product_catalog c ON c.product_id=a.product_id
      WHERE a.product_id=NEW.target AND a.in_stock=1 AND c.confirmed_price_kop=json_extract(NEW.payload_json,'$.priceKop')) THEN 1 ELSE 0 END,
    details_json=json_extract(NEW.payload_json,'$.detailsJson') WHERE id=NEW.target;
END;
DROP TRIGGER IF EXISTS loza_admin_availability;
CREATE TRIGGER loza_admin_availability AFTER INSERT ON admin_availability_changes BEGIN
  INSERT INTO admin_mutations(id,actor,kind,target,expected_version,payload_json)
    SELECT NEW.id,NEW.actor,'product',p.id,NEW.expected_version,json_object('name',p.name,'priceKop',p.price_kop,'available',NEW.in_stock,
      'priceConfirmed',CASE WHEN c.confirmed_price_kop=p.price_kop THEN 1 ELSE 0 END,
      'characteristicsConfirmed',c.characteristics_confirmed,'detailsJson',p.details_json)
    FROM products p JOIN product_catalog c ON c.product_id=p.id WHERE p.id=NEW.product_id AND p.is_demo=0;
END;
DROP TRIGGER IF EXISTS loza_admin_status;
CREATE TRIGGER loza_admin_status AFTER INSERT ON admin_mutations WHEN NEW.kind='status' BEGIN
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
  -- Cancellation never changes availability or archived inventory values/ledgers.
END;
-- Preserve stock as an unused historical column. Never initialize/reset it to a pretend quantity.
UPDATE products SET available=CASE WHEN EXISTS(SELECT 1 FROM product_availability a JOIN product_catalog c ON c.product_id=a.product_id
  WHERE a.product_id=products.id AND a.in_stock=1 AND c.confirmed_price_kop=products.price_kop) THEN 1 ELSE 0 END
  WHERE is_demo=0 AND available<>CASE WHEN EXISTS(SELECT 1 FROM product_availability a JOIN product_catalog c ON c.product_id=a.product_id
    WHERE a.product_id=products.id AND a.in_stock=1 AND c.confirmed_price_kop=products.price_kop) THEN 1 ELSE 0 END;

CREATE TABLE IF NOT EXISTS support_tickets(
  id TEXT PRIMARY KEY,request_key_hash TEXT NOT NULL UNIQUE,payload_hash TEXT NOT NULL,
  contact_type TEXT NOT NULL CHECK(contact_type IN('telegram','phone')),contact TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN('checkout','delivery','catalog','order_status','technical','other')),
  message TEXT NOT NULL CHECK(length(message) BETWEEN 10 AND 2000),
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN('new','in_progress','resolved')),
  version INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_support_created ON support_tickets(created_at DESC,id);
CREATE TABLE IF NOT EXISTS support_admin_actions(
  id TEXT PRIMARY KEY,actor TEXT NOT NULL,ticket_id TEXT NOT NULL REFERENCES support_tickets(id),
  expected_version INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN('new','in_progress','resolved')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER IF NOT EXISTS loza_support_admin AFTER INSERT ON support_admin_actions BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM support_tickets WHERE id=NEW.ticket_id AND version=NEW.expected_version AND status<>NEW.status)
    THEN RAISE(ABORT,'LOZA_VERSION_CONFLICT') END;
  UPDATE support_tickets SET status=NEW.status,version=version+1 WHERE id=NEW.ticket_id;
END;
CREATE TABLE IF NOT EXISTS support_outbox(
  ticket_id TEXT PRIMARY KEY REFERENCES support_tickets(id),state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN('queued','sending','retry','sent','failed','uncertain')),
  attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,lease_token TEXT,lease_until INTEGER,
  message_id INTEGER,last_error TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_support_due ON support_outbox(state,next_attempt);
CREATE TABLE IF NOT EXISTS support_notification_actions(
  id TEXT PRIMARY KEY,actor TEXT NOT NULL,ticket_id TEXT NOT NULL REFERENCES support_outbox(ticket_id),
  allow_duplicate_risk INTEGER NOT NULL CHECK(allow_duplicate_risk IN(0,1)),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER IF NOT EXISTS loza_support_retry AFTER INSERT ON support_notification_actions BEGIN
  UPDATE support_outbox SET state='queued',attempts=0,next_attempt=0,last_error=NULL
    WHERE ticket_id=NEW.ticket_id AND (state IN('retry','failed') OR (state='uncertain' AND NEW.allow_duplicate_risk=1));
END;
INSERT OR IGNORE INTO loza_store_migrations(version) VALUES('0008_manual_catalog_support');
