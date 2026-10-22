import {body,configured,db,digest,endpoint,json,rateLimit,requestKey,requireSchema,StoreError,verifyTurnstile} from './checkout.js';
import {telegramConfigured} from './telegram.js';

export const SUPPORT_REASONS={checkout:'Не вдається оформити замовлення',delivery:'Доставка та відділення',catalog:'Назва, ціна чи наявність сорту',order_status:'Статус мого замовлення',technical:'Технічна проблема на сайті',other:'Інше питання'};
export const SUPPORT_STATUSES={new:'Нове',in_progress:'В роботі',resolved:'Вирішено'};
const invalid=()=>new StoreError('INVALID_SUPPORT','Оберіть причину, опишіть проблему та вкажіть Telegram @username або український номер телефону.');
export function supportInput(input){
  if(!Object.hasOwn(SUPPORT_REASONS,input.reason) || !['telegram','phone'].includes(input.contactType) || typeof input.contact!=='string' || typeof input.message!=='string' || input.website)throw invalid();
  let contact=input.contact.normalize('NFC').trim();
  if(input.contactType==='telegram'){
    if(!/^@[A-Za-z0-9_]{5,32}$/.test(contact))throw invalid();
  }else{
    contact=contact.replace(/[\s()-]/g,'');if(/^0\d{9}$/.test(contact))contact='+38'+contact;if(/^380\d{9}$/.test(contact))contact='+'+contact;
    if(!/^\+380\d{9}$/.test(contact))throw invalid();
  }
  const message=input.message.normalize('NFC').trim();
  if(message.length<10 || message.length>2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(message))throw invalid();
  return {reason:input.reason,contactType:input.contactType,contact,message};
}
const ticketId=id=>typeof id==='string' && /^SUP-[0-9a-f-]{36}$/.test(id);
const savedResponse=row=>json({success:true,ticketId:row.id,status:'received',statusLabel:'Звернення отримано'});
export const createSupport=context=>endpoint(context,'POST',async context=>{
  const database=db(context);await requireSchema(database);await rateLimit(context,database,'support',3);
  if(!configured(context.env))throw new StoreError('SUPPORT_UNAVAILABLE','Форма підтримки тимчасово недоступна. Зателефонуйте або напишіть Сергію.',503);
  const input=await body(context.request,12288),ticket=supportInput(input);
  const key=await digest('support:'+await requestKey(context.request)),hash=await digest(JSON.stringify(ticket));
  const find=()=>database.prepare('SELECT id,payload_hash FROM support_tickets WHERE request_key_hash=?').bind(key).first();
  let row=await find();
  if(row){if(row.payload_hash!==hash)throw new StoreError('SUPPORT_CONFLICT','Попереднє звернення вже прийнято з іншими даними.',409);scheduleSupport(context,database);return savedResponse(row);}
  await verifyTurnstile(context,input.turnstileToken,'loza_support');
  const id='SUP-'+crypto.randomUUID();
  try{
    await database.batch([
      database.prepare('INSERT INTO support_tickets(id,request_key_hash,payload_hash,contact_type,contact,reason,message) VALUES(?,?,?,?,?,?,?)')
        .bind(id,key,hash,ticket.contactType,ticket.contact,ticket.reason,ticket.message),
      database.prepare('INSERT INTO support_outbox(ticket_id) SELECT ? WHERE (SELECT enabled FROM telegram_settings WHERE id=1)=1').bind(id)
    ]);
  }catch(error){row=await find();if(!row)throw error;if(row.payload_hash!==hash)throw new StoreError('SUPPORT_CONFLICT','Попереднє звернення вже прийнято з іншими даними.',409);scheduleSupport(context,database);return savedResponse(row);}
  scheduleSupport(context,database);return json({success:true,ticketId:id,status:'received',statusLabel:'Звернення отримано'},201);
});
export function scheduleSupport(context,database){if(context.waitUntil)context.waitUntil(deliverSupportPending(database,context.env,3).catch(()=>{}));}

// A separate outbox avoids rebuilding the existing order/Telegram tables. Contact/message never leave D1.
export async function deliverSupportPending(database,env,limit=5){
  if(!telegramConfigured(env))return {configured:false};
  if(!await database.prepare("SELECT version FROM loza_store_migrations WHERE version='0008_manual_catalog_support'").first())return {schemaReady:false};
  const now=Math.floor(Date.now()/1000);
  await database.prepare("UPDATE support_outbox SET state='uncertain',last_error='DELIVERY_UNCERTAIN',lease_token=NULL WHERE state='sending' AND lease_until<?").bind(now).run();
  const enabled=await database.prepare('SELECT enabled FROM telegram_settings WHERE id=1').first();if(!enabled?.enabled)return {configured:true};
  const due=await database.prepare("SELECT ticket_id FROM support_outbox WHERE state IN('queued','retry') AND next_attempt<=? AND attempts<8 ORDER BY created_at LIMIT ?").bind(now,Math.max(1,Math.min(10,limit))).all();
  for(const {ticket_id:id} of due.results){
    const claimedAt=Math.floor(Date.now()/1000),lease=crypto.randomUUID();
    const event=await database.prepare("UPDATE support_outbox SET state='sending',lease_token=?,lease_until=?,attempts=attempts+1 WHERE ticket_id=? AND state IN('queued','retry') AND next_attempt<=? AND attempts<8 RETURNING *").bind(lease,claimedAt+90,id,claimedAt).first();
    if(!event)continue;
    let state='uncertain',error='DELIVERY_UNCERTAIN',next=0,messageId=null;
    try{
      const ticket=await database.prepare('SELECT reason FROM support_tickets WHERE id=?').bind(id).first();
      const text=['💬 Нове звернення LOZA','Номер: '+id,'Причина: '+(SUPPORT_REASONS[ticket?.reason] || 'Інше питання'),'Повідомлення та контакт — у захищеній адмінпанелі, розділ «Підтримка».'].join('\n');
      const response=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},redirect:'manual',signal:AbortSignal.timeout(8000),body:JSON.stringify({chat_id:env.TELEGRAM_CHAT_ID,text,link_preview_options:{is_disabled:true},protect_content:true})});
      let result;try{result=await response.json();}catch{result=null;}
      if(response.ok && result?.ok===true && Number.isSafeInteger(result.result?.message_id)){state='sent';error=null;messageId=result.result.message_id;}
      else if(result?.ok===false && Number.isInteger(result.error_code)){
        const retryable=result.error_code===429 || result.error_code>=500;
        state=retryable && event.attempts<8?'retry':'failed';error='TELEGRAM_'+result.error_code;
        const delay=Number.isInteger(result.parameters?.retry_after)?Math.max(1,Math.min(86400,result.parameters.retry_after)):Math.min(3600,15*2**event.attempts);
        next=Math.floor(Date.now()/1000)+delay;
      }
    }catch{ /* Unknown outcome is reviewed by an authorized administrator before retry. */ }
    await database.prepare("UPDATE support_outbox SET state=?,last_error=?,next_attempt=?,message_id=?,lease_token=NULL,sent_at=CASE WHEN ?='sent' THEN CURRENT_TIMESTAMP ELSE sent_at END WHERE ticket_id=? AND state='sending' AND lease_token=?")
      .bind(state,error,next,messageId,state,id,lease).run();
  }
  return {configured:true};
}

export async function supportAdminApi(context,database,route,actor,commandId){
  const url=new URL(context.request.url),method=context.request.method,parts=route.split('/');
  if(method==='GET' && route==='support'){
    const status=url.searchParams.get('status') || '',offset=Number(url.searchParams.get('offset') || 0),q=url.searchParams.get('q') || '';
    if(q.length>100 || (status && !Object.hasOwn(SUPPORT_STATUSES,status)) || !Number.isSafeInteger(offset) || offset<0 || offset>1000000)throw invalid();
    const result=await database.prepare("SELECT id,contact_type,contact,reason,message,status,version,created_at FROM support_tickets WHERE (?='' OR status=?) AND (instr(lower(id),lower(?))>0 OR instr(lower(contact),lower(?))>0) ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET ?").bind(status,status,q,q,offset).all();
    return json({success:true,tickets:result.results,reasons:SUPPORT_REASONS,statuses:SUPPORT_STATUSES});
  }
  const id=parts[1];if(!ticketId(id))throw new StoreError('NOT_FOUND','Звернення не знайдено.',404);
  if(method==='GET' && parts.length===2){
    const ticket=await database.prepare('SELECT id,contact_type,contact,reason,message,status,version,created_at FROM support_tickets WHERE id=?').bind(id).first();
    if(!ticket)throw new StoreError('NOT_FOUND','Звернення не знайдено.',404);
    const actions=await database.prepare('SELECT actor,status,created_at FROM support_admin_actions WHERE ticket_id=? ORDER BY created_at,id').bind(id).all();
    const notification=await database.prepare('SELECT state,attempts,last_error FROM support_outbox WHERE ticket_id=?').bind(id).first();
    return json({success:true,ticket,actions:actions.results,notification});
  }
  if(method!=='POST' || parts.length!==3)throw new StoreError('NOT_FOUND','Не знайдено.',404);
  const input=await body(context.request),actionId=commandId(context.request);
  if(parts[2]==='status'){
    if(!Object.hasOwn(SUPPORT_STATUSES,input.status) || !Number.isSafeInteger(input.version) || input.version<0)throw invalid();
    const find=()=>database.prepare('SELECT actor,ticket_id,expected_version,status FROM support_admin_actions WHERE id=?').bind(actionId).first();
    const matches=p=>p?.actor===actor && p.ticket_id===id && p.expected_version===input.version && p.status===input.status;
    const saved=await find();if(saved){if(matches(saved))return json({success:true,replayed:true});throw new StoreError('MUTATION_CONFLICT','Цей ключ уже використано.',409);}
    try{await database.prepare('INSERT INTO support_admin_actions(id,actor,ticket_id,expected_version,status) VALUES(?,?,?,?,?)').bind(actionId,actor,id,input.version,input.status).run();}
    catch(error){if(matches(await find()))return json({success:true,replayed:true});if(String(error.message).includes('LOZA_VERSION_CONFLICT'))throw new StoreError('VERSION_CONFLICT','Звернення змінилося. Оновіть список.',409);throw error;}
    return json({success:true});
  }
  if(parts[2]==='retry'){
    if(typeof input.allowDuplicateRisk!=='boolean')throw invalid();
    const saved=await database.prepare('SELECT actor,ticket_id,allow_duplicate_risk FROM support_notification_actions WHERE id=?').bind(actionId).first();
    if(saved && (saved.actor!==actor || saved.ticket_id!==id || saved.allow_duplicate_risk!==Number(input.allowDuplicateRisk)))throw new StoreError('MUTATION_CONFLICT','Цей ключ уже використано.',409);
    if(!saved)await database.prepare('INSERT INTO support_notification_actions(id,actor,ticket_id,allow_duplicate_risk) VALUES(?,?,?,?)').bind(actionId,actor,id,Number(input.allowDuplicateRisk)).run();
    await deliverSupportPending(database,context.env,3);return json({success:true});
  }
  throw new StoreError('NOT_FOUND','Не знайдено.',404);
}
