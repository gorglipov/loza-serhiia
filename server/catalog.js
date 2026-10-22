import {body,digest,json,StoreError} from './checkout.js';

const columns=['product_id','version','name','price_uah','price_confirmed','stock','available','taste','ripening','color','kishmish','berry','shape','frost','characteristics_confirmed'];
const invalid=message=>new StoreError('INVALID_CSV',message);
const integer=(value,max)=>/^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value)<=max;
const flag=(value,column,row)=>{if(!['0','1'].includes(value))throw invalid(`Рядок ${row}: ${column} має бути 0 або 1.`);return value==='1';};

// RFC 4180 quoting, UTF-8 BOM, Excel semicolon or comma delimiter. No eval/formulas.
export function parseCsv(source) {
  if(typeof source!=='string' || !source.length || source.length>250000)throw invalid('Оберіть CSV до 250 КБ.');
  source=source.replace(/^\uFEFF/,'');
  const delimiter=source.slice(0,source.indexOf('\n')<0?source.length:source.indexOf('\n')).includes(';')?';':',';
  const rows=[];let row=[],cell='',quoted=false,closed=false;
  function endCell(){row.push(cell);cell='';closed=false;}
  function endRow(){endCell();if(row.some(value=>value!==''))rows.push(row);row=[];if(rows.length>108)throw invalid('В одному імпорті допускається до 107 товарів.');}
  for(let i=0;i<source.length;i++){
    const char=source[i];
    if(quoted){if(char==='"'){if(source[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=char;continue;}
    if(char==='"'){if(cell || closed)throw invalid('Некоректні лапки у CSV.');quoted=true;}
    else if(char===delimiter)endCell();
    else if(char==='\n' || char==='\r'){if(char==='\r' && source[i+1]==='\n')i++;endRow();}
    else {if(closed)throw invalid('Після закриття лапок очікується роздільник.');cell+=char;}
  }
  if(quoted)throw invalid('У CSV не закрито лапки.');
  if(row.length || cell || closed)endRow();
  if(rows.length<2 || rows[0].length!==columns.length || !columns.every((name,i)=>rows[0][i]===name))throw invalid('Заголовки не відповідають шаблону. Завантажте актуальний CSV з адмінпанелі.');
  return rows.slice(1).map((values,index)=>{
    if(values.length!==columns.length)throw invalid(`Рядок ${index+2}: неправильна кількість колонок.`);
    return Object.fromEntries(columns.map((name,i)=>[name,values[i].replace(/^'(?=[=+\-@])/,'').trim()]));
  });
}

function normalize(source,productInput) {
  const seen=new Set();
  return parseCsv(source).map((row,index)=>{
    const n=index+2,id=row.product_id;
    if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || seen.has(id))throw invalid(`Рядок ${n}: невідомий або повторний код товару.`);
    seen.add(id);
    if(!integer(row.version,100000000) || !integer(row.stock,1000000))throw invalid(`Рядок ${n}: перевірте версію та цілий залишок.`);
    if(row.price_uah && !/^\d{1,7}([.,]\d{1,2})?$/.test(row.price_uah))throw invalid(`Рядок ${n}: ціна має бути додатною сумою у гривнях.`);
    const [whole,fraction='']=row.price_uah.replace(',','.').split('.');
    const input={version:Number(row.version),name:row.name,priceKop:row.price_uah?Number(whole)*100+Number(fraction.padEnd(2,'0')):null,
      stock:Number(row.stock),available:flag(row.available,'available',n),priceConfirmed:flag(row.price_confirmed,'price_confirmed',n),
      characteristicsConfirmed:flag(row.characteristics_confirmed,'characteristics_confirmed',n),details:{kishmish:flag(row.kishmish,'kishmish',n)}};
    for(const key of ['taste','ripening','color','berry','shape','frost'])input.details[key]=row[key];
    let payload;try{payload=productInput(input);}catch{throw invalid(`Рядок ${n}: перевірте назву, ціну, підтвердження та наявність. Активний товар потребує підтвердженої ціни й залишку.`);}
    return {id,version:input.version,payload};
  }).sort((a,b)=>a.id.localeCompare(b.id,'en'));
}

export function exportCsv(rows) {
  const cell=value=>'"'+String(value??'').replace(/^[=+\-@]/,"'$&").replace(/"/g,'""')+'"';
  const lines=[columns];
  for(const row of rows){
    const d=JSON.parse(row.details_json);
    lines.push([row.id,row.version,row.name,row.price_kop===null?'':(row.price_kop/100).toFixed(2),
      row.price_kop!==null && row.confirmed_price_kop===row.price_kop?1:0,row.stock,row.available && row.stock>0 && row.price_kop!==null && row.confirmed_price_kop===row.price_kop?1:0,
      d.taste,d.ripening,d.color,d.kishmish?1:0,d.berry,d.shape,d.frost,row.characteristics_confirmed]);
  }
  return '\uFEFF'+lines.map(row=>row.map(cell).join(';')).join('\r\n')+'\r\n';
}

export async function catalogApi(context,database,route,actor,productInput,commandId) {
  const method=context.request.method;
  if(method==='GET' && route==='catalog/export'){
    const rows=await database.prepare(`SELECT p.*,v.version,c.confirmed_price_kop,c.characteristics_confirmed FROM products p
      JOIN product_catalog c ON c.product_id=p.id JOIN admin_product_versions v ON v.product_id=p.id WHERE p.is_demo=0 ORDER BY p.id`).all();
    return json({success:true,csv:exportCsv(rows.results),count:rows.results.length});
  }
  if(method!=='POST' || !['catalog/preview','catalog/import'].includes(route))throw new StoreError('NOT_FOUND','Не знайдено.',404);
  const input=await body(context.request,524288),rows=normalize(input.csv,productInput);
  const hash=await digest(JSON.stringify({actor,rows}));
  let id;
  if(route==='catalog/import'){
    id=commandId(context.request);
    if(input.previewHash!==hash)throw invalid('Файл змінився. Спочатку перевірте його ще раз.');
    const saved=await database.prepare('SELECT actor,payload_hash,row_count FROM catalog_imports WHERE id=?').bind(id).first();
    if(saved){if(saved.actor!==actor || saved.payload_hash!==hash)throw new StoreError('IMPORT_CONFLICT','Ключ імпорту вже використано.',409);return json({success:true,count:saved.row_count,replayed:true});}
  }
  const current=await database.prepare(`SELECT p.id,v.version FROM products p JOIN product_catalog c ON c.product_id=p.id
    JOIN admin_product_versions v ON v.product_id=p.id WHERE p.is_demo=0`).all();
  const versions=new Map(current.results.map(row=>[row.id,row.version]));
  for(const row of rows){
    if(!versions.has(row.id))throw invalid(`Товар ${row.id} не входить до каталогу. Створення товарів цим імпортом не дозволено.`);
    if(versions.get(row.id)!==row.version)throw new StoreError('VERSION_CONFLICT',`Товар ${row.id} змінено. Завантажте свіжий CSV, щоб не втратити зміни або резерви замовлень.`,409);
  }
  if(route==='catalog/preview')return json({success:true,previewHash:hash,count:rows.length,
    rows:rows.map(row=>({id:row.id,name:row.payload.name,priceKop:row.payload.priceKop,stock:row.payload.stock,available:Boolean(row.payload.available),priceConfirmed:Boolean(row.payload.priceConfirmed)}))});
  try{
    // One INSERT; its trigger applies every product mutation, audit and version check atomically.
    await database.prepare('INSERT INTO catalog_imports(id,actor,payload_hash,rows_json,row_count) VALUES(?,?,?,?,?)')
      .bind(id,actor,hash,JSON.stringify(rows),rows.length).run();
  }catch(error){
    const saved=await database.prepare('SELECT actor,payload_hash,row_count FROM catalog_imports WHERE id=?').bind(id).first();
    if(saved?.actor===actor && saved.payload_hash===hash)return json({success:true,count:saved.row_count,replayed:true});
    if(String(error.message).includes('LOZA_VERSION_CONFLICT'))throw new StoreError('VERSION_CONFLICT','Під час імпорту змінилися товари або залишки. Жодних змін не збережено; завантажте новий CSV.',409);
    throw error;
  }
  return json({success:true,count:rows.length,replayed:false});
}
