import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deliverPending} from '../server/telegram.js';

test('every Telegram claim has a fresh lease and retry_after starts after the failed response',async t=>{
  let clock=1800000000000,requests=0;const claims=[],outcomes=[];
  t.mock.method(Date,'now',()=>clock);
  t.mock.method(globalThis,'fetch',async()=>{
    requests++;
    if(requests===1){clock+=20000;return Response.json({ok:true,result:{message_id:1}});}
    clock+=5000;return Response.json({ok:false,error_code:429,parameters:{retry_after:7}},{status:429});
  });
  const database={prepare(sql){return{bind(...args){return{
    async first(){
      if(sql.startsWith('UPDATE telegram_outbox SET state=')){
        const [,leaseUntil,id,claimedAt]=args;claims.push({leaseUntil,claimedAt});
        assert.equal(leaseUntil,Math.floor(clock/1000)+90);
        return{id,kind:'test',attempts:1};
      }
      return{enabled:1};
    },
    async all(){return{results:[{id:1},{id:2}]};},
    async run(){if(sql.includes('message_id=?'))outcomes.push(args);return{success:true};}
  };},async first(){return{enabled:1};}};}};
  await deliverPending(database,{TELEGRAM_BOT_TOKEN:'12345:isolated_fixture',TELEGRAM_CHAT_ID:'123456'},2);
  assert.equal(claims.length,2);assert.equal(claims[1].claimedAt-claims[0].claimedAt,20);
  assert.equal(outcomes[0][0],'sent');assert.equal(outcomes[1][0],'retry');
  assert.equal(outcomes[1][2],Math.floor(clock/1000)+7);
});
