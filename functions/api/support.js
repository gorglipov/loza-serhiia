import {body,configured,db,digest,endpoint,json,rateLimit,requestKey,StoreError,verifyTurnstile} from '../../server/checkout.js';
import {normalizeSupport,supportReady} from '../../server/support.js';
export const onRequest=context=>endpoint(context,'POST',async context=>{
  const database=db(context);
  if(context.env.SUPPORT_ENABLED!=='true' || !configured(context.env) || !await supportReady(database))throw new StoreError('SUPPORT_UNAVAILABLE','Форма підтримки тимчасово недоступна. Напишіть Сергію в Telegram або зателефонуйте.',503);
  await rateLimit(context,database,'support',4);
  const input=await body(context.request),data=normalizeSupport(input),key=await requestKey(context.request),hash=await digest(JSON.stringify(data));
  const find=()=>database.prepare('SELECT id,payload_hash FROM loza_support_requests WHERE request_key_hash=?').bind(key).first();
  const existing=await find();
  if(existing){if(existing.payload_hash!==hash)throw new StoreError('IDEMPOTENCY_CONFLICT','Цей запит уже прийнято з іншими даними.',409);return json({success:true,requestId:existing.id});}
  await verifyTurnstile(context,input.turnstileToken,'loza_support');
  const id='SUP-'+crypto.randomUUID();
  try{await database.prepare('INSERT INTO loza_support_requests(id,request_key_hash,payload_hash,reason,comment,contact_type,contact) VALUES(?,?,?,?,?,?,?)').bind(id,key,hash,data.reason,data.comment,data.contactType,data.contact).run();}
  catch(error){const saved=await find();if(!saved)throw error;if(saved.payload_hash!==hash)throw new StoreError('IDEMPOTENCY_CONFLICT','Цей запит уже прийнято з іншими даними.',409);return json({success:true,requestId:saved.id});}
  return json({success:true,requestId:id},201);
});
