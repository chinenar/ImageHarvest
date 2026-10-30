'use strict';

function createBlockScripts() {
  function sharedBlockStyleScript(selectors) {
    return `(() => {
    const styleId='__imageharvest_shared_block_rules__';
    document.getElementById(styleId)?.remove();
    const selectors=${JSON.stringify(selectors)};
    const safe=selectors.filter(selector=>{
      try {
        const count=document.querySelectorAll(selector).length;
        const precise=selector.includes('>')||selector.includes('#')||selector.includes(':nth-of-type(');
        if(count>1)return false;
        if(count===0&&!precise)return false;
        return true;
      } catch { return false; }
    });
    if(!safe.length)return {applied:0,selectors:[]};
    const style=document.createElement('style');
    style.id=styleId;
    style.textContent=safe.map(s=>s+'{display:none!important;visibility:hidden!important}').join('\\n');
    (document.head||document.documentElement).append(style);
    return {applied:safe.length,selectors:safe};
  })()`;
  }

  function harvestBlockPickerScript() {
    return `new Promise(resolve => {
    let current=null, done=false;
    const esc = v => (CSS&&CSS.escape?CSS.escape(v):String(v).replace(/[^a-zA-Z0-9_-]/g,'\\\\$&'));
    const selectorFor = el => {
      if (!(el instanceof Element) || ['HTML','BODY'].includes(el.tagName)) return '';
      const unique = selector => { try { return document.querySelectorAll(selector).length === 1; } catch { return false; } };
      if (el.id) {
        const byId='#'+esc(el.id);
        if(unique(byId)) return byId;
      }
      const parts=[]; let node=el;
      while(node && node.nodeType===1 && node!==document.body && parts.length<10){
        let part=node.tagName.toLowerCase();
        const classes=[...node.classList]
          .filter(c=>c && !c.startsWith('__harvestts_') && c.length<=80)
          .slice(0,2);
        if(classes.length) part += classes.map(c=>'.'+esc(c)).join('');
        if(node.parentElement){
          const sameTag=[...node.parentElement.children].filter(x=>x.tagName===node.tagName);
          const samePart=classes.length
            ? sameTag.filter(x=>classes.every(c=>x.classList.contains(c)))
            : sameTag;
          if(samePart.length>1) part += ':nth-of-type('+(sameTag.indexOf(node)+1)+')';
        }
        parts.unshift(part);
        const candidate=parts.join(' > ');
        if(unique(candidate)) return candidate;
        node=node.parentElement;
        if(node?.id){
          const anchor='#'+esc(node.id);
          if(unique(anchor)){
            const anchored=anchor+' > '+parts.join(' > ');
            if(unique(anchored)) return anchored;
          }
        }
      }
      const absolute=[]; node=el;
      while(node && node.nodeType===1 && node!==document.body && absolute.length<24){
        let part=node.tagName.toLowerCase();
        if(node.parentElement){
          const sameTag=[...node.parentElement.children].filter(x=>x.tagName===node.tagName);
          if(sameTag.length>1) part += ':nth-of-type('+(sameTag.indexOf(node)+1)+')';
        }
        absolute.unshift(part);
        node=node.parentElement;
      }
      const fallback='body > '+absolute.join(' > ');
      return unique(fallback) ? fallback : parts.join(' > ');
    };
    const cleanup = value => {
      if(done) return; done=true; current?.classList.remove('__harvestts_pick__');
      removeEventListener('mouseover',over,true); removeEventListener('mouseout',out,true);
      removeEventListener('click',click,true); removeEventListener('keydown',key,true); resolve(value);
    };
    const over=e=>{ current?.classList.remove('__harvestts_pick__'); current=e.target; current?.classList.add('__harvestts_pick__'); };
    const out=e=>{ if(e.target===current){current.classList.remove('__harvestts_pick__');current=null;} };
    const click=e=>{ e.preventDefault();e.stopPropagation();e.stopImmediatePropagation(); cleanup(selectorFor(e.target)); };
    const key=e=>{ if(e.key==='Escape'){e.preventDefault();cleanup('');} };
    addEventListener('mouseover',over,true);addEventListener('mouseout',out,true);addEventListener('click',click,true);addEventListener('keydown',key,true);
  })`;
  }

  function harvestBlockDraftBootstrapScript() {
    return `(() => {
    try { window.__harvestBlockDraft?.finish?.(true); } catch {}
    document.getElementById('__harvestts_picker_root__')?.remove();
    const selected = new Set(), nodes = new Map();
    let hover = null, cancelled = false, active = true;
    const esc = v => (window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/[^a-zA-Z0-9_-]/g,'\\\\$&'));
    const selectorFor = el => {
      if (!(el instanceof Element) || ['HTML','BODY'].includes(el.tagName)) return '';
      const unique = selector => { try { return document.querySelectorAll(selector).length === 1; } catch { return false; } };
      if (el.id) {
        const byId='#'+esc(el.id);
        if(unique(byId)) return byId;
      }
      const parts=[]; let node=el;
      while(node && node.nodeType===1 && node!==document.body && parts.length<10){
        let part=node.tagName.toLowerCase();
        const classes=[...node.classList]
          .filter(c=>c && !c.startsWith('__harvestts_') && c.length<=80)
          .slice(0,2);
        if(classes.length) part += classes.map(c=>'.'+esc(c)).join('');
        if(node.parentElement){
          const sameTag=[...node.parentElement.children].filter(x=>x.tagName===node.tagName);
          const samePart=classes.length
            ? sameTag.filter(x=>classes.every(c=>x.classList.contains(c)))
            : sameTag;
          if(samePart.length>1) part += ':nth-of-type('+(sameTag.indexOf(node)+1)+')';
        }
        parts.unshift(part);
        const candidate=parts.join(' > ');
        if(unique(candidate)) return candidate;
        node=node.parentElement;
        if(node?.id){
          const anchor='#'+esc(node.id);
          if(unique(anchor)){
            const anchored=anchor+' > '+parts.join(' > ');
            if(unique(anchored)) return anchored;
          }
        }
      }
      const absolute=[]; node=el;
      while(node && node.nodeType===1 && node!==document.body && absolute.length<24){
        let part=node.tagName.toLowerCase();
        if(node.parentElement){
          const sameTag=[...node.parentElement.children].filter(x=>x.tagName===node.tagName);
          if(sameTag.length>1) part += ':nth-of-type('+(sameTag.indexOf(node)+1)+')';
        }
        absolute.unshift(part);
        node=node.parentElement;
      }
      const fallback='body > '+absolute.join(' > ');
      return unique(fallback) ? fallback : parts.join(' > ');
    };

    const root=document.createElement('div');
    root.id='__harvestts_picker_root__';
    root.setAttribute('aria-hidden','true');
    Object.assign(root.style,{
      position:'fixed',left:'0',top:'0',width:'100vw',height:'100vh',
      zIndex:'2147483647',pointerEvents:'auto',cursor:'crosshair',
      overflow:'hidden'
    });
    const dim=document.createElement('div');
    Object.assign(dim.style,{
      position:'absolute',inset:'0',background:'rgba(30,32,38,.62)',pointerEvents:'none'
    });
    const hoverLayer=document.createElement('div');
    const selectedLayer=document.createElement('div');
    for(const layer of [hoverLayer,selectedLayer]) Object.assign(layer.style,{position:'absolute',inset:'0',pointerEvents:'none'});
    root.append(dim,hoverLayer,selectedLayer);
    document.documentElement.append(root);

    const clippedRect = el => {
      if(!(el instanceof Element) || !el.isConnected) return null;
      const r=el.getBoundingClientRect();
      const left=Math.max(2,Math.min(innerWidth-2,r.left));
      const top=Math.max(2,Math.min(innerHeight-2,r.top));
      const right=Math.max(left+2,Math.min(innerWidth-2,r.right));
      const bottom=Math.max(top+2,Math.min(innerHeight-2,r.bottom));
      if(r.right<=0 || r.bottom<=0 || r.left>=innerWidth || r.top>=innerHeight) return null;
      return {
        left,top,right,bottom,width:Math.max(2,right-left),height:Math.max(2,bottom-top),
        raw:r, clipped:{left:r.left<0,top:r.top<0,right:r.right>innerWidth,bottom:r.bottom>innerHeight}
      };
    };
    const box = (el, kind, selector='') => {
      const rect=clippedRect(el); if(!rect) return null;
      const wrap=document.createElement('div');
      const selectedKind=kind==='selected';
      Object.assign(wrap.style,{
        position:'absolute',
        left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px',
        boxSizing:'border-box',
        border:selectedKind?'3px solid #829bff':'2px solid #c2c6ce',
        borderRadius:'4px',
        background:selectedKind?'rgba(205,218,255,.68)':'rgba(74,78,86,.52)',
        boxShadow:selectedKind?'0 0 0 1px rgba(62,81,190,.72), inset 0 0 0 1px rgba(255,255,255,.32)':'0 0 0 1px rgba(15,18,22,.70)',
        pointerEvents:'none'
      });
      const label=document.createElement('div');
      const raw=rect.raw;
      const clipped=rect.clipped.left||rect.clipped.top||rect.clipped.right||rect.clipped.bottom;
      label.textContent=(selector||selectorFor(el)||el.tagName.toLowerCase())+'  '+Math.round(raw.width)+'×'+Math.round(raw.height)+(clipped?'  • ขอบอยู่นอกจอ':'');
      Object.assign(label.style,{
        position:'absolute',left:'4px',top:'4px',maxWidth:'calc(100% - 8px)',
        padding:'3px 6px',borderRadius:'4px',
        background:selectedKind?'rgba(95,111,205,.94)':'rgba(48,52,61,.94)',
        color:'#fff',font:'10px/1.3 Consolas, monospace',
        whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'
      });
      wrap.append(label);
      return wrap;
    };
    const render=()=>{
      if(!active || !root.isConnected) return;
      hoverLayer.replaceChildren();
      selectedLayer.replaceChildren();
      if(hover){
        const sel=selectorFor(hover);
        if(sel && !selected.has(sel)){
          const b=box(hover,'hover',sel); if(b) hoverLayer.append(b);
        }
      }
      for(const sel of selected){
        let node=nodes.get(sel);
        if(!node?.isConnected){ try{node=document.querySelector(sel)}catch{} if(node) nodes.set(sel,node); }
        const b=box(node,'selected',sel); if(b) selectedLayer.append(b);
      }
    };
    const targetAt=(x,y)=>{
      const stack=document.elementsFromPoint(x,y);
      for(const el of stack){
        if(!(el instanceof Element) || root.contains(el) || ['HTML','BODY'].includes(el.tagName)) continue;
        return el;
      }
      return null;
    };
    const snapshot=()=>({active,cancelled,selectors:[...selected],count:selected.size});
    const clearHover=()=>{hover=null;render();};
    const move=e=>{ if(!active) return; hover=targetAt(e.clientX,e.clientY); render(); };
    const leave=()=>{ if(!active) return; hover=null; render(); };
    const click=e=>{
      if(!active) return;
      const target=targetAt(e.clientX,e.clientY); if(!target) return;
      const sel=selectorFor(target); if(!sel) return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      if(selected.has(sel)){selected.delete(sel);nodes.delete(sel);}
      else {selected.add(sel);nodes.set(sel,target);}
      hover=target; render();
    };
    const scrollableFor=el=>{
      let node=el;
      while(node && node!==document.body && node!==document.documentElement){
        const s=getComputedStyle(node);
        if(/auto|scroll/.test(s.overflowY||'') && node.scrollHeight>node.clientHeight+2) return node;
        node=node.parentElement;
      }
      return document.scrollingElement || document.documentElement;
    };
    const wheel=e=>{
      if(!active) return;
      const target=targetAt(e.clientX,e.clientY);
      const scroller=scrollableFor(target);
      if(scroller){
        e.preventDefault();
        if(scroller===document.scrollingElement || scroller===document.documentElement || scroller===document.body) window.scrollBy(e.deltaX,e.deltaY);
        else scroller.scrollBy(e.deltaX,e.deltaY);
        requestAnimationFrame(()=>{hover=targetAt(e.clientX,e.clientY);render();});
      }
    };
    const key=e=>{ if(e.key==='Escape' && active){e.preventDefault();cancelled=true;} };
    const reposition=()=>render();
    const clear=()=>{selected.clear();nodes.clear();clearHover();return snapshot();};
    const finish=(cancel=false)=>{
      if(!active) return snapshot();
      cancelled=cancelled||Boolean(cancel);
      active=false;hover=null;
      root.removeEventListener('pointermove',move,true);root.removeEventListener('pointerleave',leave,true);
      root.removeEventListener('click',click,true);root.removeEventListener('wheel',wheel,true);
      removeEventListener('keydown',key,true);
      removeEventListener('scroll',reposition,true);removeEventListener('resize',reposition,true);
      root.remove();
      return snapshot();
    };
    root.addEventListener('pointermove',move,true);root.addEventListener('pointerleave',leave,true);
    root.addEventListener('click',click,true);root.addEventListener('wheel',wheel,{capture:true,passive:false});
    addEventListener('keydown',key,true);
    addEventListener('scroll',reposition,true);addEventListener('resize',reposition,true);
    window.__harvestBlockDraft={snapshot,clear,finish,render};
    render();
    return snapshot();
  })()`;
  }
  return {
    sharedBlockStyleScript,
    harvestBlockPickerScript,
    harvestBlockDraftBootstrapScript,
  };
}
module.exports = { createBlockScripts };
