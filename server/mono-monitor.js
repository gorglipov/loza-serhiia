import {StoreError,body,digest,json} from './checkout.js';
import {fetchStatement,statementItem} from './mono-statement.js';
import {monoFixtures} from './mono-fixtures.js';
import {telegramConfigured} from './telegram.js';
const now=()=>Math.floor(Date.now()/1000),uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail=()=>new StoreError('MONO_INVALID_INPUT','Перевірте дані моніторингу.');
// This release has NO live execution path. Even a configured MONO_TOKEN cannot enable it.
export function fixturePreview(request){
  const url=new URL(request.url),host=url.hostname;
  // Hash URLs may also belong to Production deployments. Allow only the dedicated branch alias.
  return host==='preview.loza.test' || host==='codex-mono-monitor-preview.loza-serhiia.pages.dev' ||
    (url.protocol==='http:' && ['localhost','127.0.0.1'].includes(host));
}
export function normalizedHints(hints){
  if(!Array.isArray(hints) || hints.length>500)throw fail();
  const result=[];
  for(const hint of hints){try{
    const item=statementItem({...hint,time:hint.time??1});result.push({...item,time:hint.time??null});
  }catch{/* A malformed, untrusted webhook must never prevent verification of the bank's statement. */}}
  return result;
}
export async function saveHints(database,accountRef,hints,source){
  if(!['fixture','bank'].includes(source) || !/^[a-f0-9]{64}$/.test(accountRef) || !Array.isArray(hints) || hints.length>500)throw fail();
  // One JSON-bound query, rather than one request per webhook, stays within D1 request limits.
  const rows=normalizedHints(hints).map(hint=>({...hint,rowId:crypto.randomUUID()}));
  await database.prepare(`INSERT OR IGNORE INTO mono_monitor_transactions
    (id,account_ref,transaction_id,amount_kop,currency_code,transaction_time,hold,verification_state,data_source)
    SELECT json_extract(j.value,'$.rowId'),?,json_extract(j.value,'$.id'),json_extract(j.value,'$.amount'),
    json_extract(j.value,'$.currencyCode'),json_extract(j.value,'$.time'),json_extract(j.value,'$.hold'),'unverified',?
    FROM json_each(?) j`).bind(accountRef,source,JSON.stringify(rows)).run();
}
export async function reconcileStatement(database,{accountRef,source,items,hints=[],possiblyTruncated=false}){
  if(!['fixture','bank'].includes(source) || !/^[a-f0-9]{64}$/.test(accountRef) || !Array.isArray(items) || items.length>500)throw fail();
  const normalized=new Map();for(const value of items){const item=statementItem(value);
    if(normalized.has(item.id) && JSON.stringify(normalized.get(item.id))!==JSON.stringify(item))throw fail();normalized.set(item.id,item);}
  hints=normalizedHints(hints);
  const hintMap=new Map(hints.map(hint=>[hint.id,hint])),rows=[];
  for(const item of normalized.values()){
    const hint=hintMap.get(item.id),mismatch=Boolean(hint && (hint.amount!==item.amount || hint.currencyCode!==item.currencyCode));
    const state=item.hold?'held':item.amount<=0 || item.currencyCode!==980?'excluded':mismatch?'mismatch':'verified';
    rows.push({...item,rowId:crypto.randomUUID(),noticeId:crypto.randomUUID(),state,mismatch:mismatch?1:0});
  }
  const encoded=JSON.stringify(rows),statements=[database.prepare(`INSERT INTO mono_monitor_transactions
    (id,account_ref,transaction_id,amount_kop,currency_code,transaction_time,hold,verification_state,data_source,hint_mismatch,verified_at,updated_at)
    SELECT json_extract(j.value,'$.rowId'),?,json_extract(j.value,'$.id'),json_extract(j.value,'$.amount'),json_extract(j.value,'$.currencyCode'),
      json_extract(j.value,'$.time'),json_extract(j.value,'$.hold'),json_extract(j.value,'$.state'),?,json_extract(j.value,'$.mismatch'),?,?
    FROM json_each(?) j WHERE 1 ON CONFLICT(account_ref,transaction_id) DO UPDATE SET
      amount_kop=excluded.amount_kop,currency_code=excluded.currency_code,transaction_time=excluded.transaction_time,
      hold=excluded.hold,verification_state=excluded.verification_state,hint_mismatch=excluded.hint_mismatch,
      verified_at=excluded.verified_at,updated_at=excluded.updated_at`).bind(accountRef,source,now(),now(),encoded),
    database.prepare(`INSERT OR IGNORE INTO mono_monitor_notifications(id,transaction_ref)
      SELECT json_extract(j.value,'$.noticeId'),t.id FROM json_each(?) j JOIN mono_monitor_transactions t
      ON t.transaction_id=json_extract(j.value,'$.id') AND t.account_ref=?
      WHERE t.verification_state='verified' AND t.amount_kop>0 AND t.currency_code=980 AND t.hold=0`).bind(encoded,accountRef)];
  if(!possiblyTruncated)statements.push(database.prepare(`UPDATE mono_monitor_transactions
    SET verification_state='not_found',updated_at=? WHERE account_ref=? AND transaction_id IN(SELECT value FROM json_each(?))
    AND verification_state IN('unverified','not_found')`).bind(now(),accountRef,JSON.stringify(hints.filter(h=>!normalized.has(h.id)).map(h=>h.id))));
  statements.push(database.prepare(`UPDATE mono_monitor_notifications SET state='failed',last_error='MONO_NOT_VERIFIED'
    WHERE state IN('queued','retry') AND transaction_ref IN(SELECT id FROM mono_monitor_transactions
    WHERE account_ref=? AND verification_state<>'verified')`).bind(accountRef));
  await database.batch(statements);
  const counts=await database.prepare('SELECT verification_state state,COUNT(*) count FROM mono_monitor_transactions WHERE account_ref=? GROUP BY verification_state').bind(accountRef).all();
  return {counts:counts.results,possiblyTruncated};
}
export async function candidateOrders(database,transaction,fixtureOrders=null){
  if(transaction.verification_state!=='verified' || transaction.amount_kop<=0 || transaction.currency_code!==980 || transaction.hold)return [];
  if(transaction.data_source==='fixture' && fixtureOrders)return fixtureOrders.filter(o=>o.amount_kop===transaction.amount_kop && ['pending','confirmed'].includes(o.status) &&
    o.created_at>=transaction.transaction_time-259200 && o.created_at<=transaction.transaction_time+300).slice(0,21);
  if(transaction.data_source==='fixture')return (await database.prepare(`SELECT id,amount_kop,status,created_at FROM mono_monitor_fixture_orders
    WHERE amount_kop=? AND created_at BETWEEN ? AND ? AND status IN('pending','confirmed') ORDER BY id LIMIT 21`)
    .bind(transaction.amount_kop,transaction.transaction_time-259200,transaction.transaction_time+300).all()).results;
  // Only metadata, no buyer contacts. Amount + time are suggestions, never proof of an order payment.
  return (await database.prepare(`SELECT o.id,o.amount_kop,o.status,c.created_at FROM orders o JOIN order_checkout c ON c.order_id=o.id
    WHERE o.amount_kop=? AND o.status IN('pending','confirmed') AND c.demo_only=0
    AND CAST(strftime('%s',c.created_at) AS INTEGER) BETWEEN ? AND ? ORDER BY c.created_at DESC LIMIT 21`)
    .bind(transaction.amount_kop,transaction.transaction_time-259200,transaction.transaction_time+300).all()).results;
}
export async function syncFixture(database,request,actor,id){
  if(!fixturePreview(request))throw new StoreError('MONO_LIVE_DISABLED','Живий моніторинг заблокований. Ця версія доступна лише у Preview.',403);
  const previous=await database.prepare('SELECT * FROM mono_monitor_runs WHERE id=?').bind(id).first();
  if(previous){
    if(previous.actor!==actor)throw new StoreError('MUTATION_CONFLICT','Цей ключ уже використано.',409);
    return {replayed:true,state:previous.state,summary:previous.summary_json?JSON.parse(previous.summary_json):null,errorCode:previous.error_code};
  }
  const inserted=await database.prepare("INSERT OR IGNORE INTO mono_monitor_runs(id,actor,state,started_at) VALUES(?,?,'running',?)").bind(id,actor,now()).run();
  if(inserted.meta.changes===0)return syncFixture(database,request,actor,id);
  const accountRef=await digest('loza-mono-fixture-account'),lease=crypto.randomUUID();
  const lock=await database.prepare(`INSERT INTO mono_monitor_sync_lock(account_ref,next_sync_at,lease_until,lease_token) VALUES(?,?,?,?)
    ON CONFLICT(account_ref) DO UPDATE SET next_sync_at=excluded.next_sync_at,lease_until=excluded.lease_until,lease_token=excluded.lease_token
    WHERE mono_monitor_sync_lock.next_sync_at<=? AND mono_monitor_sync_lock.lease_until<=? RETURNING lease_token`)
    .bind(accountRef,now()+60,now()+120,lease,now(),now()).first();
  if(!lock){
    await database.prepare("UPDATE mono_monitor_runs SET state='failed',finished_at=?,error_code='MONO_RATE_LIMITED' WHERE id=? AND state='running'").bind(now(),id).run();
    throw new StoreError('MONO_RATE_LIMITED','Оновлення можливе не частіше разу на хвилину.',429,60);
  }
  try{
    const settings=await database.prepare('SELECT fixture_epoch FROM mono_monitor_settings WHERE id=1').first();
    const fixture=monoFixtures(settings.fixture_epoch);
    const inserts=fixture.orders.map(o=>database.prepare('INSERT OR IGNORE INTO mono_monitor_fixture_orders(id,amount_kop,created_at) VALUES(?,?,?)').bind(o.id,o.amount,settings.fixture_epoch-600));
    await database.batch(inserts);await saveHints(database,accountRef,fixture.hints,'fixture');
    const statement=await fetchStatement({account:'fixture-account',token:'fixture-personal-token-for-tests',from:settings.fixture_epoch-3600,to:settings.fixture_epoch+60,transport:fixture.transport});
    const summary=await reconcileStatement(database,{accountRef,source:'fixture',hints:fixture.hints,...statement});
    await database.prepare("UPDATE mono_monitor_runs SET state='done',finished_at=?,summary_json=? WHERE id=?").bind(now(),JSON.stringify(summary),id).run();
    return {state:'done',summary};
  }catch(error){
    const code=error instanceof StoreError?error.code:'MONO_SYNC_FAILED';
    await database.prepare("UPDATE mono_monitor_runs SET state='failed',finished_at=?,error_code=? WHERE id=?").bind(now(),code,id).run();
    throw new StoreError(code,'Тестову перевірку не завершено. Дані не підтверджено.',502);
  }finally{
    await database.prepare('UPDATE mono_monitor_sync_lock SET lease_until=0,lease_token=NULL WHERE account_ref=? AND lease_token=?').bind(accountRef,lease).run();
  }
}
export async function deliverMonitorNotifications(database,env,limit=3){
  if(!telegramConfigured(env))return {configured:false};
  if(!await database.prepare("SELECT version FROM loza_store_migrations WHERE version='0006_mono_monitor'").first())return {configured:false};
  const enabled=await database.prepare('SELECT notifications_enabled FROM mono_monitor_settings WHERE id=1').first();
  const global=await database.prepare('SELECT enabled FROM telegram_settings WHERE id=1').first();
  if(!enabled?.notifications_enabled || !global?.enabled)return {configured:true,paused:true};
  await database.prepare("UPDATE mono_monitor_notifications SET state='uncertain',last_error='DELIVERY_UNCERTAIN',lease_token=NULL WHERE state='sending' AND lease_until<?").bind(now()).run();
  const due=await database.prepare("SELECT id FROM mono_monitor_notifications WHERE state IN('queued','retry') AND attempts<8 AND next_attempt<=? ORDER BY created_at,id LIMIT ?").bind(now(),Math.max(1,Math.min(5,limit))).all();
  for(const {id} of due.results){
    const lease=crypto.randomUUID();
    const event=await database.prepare(`UPDATE mono_monitor_notifications SET state='sending',lease_token=?,lease_until=?,attempts=attempts+1
      WHERE id=? AND state IN('queued','retry') AND next_attempt<=? AND attempts<8 AND EXISTS(SELECT 1 FROM mono_monitor_transactions t
      WHERE t.id=transaction_ref AND t.verification_state='verified' AND t.amount_kop>0 AND t.currency_code=980 AND t.hold=0)
      RETURNING *`).bind(lease,now()+90,id,now()).first();
    if(!event)continue;
    let state='uncertain',error='DELIVERY_UNCERTAIN',next=0,messageId=null;
    try{
      const t=await database.prepare('SELECT id,amount_kop,transaction_time,data_source FROM mono_monitor_transactions WHERE id=?').bind(event.transaction_ref).first();
      const text=[t.data_source==='fixture'?'🧪 ТЕСТ LOZA · синтетичне надходження':'💚 LOZA · надходження',
        'Сума: '+(t.amount_kop/100).toFixed(2)+' грн','Час: '+new Date(t.transaction_time*1000).toISOString(),
        'Внутрішній запис: '+t.id.slice(0,8),t.data_source==='fixture'?'Перевірено тестовою випискою. Реальних коштів немає.':'Перевірено авторизованою випискою.',
        'Можливий збіг потребує ручної перевірки. Статус замовлення не змінено.'].join('\n');
      const response=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},
        redirect:'manual',signal:AbortSignal.timeout(8000),body:JSON.stringify({chat_id:env.TELEGRAM_CHAT_ID,text,protect_content:true,link_preview_options:{is_disabled:true}})});
      let data;try{data=await response.json();}catch{data=null;}
      if(response.ok && data?.ok===true && Number.isSafeInteger(data.result?.message_id)){state='sent';error=null;messageId=data.result.message_id;}
      else if(data?.ok===false && Number.isInteger(data.error_code)){
        state=(data.error_code===429 || data.error_code>=500) && event.attempts<8?'retry':'failed';error='TELEGRAM_'+data.error_code;
        next=now()+(Number.isInteger(data.parameters?.retry_after)?Math.min(86400,Math.max(1,data.parameters.retry_after)):Math.min(3600,15*2**event.attempts));
      }
    }catch{/* Never log a URL, exception, token, bank response or uncertain payload. */}
    await database.prepare(`UPDATE mono_monitor_notifications SET state=?,last_error=?,next_attempt=?,message_id=?,lease_token=NULL,
      sent_at=CASE WHEN ?='sent' THEN CURRENT_TIMESTAMP ELSE sent_at END WHERE id=? AND state='sending' AND lease_token=?`)
      .bind(state,error,next,messageId,state,id,lease).run();
  }
  return {configured:true};
}
async function action(database,id,actor,kind,payload){
  const serialized=JSON.stringify(payload),old=await database.prepare('SELECT actor,action,payload_json FROM mono_monitor_actions WHERE id=?').bind(id).first();
  const matches=row=>row?.actor===actor && row.action===kind && row.payload_json===serialized;
  if(old){if(matches(old))return;throw new StoreError('MUTATION_CONFLICT','Цей ключ уже використано.',409);}
  try{await database.prepare('INSERT INTO mono_monitor_actions(id,actor,action,payload_json) VALUES(?,?,?,?)').bind(id,actor,kind,serialized).run();}
  catch(error){if(matches(await database.prepare('SELECT actor,action,payload_json FROM mono_monitor_actions WHERE id=?').bind(id).first()))return;
    if(String(error.message).includes('LOZA_VERSION_CONFLICT'))throw new StoreError('VERSION_CONFLICT','Налаштування змінилися. Оновіть сторінку.',409);throw error;}
}
export async function monoMonitorApi(context,database,route,actor,commandId){
  const ready=Boolean(await database.prepare("SELECT version FROM loza_store_migrations WHERE version='0006_mono_monitor'").first());
  const fixture=fixturePreview(context.request);
  if(route==='mono' && context.request.method==='GET'){
    const base={success:true,schemaReady:ready,mode:fixture?'fixture':'off',liveEnabled:false,paymentsEnabled:false,tokenConfigured:Boolean(context.env.MONO_TOKEN),telegramConfigured:telegramConfigured(context.env)};
    if(!ready || !fixture)return json({...base,transactions:[],notifications:[],runs:[],actions:[]});
    const rows=await database.prepare('SELECT * FROM mono_monitor_transactions WHERE data_source=? ORDER BY transaction_time DESC,id LIMIT 50').bind('fixture').all();
    const fixtureOrders=await database.prepare('SELECT id,amount_kop,status,created_at FROM mono_monitor_fixture_orders ORDER BY id LIMIT 500').all();
    const transactions=[];
    for(const t of rows.results){const candidates=await candidateOrders(database,t,fixtureOrders.results);transactions.push({id:t.id,amountKop:t.amount_kop,currencyCode:t.currency_code,time:t.transaction_time,
      verificationState:t.verification_state,source:t.data_source,verifiedByBank:false,verifiedAt:t.verified_at,candidates:candidates.slice(0,20),moreCandidates:candidates.length>20});}
    const settings=await database.prepare('SELECT notifications_enabled,version FROM mono_monitor_settings WHERE id=1').first();
    const notifications=await database.prepare('SELECT id,transaction_ref,state,attempts,last_error,next_attempt,created_at FROM mono_monitor_notifications ORDER BY created_at DESC LIMIT 50').all();
    const runs=await database.prepare('SELECT id,state,started_at,finished_at,error_code,summary_json FROM mono_monitor_runs ORDER BY started_at DESC LIMIT 10').all();
    const actions=await database.prepare('SELECT actor,action,created_at FROM mono_monitor_actions ORDER BY rowid DESC LIMIT 20').all();
    return json({...base,transactions,settings,notifications:notifications.results,runs:runs.results,actions:actions.results});
  }
  if(!fixture)throw new StoreError('MONO_LIVE_DISABLED','Живий моніторинг і приймання платежів вимкнені.',403);
  if(!ready)throw new StoreError('MONO_SCHEMA_REQUIRED','Спочатку застосуйте 0006 тільки до Preview D1.',503);
  if(context.request.method!=='POST')return json({success:false,error:'Маршрут не знайдено.'},404);
  const input=await body(context.request,2048),id=commandId(context.request);
  if(route==='mono/sync'){
    if(Object.keys(input).length)throw fail();
    const result=await syncFixture(database,context.request,actor,id);
    if(context.waitUntil)context.waitUntil(deliverMonitorNotifications(database,context.env).catch(()=>{}));
    return json({success:true,...result});
  }
  if(route==='mono/settings'){
    if(!Number.isSafeInteger(input.version) || input.version<0 || typeof input.enabled!=='boolean' || Object.keys(input).some(k=>!['version','enabled'].includes(k)))throw fail();
    await action(database,id,actor,'settings',{version:input.version,enabled:input.enabled?1:0});return json({success:true});
  }
  if(route==='mono/retry'){
    if(Object.keys(input).some(k=>!['eventId','allowDuplicateRisk'].includes(k)))throw fail();
    if(input.eventId!==undefined){
      if(typeof input.eventId!=='string' || !uuid.test(input.eventId) || typeof input.allowDuplicateRisk!=='boolean')throw fail();
      const previous=await database.prepare('SELECT actor,action,payload_json FROM mono_monitor_actions WHERE id=?').bind(id).first();
      if(!previous){
        const event=await database.prepare('SELECT state FROM mono_monitor_notifications WHERE id=?').bind(input.eventId).first();
        if(!event || !['retry','failed','uncertain'].includes(event.state))throw fail();
        if(event.state==='uncertain' && !input.allowDuplicateRisk)throw new StoreError('UNCERTAIN_DELIVERY','Спочатку перевірте Telegram: можливий дубль.',409);
      }
      await action(database,id,actor,'retry',{eventId:input.eventId,allowDuplicateRisk:input.allowDuplicateRisk});
    }
    await deliverMonitorNotifications(database,context.env);return json({success:true});
  }
  return json({success:false,error:'Маршрут не знайдено.'},404);
}
