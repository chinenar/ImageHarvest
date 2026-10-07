'use strict';

function repairContinuousReaderScroll(wc){
 return wc.executeJavaScript(`(()=>{
  const modes=['Single Page','Double Page','Wide Strip','Long Strip'];
  const mode=[...document.querySelectorAll('button')].find(b=>modes.includes((b.textContent||'').trim()))?.textContent.trim()||'missing';
  if(mode!=='Long Strip')return {mode,repaired:false,blocked:false};
  const intersectsViewport=e=>{
    const r=e.getBoundingClientRect(),s=getComputedStyle(e);
    if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0||s.pointerEvents==='none'||r.width<2||r.height<2)return false;
    return r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight;
  };
  const modal=[...document.querySelectorAll('dialog[open],[role="dialog"],[aria-modal="true"]')].some(intersectsViewport);
  const readerPanel=[...document.querySelectorAll('.reader--menu,.md--reader-comments')].some(intersectsViewport);
  const blocked=modal||readerPanel;
  let repaired=false;
  if(!blocked&&document.body?.classList.contains('scroll-lock')){
    document.body.classList.remove('scroll-lock');
    repaired=true;
  }
  return {mode,repaired,blocked,bodyClass:document.body?.className||'',overflowY:getComputedStyle(document.body).overflowY,scrollHeight:document.scrollingElement?.scrollHeight||0,clientHeight:document.scrollingElement?.clientHeight||0};
 })()`,true);
}

// Use the reader's own controls/state. Do not flatten arbitrary website DOMs.
async function ensureContinuousReader(wc,{signal}={}){
 const url=new URL(wc.getURL());
 if(!['mangadex.org','www.mangadex.org'].includes(url.hostname)||!url.pathname.startsWith('/chapter/'))return {supported:false,changed:false};
 let previous='',changed=false;
 for(let attempt=0;attempt<8;attempt++){
  if(signal?.aborted)throw Error('ยกเลิกการเตรียมหน้าอ่าน');
  const result=await wc.executeJavaScript(`(()=>{const buttons=[...document.querySelectorAll('button')];const current=buttons.find(b=>['Single Page','Double Page','Wide Strip','Long Strip'].includes(b.textContent.trim()));if(!current)return {mode:'missing'};const mode=current.textContent.trim();if(mode!=='Long Strip')current.click();return {mode};})()`,true);
  if(result.mode==='Long Strip'){
   await new Promise(resolve=>setTimeout(resolve,250));
   const scroll=await repairContinuousReaderScroll(wc).catch(()=>null);
   return {supported:true,changed,previous,mode:'Long Strip',scroll};
  }
  if(result.mode!=='missing'){previous||=result.mode;changed=true;}
  await new Promise(resolve=>setTimeout(resolve,250));
 }
 throw Error('ตั้งหน้าอ่านแบบเลื่อนต่อเนื่องไม่ได้ กรุณาเลือก Long Strip ใน Reader Settings แล้วกด Start ใหม่');
}
module.exports={ensureContinuousReader,repairContinuousReaderScroll};
