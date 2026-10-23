// GSAP core/performance skills: transforms only, reversible reduced motion,
// no scroll interception and no animation prerequisite for using the catalog.
(() => {
  const gsap=window.gsap;if(!gsap)return;
  const seen=new WeakSet();let observer,grapeObserver,visibilityHandler;
  const media=gsap.matchMedia();
  media.add('(prefers-reduced-motion: no-preference)',()=>{
    const intro=gsap.timeline({defaults:{ease:'power2.out',duration:.65}});
    intro.from('.welcome-line',{y:12,autoAlpha:0}).from('.hero-main h1, .hero-main p, .hero-cta',{y:18,autoAlpha:0,stagger:.1},'-.3');
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
// Circular portal is decorative and never captures input or blocks navigation.
(() => {
  const link=document.querySelector('.hero-cta[href="#catalog"]'),target=document.querySelector('#catalog');
  if(!link||!target)return;
  let busy=false,finishCurrent;
  const go=()=>{target.scrollIntoView({behavior:'instant',block:'start'});if(location.hash!=='#catalog')history.pushState(null,'','#catalog');};
  link.addEventListener('click',event=>{
    if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||matchMedia('(prefers-reduced-motion: reduce)').matches||!window.gsap)return;
    event.preventDefault();if(busy)return;busy=true;
    const box=link.getBoundingClientRect(),x=box.left+box.width/2,y=box.top+box.height/2;
    const overlay=document.createElement('div');overlay.className='catalog-portal';overlay.setAttribute('aria-hidden','true');
    overlay.innerHTML='<div class="portal-disc"></div><div class="portal-caption"><svg viewBox="0 0 48 48" fill="none" stroke-width="1.5"><path d="M24 43V17m0 12C8 29 5 15 9 7c15 0 20 10 15 22Zm0 7c17-1 22-13 17-24-14 0-21 10-17 24Z"/></svg><strong>Ваш сад починається тут</strong><span>ВІДКРИВАЄМО КАТАЛОГ ЛОЗИ</span></div>';
    document.body.append(overlay);const disc=overlay.querySelector('.portal-disc'),caption=overlay.querySelector('.portal-caption');
    const cover=Math.hypot(Math.max(x,innerWidth-x),Math.max(y,innerHeight-y))/90+1;
    let navigated=false,done=false,timer;
    const navigate=()=>{if(!navigated){navigated=true;go();}};
    const cleanup=()=>{if(done)return;done=true;clearTimeout(timer);timeline?.kill();overlay.remove();busy=false;finishCurrent=null;document.removeEventListener('keydown',escape);};
    const escape=event=>{if(event.key==='Escape'){navigate();cleanup();}};
    let timeline;finishCurrent=()=>{navigate();cleanup();};document.addEventListener('keydown',escape);
    try{
      gsap.set(disc,{left:x-90,top:y-90,scale:.12,opacity:0});gsap.set(caption,{autoAlpha:0,y:12});
      timeline=gsap.timeline({onComplete:()=>{navigate();cleanup();target.classList.remove('portal-active');target.parentElement.classList.add('portal-active');setTimeout(()=>target.parentElement.classList.remove('portal-active'),750);const heading=target.querySelector('h2');heading?.setAttribute('tabindex','-1');heading?.focus({preventScroll:true});}});
      timeline.to(disc,{scale:cover,opacity:1,duration:.55,ease:'power3.inOut'}).to(caption,{autoAlpha:1,y:0,duration:.24},.22).call(navigate,[],.57).to(caption,{autoAlpha:0,y:-8,duration:.22},.75).to(disc,{opacity:0,scale:cover*1.1,duration:.44,ease:'power2.in'},.78);
      timer=setTimeout(()=>{navigate();cleanup();},1800);
    }catch{navigate();cleanup();}
  });
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',event=>{if(event.matches)finishCurrent?.();});
  addEventListener('pagehide',()=>finishCurrent?.());
})();
