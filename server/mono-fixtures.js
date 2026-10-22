// Synthetic data only. This transport can never call a bank or use an owner's token.
export function monoFixtures(epoch){
  const item=(id,amount,extra={})=>({id:'fixture-'+id,time:epoch-120,amount,currencyCode:980,hold:false,...extra});
  const statement=[item('incoming-500',50000),item('incoming-100',10000),item('held',25000,{hold:true}),
    item('mismatch',40000),item('debit',-5000),item('foreign',10000,{currencyCode:840})];
  statement.push({...statement[0],description:'Private fixture description',counterIban:'PRIVATE_FIXTURE_IBAN',counterName:'<script>bad()</script>',balance:123456789});
  const hints=[...statement.slice(0,-1).map(x=>({...x})),item('forged',999000)];hints.find(x=>x.id==='fixture-mismatch').amount=30000;
  return {hints,statement,orders:[{id:'MONO-DEMO-A',amount:50000},{id:'MONO-DEMO-B',amount:50000},{id:'MONO-DEMO-C',amount:10000}],
    transport:async(url,options)=>{
      if(!url.startsWith('https://api.monobank.ua/personal/statement/fixture-account/') || options.headers['X-Token']!=='fixture-personal-token-for-tests')throw new Error('Invalid fixture transport');
      return Response.json(statement);
    }};
}
