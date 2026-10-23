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
