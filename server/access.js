// Cloudflare Access application JWT validation using Workers Web Crypto.
// Trust only the configured team JWKS, never a URL supplied by a token/header.
import { digest, json, StoreError } from './checkout.js';
const enc = new TextEncoder();
const cache = new Map();
const denied = () => new StoreError('ADMIN_FORBIDDEN', 'Доступ лише для адміністратора через Cloudflare Access.', 403);
const decode = value => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw denied();
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4-value.length%4)%4));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
};
const encode = value => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
// Accept the team hostname copied from Zero Trust as well as its HTTPS issuer URL.
// Only this exact Cloudflare hostname is allowed; no arbitrary issuer/JWKS URLs.
function teamDomain(value) {
  if (typeof value !== 'string') return null;
  const input=value.trim();
  const match=input.match(/^(?:https:\/\/)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com)\/?$/i);
  return match ? 'https://'+match[1].toLowerCase() : null;
}
const configuredText=value=>typeof value==='string' ? value.trim() : '';
function administratorEmails(value) {
  return configuredText(value).split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
}
// Safe runtime diagnostics: fixed field names and booleans, never values/lengths.
export function adminConfiguration(env) {
  const emails=administratorEmails(env.ADMIN_EMAILS);
  const validity={
    ACCESS_TEAM_DOMAIN:teamDomain(env.ACCESS_TEAM_DOMAIN)!==null,
    ACCESS_AUD:/^[a-f0-9]{64}$/i.test(configuredText(env.ACCESS_AUD)),
    ADMIN_EMAILS:emails.length>0 && emails.every(x=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)),
    ADMIN_CSRF_SECRET:typeof env.ADMIN_CSRF_SECRET==='string' && env.ADMIN_CSRF_SECRET.trim().length>=32,
  };
  return Object.fromEntries(Object.entries(validity).map(([name,formatValid])=>[name,{
    present:env[name]!==undefined && env[name]!==null && env[name]!=='',formatValid,
  }]));
}
function settings(env) {
  const configuration=adminConfiguration(env);
  const invalidFields=Object.keys(configuration).filter(name=>!configuration[name].formatValid);
  if (invalidFields.length) {
    const error=new StoreError('ADMIN_NOT_CONFIGURED','Перевірте налаштування адміністратора: '+invalidFields.join(', ')+'.',503);
    error.configuration=configuration;
    throw error;
  }
  return {domain:teamDomain(env.ACCESS_TEAM_DOMAIN),aud:configuredText(env.ACCESS_AUD),emails:administratorEmails(env.ADMIN_EMAILS)};
}
async function signingKey(domain,kid) {
  let entry = cache.get(domain);
  const now = Date.now();
  if (!entry || now-entry.fetched>300000 || (!entry.keys.some(k=>k.kid===kid) && now-entry.fetched>30000)) {
    const response = await fetch(domain+'/cdn-cgi/access/certs', {signal:AbortSignal.timeout(5000),redirect:'manual'});
    if (!response.ok) throw denied();
    const data = await response.json();
    if (!Array.isArray(data.keys) || data.keys.length>20) throw denied();
    entry = {keys:data.keys,fetched:now};
    cache.set(domain,entry);
  }
  const key=entry.keys.find(k=>k.kid===kid && k.kty==='RSA' && k.alg==='RS256' && k.use==='sig');
  if (!key) throw denied();
  return crypto.subtle.importKey('jwk',key,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
}
export async function authenticate(request,env) {
  const {domain,aud,emails}=settings(env);
  const token=request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token || token.length>16384) throw denied();
  try {
    const parts=token.split('.');
    if (parts.length!==3) throw denied();
    const header=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(decode(parts[0])));
    if (header.alg!=='RS256' || typeof header.kid!=='string' || header.kid.length>256 || header.crit || header.jku || header.jwk || header.x5u) throw denied();
    const key=await signingKey(domain,header.kid);
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,decode(parts[2]),enc.encode(parts[0]+'.'+parts[1]))) throw denied();
    const claims=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(decode(parts[1])));
    const now=Math.floor(Date.now()/1000);
    if (claims.iss!==domain || !(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(aud) ||
      !Number.isInteger(claims.exp) || claims.exp<=now || !Number.isInteger(claims.iat) || claims.iat>now+30 || claims.iat>=claims.exp ||
      (claims.nbf!==undefined && (!Number.isInteger(claims.nbf) || claims.nbf>now+30)) ||
      (claims.type!==undefined && claims.type!=='app') || typeof claims.sub!=='string' || !claims.sub || claims.sub.length>256 ||
      typeof claims.email!=='string' || !emails.includes(claims.email.toLowerCase())) throw denied();
    return {email:claims.email.toLowerCase(),sub:claims.sub,tokenHash:await digest(token),expires:claims.exp};
  } catch { throw denied(); }
}
async function csrfKey(env) {
  return crypto.subtle.importKey('raw',enc.encode(env.ADMIN_CSRF_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
}
function csrfMessage(expiry,identity,request) {
  return enc.encode(JSON.stringify([expiry,identity.sub,identity.tokenHash,new URL(request.url).origin]));
}
export async function issueCsrf(request,env,identity) {
  const expiry=Math.min(identity.expires,Math.floor(Date.now()/1000)+3600);
  return expiry+'.'+encode(await crypto.subtle.sign('HMAC',await csrfKey(env),csrfMessage(expiry,identity,request)));
}
export async function verifyCsrf(request,env,identity) {
  if (request.headers.get('Origin')!==new URL(request.url).origin || request.headers.get('Sec-Fetch-Site')==='cross-site' ||
      request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json') throw denied();
  const token=request.headers.get('X-CSRF-Token') || '';
  const [expiry,signature,...extra]=token.split('.');
  if (extra.length || !/^\d{10}$/.test(expiry) || Number(expiry)<=Date.now()/1000 || Number(expiry)>identity.expires || Number(expiry)>Date.now()/1000+3600) throw denied();
  try {
    if (!await crypto.subtle.verify('HMAC',await csrfKey(env),decode(signature || ''),csrfMessage(Number(expiry),identity,request))) throw denied();
  } catch { throw denied(); }
}
// Kept separate from authentication so static and dynamic private responses share headers.
function privateHeaders(response) {
  const headers=new Headers(response.headers);
  headers.set('Cache-Control','private, no-store'); headers.set('X-Content-Type-Options','nosniff');
  headers.set('Referrer-Policy','no-referrer'); headers.set('X-Frame-Options','DENY');
  headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  return headers;
}
// Exported for middleware reuse without ever exposing claims before verification.
export async function protectAdmin(context) {
  try {
    context.data.admin=await authenticate(context.request,context.env);
    if (!['GET','HEAD'].includes(context.request.method)) await verifyCsrf(context.request,context.env,context.data.admin);
    const response=await context.next();
    return new Response(response.body,{status:response.status,statusText:response.statusText,headers:privateHeaders(response)});
  } catch(error) {
    return json({success:false,code:error instanceof StoreError?error.code:'ADMIN_UNAVAILABLE',error:error instanceof StoreError?error.message:'Адмінпанель тимчасово недоступна.',
      ...(error instanceof StoreError && error.code==='ADMIN_NOT_CONFIGURED' ? {configuration:error.configuration} : {}),
    },error instanceof StoreError?error.status:503);
  }
}
