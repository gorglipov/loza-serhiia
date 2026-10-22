(() => {
  'use strict';
  const $=id=>document.getElementById(id),content=$('content'),dialog=$('editor');
  let csrf='',view='dashboard',offset=0,busy=false,loadId=0;
  const labels={pending:'Очікує підтвердження',confirmed:'Підтверджено',shipped:'Відправлено',completed:'Виконано',cancelled:'Скасовано'};
  const eventLabels={queued:'У черзі',retry:'Повторна спроба',sending:'Надсилання',sent:'Надіслано',failed:'Помилка',uncertain:'Перевірте доставку'};
  const paymentLabels={awaiting:'Очікуємо оплату',reported:'Покупець повідомив',confirmed:'Надходження підтверджено вручну',not_paid:'Не оплачено'};
  const money=kop=>kop===null?'Ціну не задано':new Intl.NumberFormat('uk-UA',{style:'currency',currency:'UAH'}).format(kop/100);
  const date=value=>value?new Date(value.replace(' ','T')+'Z').toLocaleString('uk-UA'):'Попереднє замовлення';
  function el(tag,text,cls) {const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
  function notice(text,error=false){$('notice').hidden=false;$('notice').className=error?'error':'';$('notice').textContent=text;}
  async function api(path,data,key) {
    const response=await fetch('/api/admin/'+path,{method:data===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',headers:data===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf,'Idempotency-Key':key || crypto.randomUUID()},body:data===undefined?undefined:JSON.stringify(data)});
    let result;try{result=await response.json();}catch{throw new Error('Сесію завершено або Access потребує входу. Оновіть сторінку.');}
    if(!response.ok || !result.success)throw new Error(result.error || 'Запит не виконано.');return result;
  }
  function button(text,action,primary=false) {const b=el('button',text,primary?'primary':'secondary');b.type='button';b.addEventListener('click',action);return b;}
  function badge(status,dictionary=labels){return el('span',dictionary[status] || status,'badge '+(Object.hasOwn(dictionary,status)?status:''));}
  function table(headers,rows) {
    const wrap=el('div',undefined,'table-wrap'),t=el('table'),head=el('thead'),tr=el('tr'),body=el('tbody');
    headers.forEach(x=>tr.append(el('th',x)));head.append(tr);t.append(head,body);
    rows.forEach(values=>{const r=el('tr');values.forEach(value=>{const c=el('td');if(value instanceof Node)c.append(value);else c.textContent=value??'—';r.append(c);});body.append(r);});
    wrap.append(t);if(!rows.length)wrap.append(el('p','Немає записів за цим фільтром.','empty'));return wrap;
  }
  function searchToolbar(filters,callback,placeholder) {
    const bar=el('form',undefined,'toolbar'),search=el('input'),select=el('select');
    search.type='search';search.placeholder=placeholder;search.setAttribute('aria-label',placeholder);
    filters.forEach(([value,text])=>{const opt=el('option',text);opt.value=value;select.append(opt);});select.setAttribute('aria-label','Фільтр');
    let timer;search.addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(()=>callback(search.value,select.value),250);});select.addEventListener('change',()=>callback(search.value,select.value));
    bar.addEventListener('submit',e=>{e.preventDefault();callback(search.value,select.value);});bar.append(search,select);return bar;
  }
  async function saving(action) {
    if(busy)return;busy=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);
    try{const message=await action();notice(typeof message==='string'?message:'Зміни збережено.');}catch(error){notice(error.message,true);}finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);}
  }
  function openEditor(title){$('editorTitle').textContent=title;$('editorBody').replaceChildren();dialog.showModal();}
  function field(parent,title,value,options={}) {
    const label=el('label',title,options.wide?'wide':''),input=el(options.multiline?'textarea':'input');
    input.value=value??'';input.type=options.type || 'text';if(options.max)input.maxLength=options.max;if(options.required)input.required=true;
    if(options.type==='number'){input.min='0';input.max='1000000';input.step='1';}
    label.append(input);parent.append(label);return input;
  }
  function editProduct(product) {
    openEditor(product.name);const form=el('form'),grid=el('div',undefined,'form-grid');
    const name=field(grid,'Назва',product.name,{wide:true,max:160,required:true}),price=field(grid,'Ціна у гривнях (порожньо — без ціни)',product.price_kop===null?'':(product.price_kop/100).toFixed(2));price.inputMode='decimal';
    const confirmedLabel=el('label',undefined,'check wide'),confirmed=el('input');confirmed.type='checkbox';confirmed.checked=product.price_kop!==null && product.confirmed_price_kop===product.price_kop;confirmedLabel.append(confirmed,document.createTextNode('Підтверджую ціну для продажу'));grid.append(confirmedLabel);
    const activeLabel=el('label',undefined,'check wide'),active=el('input');active.type='checkbox';active.setAttribute('role','switch');active.checked=!!product.inStock;activeLabel.append(active,document.createTextNode('В наявності'));grid.append(activeLabel);
    const fields={};for(const [key,title] of Object.entries({ripening:'Термін дозрівання',color:'Колір',taste:'Смак',berry:'Ягода',shape:'Форма',frost:'Морозостійкість'}))fields[key]=field(grid,title,product.details[key],{max:500});
    const kishLabel=el('label',undefined,'check wide'),kish=el('input');kish.type='checkbox';kish.checked=!!product.details.kishmish;kishLabel.append(kish,document.createTextNode('Кишмиш'));grid.append(kishLabel);
    const reviewedLabel=el('label',undefined,'check wide'),reviewed=el('input');reviewed.type='checkbox';reviewed.checked=!!product.characteristics_confirmed;reviewedLabel.append(reviewed,document.createTextNode('Характеристики перевірено власником'));grid.append(reviewedLabel);
    if(product.source)form.append(el('p',`Джерело: ${product.source.document}, сторінка ${product.source.page}, рядок ${product.source.row}. Ціна у PDF: ${money(product.source.priceKop)}. Оригінальні дані джерела зберігаються окремо. Фото не потрібне.`,'hint'));
    const confirmationHint=el('p',confirmed.checked?'Ціна підтверджена — замовлення залежать від наявності.':'Ціна ще не підтверджена. Для покупки потрібно підтвердити її окремо.','hint');
    const updateHint=()=>{confirmationHint.textContent=confirmed.checked
      ? 'Ціну буде підтверджено після успішного збереження.'
      : 'Ціна не підтверджена — навіть якщо сорт «В наявності», покупка буде заблокована.';};
    price.addEventListener('input',()=>{
      // Any change to a previously confirmed price requires an explicit confirmation again.
      confirmed.checked=false;updateHint();
    });
    confirmed.addEventListener('change',updateHint);
    form.append(grid,confirmationHint,el('p','Наявність змінюєте лише ви. Замовлення та їх скасування її не змінюють. Для купівлі також потрібна підтверджена ціна.','hint'));
    const submit=el('button','Зберегти товар','secondary');submit.type='submit';
    const confirmSubmit=el('button','Підтвердити ціну і зберегти','primary');confirmSubmit.type='button';
    confirmSubmit.addEventListener('click',()=>{
      if(!price.value.trim()){notice('Спочатку введіть ціну товару.',true);price.focus();return;}
      confirmed.checked=true;updateHint();form.requestSubmit();
    });
    form.append(submit,confirmSubmit);
    form.addEventListener('submit',e=>{e.preventDefault();saving(async()=>{
      const value=price.value.trim().replace(',','.');if(value && !/^\d{1,7}(\.\d{1,2})?$/.test(value))throw new Error('Введіть ціну, наприклад 500,00.');
      const [whole,fraction='']=value.split('.');const priceKop=value?Number(whole)*100+Number(fraction.padEnd(2,'0')):null;
      if(confirmed.checked && priceKop===null)throw new Error('Спочатку введіть ціну, потім підтвердьте її.');
      const details={kishmish:kish.checked};Object.entries(fields).forEach(([key,input])=>details[key]=input.value);
      await api('products/'+encodeURIComponent(product.id),{version:product.version,name:name.value,priceKop,priceConfirmed:confirmed.checked,characteristicsConfirmed:reviewed.checked,available:active.checked,details});
      // Verify the same environment's persisted D1 state; do not say "confirmed" just because the POST returned 200.
      const verification=await api('products?'+new URLSearchParams({q:product.id}));
      const saved=verification.products?.find(row=>row.id===product.id);
      if(!saved || saved.price_kop!==priceKop || (confirmed.checked && saved.confirmed_price_kop!==priceKop)){
        throw new Error('Підтвердження ціни не збережено на сервері. Не оновлюйте ціну повторно; перевірте середовище Preview/Production.');
      }
      const wasConfirmed=Boolean(confirmed.checked);
      dialog.close();await load();
      return wasConfirmed ? 'Ціну підтверджено й збережено. Перевірте наявність і відкрийте каталог у цьому ж середовищі.' : 'Товар збережено без підтвердження ціни.';
    });});$('editorBody').append(form);
  }
  async function editOrder(id) {
    try{
      const {order:o,items,payment,paymentReady,paymentTerms}=await api('orders/'+encodeURIComponent(id));openEditor('Замовлення');
      const dl=el('dl',undefined,'detail');for(const [label,value]of [['Номер',o.id],['Дата',date(o.created_at)],['Сума',money(o.amount_kop)],['Покупець',o.buyer_name],['Телефон',o.phone],['Доставка',[o.city,o.delivery_method==='nova_poshta'?'Нова пошта':o.delivery_method==='ukrposhta'?'Укрпошта':'',o.delivery_branch].filter(Boolean).join(' · ')],['Умови оплати',/^\[LOZA_PAYMENT:deposit_cod\] /.test(o.comment||'') ? 'Передоплата 100 грн, післяплата '+money(Math.max(0,o.amount_kop-10000)) : /^\[LOZA_PAYMENT:full\] /.test(o.comment||'') ? 'Повна передоплата '+money(o.amount_kop) : 'Не обрано (старе замовлення)'],['Статус оплати',paymentReady?(payment?paymentLabels[payment.state] || payment.state:'Немає умов оплати'):'Облік оплати ще не налаштовано'],['Коментар',(o.comment||'').replace(/^\[LOZA_PAYMENT:(?:full|deposit_cod)\] /,'') || '—']])dl.append(el('dt',label),el('dd',value || '—'));
      $('editorBody').append(dl,table(['Товар','Кількість','Сума'],items.map(i=>[i.product_name,i.quantity,money(i.line_total_kop)])));
      const form=el('form'),label=el('label','Статус замовлення'),select=el('select');
      const next={pending:['confirmed','cancelled'],confirmed:['shipped','cancelled'],shipped:['completed']}[o.status] || [];
      [o.status,...next].forEach(status=>{const option=el('option',labels[status] || status);option.value=status;select.append(option);});label.append(select);form.append(label);form.className='actions';
      if(next.length){const submit=el('button','Змінити статус','primary');submit.type='submit';form.append(submit);form.addEventListener('submit',e=>{e.preventDefault();saving(async()=>{if(select.value===o.status)return;if(select.value==='cancelled' && !confirm('Скасувати замовлення? Наявність сортів не зміниться.'))return;await api('orders/'+encodeURIComponent(id)+'/status',{version:o.version,status:select.value});dialog.close();await load();});});}
      $('editorBody').append(form);
      const payPanel=el('section',undefined,'payment-check');
      payPanel.append(el('h3','Контроль надходження оплати'));
      if(!paymentReady) {
        payPanel.append(el('p','Міграція 0009_payment_tracking ще не застосована до D1 цього середовища. Замовлення залишаються доступними, але статус оплати поки не змінюється.','hint'));
      }else if(!payment || !paymentTerms?.mode) {
        payPanel.append(el('p','Для цього старого замовлення не записані умови передоплати. Не підтверджуйте платіж без перевірки обставин.','hint'));
      }else{
        payPanel.append(el('p','Передоплата за умовами замовлення: '+money(paymentTerms.advanceKop)+'. Залишок післяплати: '+money(paymentTerms.codKop)+'. Доставка і комісії Нової пошти окремо.','hint'));
        payPanel.append(el('p','Поточний статус: '+(paymentLabels[payment.state]||payment.state)+' · версія '+payment.version,'hint'));
        if(payment.updated_by)payPanel.append(el('p','Остання зміна: '+payment.updated_by+' · '+date(payment.updated_at),'hint'));
        const payForm=el('form',undefined,'actions'),payLabel=el('label','Статус оплати'),paySelect=el('select');
        for(const [value,title]of Object.entries(paymentLabels)){
          const option=el('option',title);option.value=value;paySelect.append(option);
        }
        paySelect.value=payment.state;payLabel.append(paySelect);
        const confirmHint=el('p','«Покупець повідомив» не означає, що кошти отримано. Вибирайте «Надходження підтверджено вручну» лише після перевірки рахунку. Це стосується тільки передоплати; післяплата окремо.','hint');
        const paySubmit=el('button','Зберегти статус оплати','primary');paySubmit.type='submit';
        payForm.append(payLabel,paySubmit);
        payForm.addEventListener('submit',e=>{
          e.preventDefault();
          if(paySelect.value===payment.state)return;
          const confirmedAfterBankCheck=paySelect.value==='confirmed';
          if(confirmedAfterBankCheck && !confirm('Ви особисто перевірили зарахування '+money(paymentTerms.advanceKop)+' на свій рахунок? Дані покупця та сам вибір способу оплати НЕ є підтвердженням.'))return;
          saving(async()=>{
            await api('orders/'+encodeURIComponent(id)+'/payment',{version:payment.version,state:paySelect.value,confirmedAfterBankCheck});
            dialog.close();await load();
            return 'Статус оплати оновлено. Це ручна відмітка, а не банківська перевірка сайтом.';
          });
        });
        payPanel.append(confirmHint,payForm);
      }
      $('editorBody').append(payPanel);
    }catch(error){notice(error.message,true);}
  }
  async function dashboard() {
    const data=await api('dashboard'),stats=el('div',undefined,'stats'),counts=Object.fromEntries(data.orders.map(r=>[r.status,r.count]));
    for(const [title,value,caption]of [['Усього товарів',data.products.total,'Каталог D1'],['Нові замовлення',counts.pending || 0,'Очікують підтвердження'],['Сорти в наявності',data.products.active || 0,'Наявність визначає власник']]){const box=el('article',undefined,'stat');box.append(el('span',title),el('strong',value),el('small',caption));stats.append(box);}
    const card=el('section',undefined,'card'),grid=el('div',undefined,'status-grid');card.append(el('h2','Замовлення за статусами'));
    for(const [status,title]of Object.entries(labels)){const item=el('div',undefined,'status-card');item.append(el('span',title),el('strong',counts[status] || 0));grid.append(item);}card.append(grid);return [stats,card];
  }
  async function products() {
    const results=el('div');let query=0,currentQuery='',currentFilter='all';
    function availabilitySwitch(p){
      if(p.is_demo)return el('span','Архівний демотовар','muted');
      const label=el('label',undefined,'availability-switch'),toggle=el('input');toggle.type='checkbox';toggle.setAttribute('role','switch');toggle.setAttribute('aria-label','Наявність сорту '+p.name);toggle.checked=p.inStock;
      label.append(toggle,el('span',p.inStock?'В наявності':'Немає в наявності'));
      toggle.addEventListener('change',async()=>{const next=toggle.checked;if(busy){toggle.checked=p.inStock;return;}toggle.disabled=true;let applied=false;try{await saving(async()=>{await api('products/'+encodeURIComponent(p.id)+'/availability',{version:p.version,inStock:next});applied=true;await refresh(currentQuery,currentFilter);return 'Наявність сорту оновлено.';});}finally{if(!applied)toggle.checked=p.inStock;toggle.disabled=false;}});return label;
    }
    async function refresh(q='',filter='all'){currentQuery=q;currentFilter=filter;const id=++query;try{const data=await api('products?'+new URLSearchParams({q,filter}));if(id!==query)return;results.replaceChildren(table(['Товар','Ціна','Наявність',''],data.products.map(p=>[p.name,money(p.price_kop),availabilitySwitch(p),button('Редагувати',()=>editProduct(p))])));}catch(error){notice(error.message,true);}}
    const bar=searchToolbar([['all','Усі товари'],['active','В наявності'],['inactive','Немає в наявності'],['demo','Демонстраційні']],refresh,'Пошук за назвою або кодом');
    const bulk=el('section',undefined,'card csv-tools');bulk.append(el('h2','Масове редагування CSV'),el('p','Завантажте актуальний файл усіх 107 сортів, внесіть зміни та перевірте перед імпортом. Ціна — у гривнях; підтвердження й доступність — 0 або 1. Фото не потрібні.','hint'));
    bulk.append(button('Завантажити CSV',()=>saving(async()=>{const data=await api('catalog/export');const url=URL.createObjectURL(new Blob([data.csv],{type:'text/csv;charset=utf-8'})),link=el('a');link.href=url;link.download='loza-catalog.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);})),button('Імпортувати CSV',()=>importCatalog()));
    await refresh();return [bulk,bar,results];
  }
  function importCatalog(){
    openEditor('Імпорт каталогу');const form=el('form'),file=field(form,'CSV-файл','',{type:'file'});file.accept='.csv,text/csv';file.required=true;
    const message=el('p','Порожня ціна залишає «Ціну уточнюйте». Наявність задається available=1 або 0, кількість вводити не потрібно. Для купівлі також потрібна підтверджена ціна. Імпорт не змінює початкове джерело PDF.','hint'),preview=el('div'),status=el('p');status.setAttribute('role','status');
    const check=el('button','Перевірити файл','primary');check.type='submit';let source='',result=null,key=null;
    const apply=button('Застосувати імпорт',()=>saving(async()=>{if(!result)return;const data=await api('catalog/import',{csv:source,previewHash:result.previewHash},key);dialog.close();await load();return `Імпортовано ${data.count} товарів. Зміни записано в історію.`;}),true);apply.hidden=true;
    file.addEventListener('change',()=>{result=null;source='';key=null;apply.hidden=true;preview.replaceChildren();status.textContent='';});
    form.addEventListener('submit',e=>{e.preventDefault();saving(async()=>{
      apply.hidden=true;result=null;const selected=file.files[0];if(!selected || selected.size>250000)throw new Error('Оберіть UTF-8 CSV до 250 КБ.');
      source=await selected.text();result=await api('catalog/preview',{csv:source});key=crypto.randomUUID();
      preview.replaceChildren(table(['Код / назва','Ціна','Наявність'],result.rows.map(row=>[row.id+' · '+row.name,money(row.priceKop),row.available?'В наявності':'Немає в наявності'])));
      status.textContent=`Перевірено товарів: ${result.count}. Перегляньте дані перед збереженням.`;apply.hidden=false;
    });});form.append(message,check,status,preview,apply);$('editorBody').append(form);
  }
  async function orders() {
    const paymentNotice=el('p',undefined,'hint'),results=el('div'),pagination=el('div',undefined,'pagination');let search='',status='',query=0;
    async function refresh(q=search,s=status){const id=++query;search=q;status=s;try{const data=await api('orders?'+new URLSearchParams({q,status,offset}));if(id!==query)return;
      results.replaceChildren(table(['Номер / дата','Товари','Сума','Доставка','Оплата',''],data.orders.map(o=>{const number=el('div',o.id,'order-id');number.append(el('small',date(o.created_at)));return[number,o.items.map(i=>i.name+' × '+i.quantity).join(', ') || 'Попереднє оформлення',money(o.amount_kop),badge(o.status),o.payment_state?paymentLabels[o.payment_state]||o.payment_state:'—',button('Деталі',()=>editOrder(o.id))];})));
      paymentNotice.textContent=data.paymentReady?'Оплата відстежується окремо від статусу замовлення. Підтвердження надходження здійснює лише власник.':'Облік оплати ще не ввімкнено: спочатку застосуйте міграцію 0009 до Preview D1.';
      pagination.replaceChildren();if(offset>0)pagination.append(button('← Попередні',()=>{offset=Math.max(0,offset-50);refresh();}));if(data.hasMore)pagination.append(button('Наступні →',()=>{offset+=50;refresh();}));
    }catch(error){notice(error.message,true);}}
    const bar=searchToolbar([['','Усі статуси'],...Object.entries(labels)],(q,s)=>{offset=0;refresh(q,s);},'Номер замовлення');await refresh();return[bar,paymentNotice,results,pagination];
  }
  async function audit() {
    const holder=el('div');let before='';
    async function refresh(){const data=await api('audit'+(before?'?before='+before:''));holder.replaceChildren(table(['Коли / хто','Дія','Об’єкт','Зміни'],data.changes.map(r=>{const details=el('details'),summary=el('summary','Переглянути');details.append(summary,el('pre',JSON.stringify({до:JSON.parse(r.before_json),після:JSON.parse(r.after_json)},null,2),'audit-detail'));return [date(r.created_at)+' · '+r.actor,r.action,r.target,details];})));
      if(data.changes.length===50)holder.append(button('Старіші зміни',()=>{before=data.changes.at(-1).id;refresh().catch(e=>notice(e.message,true));}));
      if(data.notifications.length)holder.append(el('h2','Дії зі сповіщеннями'),table(['Коли','Адміністратор','Дія','Подія'],data.notifications.map(r=>[date(r.created_at),r.actor,r.action,r.event_key])));
    }await refresh();return[holder];
  }
  async function telegram() {
    const data=await api('telegram'),card=el('section',undefined,'card');card.append(el('h2','Сповіщення власнику'),el('p',data.configured?'Серверні секрети Telegram налаштовані.':'У цьому середовищі відсутні або некоректні секрети Telegram.','muted'));
    card.append(el('p','Бот надсилає номер, товари, кількість, суму та статус. Телефон, ім’я й адреса покупця не надсилаються.','hint'));
    const actions=el('div',undefined,'actions');actions.append(button(data.settings.enabled?'Вимкнути сповіщення':'Увімкнути сповіщення',()=>saving(async()=>{await api('telegram/settings',{version:data.settings.version,enabled:!data.settings.enabled});await load();})),button('Надіслати тест',()=>saving(async()=>{await api('telegram/test',{});await load();}),true),button('Повторити заплановані',()=>saving(async()=>{await api('telegram/retry',{});await load();})));
    card.append(actions,el('p','Для повторів без відкритої адмінпанелі налаштуйте окремий Cron Worker за інструкцією. Невизначену доставку спочатку перевірте у Telegram.','muted'));
    const rows=data.events.map(e=>{const retry=el('span');if(['retry','failed','uncertain'].includes(e.state))retry.append(button('Повторити',()=>saving(async()=>{let allowDuplicateRisk=false;if(e.state==='uncertain'){allowDuplicateRisk=confirm('Telegram міг уже отримати це повідомлення. Ви перевірили чат і погоджуєтеся на можливий дубль?');if(!allowDuplicateRisk)return;}await api('telegram/retry',{eventId:e.id,allowDuplicateRisk});await load();})));return[e.event_key,badge(e.state,eventLabels),e.attempts,e.last_error || '—',retry];});
    return[card,el('h2','Черга сповіщень'),table(['Подія','Стан','Спроб','Результат',''],rows)];
  }
  async function load() {
    const id=++loadId;content.setAttribute('aria-busy','true');
    try{const nodes=await ({dashboard,products,orders,audit,telegram}[view])();if(id===loadId)content.replaceChildren(...nodes);}catch(error){notice(error.message,true);}finally{if(id===loadId)content.setAttribute('aria-busy','false');}
  }
  document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>{view=b.dataset.view;offset=0;$('notice').hidden=true;document.querySelectorAll('[data-view]').forEach(x=>x.removeAttribute('aria-current'));b.setAttribute('aria-current','page');$('pageTitle').textContent={dashboard:'Огляд магазину',products:'Товари та наявність',orders:'Замовлення',audit:'Історія змін',telegram:'Telegram-сповіщення'}[view];load();}));
  $('closeEditor').addEventListener('click',()=>{if(!busy)dialog.close();});dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
  api('session').then(data=>{csrf=data.csrfToken;$('identity').textContent=data.email;return load();}).catch(error=>{content.replaceChildren(el('p','Доступ закрито до налаштування Cloudflare Access.'));content.setAttribute('aria-busy','false');notice(error.message,true);});
})();
