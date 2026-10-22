import {test} from 'node:test';
import assert from 'node:assert/strict';
import {onRequest} from '../functions/api/np.js';
test('Nova Poshta settlement, warehouse and street mapping stays compatible without live requests',async()=>{
  const original=globalThis.fetch,seen=[],ref='11111111-1111-1111-1111-111111111111';
  globalThis.fetch=async(url,options)=>{assert.equal(url,'https://api.novaposhta.ua/v2.0/json/');seen.push(JSON.parse(options.body));return Response.json({success:true,data:[{Ref:ref,Description:'Київ',AreaDescription:'Київська',ShortAddress:'Хрещатик 1',Number:'1',StreetsTypeDescription:'вул.'}]});};
  const call=(query,headers={})=>onRequest({request:new Request('https://preview.loza.test/api/np?'+query,{headers}),env:{NOVA_POSHTA_API_KEY:'fixture-only'}});
  try{
    for(const [type,method] of [['settlements','getSettlements'],['warehouses','getWarehouses'],['streets','getStreet']]){
      const response=await call('type='+type+'&q=Київ&settlementRef='+ref);assert.equal(response.status,200);const data=await response.json();assert.equal(data.data[0].ref,ref);assert.ok(data.data[0].label);assert.equal(seen.at(-1).calledMethod,method);assert.equal(JSON.stringify(data).includes('fixture-only'),false);
    }
    assert.equal(seen[1].methodProperties.SettlementRef,ref);assert.equal(seen[2].methodProperties.CityRef,ref);
    assert.equal((await call('type=warehouses&settlementRef=invalid')).status,400);
    assert.equal((await call('type=settlements&q=Київ',{Origin:'https://foreign.test'})).status,403);assert.equal(seen.length,3);
  }finally{globalThis.fetch=original;}
});
