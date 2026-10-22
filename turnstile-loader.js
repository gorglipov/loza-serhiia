(() => {
  'use strict';let loading=null;
  window.lozaLoadTurnstile=()=>{
    if(window.turnstile)return Promise.resolve(window.turnstile);
    if(loading)return loading;
    loading=new Promise((resolve,reject)=>{
      const script=document.createElement('script');
      const fail=()=>{clearTimeout(timer);script.remove();loading=null;reject(new Error('Не вдалося завантажити перевірку. Перевірте інтернет і відкрийте форму знову.'));};
      const timer=setTimeout(fail,15000);
      window.lozaTurnstileReady=()=>{clearTimeout(timer);resolve(window.turnstile);};
      script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=lozaTurnstileReady';script.async=true;script.onerror=fail;document.head.append(script);
    });return loading;
  };
})();
