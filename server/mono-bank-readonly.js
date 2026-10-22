// Prepared for separate review. No Pages route or scheduled handler calls this live-bank adapter.
import {digest,StoreError} from './checkout.js';
import {fetchStatement} from './mono-statement.js';
import {saveHints,reconcileStatement,normalizedHints} from './mono-monitor.js';
export async function verifyBankWindow(database,{account,token,from,to,transport=fetch}){
  if(typeof account!=='string' || !/^[A-Za-z0-9_+=/\-]{1,128}$/.test(account) || account==='0')throw new StoreError('MONO_INVALID_ACCOUNT','Потрібен явно вибраний серверний рахунок.');
  // One global statement gate, including multiple accounts; never bypass the bank's one-minute interval.
  const gate=await digest('loza-mono-bank-statement-gate'),accountRef=await digest('loza-mono-bank-account:'+account),lease=crypto.randomUUID();
  const now=()=>Math.floor(Date.now()/1000);
  const acquired=await database.prepare(`INSERT INTO mono_monitor_sync_lock(account_ref,next_sync_at,lease_until,lease_token) VALUES(?,?,?,?)
    ON CONFLICT(account_ref) DO UPDATE SET next_sync_at=excluded.next_sync_at,lease_until=excluded.lease_until,lease_token=excluded.lease_token
    WHERE mono_monitor_sync_lock.next_sync_at<=? AND mono_monitor_sync_lock.lease_until<=? RETURNING lease_token`)
    .bind(gate,now()+60,now()+120,lease,now(),now()).first();
  if(!acquired)throw new StoreError('MONO_RATE_LIMITED','Виписку можна запитувати не частіше разу на хвилину.',429,60);
  let cooldown=60;
  try{
    const rows=await database.prepare('SELECT transaction_id,amount_kop,currency_code,is_hold FROM mono_events WHERE account_id=? ORDER BY rowid DESC LIMIT 500').bind(account).all();
    const hints=normalizedHints(rows.results.map(row=>({id:row.transaction_id,amount:row.amount_kop,currencyCode:row.currency_code,hold:Boolean(row.is_hold)})));
    await saveHints(database,accountRef,hints,'bank');
    // Only this authorized HTTPS statement can upgrade an untrusted webhook hint.
    const statement=await fetchStatement({account,token,from,to,transport});
    return await reconcileStatement(database,{accountRef,source:'bank',hints,...statement});
  }catch(error){
    if(error instanceof StoreError && error.retryAfter)cooldown=Math.max(60,error.retryAfter);throw error;
  }finally{
    await database.prepare('UPDATE mono_monitor_sync_lock SET next_sync_at=?,lease_until=0,lease_token=NULL WHERE account_ref=? AND lease_token=?')
      .bind(now()+cooldown,gate,lease).run();
  }
}
