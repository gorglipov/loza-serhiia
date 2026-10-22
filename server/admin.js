import {body,db,endpoint,json,rateLimit,StoreError} from './checkout.js';
import {issueCsrf} from './access.js';
import {deliverPending,telegramConfigured,STATUS_LABELS} from './telegram.js';
import {catalogApi} from './catalog.js';
import {monoMonitorApi} from './mono-monitor.js';
const invalid=()=>new StoreError('INVALID_ADMIN_INPUT','Перевірте введені значення.');
const int=(v,max=100000000)=>Number.isSafeInteger(v) && v>=0 && v<=max;
const clean=(v,min,max)=> {
  if(typeof v!=='string' || /[\u0000-\u001f\u007f]/.test(v)) throw invalid();
  v=v.normalize('NFC').trim(); if(v.length<min || v.length>max) throw invalid(); return v;
};
export function productInput(input) {
  if(!int(input.version) || !(input.priceKop===null || (int(input.priceKop) && input.priceKop>0)) ||
    typeof input.available!=='boolean' || typeof input.priceConfirmed!=='boolean' || typeof input.characteristicsConfirmed!=='boolean' ||
    (input.priceConfirmed && input.priceKop===null) ||
    !input.details || typeof input.details!=='object' || Array.isArray(input.details)) throw invalid();
  const details={};
  for(const key of Object.keys(input.details)) {
    if(!['ripening','color','taste','berry','shape','frost','kishmish'].includes(key)) throw invalid();
    if(key==='kishmish') { if(typeof input.details[key]!=='boolean') throw invalid(); details[key]=input.details[key]; }
    else details[key]=clean(input.details[key],0,500);
  }
  return {name:clean(input.name,2,160),priceKop:input.priceKop,stock:input.available?20:0,available:input.available?1:0,
    priceConfirmed:input.priceConfirmed?1:0,characteristicsConfirmed:input.characteristicsConfirmed?1:0,detailsJson:JSON.stringify(details)};
}
function commandId(request) {
  const id=request.headers.get('Idempotency-Key');
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id || '')) throw invalid();
  return id.toLowerCase();
}
async function mutate(database,request,actor,kind,target,version,payload) {
  const id=commandId(request), serialized=JSON.stringify(payload);
  const previous=await database.prepare('SELECT actor,kind,target,expected_version,payload_json FROM admin_mutations WHERE id=?').bind(id).first();
  const matches=row=>row?.actor===actor && row.kind===kind && row.target===target && row.expected_version===version && row.payload_json===serialized;
  if(previous) { if(matches(previous)) return; throw new StoreError('MUTATION_CONFLICT','Цей ключ уже використано.',409); }
  try {
    await database.prepare('INSERT INTO admin_mutations(id,actor,kind,target,expected_version,payload_json) VALUES(?,?,?,?,?,?)').bind(id,actor,kind,target,version,serialized).run();
  } catch(error) {
    const saved=await database.prepare('SELECT actor,kind,target,expected_version,payload_json FROM admin_mutations WHERE id=?').bind(id).first();
    if(matches(saved)) return;
    if(String(error.message).includes('LOZA_VERSION_CONFLICT')) throw new StoreError('VERSION_CONFLICT','Дані змінилися. Оновіть сторінку перед редагуванням.',409);
    if(String(error.message).includes('LOZA_INVALID_TRANSITION')) throw new StoreError('INVALID_TRANSITION','Ця зміна статусу недоступна. Оновіть замовлення.',409);
    if(String(error.message).includes('LOZA_PRICE_NOT_CONFIRMED')) throw new StoreError('PRICE_NOT_CONFIRMED','Перевірте наявність і підтвердження ціни реального сорту.',400);
    throw error;
  }
}
function product(row) { const {details_json,source_json,in_stock,...data}=row; return {...data,inStock:Boolean(in_stock),details:JSON.parse(details_json),source:source_json?JSON.parse(source_json):null}; }
async function availability(database,request,actor,target,input) {
  if(!int(input.version) || typeof input.inStock!=='boolean')throw invalid();
  const id=commandId(request),state=input.inStock?1:0;
  const saved=()=>database.prepare('SELECT actor,product_id,expected_version,in_stock FROM admin_availability_changes WHERE id=?').bind(id).first();
  const matches=row=>row?.actor===actor && row.product_id===target && row.expected_version===input.version && row.in_stock===state;
  const previous=await saved();
  if(previous){if(matches(previous))return;throw new StoreError('MUTATION_CONFLICT','Цей ключ уже використано.',409);}
  if(!await database.prepare('SELECT product_id FROM product_availability WHERE product_id=?').bind(target).first())throw new StoreError('NOT_FOUND','Сорт не знайдено.',404);
  try{
    await database.prepare('INSERT INTO admin_availability_changes(id,actor,product_id,expected_version,in_stock) VALUES(?,?,?,?,?)')
      .bind(id,actor,target,input.version,state).run();
  }catch(error){
    if(matches(await saved()))return;
    if(String(error.message).includes('LOZA_VERSION_CONFLICT'))throw new StoreError('VERSION_CONFLICT','Наявність або дані сорту змінилися. Оновіть список.',409);
    if(await database.prepare('SELECT id FROM admin_mutations WHERE id=?').bind(id).first())throw new StoreError('MUTATION_CONFLICT','Цей ключ уже використано.',409);
    throw error;
  }
}
export async function adminApi(context) {
  const method=context.request.method;
  return endpoint(context,method,async()=> {
    if(!context.data.admin) throw new StoreError('ADMIN_FORBIDDEN','Доступ заборонено.',403);
    const database=db(context);
    const schema=await database.prepare("SELECT version FROM loza_store_migrations WHERE version='0005_manual_availability'").first();
    if(!schema) throw new StoreError('ADMIN_SCHEMA_REQUIRED','Спочатку застосуйте міграцію 0005 до D1 цього середовища.',503);
    await rateLimit(context,database,'admin',method==='GET'?180:30);
    const url=new URL(context.request.url), route=url.pathname.replace(/^\/api\/admin\/?/,'').replace(/\/$/,'');
    const actor=context.data.admin.email;
    if(route==='mono' || route.startsWith('mono/')) return monoMonitorApi(context,database,route,actor,commandId);
    if(route.startsWith('catalog/')) return catalogApi(context,database,route,actor,productInput,commandId);
    if(method==='GET' && route==='session') return json({success:true,email:actor,csrfToken:await issueCsrf(context.request,context.env,context.data.admin),statuses:STATUS_LABELS});
    if(method==='GET' && route==='dashboard') {
      const [products,counts]=await Promise.all([
        database.prepare('SELECT COUNT(*) total,SUM(COALESCE(a.in_stock,0)) active FROM products p LEFT JOIN product_availability a ON a.product_id=p.id WHERE p.is_demo=0').first(),
        database.prepare('SELECT status,COUNT(*) count FROM orders GROUP BY status').all()
      ]);
      return json({success:true,products,orders:counts.results});
    }
    if(method==='GET' && route==='products') {
      const q=clean(url.searchParams.get('q') || '',0,100),filter=url.searchParams.get('filter') || 'all';
      if(!['all','active','inactive','demo','empty'].includes(filter)) throw invalid();
      const result=await database.prepare(`SELECT p.*,v.version,c.confirmed_price_kop,c.characteristics_confirmed,c.source_json,a.in_stock
        FROM products p JOIN admin_product_versions v ON v.product_id=p.id LEFT JOIN product_catalog c ON c.product_id=p.id
        LEFT JOIN product_availability a ON a.product_id=p.id
        WHERE (p.is_demo=0 OR ?='demo') AND (?='all' OR (?='active' AND a.in_stock=1) OR (?='inactive' AND COALESCE(a.in_stock,0)=0) OR
        (?='demo' AND p.is_demo=1) OR (?='empty' AND COALESCE(a.in_stock,0)=0)) ORDER BY p.name`)
        .bind(filter,filter,filter,filter,filter,filter).all();
      // SQLite lower() folds ASCII only. Fold Ukrainian names on the server.
      const needle=q.toLocaleLowerCase('uk');
      return json({success:true,products:result.results.filter(row=>(row.name+' '+row.id).toLocaleLowerCase('uk').includes(needle)).map(product)});
    }
    if(method==='POST' && /^products\/[a-z0-9-]{1,64}\/availability$/.test(route)) {
      await availability(database,context.request,actor,route.split('/')[1],await body(context.request));
      return json({success:true});
    }
    if(method==='POST' && route.startsWith('products/')) {
      const target=route.slice(9); if(!/^[a-z0-9-]{1,64}$/.test(target)) throw invalid();
      const input=await body(context.request),payload=productInput(input);
      await mutate(database,context.request,actor,'product',target,input.version,payload);
      return json({success:true});
    }
    if(method==='GET' && route==='orders') {
      const status=url.searchParams.get('status') || '',q=clean(url.searchParams.get('q') || '',0,100);
      const offset=Number(url.searchParams.get('offset') || 0); if(!int(offset,1000000) || (status && !Object.hasOwn(STATUS_LABELS,status))) throw invalid();
      const rows=await database.prepare(`SELECT o.id,o.amount_kop,o.status,c.created_at,v.version,
        (SELECT json_group_array(json_object('name',product_name,'quantity',quantity)) FROM order_items i WHERE i.order_id=o.id) items
        FROM orders o LEFT JOIN order_checkout c ON c.order_id=o.id JOIN admin_order_versions v ON v.order_id=o.id
        WHERE (?='' OR o.status=?) AND instr(o.id,?)>0 ORDER BY c.created_at DESC,o.rowid DESC LIMIT 51 OFFSET ?`).bind(status,status,q,offset).all();
      return json({success:true,orders:rows.results.slice(0,50).map(r=>({...r,items:JSON.parse(r.items)})),hasMore:rows.results.length>50});
    }
    const match=route.match(/^orders\/([A-Za-z0-9-]{1,100})(\/status)?$/);
    if(match && method==='GET' && !match[2]) {
      const order=await database.prepare(`SELECT o.id,o.amount_kop,o.status,v.version,c.buyer_name,c.phone,c.city,c.delivery_method,c.delivery_branch,c.comment,c.created_at
        FROM orders o JOIN admin_order_versions v ON v.order_id=o.id LEFT JOIN order_checkout c ON c.order_id=o.id WHERE o.id=?`).bind(match[1]).first();
      if(!order) throw new StoreError('NOT_FOUND','Замовлення не знайдено.',404);
      const items=await database.prepare('SELECT product_name,quantity,unit_price_kop,line_total_kop FROM order_items WHERE order_id=?').bind(match[1]).all();
      return json({success:true,order,items:items.results});
    }
    if(match && method==='POST' && match[2]) {
      const input=await body(context.request); if(!int(input.version) || !Object.hasOwn(STATUS_LABELS,input.status)) throw invalid();
      await mutate(database,context.request,actor,'status',match[1],input.version,{status:input.status}); return json({success:true});
    }
    if(method==='GET' && route==='audit') {
      const before=Number(url.searchParams.get('before') || Number.MAX_SAFE_INTEGER); if(!int(before,Number.MAX_SAFE_INTEGER)) throw invalid();
      const rows=await database.prepare('SELECT * FROM admin_audit_log WHERE id<? ORDER BY id DESC LIMIT 50').bind(before).all();
      const notifications=await database.prepare('SELECT actor,action,event_key,created_at FROM admin_notification_actions ORDER BY created_at DESC LIMIT 30').all();
      return json({success:true,changes:rows.results,notifications:notifications.results});
    }
    if(method==='GET' && route==='telegram') {
      const settings=await database.prepare('SELECT enabled,version FROM telegram_settings WHERE id=1').first();
      const events=await database.prepare('SELECT id,event_key,state,attempts,next_attempt,last_error,created_at,sent_at FROM telegram_outbox ORDER BY id DESC LIMIT 50').all();
      return json({success:true,configured:telegramConfigured(context.env),settings,events:events.results});
    }
    if(method==='POST' && route==='telegram/settings') {
      const input=await body(context.request); if(!int(input.version) || typeof input.enabled!=='boolean') throw invalid();
      await mutate(database,context.request,actor,'telegram','telegram',input.version,{enabled:input.enabled?1:0}); return json({success:true});
    }
    if(method==='POST' && route==='telegram/test') {
      await rateLimit(context,database,'admin-telegram-test',2);
      await body(context.request);
      if(!telegramConfigured(context.env)) throw new StoreError('TELEGRAM_NOT_CONFIGURED','Перевірте серверні секрети Telegram у цьому середовищі.',503);
      const id=commandId(context.request),key='test:'+id;
      await database.batch([
        database.prepare("INSERT OR IGNORE INTO admin_notification_actions(id,actor,action,event_key) VALUES(?,?,'test',?)").bind(id,actor,key),
        database.prepare("INSERT OR IGNORE INTO telegram_outbox(event_key,kind) VALUES(?,'test')").bind(key)
      ]);
      await deliverPending(database,context.env,5); return json({success:true,eventKey:key});
    }
    if(method==='POST' && route==='telegram/retry') {
      const input=await body(context.request),id=commandId(context.request);
      if(input.eventId!==undefined) {
        if(!int(input.eventId) || typeof input.allowDuplicateRisk!=='boolean') throw invalid();
        const event=await database.prepare('SELECT event_key,state FROM telegram_outbox WHERE id=?').bind(input.eventId).first();
        if(!event || !['retry','failed','uncertain'].includes(event.state)) throw invalid();
        if(event.state==='uncertain' && !input.allowDuplicateRisk) throw new StoreError('UNCERTAIN_DELIVERY','Спочатку перевірте Telegram: повтор може створити дубль.',409);
        // The insert trigger resets the event exactly once for this action UUID.
        await database.prepare("INSERT OR IGNORE INTO admin_notification_actions(id,actor,action,event_key) VALUES(?,?,'retry',?)").bind(id,actor,event.event_key).run();
      }
      await deliverPending(database,context.env,5); return json({success:true});
    }
    return json({success:false,error:'Маршрут не знайдено.'},404);
  });
}
