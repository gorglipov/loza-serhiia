// Official personal API adapter. No caller-supplied URL, redirect, raw-body logging or payment methods.
import {StoreError} from './checkout.js';
export const MONO_INTERVAL=60,MAX_STATEMENT_RANGE=2682000;
const identifier=/^[A-Za-z0-9_+=/\-]{1,128}$/;
export function statementItem(item){
  if(!item || typeof item.id!=='string' || !identifier.test(item.id) || !Number.isSafeInteger(item.time) || item.time<1 ||
    !Number.isSafeInteger(item.amount) || Math.abs(item.amount)>100000000000 || !Number.isInteger(item.currencyCode) ||
    item.currencyCode<1 || item.currencyCode>999 || typeof item.hold!=='boolean')throw new StoreError('MONO_INVALID_STATEMENT','Некоректний формат виписки.',502);
  // Descriptions, names, cards, balances, IBAN, tax IDs and comments are deliberately discarded.
  return {id:item.id,time:item.time,amount:item.amount,currencyCode:item.currencyCode,hold:item.hold};
}
export async function fetchStatement({account,token,from,to,transport=fetch}){
  const now=Math.floor(Date.now()/1000);
  if(typeof account!=='string' || account==='0' || !identifier.test(account) || typeof token!=='string' ||
    token.length<16 || token.length>512 || /[\r\n]/.test(token) || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) ||
    from<1 || to<=from || to-from>MAX_STATEMENT_RANGE || to>now+300)throw new StoreError('MONO_INVALID_RANGE','Перевірте серверну конфігурацію та період виписки.');
  let response;
  try{response=await transport('https://api.monobank.ua/personal/statement/'+encodeURIComponent(account)+'/'+from+'/'+to,
    {headers:{'X-Token':token},redirect:'manual',signal:AbortSignal.timeout(8000)});}
  catch{throw new StoreError('MONO_BANK_UNAVAILABLE','Виписка тимчасово недоступна.',502);}
  if(response.status===429){
    const retry=Number(response.headers.get('Retry-After'));
    throw new StoreError('MONO_BANK_RATE_LIMITED','Банк обмежив частоту. Зачекайте перед повтором.',429,
      Number.isSafeInteger(retry)?Math.max(60,Math.min(86400,retry)):60);
  }
  if(!response.ok)throw new StoreError('MONO_BANK_UNAVAILABLE','Не вдалося отримати авторизовану виписку.',502);
  let data;const reader=response.body?.getReader(),chunks=[];let size=0;
  try{
    if(!reader)throw new Error();
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1000000){await reader.cancel();throw new Error();}chunks.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  }catch{throw new StoreError('MONO_INVALID_STATEMENT','Не вдалося прочитати виписку.',502);}
  if(!Array.isArray(data) || data.length>500)throw new StoreError('MONO_STATEMENT_TOO_LARGE','Звузьте період виписки.',502);
  const unique=new Map();
  for(const value of data){
    const item=statementItem(value);if(item.time<from || item.time>to)throw new StoreError('MONO_INVALID_STATEMENT','Транзакція поза запитаним періодом.',502);
    if(unique.has(item.id) && JSON.stringify(unique.get(item.id))!==JSON.stringify(item))throw new StoreError('MONO_INVALID_STATEMENT','Суперечливі дані виписки.',502);
    unique.set(item.id,item);
  }
  // A full page may be incomplete. Absence never proves that money was not received.
  return {items:[...unique.values()],possiblyTruncated:data.length>=500};
}
