'use strict';
const $=id=>document.getElementById(id);
let all=[];
const unwrap=value=>value?.data??value??{};
const time=ms=>{try{return new Date(Number(ms)||Date.now()).toLocaleString('th-TH',{dateStyle:'medium',timeStyle:'short'})}catch{return''}};
const bytes=n=>{n=Number(n)||0;if(n<1024)return n+' B';if(n<1024**2)return(n/1024).toFixed(1)+' KB';if(n<1024**3)return(n/1024**2).toFixed(1)+' MB';return(n/1024**3).toFixed(1)+' GB'};
const stateLabel=state=>({progressing:'กำลังดาวน์โหลด',completed:'เสร็จแล้ว',cancelled:'ยกเลิกแล้ว',interrupted:'ดาวน์โหลดไม่สำเร็จ'}[state]||state||'ไม่ทราบสถานะ');
function render(){
 const q=$('downloadSearch').value.trim().toLowerCase();
 const items=!q?all:all.filter(x=>((x.filename||'')+' '+(x.url||'')).toLowerCase().includes(q));
 const active=all.filter(x=>x.active||x.state==='progressing').length;
 $('downloadMeta').textContent=(q?'ผลการค้นหา ':'')+items.length+' รายการ'+(active?' • กำลังดาวน์โหลด '+active+' รายการ':'');
 $('clearDownloads').disabled=!all.some(x=>!x.active&&x.state!=='progressing');
 if(!items.length){const e=document.createElement('div');e.className='empty';e.textContent=q?'ไม่พบไฟล์ที่ตรงกับคำค้น':'ยังไม่มีรายการดาวน์โหลด';$('downloadList').replaceChildren(e);return}
 const f=document.createDocumentFragment();
 for(const item of items){
  const row=document.createElement('article');row.className='download-row '+(item.state||'');
  const icon=document.createElement('div');icon.className='download-icon';icon.textContent=item.state==='completed'?'✓':item.state==='progressing'?'↓':'!';
  const main=document.createElement('div');main.className='download-main';
  const title=document.createElement('div');title.className='download-title';title.textContent=item.filename||'download';title.title=title.textContent;
  const url=document.createElement('div');url.className='download-url';url.textContent=item.url||'';url.title=item.url||'';
  const line=document.createElement('div');line.className='download-statusline';
  const state=document.createElement('span');state.className='download-state '+(item.state||'');state.textContent=stateLabel(item.state);
  const size=document.createElement('span');
  if(item.totalBytes>0) size.textContent=bytes(item.receivedBytes)+' / '+bytes(item.totalBytes);
  else if(item.receivedBytes>0) size.textContent=bytes(item.receivedBytes);
  const t=document.createElement('span');t.textContent=time(item.updatedAt||item.startedAt);
  line.append(state,size,t);main.append(title,url,line);
  if(item.state==='progressing'){
    const progress=document.createElement('div');progress.className='download-progress';
    const bar=document.createElement('i');bar.style.width=item.totalBytes>0?Math.max(0,Math.min(100,item.receivedBytes/item.totalBytes*100)).toFixed(1)+'%':'18%';
    progress.append(bar);main.append(progress);
  }
  const actions=document.createElement('div');actions.className='download-actions';
  if(item.state==='progressing'||item.active){
    const cancel=document.createElement('button');cancel.className='cancel';cancel.type='button';cancel.textContent='ยกเลิก';
    cancel.addEventListener('click',()=>window.harvestInternal.downloadsCancel(item.id));actions.append(cancel);
  }else{
    if(item.exists&&item.state==='completed'){
      const open=document.createElement('button');open.className='open';open.type='button';open.textContent='เปิด';
      open.addEventListener('click',()=>window.harvestInternal.downloadsOpen(item.id));actions.append(open);
    }
    if(item.exists){
      const folder=document.createElement('button');folder.className='folder';folder.type='button';folder.textContent='แสดงในโฟลเดอร์';
      folder.addEventListener('click',()=>window.harvestInternal.downloadsShow(item.id));actions.append(folder);
    }
    const remove=document.createElement('button');remove.className='remove';remove.type='button';remove.textContent='ลบจากรายการ';
    remove.addEventListener('click',async()=>{await window.harvestInternal.downloadsRemove(item.id);await refresh()});actions.append(remove);
  }
  row.append(icon,main,actions);f.append(row);
 }
 $('downloadList').replaceChildren(f);
}
async function refresh(){
 const data=unwrap(await window.harvestInternal.downloadsList());
 all=Array.isArray(data.items)?data.items:[];
 render();
}
$('downloadSearch').addEventListener('input',render);
$('clearDownloads').addEventListener('click',async()=>{await window.harvestInternal.downloadsClear();await refresh()});
window.harvestInternal.onDownloadsChanged(payload=>{all=Array.isArray(payload?.items)?payload.items:[];render()});
refresh();
