// Runs the real compiled Pages worker + isolated Miniflare D1. No remote DB/bot.
import {test,before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {webcrypto} from 'node:crypto';
const {Miniflare,convertV4MiniflareOptions}=await import(pathToFileURL(process.env.LOZA_MINIFLARE_MODULE || './node_modules/miniflare/dist/src/index.js').href);
const root=new URL('../',import.meta.url),origin='https://preview.loza.test';
let mf,db,keys,jwk,csrf,token;
let telegramMode='ok',sent=[],calls=0;
const audience='a'.repeat(64),admin='owner@example.test';
const issuer='https://loza-test.cloudflareaccess.com';
// Match the actual Preview configuration shape: bare hostname, signed HTTPS issuer.
const env={ACCESS_TEAM_DOMAIN:'loza-test.cloudflareaccess.com',ACCESS_AUD:audience,ADMIN_EMAILS:admin,ADMIN_CSRF_SECRET:'fixture-csrf-secret-'.repeat(4),CHECKOUT_SECURITY_KEY:'fixture-checkout-secret-'.repeat(4),TURNSTILE_SITE_KEY:'fixture-site-key',TURNSTILE_SECRET_KEY:'fixture-turnstile-secret',TELEGRAM_BOT_TOKEN:'12345:fixture_token',TELEGRAM_CHAT_ID:'123456'};
const b64=v=>Buffer.from(typeof v==='string'?v:JSON.stringify(v)).toString('base64url');
async function jwt(changes={},header={}) {
  const now=Math.floor(Date.now()/1000),h=b64({alg:'RS256',kid:'test-key',...header});
  const payload=b64({iss:issuer,aud:[audience],iat:now-10,exp:now+3600,type:'app',sub:'owner-sub',email:admin,...changes});
  const signature=await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5',keys.privateKey,Buffer.from(h+'.'+payload));
  return h+'.'+payload+'.'+Buffer.from(signature).toString('base64url');
}
async function request(path,{auth=token,data,key,csrfToken=csrf,headers={}}={}) {
  const response=await mf.dispatchFetch(origin+path,{method:data===undefined?'GET':'POST',headers:{...(auth?{'Cf-Access-Jwt-Assertion':auth}:{}),...(data===undefined?{}:{Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrfToken || '','Idempotency-Key':key || crypto.randomUUID()}),...headers},body:data===undefined?undefined:JSON.stringify(data)});
  return response;
}
async function json(path,options){const r=await request(path,options);const data=await r.json();return{status:r.status,data,headers:r.headers};}
async function apply(file){
  const source=await readFile(new URL(file,root),'utf8');let chunk='',trigger=false;
  for(const line of source.split(/\r?\n/)){
    if(!line.trim() || line.trim().startsWith('--'))continue;
    chunk+=line+'\n';if(/^CREATE TRIGGER/i.test(chunk.trim()))trigger=true;
    if((trigger && line.trim()==='END;') || (!trigger && /;\s*$/.test(line))){await db.prepare(chunk).run();chunk='';trigger=false;}
  }
  assert.equal(chunk.trim(),'');
}
async function settle(){await new Promise(resolve=>setTimeout(resolve,150));}
before(async()=>{
  keys=await webcrypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  jwk={...await webcrypto.subtle.exportKey('jwk',keys.publicKey),kid:'test-key',alg:'RS256',use:'sig'};
  const bundle=await readFile(new URL('.wrangler/admin-worker.js',root));
  const boundary=bundle.toString().split('\r\n')[0].slice(2);
  const form=await new Response(bundle,{headers:{'Content-Type':'multipart/form-data; boundary='+boundary}}).formData();
  const worker=[...form.values()].find(x=>typeof x!=='string');assert.ok(worker);
  const options={name:'loza',modules:true,script:await worker.text(),compatibilityDate:'2026-10-22',d1Databases:['DB'],bindings:env,
    serviceBindings:{ASSETS:async request=>{
      const path=new URL(request.url).pathname;
      if(!['/','/index.html','/admin.js','/admin.css','/storefront.js','/storefront.css','/support.js','/turnstile-loader.js'].includes(path))return new Response('Not found',{status:404});
      const file=path==='/'?'index.html':path.slice(1);return new Response(await readFile(new URL(file,root)),{headers:{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'}});
    }},outboundService:async request=>{
      const url=new URL(request.url);
      if(url.href===issuer+'/cdn-cgi/access/certs')return Response.json({keys:[jwk]});
      if(url.hostname==='challenges.cloudflare.com'){const input=await request.json();return Response.json({success:true,action:input.response==='support-fixture'?'loza_support':'loza_checkout',hostname:new URL(origin).hostname});}
      if(url.hostname==='api.telegram.org'){
        calls++;const payload=await request.json();sent.push(payload);
        if(telegramMode==='429')return Response.json({ok:false,error_code:429,parameters:{retry_after:1}},{status:429});
        if(telegramMode==='uncertain')return new Response('gateway unavailable',{status:502});
        return Response.json({ok:true,result:{message_id:calls}});
      }
      throw new Error('Unexpected outbound host');
    }};
  mf=new Miniflare(convertV4MiniflareOptions?convertV4MiniflareOptions(options):options);
  db=await mf.getD1Database('DB');
  if(process.env.LOZA_PRODUCTION_SCHEMA_FILE){
    // Schema only, read from Production metadata; no customer/order/bank rows.
    const schema=JSON.parse(await readFile(process.env.LOZA_PRODUCTION_SCHEMA_FILE,'utf8'));
    for(const kind of ['table','index','trigger'])for(const entry of schema){
      if(entry.type===kind && entry.sql)await db.prepare(entry.sql).run();
    }
  }else{
    await db.prepare("CREATE TABLE orders(id TEXT PRIMARY KEY, amount_kop INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending')").run();
    await db.prepare('CREATE TABLE mono_events(transaction_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,amount_kop INTEGER NOT NULL,currency_code INTEGER NOT NULL,description TEXT,is_hold INTEGER NOT NULL DEFAULT 0)').run();
  }
  await db.prepare("INSERT INTO orders(id,amount_kop,status) VALUES('LEGACY-1',10000,'pending')").run();
  await db.prepare("INSERT INTO mono_events(transaction_id,account_id,amount_kop,currency_code,description,is_hold) VALUES('bank-existing','fixture-account',10000,980,'isolated fixture',0)").run();
  await apply('migrations/0002_store_cart.sql');await apply('migrations/0003_admin_telegram.sql');await apply('migrations/0003_admin_telegram.sql');await apply('migrations/0004_catalog_107.sql');await apply('migrations/0004_catalog_107.sql');
  await db.prepare("INSERT INTO orders(id,amount_kop,status) VALUES('LEGACY-CANCELLED',10000,'cancelled')").run();
  await db.prepare("INSERT INTO admin_stock_returns(order_id) VALUES('LEGACY-CANCELLED')").run();
  await apply('migrations/0005_manual_availability.sql');await apply('migrations/0005_manual_availability.sql');
  await apply('migrations/0007_stock_inventory.sql');await apply('migrations/0008_manual_catalog_support.sql');await apply('migrations/0008_manual_catalog_support.sql');
  token=await jwt();const session=await json('/api/admin/session');assert.equal(session.status,200);csrf=session.data.csrfToken;
});
after(async()=>{if(mf)await mf.dispose();});
beforeEach(async()=>{telegramMode='ok';await db.prepare('DELETE FROM checkout_rate_limits').run();});

test('all 107 PDF rows, 84 exact prices and 28 kishmish markers survive; unconfirmed prices cannot be bought',async()=>{
  const source=JSON.parse(await readFile(new URL('server/catalog-source.json',root),'utf8'));
  const response=await json('/api/products',{auth:null});assert.equal(response.status,200);
  const catalog=response.data.products;assert.equal(catalog.length,107);
  assert.equal(catalog.filter(p=>p.priceKop!==null).length,84);assert.equal(catalog.filter(p=>p.details.kishmish).length,28);
  for(const expected of source){const p=catalog.find(p=>p.id===expected.id);assert.ok(p);assert.equal(p.name,expected.name);assert.deepEqual(p.details,expected.details);assert.equal(p.priceKop,expected.priceKop);assert.equal(p.priceConfirmed,false);assert.equal(p.available,false);assert.equal(Object.hasOwn(p,'stock'),false);}
  for(const id of ['grape-demo','loza-001','loza-002'])assert.equal((await json('/api/cart/quote',{auth:null,data:{items:[{productId:id,quantity:1}]}})).status,409);
  await assert.rejects(db.prepare("UPDATE products SET available=1,stock=10 WHERE id='loza-002'").run(),/LOZA_(PRICE_NOT_CONFIRMED|MANUAL_STOCK)/);
  const products=(await json('/api/admin/products')).data.products;
  for(const id of ['loza-002','loza-004']){
    const p=products.find(p=>p.id===id);
    const input={version:p.version,name:p.name,priceKop:p.price_kop,available:true,priceConfirmed:false,characteristicsConfirmed:false,details:p.details};
    assert.equal((await json('/api/admin/products/'+id,{data:input})).status,200);
    assert.equal((await json('/api/cart/quote',{data:{items:[{productId:id,quantity:1}]}})).status,409);
    const version=(await db.prepare('SELECT version FROM admin_product_versions WHERE product_id=?').bind(id).first()).version;
    assert.equal((await json('/api/admin/products/'+id,{data:{...input,version,priceConfirmed:true}})).status,200);
  }
});

test('private HTML and every admin API fail closed without a verified Access JWT',async()=>{
  for(const path of ['/admin','/admin/','/api/admin/session','/api/admin/orders','/api/admin/telegram','/api/admin/support']){
    const r=await request(path,{auth:null});assert.equal(r.status,403,path);assert.match(r.headers.get('Cache-Control'),/no-store/);
  }
  for(const bad of [await jwt({email:'outsider@example.test'}),await jwt({aud:['b'.repeat(64)]}),await jwt({iss:'https://evil.test'}),await jwt({exp:1}),await jwt({}, {alg:'HS256'}),token.slice(0,-12)+'wrong']){
    assert.equal((await request('/api/admin/session',{auth:bad})).status,403);
  }
  assert.equal((await request('/admin')).status,200);
  assert.equal((await request('/api/admin/session',{auth:null,headers:{'Cf-Access-Authenticated-User-Email':admin}})).status,403);
});
test('every administrative mutation requires signed Access identity and CSRF before side effects',async()=>{
  const before=await db.prepare('SELECT COUNT(*) n FROM admin_mutations').first(),outbox=await db.prepare('SELECT COUNT(*) n FROM telegram_outbox').first();
  const routes=['products/loza-002','products/loza-002/availability','orders/LEGACY-1/status','telegram/settings','telegram/test','telegram/retry','catalog/preview','catalog/import','support/SUP-00000000-0000-0000-0000-000000000000/status','support/SUP-00000000-0000-0000-0000-000000000000/retry'];
  for(const route of routes){
    for(const options of [{auth:null},{auth:'untrusted-jwt'},{auth:await jwt({email:'outsider@example.test'})},{csrfToken:''},{headers:{Origin:'https://evil.test'}}]){
      const response=await request('/api/admin/'+route,{data:{},...options});assert.equal(response.status,403,route);assert.match(response.headers.get('Cache-Control'),/no-store/);
    }
  }
  for(const route of ['','dashboard','products','orders/LEGACY-1','audit','catalog/export','unknown-route']){
    assert.equal((await request('/api/admin/'+route,{auth:null})).status,403,route);
  }
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM admin_mutations').first()).n,before.n);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM telegram_outbox').first()).n,outbox.n);
});
test('public catalog, cart quote and checkout config work without monobank configuration',async()=>{
  assert.equal(env.MONO_TOKEN,undefined);assert.equal(env.MONO_WEBHOOK_KEY,undefined);
  for(const path of ['/api/products','/api/store/config']){
    const result=await json(path,{auth:null});assert.equal(result.status,200);assert.equal(result.data.paymentsEnabled,false);
    if(path.endsWith('/config'))assert.equal(result.data.checkoutAvailable,true);
  }
  const quoted=await json('/api/cart/quote',{auth:null,data:{items:[{productId:'loza-002',quantity:1}]}});
  assert.equal(quoted.status,200);assert.equal(quoted.data.amountKop,15000);assert.equal(quoted.data.paymentsEnabled,false);
});
test('client assets and private/public responses never contain server secret values',async()=>{
  const hidden=['ADMIN_CSRF_SECRET','CHECKOUT_SECURITY_KEY','TURNSTILE_SECRET_KEY','TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID'];
  for(const path of ['/admin','/admin.js','/admin.css','/storefront.js','/storefront.css','/support.js','/turnstile-loader.js','/api/products','/api/store/config','/api/admin/session','/api/admin/dashboard','/api/admin/products','/api/admin/orders','/api/admin/audit','/api/admin/telegram','/api/admin/support']){
    const response=await request(path),text=await response.text();assert.equal(response.status,200,path);
    for(const key of hidden)assert.ok(!text.includes(env[key]),path+' exposed '+key);
    if(path.startsWith('/api/admin') || path==='/admin')assert.match(response.headers.get('Cache-Control'),/no-store/);
  }
});
test('CSRF is required and bound to verified JWT + exact origin',async()=>{
  for(const options of [{csrfToken:''},{headers:{Origin:'https://evil.test'}},{auth:await jwt({sub:'another-sub'})}]){
    const r=await request('/api/admin/telegram/test',{data:{},...options});assert.equal(r.status,403);
  }
});
test('migration is repeatable and preserves legacy orders and bank events',async()=>{
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM mono_events WHERE transaction_id='bank-existing'").first()).n,1);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM orders WHERE id='LEGACY-1'").first()).n,1);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM products').first()).n,110);
  const search=await json('/api/admin/products?q='+encodeURIComponent('аватар'));
  assert.ok(search.data.products.some(p=>p.name==='Аватар'));
});
let orderId;
const checkout={items:[{productId:'loza-002',quantity:2}],customer:{name:'Preview Buyer',phone:'+380991234567'},delivery:{city:'Preview City',method:'nova_poshta',branch:'Private delivery 55'},comment:'Private comment',turnstileToken:'isolated-fixture'};
test('order commit queues one message; concurrent replay never creates duplicate orders/events',async()=>{
  const key=crypto.randomUUID();const response=await json('/api/orders/create',{data:{...checkout,amountKop:1},key});assert.equal(response.status,201);orderId=response.data.orderId;assert.equal(response.data.amountKop,30000);
  await Promise.all([json('/api/orders/create',{data:checkout,key}),json('/api/orders/create',{data:checkout,key})]);await settle();
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM order_checkout').first()).n,1);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM telegram_outbox WHERE order_id=?").bind(orderId).first()).n,1);
  const event=await db.prepare('SELECT state,message_id FROM telegram_outbox WHERE order_id=?').bind(orderId).first();assert.equal(event.state,'sent');
  const text=sent.find(x=>x.text.includes(orderId))?.text;assert.ok(text);assert.match(text,/× 2/);assert.match(text,/300.00 грн/);
  for(const pii of ['Preview Buyer','380991234567','Preview City','Private delivery','Private comment'])assert.ok(!text.includes(pii));
  assert.equal(sent.filter(x=>x.text.includes(orderId)).length,1);
});
test('optimistic product updates reject stale versions and SQL injection is data',async()=>{
  const row=await db.prepare("SELECT p.*,v.version FROM products p JOIN admin_product_versions v ON v.product_id=p.id WHERE p.id='loza-002'").first();
  const payload={version:row.version,name:"Grape'); DROP TABLE orders; --",priceKop:50000,priceConfirmed:true,characteristicsConfirmed:true,available:true,details:{...JSON.parse(row.details_json),color:'<img src=x onerror=alert(1)>'}};
  assert.equal((await json('/api/admin/products/loza-002',{data:payload})).status,200);
  assert.equal((await json('/api/admin/products/loza-002',{data:payload})).status,409);
  assert.equal((await json('/api/admin/products/loza-002',{data:{...payload,priceKop:0}})).status,400);
  assert.ok((await db.prepare('SELECT COUNT(*) n FROM orders').first()).n>=2);
});
test('cancellation and its replay never change availability or historical stock; stale changes are rejected',async()=>{
  const before=(await db.prepare("SELECT stock FROM products WHERE id='loza-002'").first()).stock;
  const version=(await db.prepare('SELECT version FROM admin_order_versions WHERE order_id=?').bind(orderId).first()).version;
  const key=crypto.randomUUID();const payload={version,status:'cancelled'};
  const replies=await Promise.all([json('/api/admin/orders/'+orderId+'/status',{data:payload,key}),json('/api/admin/orders/'+orderId+'/status',{data:payload,key})]);assert.ok(replies.every(r=>r.status===200));
  assert.equal((await db.prepare("SELECT stock FROM products WHERE id='loza-002'").first()).stock,before);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM admin_stock_returns WHERE order_id=?').bind(orderId).first()).n,0);
  assert.equal((await json('/api/admin/orders/'+orderId+'/status',{data:payload})).status,409);
  assert.equal((await json('/api/admin/orders/'+orderId+'/status',{data:{version:version+1,status:'confirmed'}})).status,409);
});
test('Telegram rejection persists order and retries only the outbox; confirmed sends are deduplicated',async()=>{
  telegramMode='429';const r=await json('/api/orders/create',{data:checkout});assert.equal(r.status,201);await settle();
  let event=await db.prepare('SELECT * FROM telegram_outbox WHERE order_id=?').bind(r.data.orderId).first();assert.equal(event.state,'retry');assert.equal(event.last_error,'TELEGRAM_429');
  assert.ok(await db.prepare('SELECT id FROM orders WHERE id=?').bind(r.data.orderId).first());
  telegramMode='ok';await db.prepare('UPDATE telegram_outbox SET next_attempt=0 WHERE id=?').bind(event.id).run();
  await json('/api/admin/telegram/retry',{data:{}});event=await db.prepare('SELECT state FROM telegram_outbox WHERE id=?').bind(event.id).first();assert.equal(event.state,'sent');
  const before=calls;await json('/api/admin/telegram/retry',{data:{}});assert.equal(calls,before);
});
test('ambiguous delivery is not resent automatically; test send requires admin and CSRF',async()=>{
  telegramMode='uncertain';const r=await json('/api/orders/create',{data:checkout});await settle();
  const event=await db.prepare('SELECT * FROM telegram_outbox WHERE order_id=?').bind(r.data.orderId).first();assert.equal(event.state,'uncertain');
  const before=calls;telegramMode='ok';await json('/api/admin/telegram/retry',{data:{}});assert.equal(calls,before);
  assert.equal((await json('/api/admin/telegram/retry',{data:{eventId:event.id,allowDuplicateRisk:false}})).status,409);
  assert.equal((await json('/api/admin/telegram/test',{auth:null,data:{}})).status,403);
  const key=crypto.randomUUID();assert.equal((await json('/api/admin/telegram/test',{data:{},key})).status,200);
  assert.equal((await json('/api/admin/telegram/test',{data:{},key})).status,200);
  assert.equal(sent.filter(x=>x.text.includes('Тестове повідомлення')).length,1);
});
test('private responses contain no token; public routes do not expose orders or source/backups',async()=>{
  const response=await request('/api/admin/orders/'+orderId),text=await response.text();assert.match(text,/380991234567/);assert.match(response.headers.get('Cache-Control'),/no-store/);
  for(const secret of [env.TELEGRAM_BOT_TOKEN,env.ADMIN_CSRF_SECRET,env.CHECKOUT_SECURITY_KEY])assert.ok(!text.includes(secret));
  for(const path of ['/grape-orders-backup.sql','/server/admin.js','/.env','/migrations/0003_admin_telegram.sql'])assert.equal((await request(path,{auth:null})).status,404,path);
  const catalog=await request('/api/products',{auth:null});assert.equal(catalog.status,200);assert.ok(!(await catalog.text()).includes('380991234567'));
});
test('full status lifecycle never changes manual availability or legacy quantity; audit records accepted changes',async()=>{
  const r=await json('/api/orders/create',{data:{...checkout,items:[{productId:'loza-004',quantity:1}]}});assert.equal(r.status,201);
  const id=r.data.orderId;let version=0;
  for(const status of ['confirmed','shipped','completed']){
    assert.equal((await json('/api/admin/orders/'+id+'/status',{data:{version,status}})).status,200);version++;
  }
  assert.equal((await db.prepare("SELECT stock FROM products WHERE id='loza-004'").first()).stock,0);
  assert.equal((await json('/api/admin/orders/'+id+'/status',{data:{version,status:'cancelled'}})).status,409);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM admin_audit_log WHERE target=?').bind(id).first()).n,3);
});
test('expired sending lease becomes uncertain and a failed checkout rolls back the outbox',async()=>{
  const count=(await db.prepare('SELECT COUNT(*) n FROM telegram_outbox').first()).n;
  await assert.rejects(db.batch([
    db.prepare("INSERT INTO orders(id,amount_kop,status) VALUES('ROLLBACK-TEST',50000,'pending')"),
    db.prepare("INSERT INTO telegram_outbox(event_key,order_id,kind) VALUES('order:ROLLBACK-TEST','ROLLBACK-TEST','order')"),
    db.prepare("INSERT INTO products(id,name,price_kop,available,stock,is_demo) VALUES('bad','bad',-1,1,0,0)")
  ]));
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM telegram_outbox').first()).n,count);
  assert.equal(await db.prepare("SELECT id FROM orders WHERE id='ROLLBACK-TEST'").first(),null);
  await db.prepare("INSERT INTO telegram_outbox(event_key,kind,state,lease_until) VALUES('test:crashed','test','sending',1)").run();
  const before=calls;await json('/api/admin/telegram/retry',{data:{}});assert.equal(calls,before);
  assert.equal((await db.prepare("SELECT state FROM telegram_outbox WHERE event_key='test:crashed'").first()).state,'uncertain');
});
test('admin UI works at desktop and smartphone widths without executing stored HTML',{skip:!process.env.LOZA_PLAYWRIGHT_MODULE},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.LOZA_PLAYWRIGHT_MODULE).href);
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const local=(await mf.ready).origin;
    for(const width of [1440,390]){
      const page=await browser.newPage({viewport:{width,height:900},extraHTTPHeaders:{'Cf-Access-Jwt-Assertion':token}});
      const errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.goto(local+'/admin');await page.getByRole('heading',{name:'Замовлення за статусами'}).waitFor();
      await page.getByRole('button',{name:'Товари',exact:true}).click();await page.getByRole('button',{name:'Редагувати',exact:true}).first().waitFor();
      const search=page.getByRole('searchbox');await search.fill("Grape');");await page.getByRole('cell',{name:"Grape'); DROP TABLE orders; --",exact:true}).waitFor();
      await page.waitForFunction(()=>document.querySelectorAll('tbody tr').length===1);
      await page.getByRole('button',{name:'Редагувати',exact:true}).click();await page.getByRole('dialog').waitFor();
      assert.equal(await page.getByRole('textbox',{name:'Колір',exact:true}).inputValue(),'<img src=x onerror=alert(1)>');
      await page.getByRole('button',{name:'Закрити',exact:true}).click();
      await page.getByRole('button',{name:'Telegram',exact:true}).click();await page.getByRole('heading',{name:'Черга сповіщень'}).waitFor();
      assert.deepEqual(errors,[]);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.getByRole('button',{name:'Огляд',exact:true}).click();await page.getByRole('heading',{name:'Замовлення за статусами'}).waitFor();
      await page.screenshot({path:new URL('.wrangler/admin-'+width+'.png',root).pathname.slice(process.platform==='win32'?1:0),fullPage:true});await page.close();
    }
  } finally {await browser.close();}
});

async function exported(){const r=await json('/api/admin/catalog/export');assert.equal(r.status,200);assert.equal(r.data.count,107);return r.data.csv;}
function changeCsv(csv,id,column,value){
  // Export quotes every field; fixture values here contain no separator/quotes.
  const lines=csv.split('\r\n'),headers=lines[0].replace(/^\uFEFF/,'').slice(1,-1).split('";"'),index=headers.indexOf(column);assert.ok(index>=0);
  const row=lines.findIndex(line=>line.startsWith('"'+id+'";'));assert.ok(row>0);
  const cells=lines[row].slice(1,-1).split('";"');cells[index]=value;lines[row]='"'+cells.join('";"')+'"';return lines.join('\r\n');
}
test('CSV full 107-row import is atomic, audited and replay safe; preserves source and legacy transactions',async()=>{
  let csv=await exported();csv=changeCsv(csv,'loza-001','price_uah','123,45');csv=changeCsv(csv,'loza-001','price_confirmed','1');csv=changeCsv(csv,'loza-001','available','1');
  const check=await json('/api/admin/catalog/preview',{data:{csv}});assert.equal(check.status,200);assert.equal(check.data.count,107);
  assert.equal(check.data.rows.find(row=>row.id==='loza-001').priceKop,12345);
  const before=(await db.prepare('SELECT COUNT(*) n FROM admin_audit_log').first()).n,key=crypto.randomUUID();
  const payload={csv,previewHash:check.data.previewHash};const r=await json('/api/admin/catalog/import',{data:payload,key});assert.equal(r.status,200);assert.equal(r.data.count,107);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM admin_audit_log').first()).n,before+107);
  const replay=await json('/api/admin/catalog/import',{data:payload,key});assert.equal(replay.status,200);assert.equal(replay.data.replayed,true);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM admin_audit_log').first()).n,before+107);
  const quote=await json('/api/cart/quote',{auth:null,data:{items:[{productId:'loza-001',quantity:2}],priceKop:1}});assert.equal(quote.status,200);assert.equal(quote.data.amountKop,24690);
  const row=await db.prepare("SELECT source_json FROM product_catalog WHERE product_id='loza-001'").first();assert.equal(JSON.parse(row.source_json).priceKop,null);
  await apply('migrations/0008_manual_catalog_support.sql');assert.equal((await db.prepare("SELECT price_kop,stock FROM products WHERE id='loza-001'").first()).price_kop,12345);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM orders WHERE id='LEGACY-1'").first()).n,1);assert.equal((await db.prepare('SELECT COUNT(*) n FROM mono_events').first()).n,1);
});
test('CSV rejects stale availability, invalid flags, unknown IDs, duplicate rows and tampering without partial writes',async()=>{
  const original=await exported(),check=await json('/api/admin/catalog/preview',{data:{csv:original}});assert.equal(check.status,200);
  const changed=(await json('/api/admin/products?q=loza-107')).data.products[0];
  assert.equal((await json('/api/admin/products/loza-107/availability',{data:{version:changed.version,inStock:true}})).status,200);
  const before=(await db.prepare('SELECT COUNT(*) n FROM admin_audit_log').first()).n;
  const stale=await json('/api/admin/catalog/import',{data:{csv:original,previewHash:check.data.previewHash}});assert.equal(stale.status,409);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM admin_audit_log').first()).n,before);
  for(const csv of [changeCsv(original,'loza-001','price_confirmed','2'),original.replace('"loza-001";','"grape-demo";'),original+original.split('\r\n')[1]+'\r\n',original.replace('"available"','"stock"')])assert.equal((await json('/api/admin/catalog/preview',{data:{csv}})).status,400);
  const fresh=await exported(),valid=await json('/api/admin/catalog/preview',{data:{csv:fresh}});assert.equal(valid.status,200);
  assert.equal((await json('/api/admin/catalog/import',{data:{csv:changeCsv(fresh,'loza-001','price_uah','1.00'),previewHash:valid.data.previewHash}})).status,400);
  // Force a stale version INSIDE the D1 import trigger: every earlier row must roll back.
  const {productInput}=await import('../server/admin.js');const {parseCsv}=await import('../server/catalog.js');
  const rows=parseCsv(fresh).map(r=>({id:r.product_id,version:Number(r.version),payload:productInput({name:r.name,version:Number(r.version),priceKop:r.price_uah?Math.round(Number(r.price_uah)*100):null,available:r.available==='1',priceConfirmed:r.price_confirmed==='1',characteristicsConfirmed:r.characteristics_confirmed==='1',details:{kishmish:r.kishmish==='1',...Object.fromEntries(['taste','ripening','color','berry','shape','frost'].map(k=>[k,r[k]]))}})}));
  rows.at(-1).version+=1;await assert.rejects(db.prepare('INSERT INTO catalog_imports(id,actor,payload_hash,rows_json,row_count) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),admin,'f'.repeat(64),JSON.stringify(rows),rows.length).run(),/LOZA_VERSION_CONFLICT/);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM admin_audit_log').first()).n,before);
});
test('authorized admin imports a CSV through the mobile dialog without photo fields',{skip:!process.env.LOZA_PLAYWRIGHT_MODULE},async()=>{
  const csv=await exported(),lines=csv.split('\r\n'),one=lines[0]+'\r\n'+lines.find(line=>line.startsWith('"loza-106";'))+'\r\n';
  const {chromium}=await import(pathToFileURL(process.env.LOZA_PLAYWRIGHT_MODULE).href),browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:390,height:900},extraHTTPHeaders:{'Cf-Access-Jwt-Assertion':token}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto((await mf.ready).origin+'/admin');await page.getByRole('heading',{name:'Замовлення за статусами'}).waitFor();
    await page.getByRole('button',{name:'Товари',exact:true}).click();await page.getByRole('button',{name:'Імпортувати CSV',exact:true}).click();
    await page.getByLabel('CSV-файл',{exact:true}).setInputFiles({name:'catalog.csv',mimeType:'text/csv',buffer:Buffer.from(one)});
    await page.getByRole('button',{name:'Перевірити файл',exact:true}).click();await page.getByText('Перевірено товарів: 1.',{exact:false}).waitFor();
    await page.getByRole('button',{name:'Застосувати імпорт',exact:true}).click();await page.getByText('Імпортовано 1 товарів.',{exact:false}).waitFor();
    assert.equal(await page.locator('#editor').count(),1);assert.equal(await page.locator('#editor').isVisible(),false);assert.deepEqual(errors,[]);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }finally{await browser.close();}
});
test('catalog cards, search, all filters and cart work without photos on desktop and mobile',{skip:!process.env.LOZA_PLAYWRIGHT_MODULE},async()=>{
  const source=JSON.parse(await readFile(new URL('server/catalog-source.json',root),'utf8')).find(p=>p.id==='loza-002');
  const product=(await json('/api/admin/products?q=loza-002')).data.products[0];
  assert.equal((await json('/api/admin/products/loza-002',{data:{version:product.version,name:source.name,priceKop:product.price_kop,available:true,priceConfirmed:true,characteristicsConfirmed:false,details:source.details}})).status,200);
  const {chromium}=await import(pathToFileURL(process.env.LOZA_PLAYWRIGHT_MODULE).href),browser=await chromium.launch({channel:'msedge',headless:true});
  try{for(const width of [1440,390,320]){
    const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'}),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto((await mf.ready).origin+'/');await page.waitForFunction(()=>document.querySelectorAll('#grid article').length===107);
    assert.equal(await page.locator('#grid img,#grid picture,#grid canvas').count(),0);assert.equal(await page.locator('.kishmish-badge').count(),28);
    assert.ok(await page.getByText('Немає в наявності',{exact:true}).count()>0);
    await page.locator('#search').fill('Академік');assert.equal(await page.locator('.catalog-price .price').innerText(),'Ціну уточнюйте');
    assert.equal(await page.getByRole('button',{name:'Замовлення недоступне',exact:true}).isEnabled(),false);
    assert.equal(((await page.locator('#grid').innerText()).match(/Немає в наявності/g)||[]).length,1);await page.locator('#resetFilters').click();
    await page.locator('#search').fill('Алвіка');assert.equal(await page.locator('#grid article').count(),1);await page.locator('#resetFilters').click();
    await page.locator('#kishmish').selectOption('1');assert.equal(await page.locator('#grid article').count(),28);await page.locator('#resetFilters').click();
    await page.locator('#ripening').selectOption('ранньо-середній');assert.equal(await page.locator('#grid article').count(),13);await page.locator('#resetFilters').click();
    await page.locator('#color').selectOption('темно-синій');assert.ok(await page.locator('#grid article').count()>0);assert.ok(await page.locator('#grid article').count()<107);await page.locator('#resetFilters').click();
    await page.locator('#priceMin').fill('120');await page.locator('#priceMax').fill('150');assert.ok(await page.locator('#grid article').count()>0);await page.locator('#resetFilters').click();
    await page.locator('#search').fill('Абажур');await page.getByRole('button',{name:'Додати до кошика',exact:true}).click();await page.locator('#openCart').click();await page.locator('#storeBuyer').waitFor();
    await page.waitForFunction(()=>document.querySelector('#storeTotal').textContent.includes('123'));assert.equal(await page.locator('#cartCount').textContent(),'1');
    await page.reload();await page.waitForFunction(()=>document.querySelector('#cartCount').textContent==='1');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
    await page.locator('#grid article').first().scrollIntoViewIfNeeded();await page.screenshot({path:new URL('.wrangler/catalog-'+width+'.png',root).pathname.slice(process.platform==='win32'?1:0),fullPage:false});await page.close();
  }}finally{await browser.close();}
});
test('admin mutation rate limits still reject excessive authenticated requests',async()=>{
  for(let i=0;i<30;i++)assert.notEqual((await request('/api/admin/catalog/preview',{data:{csv:'invalid'}})).status,429);
  assert.equal((await request('/api/admin/catalog/preview',{data:{csv:'invalid'}})).status,429);
});

async function adminProduct(id){return (await json('/api/admin/products?q='+id)).data.products.find(p=>p.id===id);}
function editPayload(p,changes={}){return {version:p.version,name:p.name,priceKop:p.price_kop,priceConfirmed:p.price_kop!==null && p.confirmed_price_kop===p.price_kop,characteristicsConfirmed:Boolean(p.characteristics_confirmed),available:p.inStock,details:p.details,...changes};}

test('manual availability is audited and independent of legacy quantity; price confirmation is still mandatory',async()=>{
  const id='loza-003';let p=await adminProduct(id);const before=await db.prepare('SELECT stock FROM products WHERE id=?').bind(id).first();
  assert.equal(Object.hasOwn(p,'stock'),false);
  assert.equal((await json('/api/admin/products/'+id+'/availability',{data:{version:p.version,inStock:true}})).status,200);
  p=await adminProduct(id);assert.equal(p.inStock,true);assert.equal(p.confirmed_price_kop,null);
  assert.equal((await json('/api/cart/quote',{data:{items:[{productId:id,quantity:1}]}})).status,409);
  for(const stock of [0,20,100])assert.equal((await json('/api/admin/products/'+id,{data:editPayload(p,{stock})})).status,400);
  assert.deepEqual(await db.prepare('SELECT stock FROM products WHERE id=?').bind(id).first(),before);
  const {parseCsv}=await import('../server/catalog.js');assert.equal(Object.hasOwn(parseCsv(await exported())[0],'stock'),false);
  assert.equal((await json('/api/admin/products/'+id+'/availability',{data:{version:p.version,inStock:false}})).status,200);
});
test('separate twenty-vine purchase limit does not reserve or deduct; cancellation/replays never alter availability',async()=>{
  const id='loza-005';let p=await adminProduct(id);
  assert.equal((await json('/api/admin/products/'+id,{data:editPayload(p,{priceKop:10000,priceConfirmed:true,available:true})})).status,200);
  const before=await db.prepare('SELECT p.stock,v.version,a.in_stock FROM products p JOIN admin_product_versions v ON v.product_id=p.id JOIN product_availability a ON a.product_id=p.id WHERE p.id=?').bind(id).first();
  assert.equal(before.stock,0);
  assert.equal((await json('/api/cart/quote',{data:{items:[{productId:id,quantity:21}]}})).status,400);
  const input={...checkout,items:[{productId:id,quantity:20}]},key=crypto.randomUUID();
  const responses=await Promise.all([json('/api/orders/create',{data:input,key}),json('/api/orders/create',{data:input})]);assert.deepEqual(responses.map(r=>r.status),[201,201]);
  assert.equal((await json('/api/orders/create',{data:input,key})).status,200);
  for(const r of responses){assert.equal(r.data.amountKop,200000);assert.equal((await json('/api/admin/orders/'+r.data.orderId+'/status',{data:{version:0,status:'cancelled'}})).status,200);}
  const after=await db.prepare('SELECT p.stock,v.version,a.in_stock FROM products p JOIN admin_product_versions v ON v.product_id=p.id JOIN product_availability a ON a.product_id=p.id WHERE p.id=?').bind(id).first();assert.deepEqual(after,before);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM order_stock_reservations').first()).n,0);
  assert.equal((await json('/api/products',{auth:null})).data.products.find(p=>p.id===id).available,true);
});
test('cached carts and SQL commit recheck manual availability and revoked price, without altering existing orders',async()=>{
  const id='loza-001',items=[{productId:id,quantity:2}];let p=await adminProduct(id);
  assert.equal((await json('/api/cart/quote',{data:{items}})).status,200);
  assert.equal((await json('/api/admin/products/'+id+'/availability',{data:{version:p.version,inStock:false}})).status,200);
  const count=(await db.prepare('SELECT COUNT(*) n FROM orders').first()).n;
  assert.equal((await json('/api/orders/create',{data:{...checkout,items}})).status,409);
  await assert.rejects(db.batch([
    db.prepare("INSERT INTO orders(id,amount_kop,status) VALUES('RACE-MANUAL',24690,'pending')"),
    db.prepare("INSERT INTO order_checkout(order_id,request_key_hash,payload_hash,buyer_name,phone,city,delivery_method,delivery_branch,comment,items_json,demo_only) VALUES('RACE-MANUAL',?,?,?,?,?,?,?,?,?,0)")
      .bind('a'.repeat(64),'b'.repeat(64),'Fixture Buyer','+380991234567','Fixture City','nova_poshta','Fixture branch','',JSON.stringify(items))
  ]),/LOZA_STOCK_UNAVAILABLE/);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM orders').first()).n,count);
  p=await adminProduct(id);assert.equal((await json('/api/admin/products/'+id,{data:editPayload(p,{available:true,priceConfirmed:false})})).status,200);
  assert.equal((await json('/api/orders/create',{data:{...checkout,items}})).status,409);
  p=await adminProduct(id);assert.equal((await json('/api/admin/products/'+id,{data:editPayload(p,{priceConfirmed:true})})).status,200);
});
test('all 107 manual switches preserve prices, original source, archived quantity and independent price confirmations',async()=>{
  const products=(await json('/api/admin/products')).data.products;assert.equal(products.length,107);
  for(const original of products){
    await db.prepare('DELETE FROM checkout_rate_limits').run();const legacy=await db.prepare('SELECT stock FROM products WHERE id=?').bind(original.id).first();
    for(const inStock of [!original.inStock,original.inStock]){
      const p=await adminProduct(original.id),key=crypto.randomUUID();assert.equal((await json('/api/admin/products/'+p.id+'/availability',{data:{version:p.version,inStock},key})).status,200);
      const saved=await adminProduct(p.id);assert.equal(saved.inStock,inStock);assert.equal(saved.price_kop,original.price_kop);assert.equal(saved.confirmed_price_kop,original.confirmed_price_kop);assert.deepEqual(saved.details,original.details);assert.deepEqual(saved.source,original.source);
      assert.deepEqual(await db.prepare('SELECT stock FROM products WHERE id=?').bind(p.id).first(),legacy);assert.equal((await db.prepare('SELECT COUNT(*) n FROM admin_audit_log WHERE mutation_id=?').bind(key).first()).n,1);
    }
  }
});
test('total purchase limit of 100 is enforced independently on server and inside the transaction',async()=>{
  const ids=['loza-006','loza-007','loza-008','loza-009','loza-010','loza-011'];
  for(const id of ids){const p=await adminProduct(id);assert.equal((await json('/api/admin/products/'+id,{data:editPayload(p,{priceKop:10000,priceConfirmed:true,available:true})})).status,200);}
  const items=ids.map(productId=>({productId,quantity:20}));
  assert.equal((await json('/api/cart/quote',{data:{items:items.slice(0,5)}})).status,200);
  assert.equal((await json('/api/orders/create',{data:{...checkout,items}})).status,400);
  await assert.rejects(db.batch([
    db.prepare("INSERT INTO orders(id,amount_kop,status) VALUES('LIMIT-100',1200000,'pending')"),
    db.prepare("INSERT INTO order_checkout(order_id,request_key_hash,payload_hash,buyer_name,phone,city,delivery_method,delivery_branch,comment,items_json,demo_only) VALUES('LIMIT-100',?,?,?,?,?,?,?,?,?,0)")
      .bind('7'.repeat(64),'8'.repeat(64),'Fixture Buyer','+380991234567','Fixture City','nova_poshta','Fixture branch','',JSON.stringify(items))
  ]),/LOZA_QUANTITY_LIMIT/);
  assert.equal(await db.prepare("SELECT id FROM orders WHERE id='LIMIT-100'").first(),null);
});
test('renaming preserves historical order snapshots, price approval and source; old versions cannot overwrite a rename',async()=>{
  const id='loza-006',p=await adminProduct(id),r=await json('/api/orders/create',{data:{...checkout,items:[{productId:id,quantity:1}]}});assert.equal(r.status,201);
  assert.equal((await json('/api/admin/products/'+id,{data:editPayload(p,{name:'Виправлена назва сорту'})})).status,200);
  const saved=await adminProduct(id);assert.equal(saved.name,'Виправлена назва сорту');assert.equal(saved.price_kop,p.price_kop);assert.equal(saved.confirmed_price_kop,p.confirmed_price_kop);assert.equal(saved.inStock,p.inStock);assert.deepEqual(saved.source,p.source);
  assert.equal((await db.prepare('SELECT product_name FROM order_items WHERE order_id=?').bind(r.data.orderId).first()).product_name,p.name);
  assert.equal((await json('/api/admin/products/'+id,{data:editPayload(p,{name:'stale'})})).status,409);
  assert.equal((await json('/api/admin/products?q='+encodeURIComponent('Виправлена'))).data.products[0].id,id);
});
test('mobile admin exposes name correction and manual availability, with no warehouse quantity input',{skip:!process.env.LOZA_PLAYWRIGHT_MODULE},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.LOZA_PLAYWRIGHT_MODULE).href),browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:390,height:900},extraHTTPHeaders:{'Cf-Access-Jwt-Assertion':token}});await page.goto((await mf.ready).origin+'/admin');await page.getByRole('button',{name:'Товари',exact:true}).click();
    const row=page.getByRole('row').filter({hasText:'Академік'});await row.getByRole('button',{name:'Редагувати',exact:true}).click();
    assert.equal(await page.getByRole('dialog').getByRole('spinbutton').count(),0);assert.equal(await page.getByRole('switch',{name:'В наявності',exact:true}).count(),1);await page.getByRole('button',{name:'Закрити',exact:true}).click();
    await row.getByRole('button',{name:'Змінити назву',exact:true}).click();await page.getByRole('textbox',{name:'Назва сорту',exact:true}).fill('Академік · назва перевірена');await page.getByRole('button',{name:'Зберегти назву',exact:true}).click();await page.getByRole('cell',{name:'Академік · назва перевірена',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }finally{await browser.close();}
});
test('mobile catalog/cart allow up to 20 despite archived stock=0, persist the cart and never display warehouse values',{skip:!process.env.LOZA_PLAYWRIGHT_MODULE},async()=>{
  const p=await adminProduct('loza-009');assert.equal((await db.prepare('SELECT stock FROM products WHERE id=?').bind(p.id).first()).stock,0);
  const {chromium}=await import(pathToFileURL(process.env.LOZA_PLAYWRIGHT_MODULE).href),browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:390,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto((await mf.ready).origin+'/');await page.waitForFunction(()=>document.querySelectorAll('#grid article').length===107);
    await page.locator('#search').fill(p.name);await page.getByRole('button',{name:'Додати до кошика',exact:true}).click();const plus=page.locator('#grid button[data-action="increase"]');for(let i=1;i<20;i++)await plus.click();assert.equal(await plus.isDisabled(),true);
    await page.reload();await page.waitForFunction(()=>document.querySelector('#cartCount').textContent==='20');await page.locator('#search').fill(p.name);assert.equal(await plus.isDisabled(),true);assert.equal(await page.locator('.store-stock').first().innerText(),'В наявності');assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

const supportData={contactType:'telegram',contact:'@fixture_support',reason:'checkout',message:'Fixture private support message about checkout.',turnstileToken:'support-fixture'};
let supportId;
test('support requires a callback contact and reason; validates phone/Telegram, body size, origin, content type and captcha action',async()=>{
  for(const change of [{contact:''},{contact:'https://evil.test'},{reason:'invented'},{contactType:'phone',contact:'123'},{message:'short'},{message:'a'.repeat(2001)},{website:'spam'}]){
    await db.prepare('DELETE FROM checkout_rate_limits').run();assert.equal((await json('/api/support/create',{auth:null,data:{...supportData,...change}})).status,400);
  }
  await db.prepare('DELETE FROM checkout_rate_limits').run();
  assert.equal((await json('/api/support/create',{auth:null,data:{...supportData,turnstileToken:'checkout-action-fixture'}})).status,400);
  assert.equal((await json('/api/support/create',{auth:null,data:supportData,headers:{Origin:'https://evil.test'}})).status,403);
  assert.equal((await json('/api/support/create',{auth:null,data:supportData,headers:{'Content-Type':'text/plain'}})).status,415);
});
test('support saves atomically, deduplicates retries and discloses no contact/message publicly or in Telegram',async()=>{
  const key=crypto.randomUUID();const r=await json('/api/support/create',{auth:null,data:supportData,key});assert.equal(r.status,201);supportId=r.data.ticketId;
  const replay=await json('/api/support/create',{auth:null,data:supportData,key});assert.equal(replay.status,200);assert.equal(replay.data.ticketId,supportId);
  assert.equal((await json('/api/support/create',{auth:null,data:{...supportData,message:'Different private message'},key})).status,409);await settle();
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM support_tickets WHERE id=?').bind(supportId).first()).n,1);
  const text=sent.filter(p=>p.text.includes(supportId));assert.equal(text.length,1);assert.match(text[0].text,/Нове звернення/);
  for(const pii of [supportData.contact,supportData.message]){assert.ok(!text[0].text.includes(pii));assert.ok(!JSON.stringify(r.data).includes(pii));}
  for(const path of ['/api/admin/support','/api/admin/support/'+supportId])assert.equal((await request(path,{auth:null})).status,403);
  assert.equal((await request('/api/support/'+supportId,{auth:null})).status,404);
  const privateTicket=await json('/api/admin/support/'+supportId);assert.equal(privateTicket.data.ticket.contact,supportData.contact);assert.match(privateTicket.headers.get('Cache-Control'),/no-store/);
});
test('support rate limit stops excessive requests and missing contact never creates a ticket',async()=>{
  for(let i=0;i<3;i++)assert.equal((await json('/api/support/create',{auth:null,data:{...supportData,contact:''}})).status,400);
  assert.equal((await json('/api/support/create',{auth:null,data:supportData})).status,429);
});
test('support statuses require admin and CSRF, use versions, are replay safe and record an audit history',async()=>{
  const path='/api/admin/support/'+supportId+'/status',data={version:0,status:'in_progress'},key=crypto.randomUUID();
  for(const options of [{auth:null},{csrfToken:''},{headers:{Origin:'https://evil.test'}}])assert.equal((await json(path,{data,...options})).status,403);
  assert.equal((await json(path,{data,key})).status,200);assert.equal((await json(path,{data,key})).status,200);assert.equal((await json(path,{data})).status,409);
  const r=await json('/api/admin/support/'+supportId);assert.equal(r.data.ticket.status,'in_progress');assert.equal(r.data.ticket.version,1);assert.equal(r.data.actions.length,1);assert.equal(r.data.actions[0].actor,admin);
});
test('Telegram support failures preserve tickets; confirmed rejection retries, uncertain delivery requires deliberate review',async()=>{
  telegramMode='429';const r=await json('/api/support/create',{data:{...supportData,contactType:'phone',contact:'099 123 45 67'}});assert.equal(r.status,201);await settle();
  const id=r.data.ticketId;let notification=await db.prepare('SELECT state FROM support_outbox WHERE ticket_id=?').bind(id).first();assert.equal(notification.state,'retry');
  telegramMode='ok';await db.prepare('UPDATE support_outbox SET next_attempt=0 WHERE ticket_id=?').bind(id).run();
  assert.equal((await json('/api/admin/support/'+id+'/retry',{data:{allowDuplicateRisk:false}})).status,200);notification=await db.prepare('SELECT state FROM support_outbox WHERE ticket_id=?').bind(id).first();assert.equal(notification.state,'sent');
  assert.equal((await json('/api/admin/support/'+id)).data.ticket.contact,'+380991234567');
  const before=calls;assert.equal((await json('/api/admin/support/'+id+'/retry',{data:{allowDuplicateRisk:false}})).status,200);assert.equal(calls,before);
  telegramMode='uncertain';const uncertain=await json('/api/support/create',{data:supportData});assert.equal(uncertain.status,201);await settle();const uid=uncertain.data.ticketId;telegramMode='ok';const count=calls;
  assert.equal((await json('/api/admin/support/'+uid+'/retry',{data:{allowDuplicateRisk:false}})).status,200);assert.equal(calls,count);assert.equal((await db.prepare('SELECT state FROM support_outbox WHERE ticket_id=?').bind(uid).first()).state,'uncertain');
});
test('mobile support form accepts a contact and reason; protected admin renders message text safely',{skip:!process.env.LOZA_PLAYWRIGHT_MODULE},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.LOZA_PLAYWRIGHT_MODULE).href),browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:390,height:900}});await page.addInitScript(()=>{window.turnstile={render(selector,options){document.querySelector(selector).textContent='Локальна тестова перевірка';options.callback('support-fixture');return 'fixture-widget';},remove(){},reset(){}};});
    await page.goto((await mf.ready).origin+'/');await page.getByRole('button',{name:'Написати в підтримку',exact:true}).first().click();await page.getByLabel('Причина звернення *',{exact:false}).selectOption('technical');
    assert.equal(await page.getByRole('button',{name:'Надіслати звернення',exact:true}).isEnabled(),true);
    await page.getByLabel('Контакт для відповіді *',{exact:true}).fill('@fixture_ui_support');await page.getByLabel('Що сталося? *',{exact:true}).fill('<img src=x onerror="window.__supportXss=1"> Fixture support message.');
    await page.getByRole('button',{name:'Надіслати звернення',exact:true}).click();await page.getByText('Звернення отримано. Номер:',{exact:false}).waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    const ticket=await db.prepare("SELECT id FROM support_tickets WHERE contact='@fixture_ui_support'").first();assert.ok(ticket);
    const adminPage=await browser.newPage({viewport:{width:390,height:900},extraHTTPHeaders:{'Cf-Access-Jwt-Assertion':token}});await adminPage.goto((await mf.ready).origin+'/admin');await adminPage.getByRole('button',{name:'Підтримка',exact:true}).click();const row=adminPage.getByRole('row').filter({hasText:'@fixture_ui_support'});await row.getByRole('button',{name:'Відкрити звернення',exact:true}).click();
    assert.equal(await adminPage.locator('#editor img').count(),0);assert.equal(await adminPage.evaluate(()=>window.__supportXss),undefined);await adminPage.getByText('Fixture support message.',{exact:false}).waitFor();assert.equal(await adminPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:new URL('.wrangler/support-mobile.png',root).pathname.slice(process.platform==='win32'?1:0),fullPage:false});
  }finally{await browser.close();}
});
