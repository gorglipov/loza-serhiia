(() => {
  'use strict';
  const dialog=document.getElementById('supportDialog'),form=document.getElementById('supportForm'),status=document.getElementById('supportStatus'),submit=document.getElementById('supportSubmit'),fields=document.getElementById('supportFields');
  const reason=document.getElementById('supportReason'),contactType=document.getElementById('supportContactType'),contact=document.getElementById('supportContact');
  let key=crypto.randomUUID(),snapshot=null,inFlight=false,token='',widget=null,returnFocus=null,opening=0;
  const feedback=(text,error=false)=>{status.textContent=text;status.dataset.tone=error?'error':'info';};
  function enabled(){submit.disabled=inFlight || !token;}
  function contactHint(){const phone=contactType.value==='phone';contact.type=phone?'tel':'text';contact.inputMode=phone?'tel':'text';contact.autocomplete=phone?'tel':'off';contact.placeholder=phone?'+380XXXXXXXXX':'@ваш_username';document.getElementById('supportContactHint').textContent=phone?'Вкажіть український номер телефону для відповіді.':'Вкажіть Telegram @username — від 5 до 32 латинських літер, цифр або _. Номер телефону теж можна обрати.';}
  async function open(){
    returnFocus=document.activeElement;dialog.showModal();const revision=++opening;feedback('Завантажуємо захист форми…');
    try{
      const response=await fetch('/api/store/config',{cache:'no-store',signal:AbortSignal.timeout(12000)}),config=await response.json();
      if(!response.ok || !config.supportAvailable)throw new Error('Форма тимчасово недоступна. Напишіть Сергію в Telegram або зателефонуйте.');
      if(!dialog.open || revision!==opening)return;
      if(!reason.options.length){const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='Оберіть причину звернення';reason.append(placeholder);Object.entries(config.supportReasons).forEach(([value,text])=>{const option=document.createElement('option');option.value=value;option.textContent=text;reason.append(option);});}
      const turnstile=await window.lozaLoadTurnstile();if(!dialog.open || revision!==opening)return;
      widget=turnstile.render('#supportTurnstile',{sitekey:config.turnstileSiteKey,action:'loza_support',theme:'light',size:'flexible',language:'uk',callback:value=>{token=value;enabled();},'expired-callback':()=>{token='';enabled();},'error-callback':()=>{token='';feedback('Не вдалося пройти перевірку. Закрийте й відкрийте форму ще раз.',true);enabled();},'timeout-callback':()=>{token='';enabled();}});
      feedback(snapshot?'Натисніть «Надіслати звернення», щоб безпечно повторити попереднє надсилання.':'Оберіть причину та залиште контакт, за яким вам можна відповісти.');
    }catch(error){feedback(error.message,true);}
  }
  function close(){if(inFlight)return;opening++;dialog.close();if(widget!==null && window.turnstile)window.turnstile.remove(widget);widget=null;token='';enabled();returnFocus?.focus();}
  document.querySelectorAll('[data-support-open]').forEach(button=>button.addEventListener('click',open));document.getElementById('supportClose').addEventListener('click',close);dialog.addEventListener('cancel',event=>{event.preventDefault();close();});contactType.addEventListener('change',contactHint);contactHint();
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(inFlight || !token)return;
    if(!snapshot)snapshot={reason:reason.value,contactType:contactType.value,contact:contact.value,message:document.getElementById('supportMessage').value,website:document.getElementById('supportWebsite').value};
    inFlight=true;fields.disabled=true;enabled();feedback('Надсилаємо звернення…');let accepted=false;
    try{
      const response=await fetch('/api/support/create',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify({...snapshot,turnstileToken:token}),signal:AbortSignal.timeout(15000)});
      let result;try{result=await response.json();}catch{throw new Error('Не вдалося отримати відповідь. Повторіть надсилання — воно не створить дубль.');}
      if(!response.ok || !result.success){if(response.status>=400 && response.status<500 && ![409,429].includes(response.status))snapshot=null;throw new Error(result.error || 'Не вдалося надіслати звернення. Спробуйте ще раз.');}
      if(typeof result.ticketId!=='string' || !/^SUP-[0-9a-f-]{36}$/.test(result.ticketId))throw new Error('Не вдалося прочитати номер звернення. Повторіть надсилання.');
      accepted=true;feedback('Звернення отримано. Номер: '+result.ticketId+'. Ми відповімо за вказаним контактом.');key=crypto.randomUUID();snapshot=null;form.reset();contactHint();
    }catch(error){feedback(error.message || 'Перевірте інтернет і повторіть надсилання.',true);}
    finally{inFlight=false;fields.disabled=Boolean(snapshot);token='';if(widget!==null && window.turnstile)window.turnstile.reset(widget);enabled();if(accepted)document.getElementById('supportStatus').focus();}
  });
})();
