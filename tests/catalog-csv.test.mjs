import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseCsv,exportCsv} from '../server/catalog.js';

const row={id:'loza-001',version:3,name:'Назва; "тест"',price_kop:12550,confirmed_price_kop:12550,stock:2,available:1,
  characteristics_confirmed:0,details_json:JSON.stringify({taste:'Солодкий, гармонійний',ripening:'Ранній',color:'Білий',kishmish:true,berry:'5–8 г',shape:'Овальна',frost:'До –23 °C'})};
test('CSV round-trip preserves Ukrainian, semicolons, quotes, decimals, flags and all characteristics',()=>{
  const csv=exportCsv([row]);assert.ok(csv.startsWith('\uFEFF'));
  const [parsed]=parseCsv(csv);assert.equal(parsed.name,row.name);assert.equal(parsed.price_uah,'125.50');assert.equal(parsed.price_confirmed,'1');
  assert.equal(parsed.taste,'Солодкий, гармонійний');assert.equal(parsed.kishmish,'1');assert.equal(parsed.berry,'5–8 г');
  assert.equal(parsed.version,'3');assert.equal(parsed.characteristics_confirmed,'0');assert.equal(Object.keys(parsed).length,15);
});
test('CSV export neutralizes spreadsheet formulas and round-trips literal text',()=>{
  const csv=exportCsv([{...row,name:'=HYPERLINK("bad")'}]);assert.match(csv,/'=HYPERLINK/);assert.equal(parseCsv(csv)[0].name,'=HYPERLINK("bad")');
});
test('CSV handles comma-separated files and rejects malformed headers, quoting and excess rows',()=>{
  const csv=exportCsv([row]);const comma=csv.split('\r\n').map(line=>line.replace(/";"/g,'","')).join('\n');assert.equal(parseCsv(comma)[0].price_uah,'125.50');
  for(const bad of ['name;price\nA;5',csv.replace('product_id','photo_url'),csv+'"unclosed',exportCsv(Array.from({length:108},()=>row))])assert.throws(()=>parseCsv(bad));
});
