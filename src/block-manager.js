'use strict';
const $=id=>document.getElementById(id);
let collapsed=false,pollTimer=null,busy=false;
const short=s=>String(s||'').length>60?String(s).slice(0,57)+'…':String(s||'');
function empty(text){const n=document.createElement('div');n.className='empty';n.textContent=text;return n}
function item(selector, removable=false){
 const row=document.createElement('div');row.className='item';
 const code=document.createElement('code');code.textContent=short(selector);code.title=selector;row.append(code);
 if(removable){const b=document.createElement('button');b.textContent='ลบ';b.type='button';b.addEventListener('click',async()=>{if(busy)return;busy=true;try{await window.harvestBlock.remove(selector);await refresh()}finally{busy=false}});row.append(b)}
 return row
}
function render(s){
 $('origin').textContent=s.origin||'เลือกส่วนที่ต้องการซ่อน';
 const draft=Array.isArray(s.selectors)?s.selectors:[],saved=Array.isArray(s.saved)?s.saved:[];
 $('draftCount').textContent=draft.length+' จุด';$('savedCount').textContent=saved.length+' กฎ';
 $('commit').disabled=!draft.length;$('clearSaved').disabled=!saved.length;
 const d=document.createDocumentFragment();if(!draft.length)d.append(empty('ยังไม่ได้เลือก Element'));else draft.forEach(x=>d.append(item(x,false)));$('draftList').replaceChildren(d);
 const f=document.createDocumentFragment();if(!saved.length)f.append(empty('ยังไม่มี Filter ที่บันทึกไว้'));else saved.forEach(x=>f.append(item(x,true)));$('savedList').replaceChildren(f);
}
async function refresh(){
 const s=await window.harvestBlock.state();render(s);
 if(s.cancelled){await window.harvestBlock.cancel().catch(()=>{});return false}
 return s.active!==false
}
async function loop(){clearTimeout(pollTimer);try{const active=await refresh();if(active)pollTimer=setTimeout(loop,220)}catch{pollTimer=setTimeout(loop,500)}}
$('clearDraft').addEventListener('click',async()=>{if(busy)return;busy=true;try{await window.harvestBlock.clearDraft();await refresh()}finally{busy=false}});
$('commit').addEventListener('click',async()=>{if(busy)return;busy=true;$('message').textContent='กำลังบันทึก…';try{const result=await window.harvestBlock.commit();$('message').textContent=result?.saved?('บันทึกแล้ว • รวม '+(result.count||0)+' กฎ • เลือกต่อได้เลย'):'ยังไม่ได้เลือก Element';await refresh()}catch(e){$('message').textContent=e.message||String(e)}finally{busy=false}});
$('cancel').addEventListener('click',async()=>{if(busy)return;busy=true;try{await window.harvestBlock.cancel()}catch{}});
$('clearSaved').addEventListener('click',async()=>{if(busy)return;busy=true;try{await window.harvestBlock.clearSaved();await refresh();$('message').textContent='ล้าง Filter แล้ว'}finally{busy=false}});
$('close').addEventListener('click',async()=>{if(busy)return;busy=true;try{await window.harvestBlock.close()}catch{}});
$('collapse').addEventListener('click',async()=>{collapsed=!collapsed;document.body.classList.toggle('collapsed',collapsed);$('collapse').textContent=collapsed?'⌄':'⌃';await window.harvestBlock.collapse(collapsed).catch(()=>{})});
loop();
