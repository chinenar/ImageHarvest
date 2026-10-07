from pathlib import Path
import re

root=Path(r"E:\Shared\ExportImagefromWeb")
main=root/"src"/"main.cjs"
pre=root/"src"/"harvest-internal-preload.cjs"
html=root/"src"/"offline.html"
css=root/"src"/"offline.css"
js=root/"src"/"offline.js"

s=main.read_text(encoding="utf-8")

old = """async function harvestOfflineLibraryList(){
  const index=await harvestOfflineIndex(),items=[...index.items];
  for(const row of items){
    if(row.coverFile)continue;
    try{const saved=await harvestOfflineReadProject(row.id),page=(saved.manifest.pages||[]).find(p=>p?.file&&!p.error);if(page){row.coverFile=page.file;row.coverMime=page.mime||'';}}catch{}
  }
  const projects=index.projects.map(project=>{
    const chapters=items.filter(x=>x.projectId===project.id).sort((a,b)=>harvestOfflineChapterNumber(a)-harvestOfflineChapterNumber(b)||Number(a.createdAt||0)-Number(b.createdAt||0));
    const latest=[...chapters].sort((a,b)=>Number(b.updatedAt||0)-Number(a.updatedAt||0))[0];
    return {...project,chapterCount:chapters.length,pageCount:chapters.reduce((n,x)=>n+(Number(x.pages)||0),0),sizeBytes:chapters.reduce((n,x)=>n+(Number(x.sizeBytes)||0),0),updatedAt:Math.max(Number(project.updatedAt)||0,...chapters.map(x=>Number(x.updatedAt)||0)),coverItemId:latest?.id||'',coverFile:latest?.coverFile||'',chapters};
  }).sort((a,b)=>Number(b.updatedAt||0)-Number(a.updatedAt||0)||a.title.localeCompare(b.title));
  return {version:2,groups:[...index.groups].sort((a,b)=>Number(a.order||0)-Number(b.order||0)||a.title.localeCompare(b.title)),projects,items};
}
async function harvestOfflineGroupCreate(input={}){
  const title=harvestOfflineSafeTitle(input.title,'กลุ่ม');
  return harvestOfflineQueued(async()=>{const index=await harvestOfflineIndex(),group={id:'group-'+randomUUID(),title,createdAt:Date.now(),updatedAt:Date.now(),order:index.groups.length};index.groups.push(group);await harvestOfflineWriteIndex(index);return group;});
}
async function harvestOfflineGroupRemove(input={}){
  const id=String(input.id||'');return harvestOfflineQueued(async()=>{const index=await harvestOfflineIndex();index.groups=index.groups.filter(x=>x.id!==id);for(const p of index.projects)if(p.groupId===id)p.groupId='';await harvestOfflineWriteIndex(index);return true;});
}"""
new = """function harvestOfflineNextHomeOrder(index){
  const values=[...index.groups.map(x=>Number(x.homeOrder)),...index.projects.filter(x=>!x.groupId).map(x=>Number(x.homeOrder))].filter(Number.isFinite);
  return values.length?Math.max(...values)+1:0;
}
function harvestOfflineNextGroupOrder(index,groupId){
  const values=index.projects.filter(x=>x.groupId===groupId).map(x=>Number(x.groupOrder)).filter(Number.isFinite);
  return values.length?Math.max(...values)+1:0;
}
async function harvestOfflineLibraryList(){
  const index=await harvestOfflineIndex(),items=[...index.items];
  for(const row of items){
    if(row.coverFile)continue;
    try{const saved=await harvestOfflineReadProject(row.id),page=(saved.manifest.pages||[]).find(p=>p?.file&&!p.error);if(page){row.coverFile=page.file;row.coverMime=page.mime||'';}}catch{}
  }
  let fallbackHome=Math.max(-1,...index.groups.map(x=>Number(x.homeOrder)).filter(Number.isFinite),...index.projects.map(x=>Number(x.homeOrder)).filter(Number.isFinite))+1;
  const stories=index.projects.map((story,storyIndex)=>{
    const chapters=items.filter(x=>x.projectId===story.id).sort((a,b)=>harvestOfflineChapterNumber(a)-harvestOfflineChapterNumber(b)||Number(a.createdAt||0)-Number(b.createdAt||0));
    if(!chapters.length)return null;
    const latest=[...chapters].sort((a,b)=>Number(b.updatedAt||0)-Number(a.updatedAt||0))[0];
    const homeOrder=Number.isFinite(Number(story.homeOrder))?Number(story.homeOrder):fallbackHome++;
    const groupOrder=Number.isFinite(Number(story.groupOrder))?Number(story.groupOrder):storyIndex;
    return {...story,homeOrder,groupOrder,chapterCount:chapters.length,pageCount:chapters.reduce((n,x)=>n+(Number(x.pages)||0),0),sizeBytes:chapters.reduce((n,x)=>n+(Number(x.sizeBytes)||0),0),updatedAt:Math.max(Number(story.updatedAt)||0,...chapters.map(x=>Number(x.updatedAt)||0)),coverItemId:latest?.id||'',coverFile:latest?.coverFile||'',chapters};
  }).filter(Boolean);
  const groups=index.groups.map((group,groupIndex)=>{
    const members=stories.filter(x=>x.groupId===group.id).sort((a,b)=>Number(a.groupOrder)-Number(b.groupOrder)||a.title.localeCompare(b.title));
    const homeOrder=Number.isFinite(Number(group.homeOrder))?Number(group.homeOrder):fallbackHome++;
    return {...group,homeOrder,storyCount:members.length,pageCount:members.reduce((n,x)=>n+x.pageCount,0),sizeBytes:members.reduce((n,x)=>n+x.sizeBytes,0),stories:members,updatedAt:Math.max(Number(group.updatedAt)||0,...members.map(x=>Number(x.updatedAt)||0))};
  });
  const home=[
    ...groups.map(x=>({type:'group',id:x.id,order:x.homeOrder})),
    ...stories.filter(x=>!x.groupId).map(x=>({type:'story',id:x.id,order:x.homeOrder}))
  ].sort((a,b)=>Number(a.order)-Number(b.order)||a.id.localeCompare(b.id));
  return {version:3,groups,stories,items,home};
}
async function harvestOfflineGroupCreate(input={}){
  const title=harvestOfflineSafeTitle(input.title,'กลุ่ม');
  return harvestOfflineQueued(async()=>{const index=await harvestOfflineIndex(),group={id:'group-'+randomUUID(),title,createdAt:Date.now(),updatedAt:Date.now(),homeOrder:harvestOfflineNextHomeOrder(index)};index.groups.push(group);await harvestOfflineWriteIndex(index);return group;});
}
async function harvestOfflineGroupRename(input={}){
  const id=String(input.id||''),title=harvestOfflineSafeTitle(input.title,'กลุ่ม');
  return harvestOfflineQueued(async()=>{const index=await harvestOfflineIndex(),group=index.groups.find(x=>x.id===id);if(!group)throw Error('ไม่พบกลุ่ม');group.title=title;group.updatedAt=Date.now();await harvestOfflineWriteIndex(index);return group;});
}
async function harvestOfflineGroupRemove(input={}){
  const id=String(input.id||'');return harvestOfflineQueued(async()=>{const index=await harvestOfflineIndex();index.groups=index.groups.filter(x=>x.id!==id);let order=harvestOfflineNextHomeOrder(index);for(const p of index.projects.filter(x=>x.groupId===id).sort((a,b)=>Number(a.groupOrder||0)-Number(b.groupOrder||0))){p.groupId='';p.groupOrder=0;p.homeOrder=order++;p.updatedAt=Date.now();}await harvestOfflineWriteIndex(index);return true;});
}
async function harvestOfflineLibraryReorder(input={}){
  const scope=String(input.scope||''),ids=Array.isArray(input.ids)?input.ids.map(String):[];
  return harvestOfflineQueued(async()=>{
    const index=await harvestOfflineIndex();
    if(scope==='home'){
      const valid=new Map();
      for(const g of index.groups)valid.set('group:'+g.id,g);
      for(const story of index.projects.filter(x=>!x.groupId))valid.set('story:'+story.id,story);
      let order=0;const seen=new Set();
      for(const key of ids){const row=valid.get(key);if(!row||seen.has(key))continue;row.homeOrder=order++;seen.add(key);}
      const rest=[...valid.entries()].filter(([key])=>!seen.has(key)).sort((a,b)=>Number(a[1].homeOrder||1e9)-Number(b[1].homeOrder||1e9));
      for(const [,row] of rest)row.homeOrder=order++;
    }else if(scope==='group'){
      const groupId=String(input.groupId||'');if(!index.groups.some(x=>x.id===groupId))throw Error('ไม่พบกลุ่ม');
      const valid=new Map(index.projects.filter(x=>x.groupId===groupId).map(x=>[x.id,x]));let order=0;const seen=new Set();
      for(const id of ids){const row=valid.get(id);if(!row||seen.has(id))continue;row.groupOrder=order++;seen.add(id);}
      const rest=[...valid.entries()].filter(([id])=>!seen.has(id)).sort((a,b)=>Number(a[1].groupOrder||1e9)-Number(b[1].groupOrder||1e9));
      for(const [,row] of rest)row.groupOrder=order++;
    }else throw Error('รูปแบบการเรียงไม่ถูกต้อง');
    await harvestOfflineWriteIndex(index);return true;
  });
}"""
if old not in s: raise SystemExit("library block missing")
s=s.replace(old,new,1)

old = """async function harvestOfflineLibraryProjectGroup(input={}){
  const id=String(input.id||''),groupId=String(input.groupId||'');
  return harvestOfflineQueued(async()=>{const index=await harvestOfflineIndex(),project=index.projects.find(x=>x.id===id);if(!project)throw Error('ไม่พบโปรเจกต์');if(groupId&&!index.groups.some(x=>x.id===groupId))throw Error('ไม่พบกลุ่มที่เลือก');project.groupId=groupId;project.updatedAt=Date.now();await harvestOfflineWriteIndex(index);return project;});
}"""
new = """async function harvestOfflineLibraryProjectGroup(input={}){
  const id=String(input.id||''),groupId=String(input.groupId||'');
  return harvestOfflineQueued(async()=>{
    const index=await harvestOfflineIndex(),story=index.projects.find(x=>x.id===id);if(!story)throw Error('ไม่พบเรื่อง');
    if(groupId&&!index.groups.some(x=>x.id===groupId))throw Error('ไม่พบกลุ่มที่เลือก');
    if(story.groupId===groupId)return story;
    story.groupId=groupId;story.updatedAt=Date.now();
    if(groupId){story.groupOrder=harvestOfflineNextGroupOrder(index,groupId);}else{story.homeOrder=harvestOfflineNextHomeOrder(index);story.groupOrder=0;}
    await harvestOfflineWriteIndex(index);return story;
  });
}"""
if old not in s: raise SystemExit("story group block missing")
s=s.replace(old,new,1)

# New auto-created story gets a stable home ordering slot.
s=s.replace(
"""if(!libraryProject){libraryProject={id:projectId,title:series.title,groupId:'',manual:false,createdAt,updatedAt};index.projects.push(libraryProject);}else libraryProject.updatedAt=updatedAt;""",
"""if(!libraryProject){libraryProject={id:projectId,title:series.title,groupId:'',manual:false,createdAt,updatedAt,homeOrder:harvestOfflineNextHomeOrder(index),groupOrder:0};index.projects.push(libraryProject);}else libraryProject.updatedAt=updatedAt;""",1)

# Extend internal IPC.
s=s.replace(
"""'offline-list','offline-remove','offline-open','offline-open-source','offline-project','offline-image','offline-cover','offline-group-create','offline-group-remove','offline-library-project-create','offline-library-project-rename','offline-library-project-group','offline-item-project','offline-export-start','offline-export-page','offline-export-finish'""",
"""'offline-list','offline-remove','offline-open','offline-open-source','offline-project','offline-image','offline-cover','offline-group-create','offline-group-rename','offline-group-remove','offline-library-reorder','offline-library-project-create','offline-library-project-rename','offline-library-project-group','offline-item-project','offline-export-start','offline-export-page','offline-export-finish'""",1)

s=s.replace(
"""  ipcMain.handle('harvest-internal:offline-group-create', async (event,input={}) => { harvestInternalSender(event,'offline'); return harvestOfflineGroupCreate(input); });
  ipcMain.handle('harvest-internal:offline-group-remove', async (event,input={}) => { harvestInternalSender(event,'offline'); return harvestOfflineGroupRemove(input); });""",
"""  ipcMain.handle('harvest-internal:offline-group-create', async (event,input={}) => { harvestInternalSender(event,'offline'); return harvestOfflineGroupCreate(input); });
  ipcMain.handle('harvest-internal:offline-group-rename', async (event,input={}) => { harvestInternalSender(event,'offline'); return harvestOfflineGroupRename(input); });
  ipcMain.handle('harvest-internal:offline-group-remove', async (event,input={}) => { harvestInternalSender(event,'offline'); return harvestOfflineGroupRemove(input); });
  ipcMain.handle('harvest-internal:offline-library-reorder', async (event,input={}) => { harvestInternalSender(event,'offline'); return harvestOfflineLibraryReorder(input); });""",1)

main.write_text(s,encoding="utf-8")

s=pre.read_text(encoding="utf-8")
s=s.replace(
"""  offlineGroupCreate: title => ipcRenderer.invoke('harvest-internal:offline-group-create', { title }),
  offlineGroupRemove: id => ipcRenderer.invoke('harvest-internal:offline-group-remove', { id }),""",
"""  offlineGroupCreate: title => ipcRenderer.invoke('harvest-internal:offline-group-create', { title }),
  offlineGroupRename: (id,title) => ipcRenderer.invoke('harvest-internal:offline-group-rename', { id,title }),
  offlineGroupRemove: id => ipcRenderer.invoke('harvest-internal:offline-group-remove', { id }),
  offlineLibraryReorder: (scope,ids,groupId='') => ipcRenderer.invoke('harvest-internal:offline-library-reorder', { scope,ids,groupId }),""",1)
pre.write_text(s,encoding="utf-8")

html.write_text(r'''<!doctype html>
<html lang="th">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline Library</title><link rel="stylesheet" href="offline.css"></head>
<body>
  <header class="topbar">
    <div class="brand"><h1>Offline Library</h1><p>เรื่องที่บันทึกไว้ในเครื่อง</p></div>
    <div class="top-actions"><input id="search" type="search" placeholder="ค้นหาเรื่องหรือตอน"><button id="newGroup" class="primary" type="button">＋ กลุ่ม</button></div>
  </header>
  <div id="meta" class="meta">กำลังโหลด…</div>
  <main id="homeGrid" class="library-grid"></main>

  <dialog id="groupDialog" class="library-dialog group-dialog">
    <header class="dialog-head">
      <div><h2 id="groupTitle">กลุ่ม</h2><p id="groupMeta"></p></div>
      <div class="dialog-actions"><button id="renameGroup" type="button">เปลี่ยนชื่อ</button><button id="deleteGroup" class="danger" type="button">ลบกลุ่ม</button><button id="closeGroup" type="button">✕</button></div>
    </header>
    <div id="groupGrid" class="library-grid dialog-grid"></div>
  </dialog>

  <dialog id="storyDialog" class="library-dialog story-dialog">
    <header class="dialog-head">
      <div><h2 id="storyTitle">เรื่อง</h2><p id="storyMeta"></p></div>
      <div class="dialog-actions"><button id="renameStory" type="button">เปลี่ยนชื่อ</button><button id="closeStory" type="button">✕</button></div>
    </header>
    <div id="chapters" class="chapter-list"></div>
  </dialog>

  <dialog id="textDialog" class="text-dialog">
    <form id="textDialogForm">
      <h2 id="textDialogTitle">สร้าง</h2>
      <label id="textDialogLabel" for="textDialogInput">ชื่อ</label>
      <input id="textDialogInput" type="text" maxlength="120" autocomplete="off">
      <div class="text-dialog-actions"><button id="textDialogCancel" type="button">ยกเลิก</button><button class="primary" type="submit">ตกลง</button></div>
    </form>
  </dialog>
  <script src="offline.js"></script>
</body></html>''',encoding="utf-8")

css.write_text(r'''*{box-sizing:border-box}html{color-scheme:dark}body{margin:0;background:#0d0f15;color:#eef0f7;font:14px/1.5 "Segoe UI",Tahoma,sans-serif}.topbar{position:sticky;top:0;z-index:10;display:flex;gap:22px;align-items:center;justify-content:space-between;padding:18px 22px;background:#131621f2;border-bottom:1px solid #282d3a;backdrop-filter:blur(12px)}h1,h2,p{margin:0}.brand h1{font-size:21px}.brand p{margin-top:2px;color:#8f96aa;font-size:12px}.top-actions{display:flex;align-items:center;gap:8px}.top-actions input{width:min(40vw,430px);min-width:220px;height:38px;padding:0 13px;border:1px solid #343a49;border-radius:10px;background:#0d1017;color:#fff;outline:none}.top-actions input:focus{border-color:#7666b8;box-shadow:0 0 0 2px #7666b826}button,select{border:1px solid #383e4d;background:#222633;color:#eceef5;border-radius:9px;padding:8px 11px;font:inherit;cursor:pointer}button:hover{background:#2a3040}button.primary{background:#6655aa;border-color:#806dc9}.danger{color:#ffb3bd}.meta{padding:12px 22px;color:#8991a3;font-size:12px}.library-grid{padding:0 22px 40px;display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:18px;align-items:start}.tile{min-width:0;border-radius:18px;background:#171a23;border:1px solid #292e3b;overflow:hidden;box-shadow:0 8px 24px #0003;transition:transform .15s ease,border-color .15s ease,opacity .15s ease}.tile:hover{transform:translateY(-2px);border-color:#4c4567}.tile.dragging{opacity:.45}.tile.drag-over{outline:2px solid #8e7bd8;outline-offset:3px}.tile-head{display:flex;align-items:center;gap:8px;padding:10px 11px 8px}.drag-handle{color:#6f778a;cursor:grab;font-size:14px;letter-spacing:-3px;padding-right:2px}.tile-title{min-width:0;flex:1;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tile-count{font-size:10px;color:#9da5b7}.story-cover{position:relative;aspect-ratio:4/5;background:linear-gradient(145deg,#201b29,#11141b);overflow:hidden;cursor:pointer}.story-cover img,.mini-cover img{width:100%;height:100%;display:block;object-fit:cover}.story-cover::after{content:"";position:absolute;inset:auto 0 0;height:40%;background:linear-gradient(transparent,#12141de8);pointer-events:none}.story-badge{position:absolute;left:10px;bottom:10px;z-index:1;padding:4px 7px;border-radius:8px;background:#151823d9;border:1px solid #ffffff17;color:#e8e5f7;font-size:10px}.cover-placeholder{height:100%;display:grid;place-items:center;color:#5d6474;font-size:32px;background:#11141b}.tile-body{padding:11px 12px 13px}.tile-sub{color:#929aab;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.story-tools{display:grid;grid-template-columns:minmax(0,1fr) 34px;gap:7px;margin-top:9px}.story-tools select{min-width:0;width:100%;font-size:10px;padding:6px 7px}.icon-btn{padding:0;width:34px;height:32px}.group-tile{background:#19151d;border-color:#3a2b39}.group-preview{display:grid;grid-template-columns:1fr 1fr;gap:6px;aspect-ratio:1/1;padding:10px;background:#24181b;cursor:pointer}.mini-cover{position:relative;min-width:0;overflow:hidden;border-radius:10px;background:#120f11;border:1px solid #ffffff0d}.mini-cover .cover-placeholder{font-size:22px}.group-footer{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 12px 12px;color:#a7a0aa;font-size:11px}.group-open{padding:6px 9px;font-size:10px}.empty{grid-column:1/-1;padding:90px 20px;text-align:center;color:#7e8698}.library-dialog{width:min(1060px,94vw);max-height:88vh;padding:0;border:1px solid #34394a;border-radius:18px;background:#11141c;color:#eef0f7;box-shadow:0 24px 80px #000b}.library-dialog::backdrop{background:#05070aa8;backdrop-filter:blur(3px)}.dialog-head{position:sticky;top:0;z-index:5;display:flex;justify-content:space-between;gap:18px;align-items:center;padding:16px 18px;background:#171a24f2;border-bottom:1px solid #2b3040}.dialog-head h2{font-size:18px}.dialog-head p{margin-top:3px;color:#8f97aa;font-size:11px}.dialog-actions{display:flex;gap:8px}.dialog-grid{padding-top:18px;min-height:220px}.chapter-list{padding:16px;display:grid;gap:11px}.chapter-card{display:grid;grid-template-columns:86px minmax(0,1fr) auto;gap:13px;align-items:center;padding:10px;background:#191c25;border:1px solid #2b303e;border-radius:12px}.chapter-thumb{width:86px;height:108px;border-radius:8px;overflow:hidden;background:#0d0f14}.chapter-thumb img{width:100%;height:100%;object-fit:cover}.chapter-info{min-width:0}.chapter-name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.chapter-url{margin-top:3px;color:#747d90;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.chapter-meta{margin-top:6px;color:#a1a8b6;font-size:11px}.chapter-actions{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end}.chapter-actions button{font-size:11px;padding:7px 9px}.text-dialog{width:min(420px,90vw);padding:0;border:1px solid #393f50;border-radius:14px;background:#151923;color:#eef0f7;box-shadow:0 24px 80px #000b}.text-dialog::backdrop{background:#05070aa8;backdrop-filter:blur(3px)}.text-dialog form{display:grid;gap:10px;padding:18px}.text-dialog h2{font-size:17px}.text-dialog label{color:#aeb5c6;font-size:12px}.text-dialog input{width:100%;height:40px;padding:0 12px;border:1px solid #3a4050;border-radius:9px;background:#0e1118;color:#fff;outline:none;font:inherit}.text-dialog input:focus{border-color:#7c69bd;box-shadow:0 0 0 2px #7c69bd26}.text-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}@media(max-width:760px){.topbar{align-items:stretch;flex-direction:column}.top-actions{flex-wrap:wrap}.top-actions input{width:100%;min-width:0;flex:1 0 100%}.library-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:0 12px 30px}.meta{padding-left:12px}.tile{border-radius:14px}.dialog-head{align-items:flex-start;flex-direction:column}.dialog-actions{width:100%;justify-content:flex-end;flex-wrap:wrap}.chapter-card{grid-template-columns:68px minmax(0,1fr)}.chapter-thumb{width:68px;height:88px}.chapter-actions{grid-column:1/-1;justify-content:flex-start}}''',encoding="utf-8")

js.write_text(r''''use strict';
const $=id=>document.getElementById(id);
let model={groups:[],stories:[],items:[],home:[]},search='',activeGroupId='',activeStoryId='',coverUrls=new Map(),textDialogResolve=null,dragState=null;
const fmtBytes=n=>{n=Number(n)||0;if(n<1024)return n+' B';if(n<1048576)return(n/1024).toFixed(1)+' KB';if(n<1073741824)return(n/1048576).toFixed(1)+' MB';return(n/1073741824).toFixed(2)+' GB'};
const fmtTime=n=>{try{return new Date(Number(n)||0).toLocaleString('th-TH',{dateStyle:'medium',timeStyle:'short'})}catch{return''}};
function askText(title,label,value=''){if(textDialogResolve){const old=textDialogResolve;textDialogResolve=null;old(null)}$('textDialogTitle').textContent=title;$('textDialogLabel').textContent=label;$('textDialogInput').value=value;$('textDialog').showModal();requestAnimationFrame(()=>{$('textDialogInput').focus();$('textDialogInput').select()});return new Promise(resolve=>{textDialogResolve=resolve})}
function finishTextDialog(value){const resolve=textDialogResolve;textDialogResolve=null;if($('textDialog').open)$('textDialog').close();resolve?.(value)}
async function coverUrl(itemId){if(!itemId)return'';if(coverUrls.has(itemId))return coverUrls.get(itemId);try{const row=await window.harvestInternal.offlineCover(itemId),blob=new Blob([row.bytes],{type:row.mime||'image/jpeg'}),url=URL.createObjectURL(blob);coverUrls.set(itemId,url);return url}catch{return''}}
async function hydrateCover(img,itemId){const url=await coverUrl(itemId);if(url&&img.isConnected)img.src=url}
addEventListener('pagehide',()=>{for(const url of coverUrls.values())URL.revokeObjectURL(url)},{once:true});
function option(value,label,selected){const o=document.createElement('option');o.value=value;o.textContent=label;o.selected=selected;return o}
function storyById(id){return model.stories.find(x=>x.id===id)}
function groupById(id){return model.groups.find(x=>x.id===id)}
function groupName(id){return groupById(id)?.title||'ไม่มีกลุ่ม'}
function groupSelect(story){
  const s=document.createElement('select');s.title='ย้ายเรื่องเข้ากลุ่ม';s.append(option('','ไม่มีกลุ่ม',!story.groupId));for(const g of model.groups)s.append(option(g.id,g.title,story.groupId===g.id));
  s.onchange=async e=>{e.stopPropagation();await window.harvestInternal.offlineLibraryProjectGroup(story.id,s.value);await refresh();if($('groupDialog').open&&!storyById(story.id)?.groupId)$('groupDialog').close()};s.onclick=e=>e.stopPropagation();return s;
}
function attachDrag(tile,{scope,key,id,groupId=''}){tile.draggable=true;tile.dataset.dragKey=key;tile.addEventListener('dragstart',e=>{dragState={scope,key,id,groupId};tile.classList.add('dragging');e.dataTransfer.effectAllowed='move';try{e.dataTransfer.setData('text/plain',key)}catch{}});tile.addEventListener('dragend',()=>{tile.classList.remove('dragging');document.querySelectorAll('.drag-over').forEach(x=>x.classList.remove('drag-over'));dragState=null});tile.addEventListener('dragover',e=>{if(!dragState||dragState.scope!==scope||dragState.groupId!==groupId||dragState.key===key)return;e.preventDefault();tile.classList.add('drag-over')});tile.addEventListener('dragleave',()=>tile.classList.remove('drag-over'));tile.addEventListener('drop',async e=>{if(!dragState||dragState.scope!==scope||dragState.groupId!==groupId||dragState.key===key)return;e.preventDefault();tile.classList.remove('drag-over');await reorderDrop(scope,dragState.key,key,groupId)})}
async function reorderDrop(scope,fromKey,toKey,groupId=''){let ids;if(scope==='home'){ids=model.home.map(x=>x.type+':'+x.id)}else{ids=(groupById(groupId)?.stories||[]).map(x=>x.id)}const from=ids.indexOf(fromKey),to=ids.indexOf(toKey);if(from<0||to<0)return;const [moved]=ids.splice(from,1);ids.splice(to,0,moved);await window.harvestInternal.offlineLibraryReorder(scope,ids,groupId);await refresh()}
function makeStoryTile(story,{scope='home',groupId=''}={}){
  const card=document.createElement('article');card.className='tile story-tile';
  const head=document.createElement('div');head.className='tile-head';const handle=document.createElement('span');handle.className='drag-handle';handle.textContent='⠿';handle.title='ลากเพื่อจัดตำแหน่ง';const title=document.createElement('div');title.className='tile-title';title.textContent=story.title;const count=document.createElement('span');count.className='tile-count';count.textContent=(story.chapterCount||0)+' ตอน';head.append(handle,title,count);
  const cover=document.createElement('div');cover.className='story-cover';cover.onclick=()=>openStory(story.id);if(story.coverItemId){const img=document.createElement('img');img.alt=story.title;img.loading='lazy';cover.append(img);hydrateCover(img,story.coverItemId)}else{const ph=document.createElement('div');ph.className='cover-placeholder';ph.textContent='▧';cover.append(ph)}const badge=document.createElement('span');badge.className='story-badge';badge.textContent=(story.pageCount||0)+' หน้า';cover.append(badge);
  const body=document.createElement('div');body.className='tile-body';const sub=document.createElement('div');sub.className='tile-sub';sub.textContent=(story.groupId?groupName(story.groupId):'ไม่มีกลุ่ม')+' • '+fmtTime(story.updatedAt);const tools=document.createElement('div');tools.className='story-tools';const select=groupSelect(story),edit=document.createElement('button');edit.className='icon-btn';edit.textContent='✎';edit.title='เปลี่ยนชื่อเรื่อง';edit.onclick=async e=>{e.stopPropagation();const name=await askText('เปลี่ยนชื่อเรื่อง','ชื่อเรื่อง',story.title);if(!name)return;await window.harvestInternal.offlineLibraryProjectRename(story.id,name);await refresh()};tools.append(select,edit);body.append(sub,tools);card.append(head,cover,body);attachDrag(card,{scope,key:scope==='home'?'story:'+story.id:story.id,id:story.id,groupId});return card;
}
function makeMiniCover(story){const box=document.createElement('div');box.className='mini-cover';if(story?.coverItemId){const img=document.createElement('img');img.alt=story.title;img.loading='lazy';box.append(img);hydrateCover(img,story.coverItemId)}else{const ph=document.createElement('div');ph.className='cover-placeholder';ph.textContent='▧';box.append(ph)}return box}
function makeGroupTile(group){
  const card=document.createElement('article');card.className='tile group-tile';const head=document.createElement('div');head.className='tile-head';const handle=document.createElement('span');handle.className='drag-handle';handle.textContent='⠿';handle.title='ลากเพื่อจัดตำแหน่ง';const title=document.createElement('div');title.className='tile-title';title.textContent=group.title;const count=document.createElement('span');count.className='tile-count';count.textContent=(group.storyCount||0)+' เรื่อง';head.append(handle,title,count);
  const preview=document.createElement('div');preview.className='group-preview';preview.onclick=()=>openGroup(group.id);const stories=group.stories||[];for(let i=0;i<4;i++)preview.append(makeMiniCover(stories[i]));const footer=document.createElement('div');footer.className='group-footer';const meta=document.createElement('span');meta.textContent=(group.pageCount||0)+' หน้า';const open=document.createElement('button');open.className='group-open';open.textContent='เปิดกลุ่ม';open.onclick=e=>{e.stopPropagation();openGroup(group.id)};footer.append(meta,open);card.append(head,preview,footer);attachDrag(card,{scope:'home',key:'group:'+group.id,id:group.id});return card;
}
function renderHome(){
  const q=search.trim().toLowerCase(),host=$('homeGrid'),f=document.createDocumentFragment();let shown=0;
  for(const ref of model.home||[]){if(ref.type==='group'){const g=groupById(ref.id);if(!g)continue;const hay=(g.title+' '+(g.stories||[]).map(s=>s.title).join(' ')).toLowerCase();if(q&&!hay.includes(q))continue;f.append(makeGroupTile(g));shown++;}else{const story=storyById(ref.id);if(!story)continue;const hay=(story.title+' '+(story.chapters||[]).map(x=>x.title+' '+x.url).join(' ')).toLowerCase();if(q&&!hay.includes(q))continue;f.append(makeStoryTile(story));shown++;}}
  $('meta').textContent=shown+' รายการ • '+model.stories.length+' เรื่อง • '+model.groups.length+' กลุ่ม • ลากการ์ดเพื่อจัดตำแหน่ง';
  if(!shown){const e=document.createElement('div');e.className='empty';e.textContent=q?'ไม่พบเรื่องที่ค้นหา':'ยังไม่มีเรื่องที่บันทึกไว้';host.replaceChildren(e)}else host.replaceChildren(f);
}
function openGroup(id){activeGroupId=id;renderGroup();$('groupDialog').showModal()}
function renderGroup(){const g=groupById(activeGroupId);if(!g){$('groupDialog').close();return}$('groupTitle').textContent=g.title;$('groupMeta').textContent=(g.storyCount||0)+' เรื่อง • '+(g.pageCount||0)+' หน้า • ลากการ์ดเพื่อจัดตำแหน่ง';const host=$('groupGrid'),f=document.createDocumentFragment();for(const story of g.stories||[])f.append(makeStoryTile(story,{scope:'group',groupId:g.id}));if(!(g.stories||[]).length){const e=document.createElement('div');e.className='empty';e.textContent='กลุ่มนี้ยังไม่มีเรื่อง';host.replaceChildren(e)}else host.replaceChildren(f)}
function openStory(id){activeStoryId=id;renderStory();if($('groupDialog').open)$('groupDialog').close();$('storyDialog').showModal()}
function renderStory(){const story=storyById(activeStoryId);if(!story){$('storyDialog').close();return}$('storyTitle').textContent=story.title;$('storyMeta').textContent=(story.chapterCount||0)+' ตอน • '+(story.pageCount||0)+' หน้า • '+fmtBytes(story.sizeBytes);const host=$('chapters'),f=document.createDocumentFragment();for(const ch of story.chapters||[]){const card=document.createElement('article');card.className='chapter-card';const thumb=document.createElement('div');thumb.className='chapter-thumb';const img=document.createElement('img');img.alt=ch.title;thumb.append(img);hydrateCover(img,ch.id);const info=document.createElement('div');info.className='chapter-info';const name=document.createElement('div');name.className='chapter-name';name.textContent=ch.title||'Untitled';const url=document.createElement('div');url.className='chapter-url';url.textContent=ch.url;const meta=document.createElement('div');meta.className='chapter-meta';meta.textContent=(ch.pages||0)+' หน้า • '+fmtBytes(ch.sizeBytes)+' • '+fmtTime(ch.updatedAt);info.append(name,url,meta);const acts=document.createElement('div');acts.className='chapter-actions';const read=document.createElement('button');read.className='primary';read.textContent='อ่าน';read.onclick=()=>window.harvestInternal.offlineOpen(ch.id);const web=document.createElement('button');web.textContent='เปิดเว็บ';web.onclick=()=>window.harvestInternal.offlineOpenSource(ch.id);const del=document.createElement('button');del.className='danger';del.textContent='ลบ';del.onclick=async()=>{if(!confirm('ลบตอนนี้ออกจากเครื่อง?'))return;await window.harvestInternal.offlineRemove(ch.id);await refresh();renderStory()};acts.append(read,web,del);card.append(thumb,info,acts);f.append(card)}host.replaceChildren(f)}
async function refresh(){model=await window.harvestInternal.offlineList();renderHome();if($('groupDialog').open)renderGroup();if($('storyDialog').open)renderStory()}
$('search').oninput=e=>{search=e.target.value;renderHome()};
$('newGroup').onclick=async()=>{const name=await askText('สร้างกลุ่ม','ชื่อกลุ่ม');if(!name)return;const g=await window.harvestInternal.offlineGroupCreate(name);await refresh();openGroup(g.id)};
$('renameGroup').onclick=async()=>{const g=groupById(activeGroupId);if(!g)return;const name=await askText('เปลี่ยนชื่อกลุ่ม','ชื่อกลุ่ม',g.title);if(!name)return;await window.harvestInternal.offlineGroupRename(g.id,name);await refresh()};
$('deleteGroup').onclick=async()=>{const g=groupById(activeGroupId);if(!g||!confirm('ลบกลุ่มนี้? เรื่องข้างในจะกลับไปหน้า Offline Library'))return;await window.harvestInternal.offlineGroupRemove(g.id);$('groupDialog').close();await refresh()};
$('closeGroup').onclick=()=>$('groupDialog').close();$('closeStory').onclick=()=>$('storyDialog').close();
$('renameStory').onclick=async()=>{const story=storyById(activeStoryId);if(!story)return;const name=await askText('เปลี่ยนชื่อเรื่อง','ชื่อเรื่อง',story.title);if(!name)return;await window.harvestInternal.offlineLibraryProjectRename(story.id,name);await refresh();renderStory()};
$('groupDialog').addEventListener('click',e=>{if(e.target===$('groupDialog'))$('groupDialog').close()});$('storyDialog').addEventListener('click',e=>{if(e.target===$('storyDialog'))$('storyDialog').close()});
$('textDialogForm').addEventListener('submit',e=>{e.preventDefault();const value=$('textDialogInput').value.trim();if(!value){$('textDialogInput').focus();return}finishTextDialog(value)});$('textDialogCancel').onclick=()=>finishTextDialog(null);$('textDialog').addEventListener('cancel',e=>{e.preventDefault();finishTextDialog(null)});$('textDialog').addEventListener('click',e=>{if(e.target===$('textDialog'))finishTextDialog(null)});
refresh().catch(e=>{$('meta').textContent='โหลดไม่ได้: '+e.message});
''',encoding="utf-8")

print("patched grouped-story Offline Library with drag ordering")
