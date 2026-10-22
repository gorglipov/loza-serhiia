// A local rehearsal only: real Production DDL/public product metadata, synthetic private records.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const {Miniflare,convertV4MiniflareOptions}=await import(pathToFileURL(process.env.LOZA_MINIFLARE_MODULE || './node_modules/miniflare/dist/src/index.js').href);
const root=new URL('../',import.meta.url);
async function migrationStatements(name){
  const source=await readFile(new URL('migrations/'+name+'.sql',root),'utf8');let chunk='',trigger=false;const statements=[];
  for(const line of source.split(/\r?\n/)){
    if(!line.trim() || line.trim().startsWith('--'))continue;
    chunk+=line+'\n';if(/^CREATE TRIGGER/i.test(chunk.trim()))trigger=true;
    if((trigger && line.trim()==='END;') || (!trigger && /;\s*$/.test(line))){statements.push(chunk);chunk='';trigger=false;}
  }
  assert.equal(chunk.trim(),'');
  return statements;
}
async function migrate(db,name){for(const sql of await migrationStatements(name))await db.prepare(sql).run();}
test('0004–0008 preserve existing orders and bank/Telegram/audit data while returning to manual availability',async()=>{
  const options={modules:true,script:'export default {fetch(){return new Response("local fixture");}}',compatibilityDate:'2026-10-22',d1Databases:['DB']};
  const mf=new Miniflare(convertV4MiniflareOptions?convertV4MiniflareOptions(options):options);
  try{
    const db=await mf.getD1Database('DB');
    if(process.env.LOZA_PRODUCTION_SCHEMA_FILE){
      const schema=JSON.parse(await readFile(process.env.LOZA_PRODUCTION_SCHEMA_FILE,'utf8'));
      for(const kind of ['table','index','trigger'])for(const entry of schema)if(entry.type===kind && entry.sql)await db.prepare(entry.sql).run();
    }else{
      await db.prepare("CREATE TABLE orders(id TEXT PRIMARY KEY,amount_kop INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending')").run();
      await db.prepare('CREATE TABLE mono_events(transaction_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,amount_kop INTEGER NOT NULL,currency_code INTEGER NOT NULL,description TEXT,is_hold INTEGER NOT NULL DEFAULT 0)').run();
    }
    await migrate(db,'0002_store_cart');await migrate(db,'0003_admin_telegram');
    if(process.env.LOZA_PRODUCTION_PRODUCTS_FILE){
      const products=JSON.parse(await readFile(process.env.LOZA_PRODUCTION_PRODUCTS_FILE,'utf8'));
      assert.equal(products.length,110);
      for(const p of products)await db.prepare('UPDATE products SET name=?,price_kop=?,available=?,stock=?,is_demo=?,details_json=? WHERE id=?')
        .bind(p.name,p.price_kop,p.available,p.stock,p.is_demo,p.details_json,p.id).run();
    }
    // These records are deliberately synthetic. No private Production data is downloaded.
    await db.prepare("INSERT INTO orders(id,amount_kop,status) VALUES('BEFORE-CATALOG',100000,'pending')").run();
    await db.prepare(`INSERT INTO order_checkout(order_id,request_key_hash,payload_hash,buyer_name,phone,city,delivery_method,delivery_branch,comment,items_json,demo_only)
      VALUES('BEFORE-CATALOG',?,?,?,?,?,?,?,?,?,1)`)
      .bind('c'.repeat(64),'d'.repeat(64),'Fixture Buyer','+380991234567','Fixture City','nova_poshta','Fixture Branch','Fixture comment',JSON.stringify([{productId:'grape-demo',quantity:2}])).run();
    await db.prepare("INSERT INTO mono_events(transaction_id,account_id,amount_kop,currency_code,description,is_hold) VALUES('BEFORE-BANK','fixture-account',100000,980,'fixture bank event',0)").run();
    await db.prepare("INSERT INTO admin_mutations(id,actor,kind,target,expected_version,payload_json) VALUES('fixture-cancel','owner@example.test','status','BEFORE-CATALOG',0,'{\"status\":\"cancelled\"}')").run();
    await db.prepare("INSERT INTO admin_mutations(id,actor,kind,target,expected_version,payload_json) VALUES('fixture-notifications','owner@example.test','telegram','telegram',0,'{\"enabled\":0}')").run();
    await db.prepare("INSERT INTO telegram_outbox(event_key,order_id,kind,state,attempts,next_attempt,last_error) VALUES('order:BEFORE-CATALOG','BEFORE-CATALOG','order','retry',3,12345,'temporary fixture error')").run();
    const protectedTables=['orders','order_checkout','order_items','mono_events','admin_stock_returns','telegram_settings','telegram_outbox','admin_mutations','admin_audit_log','admin_notification_actions','admin_order_versions'];
    const snapshot=async()=>Object.fromEntries(await Promise.all(protectedTables.map(async table=>[table,(await db.prepare('SELECT * FROM '+table+' ORDER BY 1').all()).results])));
    const before=await snapshot(),source=JSON.parse(await readFile(new URL('server/catalog-source.json',root),'utf8'));
    assert.equal(before.telegram_settings[0].enabled,0);assert.equal(before.telegram_settings[0].version,1);
    assert.equal(before.order_items.length,1);assert.equal(before.admin_stock_returns.length,1);
    await migrate(db,'0004_catalog_107');await migrate(db,'0005_manual_availability');
    assert.deepEqual(await snapshot(),before);
    const catalog=(await db.prepare(`SELECT p.*,c.confirmed_price_kop,c.source_json,a.in_stock FROM products p
      JOIN product_catalog c ON c.product_id=p.id JOIN product_availability a ON a.product_id=p.id ORDER BY p.id`).all()).results;
    assert.equal(catalog.length,107);assert.equal(new Set(catalog.map(p=>p.id)).size,107);assert.equal(new Set(catalog.map(p=>p.name)).size,107);
    for(const s of source){
      const p=catalog.find(p=>p.id===s.id);assert.ok(p);assert.equal(p.name,s.name);assert.deepEqual(JSON.parse(p.details_json),s.details);
      assert.equal(p.price_kop,s.priceKop);assert.equal(p.confirmed_price_kop,null);assert.deepEqual(JSON.parse(p.source_json),s);
      assert.equal(p.in_stock,0);assert.equal(p.available,0);assert.equal(p.stock,0);
    }
    assert.equal(catalog.filter(p=>p.price_kop!==null).length,84);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM products WHERE is_demo=1 AND available=1').first()).n,0);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM products').first()).n,110);
    assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
    const triggers=(await db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all()).results;
    for(const obsolete of ['loza_checkout_validate_v2','loza_checkout_reserve_v2','loza_checkout_catalog_guard','loza_stock_return_once'])assert.ok(!triggers.some(t=>t.name===obsolete));
    for(const name of ['loza_checkout_snapshot_manual','loza_admin_status'])assert.ok(!/UPDATE\s+products\s+SET\s+stock/i.test(triggers.find(t=>t.name===name).sql));
    // Only 0005 is safe to replay after switching to manual availability; never reapply 0004 alone.
    await migrate(db,'0005_manual_availability');assert.deepEqual(await snapshot(),before);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM product_catalog WHERE confirmed_price_kop IS NOT NULL').first()).n,0);
    // A pre-0007 manual-mode order never deducted stock. Cancelling it must not invent a return.
    const p=source.find(p=>p.id==='loza-002');
    await db.prepare("INSERT INTO admin_mutations(id,actor,kind,target,expected_version,payload_json) SELECT 'fixture-stock','owner@example.test','product','loza-002',version,? FROM admin_product_versions WHERE product_id='loza-002'")
      .bind(JSON.stringify({name:p.name,priceKop:p.priceKop,stock:20,available:1,priceConfirmed:1,characteristicsConfirmed:0,detailsJson:JSON.stringify(p.details)})).run();
    await db.prepare("INSERT INTO orders(id,amount_kop,status) VALUES('BEFORE-STOCK',?,'pending')").bind(p.priceKop*2).run();
    await db.prepare(`INSERT INTO order_checkout(order_id,request_key_hash,payload_hash,buyer_name,phone,city,delivery_method,delivery_branch,comment,items_json,demo_only)
      VALUES('BEFORE-STOCK',?,?,?,?,?,?,?,?,?,0)`)
      .bind('e'.repeat(64),'f'.repeat(64),'Fixture Buyer','+380991234567','Fixture City','nova_poshta','Fixture Branch','',JSON.stringify([{productId:p.id,quantity:2}])).run();
    const before7=await snapshot(),stockBefore=(await db.prepare('SELECT stock FROM products WHERE id=?').bind(p.id).first()).stock;
    assert.equal(stockBefore,20);
    const statements=await migrationStatements('0007_stock_inventory');
    const schemaBefore=(await db.prepare("SELECT name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name").all()).results;
    // Failure after the table swap must roll back the entire migration, including every DDL statement.
    await assert.rejects(db.batch([...statements.map(sql=>db.prepare(sql)),db.prepare('SELECT * FROM intentional_missing_fixture_table')]));
    assert.deepEqual((await db.prepare("SELECT name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name").all()).results,schemaBefore);
    assert.deepEqual(await snapshot(),before7);
    for(let i=0;i<2;i++){
      await db.batch(statements.map(sql=>db.prepare(sql)));
      assert.deepEqual(await snapshot(),before7);
      assert.equal((await db.prepare('SELECT COUNT(*) n FROM order_stock_reservations').first()).n,0);
      assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
    }
    await db.prepare("INSERT INTO admin_mutations(id,actor,kind,target,expected_version,payload_json) VALUES('fixture-old-cancel','owner@example.test','status','BEFORE-STOCK',0,'{\"status\":\"cancelled\"}')").run();
    assert.equal((await db.prepare('SELECT stock FROM products WHERE id=?').bind(p.id).first()).stock,stockBefore);
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM admin_stock_returns WHERE order_id='BEFORE-STOCK'").first()).n,0);
    const before8=await snapshot(),pricesBefore=(await db.prepare('SELECT * FROM product_catalog ORDER BY product_id').all()).results;
    const stockSnapshot=(await db.prepare('SELECT id,stock FROM products ORDER BY id').all()).results;
    for(let i=0;i<2;i++){
      await db.batch((await migrationStatements('0008_manual_catalog_support')).map(sql=>db.prepare(sql)));
      assert.deepEqual(await snapshot(),before8);assert.deepEqual((await db.prepare('SELECT * FROM product_catalog ORDER BY product_id').all()).results,pricesBefore);
      assert.deepEqual((await db.prepare('SELECT id,stock FROM products ORDER BY id').all()).results,stockSnapshot);
      assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
    }
    // Existing confirmations are preserved, while all other PDF candidate prices remain unconfirmed.
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM product_catalog WHERE confirmed_price_kop IS NOT NULL').first()).n,1);
    const finalTriggers=(await db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all()).results;
    for(const obsolete of ['loza_checkout_validate_inventory','loza_checkout_snapshot_inventory','loza_stock_return_once','loza_manual_stock_guard'])assert.ok(!finalTriggers.some(t=>t.name===obsolete));
    for(const name of ['loza_checkout_snapshot_manual_v8','loza_admin_status','loza_admin_availability','loza_admin_product'])assert.ok(!/SET\s+stock\s*=|INSERT INTO order_stock_reservations/i.test(finalTriggers.find(t=>t.name===name).sql));
    await db.prepare('UPDATE products SET stock=0 WHERE id=?').bind(p.id).run();
    await db.prepare("INSERT INTO orders(id,amount_kop,status) VALUES('MANUAL-20',?,'pending')").bind(p.priceKop*20).run();
    await db.prepare(`INSERT INTO order_checkout(order_id,request_key_hash,payload_hash,buyer_name,phone,city,delivery_method,delivery_branch,comment,items_json,demo_only)
      VALUES('MANUAL-20',?,?,?,?,?,?,?,?,?,0)`)
      .bind('1'.repeat(64),'2'.repeat(64),'Fixture Buyer','+380991234567','Fixture City','nova_poshta','Fixture Branch','',JSON.stringify([{productId:p.id,quantity:20}])).run();
    await db.prepare("INSERT INTO admin_mutations(id,actor,kind,target,expected_version,payload_json) VALUES('fixture-manual-cancel','owner@example.test','status','MANUAL-20',0,'{\"status\":\"cancelled\"}')").run();
    assert.equal((await db.prepare('SELECT stock FROM products WHERE id=?').bind(p.id).first()).stock,0);
    assert.equal((await db.prepare('SELECT in_stock FROM product_availability WHERE product_id=?').bind(p.id).first()).in_stock,1);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM order_stock_reservations').first()).n,0);
  }finally{await mf.dispose();}
});
