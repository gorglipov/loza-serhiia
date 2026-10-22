import {test,before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {fetchStatement} from '../server/mono-statement.js';
import {verifyBankWindow} from '../server/mono-bank-readonly.js';
import {saveHints,reconcileStatement,candidateOrders} from '../server/mono-monitor.js';
const {Miniflare,convertV4MiniflareOptions}=await import(pathToFileURL(process.env.LOZA_MINIFLARE_MODULE || './node_modules/miniflare/dist/src/index.js').href);
let mf,db;const epoch=Math.floor(Date.now()/1000),token='fixture-authorized-bank-token',account='fixture-owned-account';
const item=(id,extra={})=>({id,time:epoch-120,amount:50000,currencyCode:980,hold:false,...extra});
const params=()=>({token,account,from:epoch-3600,to:epoch});
async function migrate(){
  const sql=await readFile(new URL('../migrations/0006_mono_monitor.sql',import.meta.url),'utf8');let chunk='',trigger=false;
  for(const line of sql.split(/\r?\n/)){if(!line.trim() || line.trim().startsWith('--'))continue;chunk+=line+'\n';if(/^CREATE TRIGGER/i.test(chunk.trim()))trigger=true;
    if((trigger && line.trim()==='END;') || (!trigger && /;\s*$/.test(line))){await db.prepare(chunk).run();chunk='';trigger=false;}}
  assert.equal(chunk.trim(),'');
}
before(async()=>{
  const options={modules:true,script:'export default {fetch(){return new Response("isolated");}}',compatibilityDate:'2026-10-22',d1Databases:['DB']};
  mf=new Miniflare(convertV4MiniflareOptions?convertV4MiniflareOptions(options):options);db=await mf.getD1Database('DB');
  await db.prepare('CREATE TABLE loza_store_migrations(version TEXT PRIMARY KEY)').run();
  await db.prepare('CREATE TABLE mono_events(transaction_id TEXT PRIMARY KEY,account_id TEXT,amount_kop INTEGER,currency_code INTEGER,is_hold INTEGER,description TEXT)').run();
  await db.prepare('CREATE TABLE orders(id TEXT PRIMARY KEY,amount_kop INTEGER,status TEXT)').run();
  await db.prepare('CREATE TABLE order_checkout(order_id TEXT,created_at TEXT,demo_only INTEGER)').run();
  await db.prepare("INSERT INTO orders VALUES('REAL-FIXTURE-A',50000,'pending'),('REAL-FIXTURE-B',50000,'pending'),('OLD-FIXTURE',50000,'pending'),('CANCELLED',50000,'cancelled')").run();
  for(const id of ['REAL-FIXTURE-A','REAL-FIXTURE-B','CANCELLED'])await db.prepare("INSERT INTO order_checkout VALUES(?,datetime(?,'unixepoch'),0)").bind(id,epoch-600).run();
  await db.prepare("INSERT INTO order_checkout VALUES('OLD-FIXTURE',datetime(?,'unixepoch'),0)").bind(epoch-400000).run();
  await migrate();await migrate();
});
beforeEach(async()=>{
  // Only this isolated fixture database is cleared between scenarios.
  for(const table of ['mono_monitor_notifications','mono_monitor_transactions','mono_monitor_sync_lock','mono_events'])await db.prepare('DELETE FROM '+table).run();
});
after(async()=>{await mf?.dispose();});

test('official statement adapter sends X-Token only to the fixed bank origin and discards private extra fields',async()=>{
  let calls=0;const transport=async(url,options)=>{calls++;assert.equal(url,'https://api.monobank.ua/personal/statement/'+account+'/'+(epoch-3600)+'/'+epoch);assert.equal(options.headers['X-Token'],token);assert.equal(options.redirect,'manual');
    return Response.json([item('bank-001',{description:'PRIVATE_DESCRIPTION',counterName:'PRIVATE_NAME',counterIban:'PRIVATE_IBAN',balance:123456789}),item('bank-001')]);};
  const result=await fetchStatement({...params(),transport});assert.equal(calls,1);assert.equal(result.items.length,1);assert.deepEqual(Object.keys(result.items[0]),['id','time','amount','currencyCode','hold']);
  for(const privateData of ['PRIVATE_DESCRIPTION','PRIVATE_NAME','PRIVATE_IBAN','123456789',token])assert.ok(!JSON.stringify(result).includes(privateData));
});
test('invalid account, range, amount, timestamp, hold and inconsistent duplicates never become verified',async()=>{
  const noCall=async()=>{throw new Error('must not run');};
  for(const change of [{account:'0'},{account:'https://evil.test'},{token:'short'},{token:token+'\n'},{from:epoch-2682001},{to:epoch+400}])await assert.rejects(fetchStatement({...params(),...change,transport:noCall}));
  for(const rows of [[item('bad',{amount:1.5})],[item('bad',{hold:'false'})],[item('bad',{time:epoch+1})],[item('bad'),item('bad',{amount:1})]])await assert.rejects(fetchStatement({...params(),transport:async()=>Response.json(rows)}));
});
test('bank errors, redirects and malformed bodies are sanitized and do not expose response text or tokens',async()=>{
  for(const transport of [async()=>new Response(token,{status:401}),async()=>new Response(token,{status:302}),async()=>new Response(token),async()=>{throw new Error(token);}]){
    await assert.rejects(fetchStatement({...params(),transport}),error=>!error.message.includes(token) && !JSON.stringify(error).includes(token));
  }
  await assert.rejects(fetchStatement({...params(),transport:async()=>new Response(token,{status:429})}),error=>error.code==='MONO_BANK_RATE_LIMITED' && error.retryAfter===60);
});
test('webhook hints alone create no matches or messages; authorized statement gives suggestions without changing orders',async()=>{
  const original=(await db.prepare('SELECT * FROM orders ORDER BY id').all()).results;
  await db.prepare('INSERT INTO mono_events VALUES(?,?,?,?,?,?)').bind('bank-verified',account,50000,980,0,'PRIVATE_DESCRIPTION').run();
  await db.prepare('INSERT INTO mono_events VALUES(?,?,?,?,?,?)').bind('forged-only',account,50000,980,0,'untrusted webhook').run();
  let requested=0;await verifyBankWindow(db,{...params(),transport:async()=>{requested++;return Response.json([item('bank-verified')]);}});
  assert.equal(requested,1);const verified=await db.prepare("SELECT * FROM mono_monitor_transactions WHERE transaction_id='bank-verified'").first();
  assert.equal(verified.verification_state,'verified');const candidates=await candidateOrders(db,verified);assert.deepEqual(candidates.map(c=>c.id).sort(),['REAL-FIXTURE-A','REAL-FIXTURE-B']);
  const fake=await db.prepare("SELECT * FROM mono_monitor_transactions WHERE transaction_id='forged-only'").first();assert.equal(fake.verification_state,'not_found');assert.deepEqual(await candidateOrders(db,fake),[]);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM mono_monitor_notifications').first()).n,1);
  assert.deepEqual((await db.prepare('SELECT * FROM orders ORDER BY id').all()).results,original);
  const row=JSON.stringify(verified);assert.ok(!row.includes('PRIVATE_DESCRIPTION'));assert.ok(!row.includes(token));
});
test('failed bank authorization leaves hints unverified and no Telegram outbox entry',async()=>{
  await db.prepare('INSERT INTO mono_events VALUES(?,?,?,?,?,?)').bind('untrusted',account,50000,980,0,'PRIVATE_HINT').run();
  await assert.rejects(verifyBankWindow(db,{...params(),transport:async()=>new Response('PRIVATE_BANK_BODY',{status:403})}));
  const row=await db.prepare('SELECT * FROM mono_monitor_transactions').first();assert.equal(row.verification_state,'unverified');assert.equal(row.transaction_time,null);
  assert.deepEqual(await candidateOrders(db,row),[]);assert.equal((await db.prepare('SELECT COUNT(*) n FROM mono_monitor_notifications').first()).n,0);
});
test('global one-minute bank gate survives errors and prevents overlapping accounts or concurrent requests',async()=>{
  let calls=0;const transport=async()=>{calls++;await new Promise(r=>setTimeout(r,30));return Response.json([]);};
  const result=await Promise.allSettled([verifyBankWindow(db,{...params(),transport}),verifyBankWindow(db,{...params(),account:'another-owned-account',transport})]);
  assert.equal(result.filter(x=>x.status==='fulfilled').length,1);assert.equal(calls,1);assert.equal(result.find(x=>x.status==='rejected').reason.code,'MONO_RATE_LIMITED');
  await assert.rejects(verifyBankWindow(db,{...params(),transport}),error=>error.code==='MONO_RATE_LIMITED');assert.equal(calls,1);
});
test('reconciliation is replay safe, uses composite account/transaction identity and rejects conflicting statements atomically',async()=>{
  const accountRef='a'.repeat(64),other='b'.repeat(64),input={accountRef,source:'bank',items:[item('same-bank-id')]};
  await saveHints(db,accountRef,[item('same-bank-id')],'bank');assert.equal((await db.prepare('SELECT verification_state FROM mono_monitor_transactions').first()).verification_state,'unverified');
  await reconcileStatement(db,input);await reconcileStatement(db,input);await reconcileStatement(db,{...input,accountRef:other});
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM mono_monitor_transactions').first()).n,2);assert.equal((await db.prepare('SELECT COUNT(*) n FROM mono_monitor_notifications').first()).n,2);
  await assert.rejects(reconcileStatement(db,{...input,items:[item('bad'),item('bad',{amount:100})]}));assert.equal((await db.prepare('SELECT COUNT(*) n FROM mono_monitor_transactions').first()).n,2);
  await reconcileStatement(db,{...input,items:[item('same-bank-id',{hold:true})]});assert.equal((await db.prepare('SELECT state FROM mono_monitor_notifications WHERE transaction_ref=(SELECT id FROM mono_monitor_transactions WHERE account_ref=?)').bind(accountRef).first()).state,'failed');
});
test('potentially truncated windows do not mark absent hints as failed verification',async()=>{
  const accountRef='c'.repeat(64),hints=[item('not-in-page')];await saveHints(db,accountRef,hints,'bank');
  await reconcileStatement(db,{accountRef,source:'bank',items:[],hints,possiblyTruncated:true});assert.equal((await db.prepare('SELECT verification_state FROM mono_monitor_transactions').first()).verification_state,'unverified');
  const response=await fetchStatement({...params(),transport:async()=>Response.json(Array.from({length:500},(_,i)=>item('page-'+i)))});assert.equal(response.possiblyTruncated,true);
});
test('malformed webhook hints cannot block an authorized statement and Retry-After extends the persisted gate',async()=>{
  await db.prepare('INSERT INTO mono_events VALUES(?,?,?,?,?,?)').bind('invalid untrusted ID',account,50000,980,0,'ignored').run();
  await verifyBankWindow(db,{...params(),transport:async()=>Response.json([item('trusted')])});
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM mono_monitor_transactions').first()).n,1);
  await db.prepare('DELETE FROM mono_monitor_sync_lock').run();
  await assert.rejects(verifyBankWindow(db,{...params(),transport:async()=>new Response('PRIVATE_ERROR',{status:429,headers:{'Retry-After':'300'}})}),e=>e.code==='MONO_BANK_RATE_LIMITED');
  assert.ok((await db.prepare('SELECT next_sync_at FROM mono_monitor_sync_lock').first()).next_sync_at>=Math.floor(Date.now()/1000)+299);
});
test('a notification storage failure rolls back the entire verified transaction batch',async()=>{
  await db.prepare("CREATE TRIGGER fixture_mono_failure BEFORE INSERT ON mono_monitor_notifications BEGIN SELECT RAISE(ABORT,'FIXTURE_STORAGE_FAILURE'); END").run();
  try{
    await assert.rejects(reconcileStatement(db,{accountRef:'d'.repeat(64),source:'bank',items:[item('must-rollback')]}),/FIXTURE_STORAGE_FAILURE/);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM mono_monitor_transactions').first()).n,0);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM mono_monitor_notifications').first()).n,0);
  }finally{await db.prepare('DROP TRIGGER fixture_mono_failure').run();}
});
