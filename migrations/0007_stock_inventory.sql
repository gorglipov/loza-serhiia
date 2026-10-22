-- After 0005; 0006 is an independent optional bank-monitor migration.
-- Apply as one migration/batch, first to Preview. Copy order_items exactly to widen its CHECK from 5 to 20.
DROP TRIGGER IF EXISTS loza_checkout_validate_manual;
DROP TRIGGER IF EXISTS loza_checkout_snapshot_manual;
DROP TRIGGER IF EXISTS loza_checkout_validate_inventory;
DROP TRIGGER IF EXISTS loza_checkout_snapshot_inventory;
DROP TRIGGER IF EXISTS loza_stock_return_once;
DROP TRIGGER IF EXISTS loza_manual_stock_guard;
DROP TRIGGER IF EXISTS loza_manual_price_guard;
DROP TRIGGER IF EXISTS loza_inventory_price_guard;

CREATE TABLE order_items_v7(
  order_id TEXT NOT NULL REFERENCES order_checkout(order_id) ON DELETE RESTRICT,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(typeof(quantity)='integer' AND quantity BETWEEN 1 AND 20),
  unit_price_kop INTEGER NOT NULL CHECK(typeof(unit_price_kop)='integer' AND unit_price_kop>0),
  line_total_kop INTEGER NOT NULL CHECK(line_total_kop=quantity*unit_price_kop),
  PRIMARY KEY(order_id,product_id)
);
INSERT INTO order_items_v7 SELECT order_id,product_id,product_name,quantity,unit_price_kop,line_total_kop FROM order_items;
CREATE TABLE loza_0007_copy_guard(ok INTEGER NOT NULL CHECK(ok=1));
INSERT INTO loza_0007_copy_guard SELECT CASE WHEN
  (SELECT COUNT(*) FROM order_items)=(SELECT COUNT(*) FROM order_items_v7) AND NOT EXISTS(
    SELECT order_id,product_id,product_name,quantity,unit_price_kop,line_total_kop FROM order_items
    EXCEPT SELECT order_id,product_id,product_name,quantity,unit_price_kop,line_total_kop FROM order_items_v7)
  THEN 1 ELSE 0 END;
DROP TABLE loza_0007_copy_guard;
DROP TABLE order_items;
ALTER TABLE order_items_v7 RENAME TO order_items;
CREATE INDEX idx_order_items_product ON order_items(product_id);

CREATE TABLE IF NOT EXISTS order_stock_reservations(
  order_id TEXT NOT NULL REFERENCES order_checkout(order_id) ON DELETE RESTRICT,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK(typeof(quantity)='integer' AND quantity BETWEEN 1 AND 20),
  returned INTEGER NOT NULL DEFAULT 0 CHECK(returned IN(0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,returned_at TEXT,
  PRIMARY KEY(order_id,product_id)
);
-- No backfill: pre-0007 orders did not reserve stock in manual mode.
CREATE TRIGGER loza_checkout_validate_inventory BEFORE INSERT ON order_checkout BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.items_json) j
    LEFT JOIN products p ON p.id=json_extract(j.value,'$.productId')
    LEFT JOIN product_catalog c ON c.product_id=p.id LEFT JOIN product_availability a ON a.product_id=p.id
    WHERE p.id IS NULL OR p.is_demo<>0 OR COALESCE(a.in_stock,0)<>1 OR p.price_kop IS NULL
      OR c.confirmed_price_kop IS NULL OR c.confirmed_price_kop<>p.price_kop
      OR json_type(j.value,'$.quantity') IS NOT 'integer' OR json_extract(j.value,'$.quantity') NOT BETWEEN 1 AND 20
      OR p.stock<json_extract(j.value,'$.quantity')) THEN RAISE(ABORT,'LOZA_STOCK_UNAVAILABLE') END;
  SELECT CASE WHEN (SELECT COUNT(DISTINCT json_extract(value,'$.productId')) FROM json_each(NEW.items_json))
    <>json_array_length(NEW.items_json) THEN RAISE(ABORT,'LOZA_DUPLICATE_ITEM') END;
END;
CREATE TRIGGER loza_checkout_snapshot_inventory AFTER INSERT ON order_checkout BEGIN
  INSERT INTO order_items(order_id,product_id,product_name,quantity,unit_price_kop,line_total_kop)
    SELECT NEW.order_id,p.id,p.name,json_extract(j.value,'$.quantity'),p.price_kop,p.price_kop*json_extract(j.value,'$.quantity')
    FROM json_each(NEW.items_json) j JOIN products p ON p.id=json_extract(j.value,'$.productId');
  SELECT CASE WHEN (SELECT COUNT(*) FROM order_items WHERE order_id=NEW.order_id)<>json_array_length(NEW.items_json)
    OR (SELECT COALESCE(SUM(line_total_kop),0) FROM order_items WHERE order_id=NEW.order_id)
      <>(SELECT amount_kop FROM orders WHERE id=NEW.order_id) THEN RAISE(ABORT,'LOZA_TOTAL_MISMATCH') END;
  INSERT INTO order_stock_reservations(order_id,product_id,quantity)
    SELECT order_id,product_id,quantity FROM order_items WHERE order_id=NEW.order_id;
  UPDATE products SET stock=stock-(SELECT quantity FROM order_stock_reservations r WHERE r.order_id=NEW.order_id AND r.product_id=products.id),
    available=CASE WHEN stock-(SELECT quantity FROM order_stock_reservations r WHERE r.order_id=NEW.order_id AND r.product_id=products.id)>0
      AND EXISTS(SELECT 1 FROM product_availability a JOIN product_catalog c ON c.product_id=a.product_id
        WHERE a.product_id=products.id AND a.in_stock=1 AND c.confirmed_price_kop=products.price_kop) THEN 1 ELSE 0 END
    WHERE id IN(SELECT product_id FROM order_stock_reservations WHERE order_id=NEW.order_id);
END;

CREATE TRIGGER loza_stock_return_once AFTER INSERT ON admin_stock_returns BEGIN
  SELECT CASE WHEN (SELECT status FROM orders WHERE id=NEW.order_id)<>'cancelled' THEN RAISE(ABORT,'LOZA_INVALID_TRANSITION') END;
  UPDATE products SET stock=stock+(SELECT quantity FROM order_stock_reservations r WHERE r.order_id=NEW.order_id AND r.product_id=products.id AND r.returned=0),
    available=CASE WHEN EXISTS(SELECT 1 FROM product_availability a JOIN product_catalog c ON c.product_id=a.product_id
      WHERE a.product_id=products.id AND a.in_stock=1 AND c.confirmed_price_kop=products.price_kop) THEN 1 ELSE 0 END
    WHERE id IN(SELECT product_id FROM order_stock_reservations WHERE order_id=NEW.order_id AND returned=0);
  UPDATE order_stock_reservations SET returned=1,returned_at=CURRENT_TIMESTAMP WHERE order_id=NEW.order_id AND returned=0;
END;

CREATE TRIGGER loza_inventory_price_guard BEFORE UPDATE ON products WHEN NEW.available=1 AND
  (NEW.stock<=0 OR NEW.is_demo=1 OR NOT EXISTS(SELECT 1 FROM product_catalog c JOIN product_availability a ON a.product_id=c.product_id
    WHERE c.product_id=NEW.id AND a.in_stock=1 AND c.confirmed_price_kop=NEW.price_kop)) BEGIN
  SELECT RAISE(ABORT,'LOZA_PRICE_NOT_CONFIRMED');
END;

DROP TRIGGER IF EXISTS loza_admin_product;
CREATE TRIGGER loza_admin_product AFTER INSERT ON admin_mutations WHEN NEW.kind='product' BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM admin_product_versions WHERE product_id=NEW.target AND version=NEW.expected_version)
    THEN RAISE(ABORT,'LOZA_VERSION_CONFLICT') END;
  SELECT CASE WHEN json_type(NEW.payload_json,'$.stock') IS NOT 'integer' OR json_extract(NEW.payload_json,'$.stock') NOT BETWEEN 0 AND 1000000
    THEN RAISE(ABORT,'LOZA_INVALID_STOCK') END;
  INSERT INTO admin_audit_log(mutation_id,actor,action,target,before_json,after_json)
    SELECT NEW.id,NEW.actor,NEW.kind,NEW.target,json_object('name',p.name,'priceKop',p.price_kop,'stock',p.stock,
      'inStock',COALESCE(a.in_stock,0),'available',p.available,'details',json(p.details_json),
      'priceConfirmed',CASE WHEN c.confirmed_price_kop=p.price_kop THEN 1 ELSE 0 END,
      'characteristicsConfirmed',c.characteristics_confirmed),json_set(NEW.payload_json,'$.inStock',json_extract(NEW.payload_json,'$.available'))
    FROM products p LEFT JOIN product_catalog c ON c.product_id=p.id LEFT JOIN product_availability a ON a.product_id=p.id WHERE p.id=NEW.target;
  UPDATE product_catalog SET confirmed_price_kop=CASE WHEN json_extract(NEW.payload_json,'$.priceConfirmed')=1 THEN json_extract(NEW.payload_json,'$.priceKop') ELSE NULL END,
    characteristics_confirmed=COALESCE(json_extract(NEW.payload_json,'$.characteristicsConfirmed'),0) WHERE product_id=NEW.target;
  UPDATE product_availability SET in_stock=json_extract(NEW.payload_json,'$.available') WHERE product_id=NEW.target;
  UPDATE products SET name=json_extract(NEW.payload_json,'$.name'),price_kop=json_extract(NEW.payload_json,'$.priceKop'),stock=json_extract(NEW.payload_json,'$.stock'),
    available=CASE WHEN json_extract(NEW.payload_json,'$.stock')>0 AND EXISTS(SELECT 1 FROM product_availability a JOIN product_catalog c ON c.product_id=a.product_id
      WHERE a.product_id=NEW.target AND a.in_stock=1 AND c.confirmed_price_kop=json_extract(NEW.payload_json,'$.priceKop')) THEN 1 ELSE 0 END,
    details_json=json_extract(NEW.payload_json,'$.detailsJson') WHERE id=NEW.target;
END;

DROP TRIGGER IF EXISTS loza_admin_availability;
CREATE TRIGGER loza_admin_availability AFTER INSERT ON admin_availability_changes BEGIN
  INSERT INTO admin_mutations(id,actor,kind,target,expected_version,payload_json)
    SELECT NEW.id,NEW.actor,'product',p.id,NEW.expected_version,json_object('name',p.name,'priceKop',p.price_kop,'stock',p.stock,'available',NEW.in_stock,
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
  INSERT OR IGNORE INTO admin_stock_returns(order_id) SELECT NEW.target WHERE json_extract(NEW.payload_json,'$.status')='cancelled'
    AND EXISTS(SELECT 1 FROM order_stock_reservations WHERE order_id=NEW.target AND returned=0);
END;
INSERT OR IGNORE INTO loza_store_migrations(version) VALUES('0007_stock_inventory');
