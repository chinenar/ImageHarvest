'use strict';
const $=id=>document.getElementById(id);
let all=[];
const time=ms=>{try{return new Date(Number(ms)||Date.now()).toLocaleString('th-TH',{dateStyle:'medium',timeStyle:'short'})}catch{return''}};
function render(){
 const q=$('historySearch').value.trim().toLowerCase();
 const items=!q?all:all.filter(x=>((x.title||'')+' '+(x.url||'')).toLowerCase().includes(q));
 $('historyMeta').textContent=(q?'ผลการค้นหา ':'')+items.length+' รายการ';
 $('clearHistory').disabled=!all.length;
 if(!items.length){const e=document.createElement('div');e.className='empty';e.textContent=q?'ไม่พบประวัติที่ตรงกับคำค้น':'ยังไม่มีประวัติการเข้าเว็บ';$('historyList').replaceChildren(e);return}
 const f=document.createDocumentFragment();
 for(const item of items){
  const row=document.createElement('article');row.className='history-row';
  const main=document.createElement('div');main.className='history-main';
  const title=document.createElement('div');title.className='history-title';title.textContent=item.title||item.url;
  const url=document.createElement('div');url.className='history-url';url.textContent=item.url;url.title=item.url;
  const t=document.createElement('div');t.className='history-time';t.textContent=time(item.visitedAt);
  main.append(title,url,t);
  const actions=document.createElement('div');actions.className='history-actions';
  const open=document.createElement('button');open.className='open';open.textContent='เปิด';open.type='button';
  const remove=document.createElement('button');remove.className='remove';remove.textContent='ลบ';remove.type='button';
  open.addEventListener('click',()=>window.harvestInternal.openUrl(item.url));
  remove.addEventListener('click',async()=>{await window.harvestInternal.historyRemove(item.id);await refresh()});
  actions.append(open,remove);row.append(main,actions);f.append(row);
 }
 $('historyList').replaceChildren(f);
}
async function refresh(){
 const [history,settings]=await Promise.all([window.harvestInternal.historyList({limit:1000}),window.harvestInternal.historySettings()]);
 all=history?.data?.items||history.items||[];
 const s=settings?.data||settings||{};
 $('historyEnabled').checked=s.historyEnabled!==false;
 render();
}
$('historySearch').addEventListener('input',render);
$('historyEnabled').addEventListener('change',async()=>{await window.harvestInternal.historySetEnabled($('historyEnabled').checked);await refresh()});
$('clearHistory').addEventListener('click',async()=>{await window.harvestInternal.historyClear();await refresh()});
refresh();
