import test from 'node:test';import assert from 'node:assert/strict';
import {inspectReceipt,validateReceiptAnalysis,RECEIPT_MODEL} from '../server/receipt-analysis.js';
const valid={contentSafety:'safe',isPaymentReceipt:true,isTestOrSample:false,transferStatus:'completed',amount:'100.00',currency:'UAH',confidence:.99};
const code=(value,expected)=>assert.throws(()=>validateReceiptAnalysis(typeof value==='string'?value:JSON.stringify(value),10000),e=>e.code===expected);
test('AI exact amount uses integer kopiykas, rejects adult/uncertain/nonreceipt/pending/foreign-currency/ambiguous output',()=>{
 assert.equal(validateReceiptAnalysis(JSON.stringify(valid),10000).bankVerified,false);
 for(const amount of ['99.99','100.01','200.00'])code({...valid,amount},'RECEIPT_AMOUNT_MISMATCH');
 code({...valid,contentSafety:'sexual'},'RECEIPT_CONTENT_BLOCKED');
 for(const update of [{isTestOrSample:true},{contentSafety:'uncertain'},{isPaymentReceipt:false},{transferStatus:'pending'},{confidence:.94},{confidence:2},{currency:'USD'},{amount:100},{amount:'100,00'},{amount:'100.001'},{amount:'1e2'}])code({...valid,...update},'RECEIPT_UNREADABLE');
 for(const text of ['','not json','```json\n'+JSON.stringify(valid)+'\n```','null','[]'])code(text,'RECEIPT_UNREADABLE');
});
test('AI disabled sends nothing; enabled without binding fails closed; PDF cannot bypass image analysis',async()=>{
 let calls=0;assert.equal((await inspectReceipt({AI:{run:()=>{calls++}}},{mimeType:'image/png'},'fixture',10000)).mode,'manual');assert.equal(calls,0);
 await assert.rejects(inspectReceipt({RECEIPT_AI_ENABLED:'true'},{mimeType:'image/png'},'fixture',10000),e=>e.code==='RECEIPT_CHECK_UNAVAILABLE');
 await assert.rejects(inspectReceipt({RECEIPT_AI_ENABLED:'true',AI:{run:()=>{calls++}}},{mimeType:'application/pdf'},'fixture',10000),e=>e.code==='RECEIPT_IMAGE_REQUIRED');assert.equal(calls,0);
});
test('AI passes only file data to the bound model, no expected amount, bank keys or remote image URLs',async()=>{
 let request;const env={RECEIPT_AI_ENABLED:'true',AI:{run:async(model,input)=>{request={model,input};return {choices:[{message:{content:JSON.stringify(valid)}}]}}}};
 const result=await inspectReceipt(env,{mimeType:'image/png'},'fixtureBase64',10000);assert.equal(result.amountKop,10000);assert.equal(result.bankVerified,false);assert.equal(request.model,RECEIPT_MODEL);assert.equal(request.input.store,false);
 assert.equal(request.input.messages[0].content[1].image_url.url,'data:image/png;base64,fixtureBase64');assert.equal(request.input.messages[0].content[0].text.includes('10000'),false);
 for(const response of [{response:'bad'},null,{choices:[]}])await assert.rejects(inspectReceipt({...env,AI:{run:async()=>response}},{mimeType:'image/png'},'fixture',10000),e=>e.code==='RECEIPT_UNREADABLE');
 await assert.rejects(inspectReceipt({...env,AI:{run:async()=>{throw Error('sensitive provider payload')}}},{mimeType:'image/png'},'fixture',10000),e=>e.code==='RECEIPT_CHECK_UNAVAILABLE'&&!e.message.includes('sensitive'));
});
