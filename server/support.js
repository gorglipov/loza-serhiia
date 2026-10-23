import {StoreError} from './checkout.js';
import {blockedComment} from '../content-rules.js';
export const SUPPORT_REASONS={site:'Проблема із сайтом',order:'Питання щодо замовлення',content:'Неприйнятний контент',other:'Інша причина'};
export const supportReady=async database=>Boolean(await database.prepare("SELECT version FROM loza_store_migrations WHERE version='0012_support_requests'").first());
export function normalizeSupport(input){
  if(!Object.hasOwn(SUPPORT_REASONS,input.reason))throw new StoreError('INVALID_SUPPORT','Оберіть причину звернення.');
  const comment=typeof input.comment==='string'?input.comment.normalize('NFC').trim():'';
  if(comment.length>1000 || (input.reason==='other' && comment.length<5) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(comment))throw new StoreError('INVALID_SUPPORT','Додайте опис до 1000 символів; для іншої причини — щонайменше 5 символів.');
  if(blockedComment(comment))throw new StoreError('CONTENT_NOT_ALLOWED','Приберіть нецензурні слова та відвертий контент із коментаря.');
  const contact=typeof input.contact==='string'?input.contact.trim():'';
  if(input.contactType==='phone' && /^\+380\d{9}$/.test(contact))return {reason:input.reason,comment,contactType:'phone',contact};
  if(input.contactType==='telegram' && /^@?[A-Za-z][A-Za-z0-9_]{4,31}$/.test(contact))return {reason:input.reason,comment,contactType:'telegram',contact:'@'+contact.replace(/^@/,'')};
  throw new StoreError('INVALID_SUPPORT','Вкажіть 9 цифр телефону після +380 або Telegram у форматі @username.');
}
