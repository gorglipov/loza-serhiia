// Durable, PII-free outbox. Never log Telegram URLs, token values or response bodies.
export const STATUS_LABELS={pending:'Очікує підтвердження',confirmed:'Підтверджено',shipped:'Відправлено',completed:'Виконано',cancelled:'Скасовано'};
export const telegramConfigured=env=>typeof env.TELEGRAM_BOT_TOKEN==='string' && /^\d+:[A-Za-z0-9_-]+$/.test(env.TELEGRAM_BOT_TOKEN) && typeof env.TELEGRAM_CHAT_ID==='string' && /^-?\d+$/.test(env.TELEGRAM_CHAT_ID);
export function queueOrder(database,id) {
  return database.prepare(`INSERT OR IGNORE INTO telegram_outbox(event_key,order_id,kind)
    SELECT ?,?,'order' WHERE (SELECT enabled FROM telegram_settings WHERE id=1)=1`).bind('order:'+id,id);
}
async function message(database,event) {
  if(event.kind==='test') return '✅ Тестове повідомлення LOZA\nTelegram-сповіщення підключено. Персональні дані покупців не надсилаються.';
  const order=await database.prepare('SELECT o.id,o.amount_kop,o.status,c.comment FROM orders o LEFT JOIN order_checkout c ON c.order_id=o.id WHERE o.id=?').bind(event.order_id).first();
  const items=await database.prepare('SELECT product_name,quantity FROM order_items WHERE order_id=? ORDER BY product_id').bind(event.order_id).all();
  if(!order || !items.results.length) throw new Error('ORDER_DATA_UNAVAILABLE');
  const payment=/^\[LOZA_PAYMENT:(full|deposit_cod)\] /.exec(order.comment||'')?.[1];
  const paymentLines=payment==='deposit_cod' && order.amount_kop>=10000
    ? ['Умови: передоплата 100 грн + післяплата '+((order.amount_kop-10000)/100).toFixed(2)+' грн']
    : payment==='full' ? ['Умови: повна передоплата '+(order.amount_kop/100).toFixed(2)+' грн'] : [];
  return ['🛒 Нове замовлення LOZA','Номер: #'+order.id,'Товари:',...items.results.map(i=>i.product_name+' × '+i.quantity),
    'Сума: '+(order.amount_kop/100).toFixed(2)+' грн',...paymentLines,
    'Оплата: не перевірена','Статус: '+(STATUS_LABELS[order.status] || 'Оновлено')].join('\n').slice(0,4096);
}
export async function deliverPending(database,env,limit=5) {
  if(!telegramConfigured(env)) return {configured:false};
  const enabled=await database.prepare('SELECT enabled FROM telegram_settings WHERE id=1').first();
  const now=Math.floor(Date.now()/1000);
  // A crashed/in-flight request may already have reached Telegram. Never resend it silently.
  await database.prepare("UPDATE telegram_outbox SET state='uncertain',last_error='DELIVERY_UNCERTAIN',lease_token=NULL WHERE state='sending' AND lease_until<?").bind(now).run();
  const due=await database.prepare("SELECT id FROM telegram_outbox WHERE state IN('queued','retry') AND next_attempt<=? AND attempts<8 AND (?=1 OR kind='test') ORDER BY id LIMIT ?").bind(now,enabled?.enabled?1:0,Math.min(10,limit)).all();
  for(const {id} of due.results) {
    // Each claimed event gets a full lease, even after slow earlier requests.
    const claimedAt=Math.floor(Date.now()/1000);
    const lease=crypto.randomUUID();
    const event=await database.prepare(`UPDATE telegram_outbox SET state='sending',lease_token=?,lease_until=?,attempts=attempts+1
      WHERE id=? AND state IN('queued','retry') AND next_attempt<=? AND attempts<8 RETURNING *`).bind(lease,claimedAt+90,id,claimedAt).first();
    if(!event) continue;
    let outcome={state:'uncertain',error:'DELIVERY_UNCERTAIN',next:0,messageId:null};
    try {
      const text=await message(database,event);
      const response=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/sendMessage',{
        method:'POST',headers:{'Content-Type':'application/json'},redirect:'manual',signal:AbortSignal.timeout(8000),
        body:JSON.stringify({chat_id:env.TELEGRAM_CHAT_ID,text,link_preview_options:{is_disabled:true},protect_content:true})
      });
      let result;
      try { result=await response.json(); } catch { result=null; }
      if(response.ok && result?.ok===true && Number.isSafeInteger(result.result?.message_id)) {
        outcome={state:'sent',error:null,next:0,messageId:result.result.message_id};
      } else if(result?.ok===false && Number.isInteger(result.error_code)) {
        // Retry only a confirmed rejection, never an ambiguous timeout/response loss.
        const retryable=result.error_code===429 || result.error_code>=500;
        const delay=Number.isInteger(result.parameters?.retry_after)?Math.max(1,Math.min(86400,result.parameters.retry_after)):Math.min(3600,15*2**event.attempts);
        outcome={state:retryable && event.attempts<8?'retry':'failed',error:'TELEGRAM_'+result.error_code,next:Math.floor(Date.now()/1000)+delay,messageId:null};
      }
    } catch { /* Unknown delivery outcome: do not automatically create a duplicate. */ }
    await database.prepare(`UPDATE telegram_outbox SET state=?,last_error=?,next_attempt=?,message_id=?,lease_token=NULL,
      sent_at=CASE WHEN ?='sent' THEN CURRENT_TIMESTAMP ELSE sent_at END WHERE id=? AND state='sending' AND lease_token=?`)
      .bind(outcome.state,outcome.error,outcome.next,outcome.messageId,outcome.state,id,lease).run();
  }
  return {configured:true};
}
export function scheduleNotifications(context,database) {
  // Called only AFTER the order batch committed. Failures cannot alter the receipt.
  if(context.waitUntil) context.waitUntil(deliverPending(database,context.env,3).catch(()=>{}));
}
