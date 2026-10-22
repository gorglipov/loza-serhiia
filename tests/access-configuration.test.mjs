import {test} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {adminConfiguration,authenticate,protectAdmin} from '../server/access.js';

const domain='https://config-test.cloudflareaccess.com',aud='c'.repeat(64);
const env={ACCESS_TEAM_DOMAIN:domain,ACCESS_AUD:aud,ADMIN_EMAILS:'owner@example.test',ADMIN_CSRF_SECRET:'isolated-fixture-secret-'.repeat(3)};
const good=()=>({present:true,formatValid:true});

test('configuration requires exactly four admin fields and reports only booleans',()=>{
  const result=adminConfiguration(env);
  assert.deepEqual(Object.keys(result),['ACCESS_TEAM_DOMAIN','ACCESS_AUD','ADMIN_EMAILS','ADMIN_CSRF_SECRET']);
  for(const entry of Object.values(result))assert.deepEqual(entry,good());
  for(const field of Object.keys(result)){
    const config={...env};delete config[field];const flags=adminConfiguration(config);
    assert.deepEqual(flags[field],{present:false,formatValid:false});
    assert.ok(Object.values(flags).every(item=>Object.values(item).every(value=>typeof value==='boolean')));
  }
});
test('canonical HTTPS URL, bare hostname, trailing slash and whitespace are supported',()=>{
  for(const value of [domain,'config-test.cloudflareaccess.com',domain+'/', ' CONFIG-TEST.cloudflareaccess.com/ ', ' '+domain+'\n']){
    assert.deepEqual(adminConfiguration({...env,ACCESS_TEAM_DOMAIN:value}).ACCESS_TEAM_DOMAIN,good());
  }
  assert.deepEqual(adminConfiguration({...env,ACCESS_AUD:' '+aud+'\n'}).ACCESS_AUD,good());
});
test('non-Cloudflare, insecure and attacker-controlled issuer/JWKS URLs stay forbidden',()=>{
  for(const value of ['http://config-test.cloudflareaccess.com','https://evil.test','https://config-test.cloudflareaccess.com.evil.test',
    'https://user@config-test.cloudflareaccess.com','https://config-test.cloudflareaccess.com:444','https://config-test.cloudflareaccess.com/path',
    domain+'?x=1',domain+'#x','https://-invalid.cloudflareaccess.com','https://invalid-.cloudflareaccess.com','a'.repeat(64)+'.cloudflareaccess.com',{},null]){
    assert.equal(adminConfiguration({...env,ACCESS_TEAM_DOMAIN:value}).ACCESS_TEAM_DOMAIN.formatValid,false);
  }
  for(const value of ['d'.repeat(63),'d'.repeat(65),'g'.repeat(64),'["'+aud+'"]',undefined]){
    assert.equal(adminConfiguration({...env,ACCESS_AUD:value}).ACCESS_AUD.formatValid,false);
  }
  assert.equal(adminConfiguration({...env,ADMIN_CSRF_SECRET:' '.repeat(64)}).ADMIN_CSRF_SECRET.formatValid,false);
});
test('configuration errors identify the field without exposing any value or allowing access',async()=>{
  const local={...env,ACCESS_TEAM_DOMAIN:'invalid-domain-fixture'};
  const response=await protectAdmin({env:local,request:new Request('https://preview.test/admin'),data:{},next:()=>{throw new Error('MUST NOT RUN');}});
  assert.equal(response.status,503);assert.match(response.headers.get('Cache-Control'),/no-store/);
  const payload=await response.json();assert.equal(payload.code,'ADMIN_NOT_CONFIGURED');assert.match(payload.error,/ACCESS_TEAM_DOMAIN/);
  assert.deepEqual(payload.configuration.ACCESS_TEAM_DOMAIN,{present:true,formatValid:false});
  const encoded=JSON.stringify(payload);
  for(const value of Object.values(local))assert.ok(!encoded.includes(value));
  const forbidden=await protectAdmin({env:{...env,ACCESS_TEAM_DOMAIN:'config-test.cloudflareaccess.com'},request:new Request('https://preview.test/admin'),data:{},next:()=>{throw new Error('MUST NOT RUN');}});
  assert.equal(forbidden.status,403);assert.equal((await forbidden.json()).code,'ADMIN_FORBIDDEN');
});
test('bare team hostname validates a real RSA-signed JWT against the canonical HTTPS issuer',async t=>{
  const keys=await webcrypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  const jwk={...await webcrypto.subtle.exportKey('jwk',keys.publicKey),kid:'config-fixture',alg:'RS256',use:'sig'};
  t.mock.method(globalThis,'fetch',async url=>{assert.equal(url,domain+'/cdn-cgi/access/certs');return Response.json({keys:[jwk]});});
  const now=Math.floor(Date.now()/1000),header=Buffer.from(JSON.stringify({alg:'RS256',kid:jwk.kid})).toString('base64url');
  const payload=Buffer.from(JSON.stringify({iss:domain,aud:[aud],iat:now-10,exp:now+600,type:'app',sub:'fixture-owner',email:env.ADMIN_EMAILS})).toString('base64url');
  const signature=await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5',keys.privateKey,Buffer.from(header+'.'+payload));
  const token=header+'.'+payload+'.'+Buffer.from(signature).toString('base64url');
  const request=new Request('https://preview.test/admin',{headers:{'Cf-Access-Jwt-Assertion':token}});
  const user=await authenticate(request,{...env,ACCESS_TEAM_DOMAIN:' CONFIG-TEST.cloudflareaccess.com/ ',ACCESS_AUD:' '+aud+' '});
  assert.equal(user.email,env.ADMIN_EMAILS);
  await assert.rejects(authenticate(request,{...env,ACCESS_AUD:'b'.repeat(64)}),error=>error.code==='ADMIN_FORBIDDEN');
  await assert.rejects(authenticate(request,{...env,ADMIN_EMAILS:'other@example.test'}),error=>error.code==='ADMIN_FORBIDDEN');
});
