// GSAP core/performance skills: transforms only, reversible reduced motion,
// no scroll interception and no animation prerequisite for using the catalog.
(() => {
  const gsap=window.gsap;if(!gsap)return;
  const seen=new WeakSet();let observer,grapeObserver,visibilityHandler;
  const media=gsap.matchMedia();
  media.add('(prefers-reduced-motion: no-preference)',()=>{
    const intro=gsap.timeline();
    // The separate arrival scene provides the visible welcome.
    const grapes=gsap.to('.grape-cluster',{y:-7,rotation:i=>i===1?3:-3,duration:2.3,stagger:.25,repeat:-1,yoyo:true,ease:'sine.inOut'});
    let inView=true;const update=()=>{if(document.hidden||!inView)grapes.pause();else grapes.resume();};
    grapeObserver=new IntersectionObserver(entries=>{inView=entries[0].isIntersecting;update();});const group=document.querySelector('.hero-grapes');if(group)grapeObserver.observe(group);
    visibilityHandler=update;document.addEventListener('visibilitychange',visibilityHandler);
    observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){gsap.from(entry.target,{y:18,opacity:0,duration:.55,ease:'power2.out',clearProps:'transform,opacity'});observer.unobserve(entry.target);}},{threshold:.08});
    const watch=()=>document.querySelectorAll('.catalog-card,.intro,.footer-message').forEach(node=>{if(!seen.has(node)){seen.add(node);observer.observe(node);}});
    watch();const mutations=new MutationObserver(watch);const grid=document.querySelector('#grid');if(grid)mutations.observe(grid,{childList:true});
    return ()=>{intro.kill();grapes.kill();observer.disconnect();grapeObserver.disconnect();mutations.disconnect();document.removeEventListener('visibilitychange',visibilityHandler);};
  });
  const bar=document.createElement('div');bar.className='scroll-progress';bar.setAttribute('aria-hidden','true');document.body.append(bar);let scheduled=false;
  const progress=()=>{scheduled=false;const height=document.documentElement.scrollHeight-innerHeight;bar.style.transform='scaleX('+(height>0?Math.min(1,scrollY/height):0)+')';};
  addEventListener('scroll',()=>{if(!scheduled){scheduled=true;requestAnimationFrame(progress);}},{passive:true});addEventListener('resize',progress);progress();
})();
// Motion uses the browser animation API and wall-clock holds, independent of GSAP.
// Each visit/reload gets a readable welcome, including a direct #catalog visit.
(() => {
  const link=document.querySelector('.hero-cta[href="#catalog"]'),target=document.querySelector('#catalog');
  if(!link||!target)return;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  let closeScene=null,arrivalDone=false;
  const leaf='<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M24 43V17m0 12C8 29 5 15 9 7c15 0 20 10 15 22Zm0 7c17-1 22-13 17-24-14 0-21 10-17 24Z"/></svg>';
  const go=()=>{target.scrollIntoView({behavior:'instant',block:'start'});if(location.hash!=='#catalog')history.pushState(null,'','#catalog');};
  function scene(kind,origin){
    closeScene?.();
    const portal=kind==='portal',layer=document.createElement('section');
    layer.className='loza-scene '+(portal?'catalog-portal':'arrival-scene');
    layer.setAttribute('aria-label',portal?'Перехід до каталогу':'Вітаємо у LOZA');
    layer.innerHTML='<div class="scene-iris"><div class="scene-orbit"></div><div class="scene-orbit scene-orbit-inner"></div></div><div class="scene-copy"><span class="scene-brand">LOZA · ВІД СЕРГІЯ</span>'+leaf+'<h2>'+(portal?'Ваш сад<br>починається тут':'Вітаємо у нашому<br><em>каталозі лози</em>')+'</h2><p>'+(portal?'Відкриваємо каталог сортів':'Виноградна лоза, вирощена з турботою')+'</p><span class="scene-rule"></span></div><button class="scene-skip" type="button">'+(portal?'До каталогу':'Пропустити вступ')+' <span aria-hidden="true">↗</span></button>';
    document.body.append(layer);
    const iris=layer.querySelector('.scene-iris'),copy=layer.querySelector('.scene-copy'),animations=[],timers=[];
    let done=false;
    const later=(fn,ms)=>timers.push(setTimeout(fn,ms));
    const animate=(node,frames,options)=>{if(node.animate&&(!reduced.matches||frames.every(frame=>!('transform' in frame)&&!('clipPath' in frame))))animations.push(node.animate(frames,{fill:'both',...options}));};
    const finish=()=>{if(done)return;done=true;timers.forEach(clearTimeout);animations.forEach(a=>a.cancel());layer.remove();document.removeEventListener('keydown',escape);if(closeScene===finish)closeScene=null;if(portal){go();const h=target.querySelector('h2');h?.setAttribute('tabindex','-1');h?.focus({preventScroll:true});}};
    const escape=e=>{if(e.key==='Escape')finish();};closeScene=finish;
    document.addEventListener('keydown',escape);layer.querySelector('button').addEventListener('click',finish);
    // The opaque background remains visible during the hold, rather than a flash.
    if(portal&&origin&&!reduced.matches){
      const x=origin.left+origin.width/2,y=origin.top+origin.height/2;
      animate(iris,[{clipPath:`circle(0px at ${x}px ${y}px)`},{clipPath:`circle(${Math.ceil(Math.hypot(innerWidth,innerHeight))}px at ${x}px ${y}px)`}],{duration:800,easing:'cubic-bezier(.22,.7,.2,1)'});
    }else animate(layer,[{opacity:0},{opacity:1}],{duration:500});
    animate(copy,[{opacity:0,transform:'translateY(28px) scale(.96)'},{opacity:1,transform:'translateY(0) scale(1)'}],{duration:850,delay:portal?350:150,easing:'cubic-bezier(.16,1,.3,1)'});
    layer.querySelectorAll('.scene-orbit').forEach((node,i)=>animate(node,[{transform:`translate(-50%,-50%) rotate(${i?18:-12}deg) scale(.86)`},{transform:`translate(-50%,-50%) rotate(${i?-12:18}deg) scale(1.08)`}],{duration:3400,easing:'ease-out'}));
    const hold=portal?1900:2400;
    later(()=>{if(portal)go();animate(layer,[{opacity:1},{opacity:0}],{duration:650,easing:'ease-in-out'});later(finish,650);},hold);
    later(finish,4200); // Cleanup still works if animation completion is unavailable.
    return finish;
  }
  function arrival(){
    if(arrivalDone||document.hidden)return;arrivalDone=true;
    requestAnimationFrame(()=>requestAnimationFrame(()=>scene('arrival')));
  }
  if(document.readyState==='complete')arrival();else addEventListener('load',arrival,{once:true});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)arrival();});
  link.addEventListener('click',event=>{
    if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    event.preventDefault();arrivalDone=true;
    // Reduced motion keeps a readable opacity-only scene, without zoom or travel.
    if(document.querySelector('.catalog-portal'))return;
    scene('portal',link.getBoundingClientRect());
  });
  reduced.addEventListener('change',()=>closeScene?.());
  addEventListener('pagehide',()=>closeScene?.());
})();
