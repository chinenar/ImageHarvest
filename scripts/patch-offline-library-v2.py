from pathlib import Path

root=Path(r"E:\Shared\ExportImagefromWeb")
main=root/"src"/"main.cjs"
pre=root/"src"/"harvest-internal-preload.cjs"

def once(s,old,new,label):
    if old not in s: raise SystemExit("missing "+label)
    return s.replace(old,new,1)

s=main.read_text(encoding="utf-8")

# Upgrade the offline index into a library: groups -> series projects -> saved chapters.
old="""async function harvestOfflineIndex(){
  const value=await harvestOfflineReadJson(harvestTsOfflineIndexFile,{version:1,items:[]});
  return {version:1,items:Array.isArray(value.items)?value.items:[]};
}"""
new="""function harvestOfflineSeriesInfo(url,title=''){
  let display=String(title||'').trim().replace(/^\\s*\\d+\\s*\\|\\s*/,'').replace(/^\\s*Manga:\\s*/i,'');
  display=display.replace(/\\s*[-|]\\s*MangaDex\\s*$/i,'').trim();
  const prefix=display.match(/^(?:Chapter|Ch\\.?)[\\s#]*\\d+(?:\\.\\d+)*(?:\\s*[-–—|:]\\s*)(.+)$/i);
  if(prefix)display=prefix[1].trim();
  display=display.replace(/\\s+(?:Chapter|Ch\\.?)[\\s#]*\\d+(?:\\.\\d+)*\\b.*$/i,'').trim();
  display=display.replace(/\\s*[-–—|:]\\s*$/,'').trim();
  let sourceKey='';
  try{
    const u=new URL(url),decoded=decodeURIComponent(u.pathname);
    const m=decoded.match(/^(.*?)(?:[-_/](?:chapter|chap|ch)[-_ ]?\\d+(?:\\.\\d+)?\\b)/i);
    if(m&&m[1].length>1)sourceKey=u.hostname.toLowerCase()+m[1].toLowerCase();
  }catch{}
  if(!display){try{display=new URL(url).hostname.replace(/^www\\./,'');}catch{display='Offline Project';}}
  const normalized=display.toLowerCase().replace(/[\\s\\u00a0]+/g,' ').replace(/[^\\p{L}\\p{N}]+/gu,' ').trim();
  const key=sourceKey||normalized||harvestOfflineDocumentKey(url);
  return {id:'series-'+createHash('sha256').update(key).digest('hex').slice(0,16),title:display};
}
async function harvestOfflineIndex(){
  const value=await harvestOfflineReadJson(harvestTsOfflineIndexFile,{version:2,items:[],projects:[],groups:[]});
  const items=Array.isArray(value.items)?value.items.filter(Boolean).map(row=>({...row})):[];
  const groups=Array.isArray(value.groups)?value.groups.filter(x=>x&&x.id&&x.title).map(x=>({...x})):[];
  const projects=Array.isArray(value.projects)?value.projects.filter(x=>x&&x.id&&x.title).map(x=>({...x})):[];
  const byId=new Map(projects.map(x=>[x.id,x]));
  for(const row of items){
    if(!row.projectId){
      const info=harvestOfflineSeriesInfo(row.url,row.title);row.projectId=info.id;
      if(!byId.has(info.id)){const project={id:info.id,title:info.title,groupId:'',manual:false,createdAt:Number(row.createdAt)||Date.now(),updatedAt:Number(row.updatedAt)||Date.now()};projects.push(project);byId.set(project.id,project);}
    }else if(!byId.has(row.projectId)){
      const info=harvestOfflineSeriesInfo(row.url,row.title),project={id:row.projectId,title:info.title,groupId:'',manual:false,createdAt:Number(row.createdAt)||Date.now(),updatedAt:Number(row.updatedAt)||Date.now()};projects.push(project);byId.set(project.id,project);
    }
  }
  return {version:2,items,projects,groups};
}
async function harvestOfflineWriteIndex(index){
  await harvestOfflineWriteJson(harvestTsOfflineIndexFile,{version:2,items:index.items||[],projects:index.projects||[],groups:index.groups||[]});
}
function harvestOfflineSafeTitle(value,fallback='โปรเจกต์'){
  const title=String(value||'').replace(/[\\x00-\\x1f]/g,' ').replace(/\\s+/g,' ').trim().slice(0,120);
  if(!title)throw Error('กรุณาใส่ชื่อ'+fallback);
  return title;
}
function harvestOfflineChapterNumber(row){
  const text=String(row?.title||'')+' '+String(row?.url||'');
  const m=text.match(/(?:chapter|chap|ch)[\\s_/#-]*(\\d+(?:\\.\\d+)?)/i);return m?Number(m[1]):Number.POSITIVE_INFINITY;
}
async function harvestOfflineLibraryList(){
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
}
async function harvestOfflineLibraryProjectCreate(input={}){
  const title=harvestOfflineSafeTitle(input.title,'โปรเจกต์'),groupId=String(input.groupId||'');
  return harvestOfflineQueued(async()=>{const index=await harvestOfflineIndex();if(groupId&&!index.groups.some(x=>x.id===groupId))throw Error('ไม่พบกลุ่มที่เลือก');const project={id:'series-'+randomUUID(),title,groupId,manual:true,createdAt:Date.now(),updatedAt:Date.now()};index.projects.push(project);await harvestOfflineWriteIndex(index);return project;});
}
async function harvestOfflineLibraryProjectRename(input={}){
  const id=String(input.id||''),title=harvestOfflineSafeTitle(input.title,'โปรเจกต์');
  return harvestOfflineQueued(async()=>{const index=await harvestOfflineIndex(),project=index.projects.find(x=>x.id===id);if(!project)throw Error('ไม่พบโปรเจกต์');project.title=title;project.updatedAt=Date.now();await harvestOfflineWriteIndex(index);return project;});
}
async function harvestOfflineLibraryProjectGroup(input={}){
  const id=String(input.id||''),groupId=String(input.groupId||'');
  return harvestOfflineQueued(async()=>{const index=await harvestOfflineIndex(),project=index.projects.find(x=>x.id===id);if(!project)throw Error('ไม่พบโปรเจกต์');if(groupId&&!index.groups.some(x=>x.id===groupId))throw Error('ไม่พบกลุ่มที่เลือก');project.groupId=groupId;project.updatedAt=Date.now();await harvestOfflineWriteIndex(index);return project;});
}
async function harvestOfflineItemProject(input={}){
  const id=String(input.id||''),projectId=String(input.projectId||'');
  return harvestOfflineQueued(async()=>{const index=await harvestOfflineIndex(),item=index.items.find(x=>x.id===id),project=index.projects.find(x=>x.id===projectId);if(!item)throw Error('ไม่พบตอนที่บันทึกไว้');if(!project)throw Error('ไม่พบโปรเจกต์');item.projectId=projectId;item.updatedAt=Date.now();project.updatedAt=item.updatedAt;await harvestOfflineWriteIndex(index);return true;});
}
async function harvestOfflineCover(itemId){
  const saved=await harvestOfflineReadProject(String(itemId||'')),page=(saved.manifest.pages||[]).find(p=>p?.file&&!p.error);if(!page)throw Error('ไม่พบภาพปก');
  const bytes=await fs.readFile(path.join(saved.dir,page.file));return {mime:page.mime||'application/octet-stream',bytes:new Uint8Array(bytes),file:page.file};
}"""
s=once(s,old,new,"library index")

# Existing list now returns the richer library model.
old="""async function harvestOfflineList(){
  const index=await harvestOfflineIndex();
  return {items:[...index.items].sort((a,b)=>Number(b.updatedAt||0)-Number(a.updatedAt||0))};
}"""
new="""async function harvestOfflineList(){ return harvestOfflineLibraryList(); }"""
s=once(s,old,new,"offline list")

# Preserve/derive the series project when saving a chapter and persist v2 metadata.
old="""    const index=await harvestOfflineIndex(),old=index.items.find(row=>row.id===id),createdAt=old?.createdAt||Date.now(),updatedAt=Date.now();"""
new="""    const index=await harvestOfflineIndex(),old=index.items.find(row=>row.id===id),createdAt=old?.createdAt||Date.now(),updatedAt=Date.now();
    const series=harvestOfflineSeriesInfo(documentUrl,job.manifest.source?.title||tab.view.webContents.getTitle()||''),projectId=old?.projectId||series.id;
    let libraryProject=index.projects.find(x=>x.id===projectId);
    if(!libraryProject){libraryProject={id:projectId,title:series.title,groupId:'',manual:false,createdAt,updatedAt};index.projects.push(libraryProject);}else libraryProject.updatedAt=updatedAt;"""
s=once(s,old,new,"save project")
old="""      const row={id,documentKey,url:documentUrl,title:project.title,createdAt,updatedAt,pages:project.pages,sizeBytes,targetLanguage};
      const next=[row,...index.items.filter(x=>x.id!==id)];await harvestOfflineWriteJson(harvestTsOfflineIndexFile,{version:1,items:next});"""
new="""      const coverPage=pages[0]||null;
      const row={id,documentKey,url:documentUrl,title:project.title,createdAt,updatedAt,pages:project.pages,sizeBytes,targetLanguage,projectId,coverFile:coverPage?.file||'',coverMime:coverPage?.mime||''};
      index.items=[row,...index.items.filter(x=>x.id!==id)];await harvestOfflineWriteIndex(index);"""
s=once(s,old,new,"save row")

# Keep v2 metadata when deleting/updating.
old="""    await harvestOfflineWriteJson(harvestTsOfflineIndexFile,{version:1,items:index.items.filter(x=>x.id!==row.id)});
    return {removed:true,id:row.id};"""
new="""    index.items=index.items.filter(x=>x.id!==row.id);await harvestOfflineWriteIndex(index);
    return {removed:true,id:row.id};"""
s=once(s,old,new,"remove index")
old="""    row.updatedAt=project.updatedAt;await harvestOfflineWriteJson(harvestTsOfflineIndexFile,index);"""
new="""    row.updatedAt=project.updatedAt;await harvestOfflineWriteIndex(index);"""
s=once(s,old,new,"style index")

# Save Offline should be quiet: stay on the current web page and only update status.
old="""    { label:'▤ Save Offline', enabled:Boolean(tab&&tab.kind==='web'), click:()=>{ harvestOfflineSave(tab).then(()=>harvestTsOpenOffline()).catch(error=>emit('harvestts-error',{id:tab?.id,message:error.message,url:tab?.view?.webContents?.getURL?.()||''})); } },"""
new="""    { label:'▤ Save Offline', enabled:Boolean(tab&&tab.kind==='web'), click:()=>{ harvestOfflineSave(tab).then(row=>emit('harvestts-offline-saved',{tabId:tab.id,title:row.title,pages:row.pages})).catch(error=>emit('harvestts-error',{id:tab?.id,message:error.message,url:tab?.view?.webContents?.getURL?.()||''})); } },"""
s=once(s,old,new,"silent save")

# IPC endpoints for library organization / covers.
old="""    'offline-list','offline-remove','offline-open','offline-open-source','offline-project','offline-image','offline-export-start','offline-export-page','offline-export-finish'"""
new="""    'offline-list','offline-remove','offline-open','offline-open-source','offline-project','offline-image','offline-cover','offline-group-create','offline-group-remove','offline-library-project-create','offline-library-project-rename','offline-library-project-group','offline-item-project','offline-export-start','offline-export-page','offline-export-finish'"""
s=once(s,old,new,"offline channels")
old="""  ipcMain.handle('harvest-internal:offline-list', async event => { harvestInternalSender(event,'offline'); return harvestOfflineList(); });
  ipcMain.handle('harvest-internal:offline-remove', async (event,input={}) => { harvestInternalSender(event,'offline'); return harvestOfflineRemove(input.id); });"""
new="""  ipcMain.handle('harvest-internal:offline-list', async event => { harvestInternalSender(event,'offline'); return harvestOfflineList(); });
  ipcMain.handle('harvest-internal:offline-cover', async (event,input={}) => { harvestInternalSender(event,'offline'); return harvestOfflineCover(input.id); });
  ipcMain.handle('harvest-internal:offline-group-create', async (event,input={}) => { harvestInternalSender(event,'offline'); return harvestOfflineGroupCreate(input); });
  ipcMain.handle('harvest-internal:offline-group-remove', async (event,input={}) => { harvestInternalSender(event,'offline'); return harvestOfflineGroupRemove(input); });
  ipcMain.handle('harvest-internal:offline-library-project-create', async (event,input={}) => { harvestInternalSender(event,'offline'); return harvestOfflineLibraryProjectCreate(input); });
  ipcMain.handle('harvest-internal:offline-library-project-rename', async (event,input={}) => { harvestInternalSender(event,'offline'); return harvestOfflineLibraryProjectRename(input); });
  ipcMain.handle('harvest-internal:offline-library-project-group', async (event,input={}) => { harvestInternalSender(event,'offline'); return harvestOfflineLibraryProjectGroup(input); });
  ipcMain.handle('harvest-internal:offline-item-project', async (event,input={}) => { harvestInternalSender(event,'offline'); return harvestOfflineItemProject(input); });
  ipcMain.handle('harvest-internal:offline-remove', async (event,input={}) => { harvestInternalSender(event,'offline'); return harvestOfflineRemove(input.id); });"""
s=once(s,old,new,"offline ipc")

main.write_text(s,encoding="utf-8")

# Expose library APIs to the internal Offline page.
s=pre.read_text(encoding="utf-8")
old="""  offlineList: () => ipcRenderer.invoke('harvest-internal:offline-list'),
  offlineRemove: id => ipcRenderer.invoke('harvest-internal:offline-remove', { id }),"""
new="""  offlineList: () => ipcRenderer.invoke('harvest-internal:offline-list'),
  offlineCover: id => ipcRenderer.invoke('harvest-internal:offline-cover', { id }),
  offlineGroupCreate: title => ipcRenderer.invoke('harvest-internal:offline-group-create', { title }),
  offlineGroupRemove: id => ipcRenderer.invoke('harvest-internal:offline-group-remove', { id }),
  offlineLibraryProjectCreate: (title,groupId) => ipcRenderer.invoke('harvest-internal:offline-library-project-create', { title,groupId }),
  offlineLibraryProjectRename: (id,title) => ipcRenderer.invoke('harvest-internal:offline-library-project-rename', { id,title }),
  offlineLibraryProjectGroup: (id,groupId) => ipcRenderer.invoke('harvest-internal:offline-library-project-group', { id,groupId }),
  offlineItemProject: (id,projectId) => ipcRenderer.invoke('harvest-internal:offline-item-project', { id,projectId }),
  offlineRemove: id => ipcRenderer.invoke('harvest-internal:offline-remove', { id }),"""
s=once(s,old,new,"preload library api")
pre.write_text(s,encoding="utf-8")
print("patched offline library data model + silent save")
