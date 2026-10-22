-- Apply AFTER 0004, to isolated Preview first. No order, price or source rows are deleted.
-- Availability is a manual flag independent of price confirmation. stock is a compatibility value only.
CREATE TABLE IF NOT EXISTS product_availability(
  product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE RESTRICT,
  in_stock INTEGER NOT NULL DEFAULT 0 CHECK(in_stock IN(0,1))
);
INSERT OR IGNORE INTO product_availability(product_id,in_stock)
  SELECT p.id,CASE WHEN p.available=1 THEN 1 ELSE 0 END FROM products p
  JOIN product_catalog c ON c.product_id=p.id WHERE p.is_demo=0;

DROP TRIGGER IF EXISTS loza_checkout_validate_v2;
DROP TRIGGER IF EXISTS loza_checkout_reserve_v2;
DROP TRIGGER IF EXISTS loza_checkout_catalog_guard;
DROP TRIGGER IF EXISTS loza_stock_return_once;
DROP TRIGGER IF EXISTS loza_catalog_price_guard_update;

CREATE TRIGGER IF NOT EXISTS loza_checkout_validate_manual BEFORE INSERT ON order_checkout BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.items_json) j
    LEFT JOIN products p ON p.id=json_extract(j.value,'$.productId')
    LEFT JOIN product_catalog c ON c.product_id=p.id
    LEFT JOIN product_availability a ON a.product_id=p.id
    WHERE p.id IS NULL OR p.is_demo<>0 OR COALESCE(a.in_stock,0)<>1 OR p.price_kop IS NULL
      OR c.confirmed_price_kop IS NULL OR c.confirmed_price_kop<>p.price_kop
      OR json_type(j.value,'$.quantity')<>'integer' OR json_extract(j.value,'$.quantity') NOT BETWEEN 1 AND 5)
    THEN RAISE(ABORT,'LOZA_STOCK_UNAVAILABLE') END;
  SELECT CASE WHEN (SELECT COUNT(DISTINCT json_extract(value,'$.productId')) FROM json_each(NEW.items_json))
    <>json_array_length(NEW.items_json) THEN RAISE(ABORT,'LOZA_DUPLICATE_ITEM') END;
END;
CREATE TRIGGER IF NOT EXISTS loza_checkout_snapshot_manual AFTER INSERT ON order_checkout BEGIN
  INSERT INTO order_items(order_id,product_id,product_name,quantity,unit_price_kop,line_total_kop)
    SELECT NEW.order_id,p.id,p.name,json_extract(j.value,'$.quantity'),p.price_kop,p.price_kop*json_extract(j.value,'$.quantity')
    FROM json_each(NEW.items_json) j JOIN products p ON p.id=json_extract(j.value,'$.productId');
  SELECT CASE WHEN (SELECT COUNT(*) FROM order_items WHERE order_id=NEW.order_id)<>json_array_length(NEW.items_json)
    OR (SELECT COALESCE(SUM(line_total_kop),0) FROM order_items WHERE order_id=NEW.order_id)
      <>(SELECT amount_kop FROM orders WHERE id=NEW.order_id) THEN RAISE(ABORT,'LOZA_TOTAL_MISMATCH') END;
  -- Intentionally no product/stock/availability updates when creating an order.
END;

CREATE TRIGGER IF NOT EXISTS loza_manual_price_guard BEFORE UPDATE ON products
WHEN NEW.available=1 AND (NEW.is_demo=1 OR NOT EXISTS(SELECT 1 FROM product_catalog c
  JOIN product_availability a ON a.product_id=c.product_id WHERE c.product_id=NEW.id
  AND a.in_stock=1 AND c.confirmed_price_kop=NEW.price_kop)) BEGIN
  SELECT RAISE(ABORT,'LOZA_PRICE_NOT_CONFIRMED');
END;
UPDATE products SET stock=CASE WHEN (SELECT in_stock FROM product_availability WHERE product_id=products.id)=1 THEN 20 ELSE 0 END,
  available=CASE WHEN EXISTS(SELECT 1 FROM product_availability a JOIN product_catalog c ON c.product_id=a.product_id
    WHERE a.product_id=products.id AND a.in_stock=1 AND c.confirmed_price_kop=products.price_kop) THEN 1 ELSE 0 END
  WHERE id IN(SELECT product_id FROM product_availability) AND (
    stock<>CASE WHEN (SELECT in_stock FROM product_availability WHERE product_id=products.id)=1 THEN 20 ELSE 0 END OR
    available<>CASE WHEN EXISTS(SELECT 1 FROM product_availability a JOIN product_catalog c ON c.product_id=a.product_id
      WHERE a.product_id=products.id AND a.in_stock=1 AND c.confirmed_price_kop=products.price_kop) THEN 1 ELSE 0 END);
CREATE TRIGGER IF NOT EXISTS loza_manual_stock_guard BEFORE UPDATE OF stock ON products
WHEN EXISTS(SELECT 1 FROM product_availability a WHERE a.product_id=NEW.id
  AND NEW.stock<>CASE WHEN a.in_stock=1 THEN 20 ELSE 0 END) BEGIN
  SELECT RAISE(ABORT,'LOZA_MANUAL_STOCK');
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
  UPDATE product_catalog SET confirmed_price_kop=CASE WHEN json_extract(NEW.payload_json,'$.priceConfirmed')=1
    THEN json_extract(NEW.payload_json,'$.priceKop') ELSE NULL END,
    characteristics_confirmed=COALESCE(json_extract(NEW.payload_json,'$.characteristicsConfirmed'),0) WHERE product_id=NEW.target;
  UPDATE product_availability SET in_stock=json_extract(NEW.payload_json,'$.available') WHERE product_id=NEW.target;
  UPDATE products SET name=json_extract(NEW.payload_json,'$.name'),price_kop=json_extract(NEW.payload_json,'$.priceKop'),
    stock=CASE WHEN EXISTS(SELECT 1 FROM product_availability WHERE product_id=NEW.target AND in_stock=1) THEN 20 ELSE 0 END,
    available=CASE WHEN EXISTS(SELECT 1 FROM product_availability a JOIN product_catalog c ON c.product_id=a.product_id
      WHERE a.product_id=NEW.target AND a.in_stock=1 AND c.confirmed_price_kop=json_extract(NEW.payload_json,'$.priceKop')) THEN 1 ELSE 0 END,
    details_json=json_extract(NEW.payload_json,'$.detailsJson') WHERE id=NEW.target;
END;

-- Preserve the historic stock-return ledger, but never return/decrement quantities in manual mode.
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
END;

CREATE TABLE IF NOT EXISTS admin_availability_changes(
  id TEXT PRIMARY KEY,actor TEXT NOT NULL,product_id TEXT NOT NULL REFERENCES product_availability(product_id),
  expected_version INTEGER NOT NULL CHECK(expected_version>=0),in_stock INTEGER NOT NULL CHECK(in_stock IN(0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER IF NOT EXISTS loza_admin_availability AFTER INSERT ON admin_availability_changes BEGIN
  INSERT INTO admin_mutations(id,actor,kind,target,expected_version,payload_json)
    SELECT NEW.id,NEW.actor,'product',p.id,NEW.expected_version,json_object('name',p.name,'priceKop',p.price_kop,
      'stock',CASE WHEN NEW.in_stock=1 THEN 20 ELSE 0 END,'available',NEW.in_stock,
      'priceConfirmed',CASE WHEN c.confirmed_price_kop=p.price_kop THEN 1 ELSE 0 END,
      'characteristicsConfirmed',c.characteristics_confirmed,'detailsJson',p.details_json)
    FROM products p JOIN product_catalog c ON c.product_id=p.id WHERE p.id=NEW.product_id AND p.is_demo=0;
END;
INSERT OR IGNORE INTO loza_store_migrations(version) SELECT '0005_manual_availability'
  WHERE (SELECT COUNT(*) FROM product_availability)=107;
