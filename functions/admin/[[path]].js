import {adminHtml} from '../../server/admin-page.js';
export function onRequest(context) {
  if(!['GET','HEAD'].includes(context.request.method)) return new Response('Method not allowed',{status:405});
  if(!['/admin','/admin/'].includes(new URL(context.request.url).pathname)) return new Response('Not found',{status:404});
  return new Response(context.request.method==='HEAD'?null:adminHtml,{headers:{'Content-Type':'text/html; charset=utf-8'}});
}
