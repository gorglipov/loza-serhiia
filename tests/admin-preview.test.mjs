// Runs the real compiled Pages worker + isolated Miniflare D1. No remote DB/bot.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {webcrypto} from 'node:crypto';
const {Miniflare,convertV4MiniflareOptions}=await import(pathToFileURL(process.env.LOZA_MINIFLARE_MODULE || './node_modules/miniflare/dist/src/index.js').href);
const root=new URL('../',import.meta.url),origin='https://preview.loza.test';
let mf,db,keys,jwk,csrf,token;
let telegramMode='ok',sent=[],calls=0;
const audience='a'.repeat(64),admin='owner@example.test';
const env={ACCESS_TEAM_DOMAIN:'https://loza-test.cloudflareaccess.com',ACCESS_AUD:audience,ADMIN_EMAILS:admin,ADMIN_CSRF_SECRET:'fixture-csrf-secret-'.repeat(4),CHECKOUT_SECURITY_KEY:'fixture-checkout-secret-'.repeat(4),TURNSTILE_SITE_KEY:'fixture-site-key',TURNSTILE_SECRET_KEY:'fixture-turnstile-secret',TELEGRAM_BOT_TOKEN:'12345:fixture_token',TELEGRAM_CHAT_ID:'123456'};
const b64=v=>Buffer.from(typeof v==='string'?v:JSON.stringify(v)).toString('base64url');
async function jwt(changes={},header={}) {
  const now=Math.floor(Date.now()/1000),h=b64({alg:'RS256',kid:'test-key',...header});
  const payload=b64({iss:env.ACCESS_TEAM_DOMAIN,aud:[audience],iat:now-10,exp:now+3600,type:'app',sub:'owner-sub',email:admin,...changes});
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
      if(!['/','/index.html','/admin.js','/admin.css','/storefront.js','/storefront.css'].includes(path))return new Response('Not found',{status:404});
      const file=path==='/'?'index.html':path.slice(1);return new Response(await readFile(new URL(file,root)),{headers:{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'}});
    }},outboundService:async request=>{
      const url=new URL(request.url);
      if(url.href===env.ACCESS_TEAM_DOMAIN+'/cdn-cgi/access/certs')return Response.json({keys:[jwk]});
      if(url.hostname==='challenges.cloudflare.com')return Response.json({success:true,action:'loza_checkout',hostname:new URL(origin).hostname});
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
  await db.prepare("CREATE TABLE orders(id TEXT PRIMARY KEY, amount_kop INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending')").run();
  await db.prepare('CREATE TABLE mono_events(id TEXT PRIMARY KEY)').run();
  await db.prepare("INSERT INTO orders VALUES('LEGACY-1',10000,'pending')").run();
  await db.prepare("INSERT INTO mono_events VALUES('bank-existing')").run();
  await apply('migrations/0002_store_cart.sql');await apply('migrations/0003_admin_telegram.sql');await apply('migrations/0003_admin_telegram.sql');
  token=await jwt();const session=await json('/api/admin/session');assert.equal(session.status,200);csrf=session.data.csrfToken;
});
after(async()=>{if(mf)await mf.dispose();});
test('private HTML and every admin API fail closed without a verified Access JWT',async()=>{
  for(const path of ['/admin','/admin/','/api/admin/session','/api/admin/orders','/api/admin/telegram']){
    const r=await request(path,{auth:null});assert.equal(r.status,403,path);assert.match(r.headers.get('Cache-Control'),/no-store/);
  }
  for(const bad of [await jwt({email:'outsider@example.test'}),await jwt({aud:['b'.repeat(64)]}),await jwt({iss:'https://evil.test'}),await jwt({exp:1}),await jwt({}, {alg:'HS256'}),token.slice(0,-12)+'wrong']){
    assert.equal((await request('/api/admin/session',{auth:bad})).status,403);
  }
  assert.equal((await request('/admin')).status,200);
  assert.equal((await request('/api/admin/session',{auth:null,headers:{'Cf-Access-Authenticated-User-Email':admin}})).status,403);
});
test('CSRF is required and bound to verified JWT + exact origin',async()=>{
  for(const options of [{csrfToken:''},{headers:{Origin:'https://evil.test'}},{auth:await jwt({sub:'another-sub'})}]){
    const r=await request('/api/admin/telegram/test',{data:{},...options});assert.equal(r.status,403);
  }
});
test('migration is repeatable and preserves legacy orders and bank events',async()=>{
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM mono_events WHERE id='bank-existing'").first()).n,1);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM orders WHERE id='LEGACY-1'").first()).n,1);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM products').first()).n,110);
  const search=await json('/api/admin/products?q='+encodeURIComponent('аватар'));
  assert.ok(search.data.products.some(p=>p.name==='Аватар'));
});
let orderId;
const checkout={items:[{productId:'grape-demo',quantity:2}],customer:{name:'Preview Buyer',phone:'+380991234567'},delivery:{city:'Preview City',method:'nova_poshta',branch:'Private delivery 55'},comment:'Private comment',turnstileToken:'isolated-fixture'};
test('order commit queues one message; concurrent replay never creates duplicate orders/events',async()=>{
  const key=crypto.randomUUID();const response=await json('/api/orders/create',{data:{...checkout,amountKop:1},key});assert.equal(response.status,201);orderId=response.data.orderId;assert.equal(response.data.amountKop,100000);
  await Promise.all([json('/api/orders/create',{data:checkout,key}),json('/api/orders/create',{data:checkout,key})]);await settle();
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM order_checkout').first()).n,1);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM telegram_outbox WHERE order_id=?").bind(orderId).first()).n,1);
  const event=await db.prepare('SELECT state,message_id FROM telegram_outbox WHERE order_id=?').bind(orderId).first();assert.equal(event.state,'sent');
  const text=sent.find(x=>x.text.includes(orderId))?.text;assert.ok(text);assert.match(text,/× 2/);assert.match(text,/1000.00 грн/);
  for(const pii of ['Preview Buyer','380991234567','Preview City','Private delivery','Private comment'])assert.ok(!text.includes(pii));
  assert.equal(sent.filter(x=>x.text.includes(orderId)).length,1);
});
test('optimistic product updates reject stale stock and SQL injection is data',async()=>{
  const row=await db.prepare("SELECT p.*,v.version FROM products p JOIN admin_product_versions v ON v.product_id=p.id WHERE p.id='grape-demo'").first();
  const payload={version:row.version,name:"Grape'); DROP TABLE orders; --",priceKop:50000,stock:row.stock,available:true,details:{color:'<img src=x onerror=alert(1)>'}};
  assert.equal((await json('/api/admin/products/grape-demo',{data:payload})).status,200);
  assert.equal((await json('/api/admin/products/grape-demo',{data:payload})).status,409);
  assert.equal((await json('/api/admin/products/grape-demo',{data:{...payload,priceKop:0}})).status,400);
  assert.ok((await db.prepare('SELECT COUNT(*) n FROM orders').first()).n>=2);
});
test('cancellation restores reserved inventory once; repeated/stale mutations are rejected',async()=>{
  const before=(await db.prepare("SELECT stock FROM products WHERE id='grape-demo'").first()).stock;
  const version=(await db.prepare('SELECT version FROM admin_order_versions WHERE order_id=?').bind(orderId).first()).version;
  const key=crypto.randomUUID();const payload={version,status:'cancelled'};
  const replies=await Promise.all([json('/api/admin/orders/'+orderId+'/status',{data:payload,key}),json('/api/admin/orders/'+orderId+'/status',{data:payload,key})]);assert.ok(replies.every(r=>r.status===200));
  assert.equal((await db.prepare("SELECT stock FROM products WHERE id='grape-demo'").first()).stock,before+2);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM admin_stock_returns WHERE order_id=?').bind(orderId).first()).n,1);
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
test('full status lifecycle preserves stock; audit records each accepted change',async()=>{
  const r=await json('/api/orders/create',{data:{...checkout,items:[{productId:'grape-demo-white',quantity:1}]}});assert.equal(r.status,201);
  const id=r.data.orderId;let version=0;
  for(const status of ['confirmed','shipped','completed']){
    assert.equal((await json('/api/admin/orders/'+id+'/status',{data:{version,status}})).status,200);version++;
  }
  assert.equal((await db.prepare("SELECT stock FROM products WHERE id='grape-demo-white'").first()).stock,39);
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
