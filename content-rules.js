// Shared validation used in both browser and server.
export function validBuyerName(value){
  return typeof value==='string' && value.length<=100 && /^[А-Яа-яЁёІіЇїЄєҐґ]+(?:[’'ʼ\-][А-Яа-яЁёІіЇїЄєҐґ]+)*(?:\s+[А-Яа-яЁёІіЇїЄєҐґ]+(?:[’'ʼ\-][А-Яа-яЁёІіЇїЄєҐґ]+)*)+$/u.test(value.trim().normalize('NFC'));
}
export function blockedComment(value){
  if(typeof value!=='string')return true;
  const text=value.normalize('NFKC').toLocaleLowerCase('uk').replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g,'').replace(/0/g,'o').replace(/1/g,'i').replace(/3/g,'е').replace(/@/g,'а');
  const roots=['нахуй','похуй','охуе','охує','ебан','єбан','пидар','підар','мудак','дебил','дебіл','motherfuck','бляд','блять','блят','сука','суки','сучк','пизд','пізд','хуй','хуя','хує','хуе','хуи','хую','ебат','ебал','єбат','ёб','йоб','їбат','заеб','заєб','fuck','shit','порно','порнограф','porn','nsfw','nudes','секс','sex'];
  return roots.some(root=>new RegExp('(?:^|[^\\p{L}\\p{N}])'+Array.from(root).join('[\\s._*\\-]*')+'[\\p{L}]*','u').test(text));
}
export function nationalPhone(value){
  let digits=String(value??'').replace(/\D/g,'');
  if(digits.startsWith('380'))digits=digits.slice(3);
  else if(digits.length===10 && digits.startsWith('0'))digits=digits.slice(1);
  return digits.slice(0,9);
}
