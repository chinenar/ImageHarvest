from pathlib import Path
root=Path(r"E:\Shared\ExportImagefromWeb")
main=root/"src"/"main.cjs"
pre=root/"src"/"harvest-internal-preload.cjs"

def once(s,old,new,label):
    if old not in s:
        raise SystemExit("missing anchor: "+label)
    return s.replace(old,new,1)

s=main.read_text(encoding="utf-8")

# persistent Offline Library paths
old="""const harvestTsTranslateSettingsFile = path.join(harvestTsDataDir, 'translate-settings.json');
const harvestAdblockCacheFile = path.join(harvestTsDataDir, 'harvest-adblock-engine.bin');"""
new="""const harvestTsTranslateSettingsFile = path.join(harvestTsDataDir, 'translate-settings.json');
const harvestTsOfflineDir = path.join(harvestTsDataDir, 'offline-library');
const harvestTsOfflineIndexFile = path.join(harvestTsOfflineDir, 'index.json');
const harvestOfflineExportSessions = new Map();
let harvestOfflineWriteQueue = Promise.resolve();
const harvestAdblockCacheFile = path.join(harvestTsDataDir, 'harvest-adblock-engine.bin');"""
s=once(s,old,new,"offline paths")

# main Offline Library implementation + restore overlays
anchor="async function restoreHarvestTranslationJob(tab){"
offline_code=r"""
function harvestOfflineDocumentKey(url){return readerDocumentKey(String(url||''));}
function harvestOfflineProjectId(url){return createHash('sha256').update(harvestOfflineDocumentKey(url)).digest('hex').slice(0,24);}
async function harvestOfflineReadJson(file,fallback){
  try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return fallback;throw error;}
}
async function harvestOfflineWriteJson(file,value){
  await fs.mkdir(path.dirname(file),{recursive:true});
  const temp=file+'.'+randomUUID()+'.tmp';
  try{
    await fs.writeFile(temp,JSON.stringify(value,null,2),'utf8');
    for(let n=0;;n++){try{await fs.rename(temp,file);break;}catch(error){if(n>=4||!['EPERM','EBUSY','EACCES','EEXIST'].includes(error.code))throw error;await fs.rm(file,{force:true}).catch(()=>{});await new Promise(r=>setTimeout(r,45*(n+1)));}}
  }finally{await fs.rm(temp,{force:true}).catch(()=>{});}
}
function harvestOfflineQueued(task){
  const next=harvestOfflineWriteQueue.then(task);
  harvestOfflineWriteQueue=next.catch(()=>{});
  return next;
}
async function harvestOfflineIndex(){
  const value=await harvestOfflineReadJson(harvestTsOfflineIndexFile,{version:1,items:[]});
  return {version:1,items:Array.isArray(value.items)?value.items:[]};
}
function harvestOfflineProjectDir(id){if(!/^[0-9a-f]{24}$/.test(String(id||'')))throw Error('Offline project ID ไม่ถูกต้อง');return path.join(harvestTsOfflineDir,String(id));}
async function harvestOfflineReadProject(id){
  const dir=harvestOfflineProjectDir(id);
  const [project,manifest]=await Promise.all([
    harvestOfflineReadJson(path.join(dir,'project.json'),null),
    harvestOfflineReadJson(path.join(dir,'manifest.json'),null)
  ]);
  if(!project||!manifest||project.id!==id||!Array.isArray(manifest.pages))throw Error('ไม่พบงาน Offline นี้');
  return {dir,project,manifest};
}
async function harvestOfflineFindByUrl(url){
  const key=harvestOfflineDocumentKey(url),index=await harvestOfflineIndex();
  return index.items.find(row=>row.documentKey===key)||null;
}
async function harvestOfflineList(){
  const index=await harvestOfflineIndex();
  return {items:[...index.items].sort((a,b)=>Number(b.updatedAt||0)-Number(a.updatedAt||0))};
}
async function harvestOfflineSave(tab){
  if(!tab||tab.kind!=='web'||tab.view.webContents.isDestroyed())throw Error('เปิดหน้าเว็บที่แปลแล้วก่อนบันทึก Offline');
  const currentUrl=tab.view.webContents.getURL()||tab.url||'';
  let job=harvestTranslationJobFor(tab);
  if(job?.running)throw Error('รอ Harvest Translate ทำงานให้เสร็จก่อน');
  if(!job?.manifest?.pages){
    const existing=await harvestOfflineFindByUrl(currentUrl);
    if(existing)return existing;
    throw Error('ยังไม่มีงาน Harvest Translate สำหรับหน้านี้');
  }
  if(!sameHarvestTranslationPage(job.sourceUrl||job.manifest.source?.url,currentUrl))throw Error('งานแปลปัจจุบันไม่ได้เป็นของหน้าเว็บนี้');
  const documentUrl=job.manifest.source?.url||job.sourceUrl||currentUrl,documentKey=harvestOfflineDocumentKey(documentUrl),id=harvestOfflineProjectId(documentUrl);
  return harvestOfflineQueued(async()=>{
    const index=await harvestOfflineIndex(),old=index.items.find(row=>row.id===id),createdAt=old?.createdAt||Date.now(),updatedAt=Date.now();
    const target=harvestOfflineProjectDir(id),temp=target+'.tmp-'+randomUUID();
    await fs.mkdir(temp,{recursive:true});
    let sizeBytes=0;
    const pages=job.manifest.pages.filter(p=>p?.file&&!p.error);
    try{
      for(const page of pages){
        const name=path.basename(String(page.file||''));if(name!==page.file)throw Error('ชื่อไฟล์หน้า Offline ไม่ถูกต้อง');
        const from=path.join(job.dir,name),to=path.join(temp,name),stat=await fs.stat(from);
        if(!stat.isFile())throw Error('ไม่พบภาพ '+name);
        await fs.copyFile(from,to);sizeBytes+=stat.size;
      }
      const styles={};const targetLanguage=job.manifest.settings?.targetLanguage||'th';
      for(const page of job.manifest.pages){
        let rendered;try{rendered=overlayPage(page,{documentUrl,targetLanguage});}catch{continue;}
        const pageStyles={};
        for(const region of rendered.regions||[]){
          const key=regionStyleKey(rendered,{...region,text:region.original},targetLanguage),style=await regionStyles().get(key);
          if(style)pageStyles[String(region.id)]=style;
        }
        if(Object.keys(pageStyles).length)styles[String(page.id)]=pageStyles;
      }
      const manifest=JSON.parse(JSON.stringify(job.manifest));
      const project={version:1,id,documentKey,url:documentUrl,title:manifest.source?.title||tab.view.webContents.getTitle()||'Offline',createdAt,updatedAt,pages:pages.length,sizeBytes,targetLanguage,styles};
      await fs.writeFile(path.join(temp,'manifest.json'),JSON.stringify(manifest,null,2),'utf8');
      await fs.writeFile(path.join(temp,'project.json'),JSON.stringify(project,null,2),'utf8');
      await fs.rm(target,{recursive:true,force:true});await fs.rename(temp,target);
      const row={id,documentKey,url:documentUrl,title:project.title,createdAt,updatedAt,pages:project.pages,sizeBytes,targetLanguage};
      const next=[row,...index.items.filter(x=>x.id!==id)];await harvestOfflineWriteJson(harvestTsOfflineIndexFile,{version:1,items:next});
      job={...job,dir:target,persistent:true,manifest};harvestTranslationJobs.set(tab.id,job);
      tab.offlineProjectId=id;
      return row;
    }finally{await fs.rm(temp,{recursive:true,force:true}).catch(()=>{});}
  });
}
async function harvestOfflineRemove(id){
  return harvestOfflineQueued(async()=>{
    const index=await harvestOfflineIndex(),row=index.items.find(x=>x.id===String(id||''));if(!row)return {removed:false};
    await fs.rm(harvestOfflineProjectDir(row.id),{recursive:true,force:true});
    await harvestOfflineWriteJson(harvestTsOfflineIndexFile,{version:1,items:index.items.filter(x=>x.id!==row.id)});
    return {removed:true,id:row.id};
  });
}
async function harvestOfflineUpdateStyle(documentUrl,pageId,regionId,style){
  const key=harvestOfflineDocumentKey(documentUrl);
  return harvestOfflineQueued(async()=>{
    const index=await harvestOfflineIndex(),row=index.items.find(x=>x.documentKey===key);if(!row)return false;
    const file=path.join(harvestOfflineProjectDir(row.id),'project.json'),project=await harvestOfflineReadJson(file,null);if(!project)return false;
    project.styles=project.styles&&typeof project.styles==='object'?project.styles:{};
    const pageKey=String(pageId),regionKey=String(regionId),pageStyles={...(project.styles[pageKey]||{})};
    if(style)pageStyles[regionKey]=style;else delete pageStyles[regionKey];
    if(Object.keys(pageStyles).length)project.styles[pageKey]=pageStyles;else delete project.styles[pageKey];
    project.updatedAt=Date.now();await harvestOfflineWriteJson(file,project);
    row.updatedAt=project.updatedAt;await harvestOfflineWriteJson(harvestTsOfflineIndexFile,index);
    return true;
  });
}
async function harvestOfflineProjectData(id){
  const {project,manifest}=await harvestOfflineReadProject(String(id||'')),targetLanguage=manifest.settings?.targetLanguage||project.targetLanguage||'th',pages=[];
  for(const page of manifest.pages||[]){
    if(!page.file||page.error)continue;
    let overlay;try{overlay=overlayPage(page,{documentUrl:'offline://'+project.id,targetLanguage});}catch{overlay={regions:[],reviewCount:0};}
    for(const region of overlay.regions||[])region.userStyle=project.styles?.[String(page.id)]?.[String(region.id)]||null;
    pages.push({id:String(page.id),index:Number(page.index)||0,file:page.file,width:Number(page.width)||0,height:Number(page.height)||0,mime:page.mime||'',imageUrl:`eiw://offline/${project.id}/${encodeURIComponent(page.file)}`,regions:overlay.regions||[]});
  }
  return {project:{id:project.id,title:project.title,url:project.url,createdAt:project.createdAt,updatedAt:project.updatedAt,targetLanguage},pages};
}
async function restoreHarvestOfflineOverlay(tab){
  if(!tab||tab.kind!=='web'||tab.view.webContents.isDestroyed())return null;
  const wc=tab.view.webContents,url=wc.getURL()||tab.url||'',documentKey=harvestOfflineDocumentKey(url);
  if(!/^https?:/i.test(url)||tab.offlineOverlayDocument===documentKey)return null;
  const active=harvestTranslationJobFor(tab);if(active?.running)return null;
  const row=await harvestOfflineFindByUrl(url);if(!row)return null;
  const saved=await harvestOfflineReadProject(row.id),manifest=saved.manifest,settings=manifest.settings||HARVEST_TRANSLATE_DEFAULTS;
  if(!sameHarvestTranslationPage(manifest.source?.url||row.url,url))return null;
  const job={id:manifest.jobId||('offline-'+row.id),dir:saved.dir,sourceUrl:manifest.source?.url||row.url,manifest,running:false,persistent:true,abort:new AbortController()};
  harvestTranslationJobs.set(tab.id,job);
  await wc.executeJavaScript(`window.__harvestTsTranslationOverlay||(window.__harvestTsTranslationOverlay=(${createTranslationOverlay.toString()})(${readerDocumentKey.toString()}))`).catch(()=>{});
  let regions=0,pages=0;
  for(const page of manifest.pages||[]){
    if(!page?.ocr?.regions?.length||page.error)continue;
    try{
      const rendered=await prepareOverlayStyles(tab,overlayPage(page,{documentUrl:job.sourceUrl,targetLanguage:settings.targetLanguage||'th'}));
      for(const region of rendered.regions||[])region.userStyle=saved.project.styles?.[String(page.id)]?.[String(region.id)]||region.userStyle||null;
      if(!rendered.regions.length)continue;
      await wc.executeJavaScript(`window.__harvestTsTranslationOverlay?.apply(${JSON.stringify(rendered)},${JSON.stringify({fontScale:settings.fontScale||1,visible:!settings.showOriginal})})`);
      regions+=rendered.regions.length;pages++;
    }catch{}
  }
  tab.offlineOverlayDocument=documentKey;tab.offlineProjectId=row.id;
  if(regions)sendHarvestTranslation(tab,{type:'complete',jobId:job.id,total:manifest.pages.length,ready:pages,failed:0,translatedRegions:regions,translationFailed:0,message:`โหลดงาน Offline แล้ว • ${pages} หน้า • ไม่ต้อง OCR หรือแปลใหม่`});
  return {id:row.id,pages,regions};
}
async function harvestOfflineExportStart(tab,input={}){
  const projectId=String(input.id||tab.projectId||''),data=await harvestOfflineProjectData(projectId),mode=['original','clean','translated'].includes(input.mode)?input.mode:'translated';
  const pick=await dialog.showOpenDialog(mainWindow,{title:'เลือกโฟลเดอร์สำหรับ Export',properties:['openDirectory','createDirectory']});
  if(pick.canceled||!pick.filePaths?.[0])return {cancelled:true};
  const cleanName=String(data.project.title||'ImageHarvest').replace(/[<>:"/\\|?*\x00-\x1f]/g,' ').replace(/\s+/g,' ').trim().slice(0,80)||'ImageHarvest';
  const suffix=mode==='translated'?'translated':mode==='clean'?'clean':'original',folder=path.join(pick.filePaths[0],cleanName+' - '+suffix);
  await fs.mkdir(folder,{recursive:true});const token=randomUUID();
  harvestOfflineExportSessions.set(token,{tabId:tab.id,projectId:data.project.id,folder,mode,total:data.pages.length,written:0,createdAt:Date.now()});
  return {cancelled:false,token,total:data.pages.length,mode};
}
async function harvestOfflineExportPage(tab,input={}){
  const session=harvestOfflineExportSessions.get(String(input.token||''));if(!session||session.tabId!==tab.id)throw Error('Export session หมดอายุ');
  const index=Number(input.index);if(!Number.isInteger(index)||index<0||index>=session.total)throw Error('ลำดับหน้า Export ไม่ถูกต้อง');
  const bytes=input.bytes;let buffer=null;
  if(bytes instanceof ArrayBuffer)buffer=Buffer.from(bytes);else if(ArrayBuffer.isView(bytes))buffer=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(!buffer||!buffer.length||buffer.length>64*1024*1024)throw Error('ข้อมูลภาพ Export ไม่ถูกต้อง');
  await fs.writeFile(path.join(session.folder,String(index+1).padStart(4,'0')+'.png'),buffer);session.written++;
  return {written:session.written,total:session.total};
}
async function harvestOfflineExportFinish(tab,input={}){
  const token=String(input.token||''),session=harvestOfflineExportSessions.get(token);if(!session||session.tabId!==tab.id)throw Error('Export session หมดอายุ');
  harvestOfflineExportSessions.delete(token);const first=path.join(session.folder,'0001.png');if(session.written&&fsSync.existsSync(first))shell.showItemInFolder(first);
  return {folder:session.folder,written:session.written,total:session.total};
}

"""
s=once(s,anchor,offline_code+anchor,"offline functions")

# persistent jobs must never be deleted by temp cleanup paths
s=once(s,
"""  if (previous?.dir) await fs.rm(previous.dir, { recursive:true, force:true }).catch(() => {});""",
"""  if (previous?.dir && !previous.persistent) await fs.rm(previous.dir, { recursive:true, force:true }).catch(() => {});""",
"preserve offline job at new translation")
s=once(s,
"""  if (removeFiles && state.dir) await fs.rm(state.dir, { recursive:true, force:true }).catch(() => {});""",
"""  if (removeFiles && state.dir && !state.persistent) await fs.rm(state.dir, { recursive:true, force:true }).catch(() => {});""",
"preserve offline job at cancel")

# persist layout/font edits into an already-saved offline project
old="""    return regionStyles().set(styleKey,input.style);
  });"""
new="""    const saved=await regionStyles().set(styleKey,input.style);
    await harvestOfflineUpdateStyle(scope.documentUrl,input.pageId,input.regionId,saved).catch(()=>{});
    return saved;
  });"""
s=once(s,old,new,"sync saved style")

# internal page authorization + APIs
old="""function harvestInternalSender(event, kind='history') {
  const tab = [...harvestTsTabs.values()].find(row => row.kind === kind && !row.view.webContents.isDestroyed() && row.view.webContents === event.sender);
  const file = kind === 'downloads' ? 'downloads.html' : 'history.html';
  const expected = pathToFileURL(path.join(__dirname, file)).href;
  if (!tab || String(event.senderFrame?.url || '') !== expected) throw new Error('Unauthorized HarvestTS internal IPC');
  return tab;
}"""
new="""function harvestInternalSender(event, kind='history') {
  const tab = [...harvestTsTabs.values()].find(row => row.kind === kind && !row.view.webContents.isDestroyed() && row.view.webContents === event.sender);
  const files={history:'history.html',downloads:'downloads.html',offline:'offline.html','offline-reader':'offline-reader.html'},file=files[kind]||files.history;
  const expected = pathToFileURL(path.join(__dirname, file)).href;
  const actual=String(event.senderFrame?.url||'').split(/[?#]/)[0];
  if (!tab || actual !== expected) throw new Error('Unauthorized HarvestTS internal IPC');
  return tab;
}"""
s=once(s,old,new,"internal sender")

old="""    'downloads-list','downloads-remove','downloads-clear','downloads-open','downloads-show','downloads-cancel'
  ];"""
new="""    'downloads-list','downloads-remove','downloads-clear','downloads-open','downloads-show','downloads-cancel',
    'offline-list','offline-remove','offline-open','offline-open-source','offline-project','offline-export-start','offline-export-page','offline-export-finish'
  ];"""
s=once(s,old,new,"internal channels")

anchor="""  ipcMain.handle('harvest-internal:downloads-cancel', async (event,input={}) => { harvestInternalSender(event,'downloads'); return harvestTsDownloadCancel(input); });
}"""
insert="""  ipcMain.handle('harvest-internal:downloads-cancel', async (event,input={}) => { harvestInternalSender(event,'downloads'); return harvestTsDownloadCancel(input); });
  ipcMain.handle('harvest-internal:offline-list', async event => { harvestInternalSender(event,'offline'); return harvestOfflineList(); });
  ipcMain.handle('harvest-internal:offline-remove', async (event,input={}) => { harvestInternalSender(event,'offline'); return harvestOfflineRemove(input.id); });
  ipcMain.handle('harvest-internal:offline-open', async (event,input={}) => { harvestInternalSender(event,'offline'); return harvestTsOpenOfflineReader(input.id); });
  ipcMain.handle('harvest-internal:offline-open-source', async (event,input={}) => { harvestInternalSender(event,'offline'); const saved=await harvestOfflineReadProject(String(input.id||'')); return createHarvestTsTab({url:saved.project.url,activate:true}); });
  ipcMain.handle('harvest-internal:offline-project', async (event,input={}) => { const tab=harvestInternalSender(event,'offline-reader'); return harvestOfflineProjectData(String(input.id||tab.projectId||'')); });
  ipcMain.handle('harvest-internal:offline-export-start', async (event,input={}) => { const tab=harvestInternalSender(event,'offline-reader'); return harvestOfflineExportStart(tab,input); });
  ipcMain.handle('harvest-internal:offline-export-page', async (event,input={}) => { const tab=harvestInternalSender(event,'offline-reader'); return harvestOfflineExportPage(tab,input); });
  ipcMain.handle('harvest-internal:offline-export-finish', async (event,input={}) => { const tab=harvestInternalSender(event,'offline-reader'); return harvestOfflineExportFinish(tab,input); });
}"""
s=once(s,anchor,insert,"offline ipc handlers")

# state titles
s=s.replace("""(tab.kind === 'history' ? 'History' : tab.kind === 'downloads' ? 'Downloads' : 'แท็บใหม่')""",
            """(tab.kind === 'history' ? 'History' : tab.kind === 'downloads' ? 'Downloads' : tab.kind === 'offline' ? 'Offline' : tab.kind === 'offline-reader' ? 'Offline Reader' : 'แท็บใหม่')""",1)

# create internal offline tabs and preserve project id through restored URL
old="""  const kind = ['history','downloads'].includes(input.kind) ? input.kind : 'web';
  const internalFile = kind === 'history' ? 'history.html' : kind === 'downloads' ? 'downloads.html' : '';
  const url = internalFile ? pathToFileURL(path.join(__dirname, internalFile)).href : normalizeHarvestTsURL(input.url || 'https://www.google.com/');
  const internal = kind !== 'web';"""
new="""  const kind = ['history','downloads','offline','offline-reader'].includes(input.kind) ? input.kind : 'web';
  const internalFile = kind === 'history' ? 'history.html' : kind === 'downloads' ? 'downloads.html' : kind === 'offline' ? 'offline.html' : kind === 'offline-reader' ? 'offline-reader.html' : '';
  let projectId=String(input.projectId||'');if(!projectId&&kind==='offline-reader'&&input.url){try{projectId=new URL(input.url).searchParams.get('id')||''}catch{}}
  const internalBase = internalFile ? pathToFileURL(path.join(__dirname, internalFile)).href : '';
  const url = internalFile ? (kind==='offline-reader'?internalBase+'?id='+encodeURIComponent(projectId):internalBase) : normalizeHarvestTsURL(input.url || 'https://www.google.com/');
  const internal = kind !== 'web';"""
s=once(s,old,new,"create kinds")
old="""  const tab = { id, kind, view, url, title: kind === 'history' ? 'History' : kind === 'downloads' ? 'Downloads' : 'แท็บใหม่', skipNextHistory:input.restored === true };"""
new="""  const tab = { id, kind, view, url, projectId, title: kind === 'history' ? 'History' : kind === 'downloads' ? 'Downloads' : kind === 'offline' ? 'Offline' : kind === 'offline-reader' ? 'Offline Reader' : 'แท็บใหม่', skipNextHistory:input.restored === true };"""
s=once(s,old,new,"tab title")

# offline open helpers + menu
anchor="""async function harvestTsOpenDownloads() {
  const existing = [...harvestTsTabs.values()].find(tab => tab.kind === 'downloads' && !tab.view.webContents.isDestroyed());
  if (existing) return switchHarvestTsTab({ id:existing.id });
  return createHarvestTsTab({ kind:'downloads', activate:true });
}
function harvestTsPopupMenu(input = {}) {"""
new="""async function harvestTsOpenDownloads() {
  const existing = [...harvestTsTabs.values()].find(tab => tab.kind === 'downloads' && !tab.view.webContents.isDestroyed());
  if (existing) return switchHarvestTsTab({ id:existing.id });
  return createHarvestTsTab({ kind:'downloads', activate:true });
}
async function harvestTsOpenOffline() {
  const existing=[...harvestTsTabs.values()].find(tab=>tab.kind==='offline'&&!tab.view.webContents.isDestroyed());
  if(existing)return switchHarvestTsTab({id:existing.id});
  return createHarvestTsTab({kind:'offline',activate:true});
}
async function harvestTsOpenOfflineReader(id) {
  const saved=await harvestOfflineReadProject(String(id||''));
  const existing=[...harvestTsTabs.values()].find(tab=>tab.kind==='offline-reader'&&tab.projectId===saved.project.id&&!tab.view.webContents.isDestroyed());
  if(existing)return switchHarvestTsTab({id:existing.id});
  return createHarvestTsTab({kind:'offline-reader',projectId:saved.project.id,activate:true});
}
function harvestTsPopupMenu(input = {}) {"""
s=once(s,anchor,new,"offline tab helpers")

old="""  const menu = Menu.buildFromTemplate([
    { label:'↶ History', click:()=>{ harvestTsOpenHistory().catch(()=>{}); } },
    { label:'↓ Downloads', click:()=>{ harvestTsOpenDownloads().catch(()=>{}); } },
    { label:'☆ Bookmark', enabled:Boolean(tab), click:()=>emit('harvestts-menu-action',{action:'bookmark'}) },"""
new="""  const menu = Menu.buildFromTemplate([
    { label:'↶ History', click:()=>{ harvestTsOpenHistory().catch(()=>{}); } },
    { label:'↓ Downloads', click:()=>{ harvestTsOpenDownloads().catch(()=>{}); } },
    { label:'▣ Offline Library', click:()=>{ harvestTsOpenOffline().catch(()=>{}); } },
    { label:'▤ Save Offline', enabled:Boolean(tab&&tab.kind==='web'), click:()=>{ harvestOfflineSave(tab).then(()=>harvestTsOpenOffline()).catch(error=>emit('harvestts-error',{id:tab?.id,message:error.message,url:tab?.view?.webContents?.getURL?.()||''})); } },
    { label:'☆ Bookmark', enabled:Boolean(tab), click:()=>emit('harvestts-menu-action',{action:'bookmark'}) },"""
s=once(s,old,new,"offline menu")

# auto restore on same web page
s=once(s,"""  wc.on('did-start-loading', update);""",
"""  wc.on('did-start-loading', () => { tab.offlineOverlayDocument=''; update(); });""","reset restore state")
old="""  wc.on('did-finish-load', () => {
    applyHarvestBlocks(tab).catch(() => {});
    scheduleContinuousReader(wc.getURL());
    if (tab.skipNextHistory) tab.skipNextHistory = false;
    else queueHarvestHistory(wc.getURL() || tab.url, wc.getTitle() || tab.title);
    scheduleHarvestTabsSave();
  });"""
new="""  wc.on('did-finish-load', () => {
    applyHarvestBlocks(tab).catch(() => {});
    scheduleContinuousReader(wc.getURL());
    if(tab.kind==='web')setTimeout(()=>restoreHarvestOfflineOverlay(tab).catch(()=>{}),700);
    if (tab.skipNextHistory) tab.skipNextHistory = false;
    else queueHarvestHistory(wc.getURL() || tab.url, wc.getTitle() || tab.title);
    scheduleHarvestTabsSave();
  });"""
s=once(s,old,new,"auto restore hook")

# secure local image protocol for offline projects
anchor="""    // Serve already-acquired image bytes on the UI origin for local pixel analysis only.
    // Website sessions, CORS and Canvas origin-clean rules remain unchanged.
    if (url.host === 'app' && /^image\\/[a-f0-9]{24}$/.test(name)) {"""
new="""    // Serve persistent Offline Library page images without exposing arbitrary local files.
    if(url.host==='offline'){
      const parts=url.pathname.split('/').filter(Boolean).map(x=>decodeURIComponent(x));
      if(parts.length!==2||!/^[0-9a-f]{24}$/.test(parts[0])||path.basename(parts[1])!==parts[1])return new Response('',{status:404});
      try{
        const saved=await harvestOfflineReadProject(parts[0]),page=saved.manifest.pages.find(p=>p.file===parts[1]&&!p.error);
        if(!page)return new Response('',{status:404});
        const buffer=await fs.readFile(path.join(saved.dir,parts[1])),ext=path.extname(parts[1]).toLowerCase();
        const mime=page.mime||({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'}[ext]||'application/octet-stream');
        return new Response(buffer,{headers:{'Content-Type':mime,'Cache-Control':'private, max-age=31536000, immutable','Access-Control-Allow-Origin':'*','X-Content-Type-Options':'nosniff'}});
      }catch{return new Response('',{status:404});}
    }
    // Serve already-acquired image bytes on the UI origin for local pixel analysis only.
    // Website sessions, CORS and Canvas origin-clean rules remain unchanged.
    if (url.host === 'app' && /^image\\/[a-f0-9]{24}$/.test(name)) {"""
s=once(s,anchor,new,"offline protocol")

main.write_text(s,encoding="utf-8")

# internal bridge
s=pre.read_text(encoding="utf-8")
anchor="""  downloadsCancel: id => ipcRenderer.invoke('harvest-internal:downloads-cancel', { id }),
  onDownloadsChanged: callback => {"""
new="""  downloadsCancel: id => ipcRenderer.invoke('harvest-internal:downloads-cancel', { id }),
  offlineList: () => ipcRenderer.invoke('harvest-internal:offline-list'),
  offlineRemove: id => ipcRenderer.invoke('harvest-internal:offline-remove', { id }),
  offlineOpen: id => ipcRenderer.invoke('harvest-internal:offline-open', { id }),
  offlineOpenSource: id => ipcRenderer.invoke('harvest-internal:offline-open-source', { id }),
  offlineProject: id => ipcRenderer.invoke('harvest-internal:offline-project', { id }),
  offlineExportStart: (id,mode) => ipcRenderer.invoke('harvest-internal:offline-export-start', { id,mode }),
  offlineExportPage: (token,index,bytes) => ipcRenderer.invoke('harvest-internal:offline-export-page', { token,index,bytes }),
  offlineExportFinish: token => ipcRenderer.invoke('harvest-internal:offline-export-finish', { token }),
  onDownloadsChanged: callback => {"""
s=once(s,anchor,new,"preload offline api")
pre.write_text(s,encoding="utf-8")

# Offline Library UI
(root/"src"/"offline.html").write_text("""<!doctype html>
<html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline Library</title><link rel="stylesheet" href="offline.css"></head>
<body><header><div><h1>Offline Library</h1><p>งาน Harvest Translate ที่เก็บไว้ในเครื่อง</p></div><input id="search" type="search" placeholder="ค้นหาชื่อเรื่องหรือ URL"></header>
<div id="meta" class="meta">กำลังโหลด…</div><main id="list"></main>
<script src="offline.js"></script></body></html>""",encoding="utf-8")

(root/"src"/"offline.css").write_text("""*{box-sizing:border-box}html{color-scheme:dark}body{margin:0;background:#11131a;color:#ececf3;font:14px/1.5 \"Segoe UI\",Tahoma,sans-serif}header{position:sticky;top:0;z-index:2;display:flex;gap:18px;align-items:center;justify-content:space-between;padding:20px 24px;background:#151822ef;border-bottom:1px solid #292e3b;backdrop-filter:blur(10px)}h1{font-size:22px;margin:0}header p{margin:3px 0 0;color:#979eaf}input{min-width:260px;max-width:440px;width:38vw;padding:10px 13px;border:1px solid #363c4b;border-radius:9px;background:#0d0f15;color:#fff;outline:none}.meta{padding:14px 24px;color:#a8afc0}main{padding:0 24px 40px;display:grid;gap:11px}.card{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;padding:16px 18px;background:#191c26;border:1px solid #2c3140;border-radius:12px}.title{font-size:16px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.url{color:#8d96aa;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:70vw}.details{margin-top:7px;color:#b7bdc9;font-size:12px}.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end}button{border:1px solid #3a4051;background:#252a37;color:#f4f4f7;border-radius:8px;padding:8px 11px;cursor:pointer}button.primary{background:#6656a8;border-color:#7e6ac8}button.danger{color:#ffb5bd}.empty{text-align:center;color:#8f96a6;padding:80px 20px}@media(max-width:700px){header{align-items:stretch;flex-direction:column}input{width:100%;max-width:none;min-width:0}.card{grid-template-columns:1fr}.actions{justify-content:flex-start}.url{max-width:90vw}}""",encoding="utf-8")

(root/"src"/"offline.js").write_text("""'use strict';
const $=id=>document.getElementById(id);let all=[];
const fmtBytes=n=>{n=Number(n)||0;if(n<1024)return n+' B';if(n<1048576)return (n/1024).toFixed(1)+' KB';if(n<1073741824)return (n/1048576).toFixed(1)+' MB';return (n/1073741824).toFixed(2)+' GB'};
const fmtTime=n=>{try{return new Date(Number(n)||0).toLocaleString('th-TH',{dateStyle:'medium',timeStyle:'short'})}catch{return''}};
function render(){const q=$('search').value.trim().toLowerCase(),rows=q?all.filter(x=>((x.title||'')+' '+(x.url||'')).toLowerCase().includes(q)):all;$('meta').textContent=rows.length+' งาน • เก็บเฉพาะในเครื่องนี้';if(!rows.length){const e=document.createElement('div');e.className='empty';e.textContent=q?'ไม่พบงานที่ค้นหา':'ยังไม่มีงาน Offline • เปิดหน้าเว็บที่แปลเสร็จแล้วเลือกเมนู Save Offline';$('list').replaceChildren(e);return}const f=document.createDocumentFragment();for(const item of rows){const card=document.createElement('article');card.className='card';const info=document.createElement('div'),title=document.createElement('div'),url=document.createElement('div'),details=document.createElement('div');title.className='title';title.textContent=item.title||'Untitled';url.className='url';url.textContent=item.url;details.className='details';details.textContent=`${item.pages||0} หน้า • ${fmtBytes(item.sizeBytes)} • แก้ไข ${fmtTime(item.updatedAt)}`;info.append(title,url,details);const actions=document.createElement('div');actions.className='actions';const read=document.createElement('button');read.className='primary';read.textContent='อ่านออฟไลน์';const web=document.createElement('button');web.textContent='เปิดเว็บ';const del=document.createElement('button');del.className='danger';del.textContent='ลบ';read.onclick=()=>window.harvestInternal.offlineOpen(item.id);web.onclick=()=>window.harvestInternal.offlineOpenSource(item.id);del.onclick=async()=>{if(!confirm('ลบงาน Offline นี้ออกจากเครื่อง?'))return;await window.harvestInternal.offlineRemove(item.id);await refresh()};actions.append(read,web,del);card.append(info,actions);f.append(card)}$('list').replaceChildren(f)}
async function refresh(){const r=await window.harvestInternal.offlineList();all=r?.items||[];render()}
$('search').addEventListener('input',render);refresh().catch(e=>{$('meta').textContent='โหลดไม่ได้: '+e.message});
""",encoding="utf-8")

# Offline reader
(root/"src"/"offline-reader.html").write_text("""<!doctype html>
<html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline Reader</title><link rel="stylesheet" href="offline-reader.css"></head>
<body><header><div class="head"><strong id="title">Offline Reader</strong><span id="sub"></span></div><div class="tools"><button id="toggle">ดูต้นฉบับ</button><select id="exportMode" aria-label="รูปแบบ Export"><option value="translated">คำแปล</option><option value="clean">ภาพคลีน</option><option value="original">ต้นฉบับ</option></select><button id="export" class="primary">Export PNG</button></div></header>
<div id="status" class="status">กำลังโหลด…</div><main id="pages"></main>
<script src="offline-reader.js"></script></body></html>""",encoding="utf-8")

(root/"src"/"offline-reader.css").write_text("""*{box-sizing:border-box}html{color-scheme:dark}body{margin:0;background:#0b0d12;color:#eee;font:14px/1.45 \"Segoe UI\",Tahoma,sans-serif}header{position:sticky;top:0;z-index:20;display:flex;justify-content:space-between;gap:16px;align-items:center;padding:11px 16px;background:#151822ef;border-bottom:1px solid #2a2f3c;backdrop-filter:blur(10px)}.head{min-width:0;display:flex;flex-direction:column}.head strong{font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.head span,.status{color:#9ba3b4;font-size:12px}.tools{display:flex;gap:8px;align-items:center}button,select{border:1px solid #3b4252;background:#242936;color:#f3f3f5;border-radius:8px;padding:8px 10px}button{cursor:pointer}.primary{background:#6656a8;border-color:#806dca}.status{padding:8px 16px;text-align:center}.status.error{color:#ffabb5}main{display:flex;flex-direction:column;align-items:center;padding:0 0 48px}.page{position:relative;display:block;max-width:100%;line-height:0;background:white}.page>img.source{display:block;max-width:100%;height:auto}.translated-layer{position:absolute;inset:0;pointer-events:none;overflow:hidden}.mask{position:absolute;inset:0;width:100%;height:100%}.patch{position:absolute}.translation{position:absolute;display:flex;align-items:center;justify-content:center;text-align:center;white-space:pre-wrap;overflow:hidden;overflow-wrap:anywhere;line-height:1.35;font-family:\"Leelawadee UI\",\"Noto Sans Thai\",Tahoma,\"Yu Gothic\",sans-serif;font-weight:500;padding:2px}.show-original .translated-layer{display:none}@media(max-width:620px){header{align-items:stretch;flex-direction:column}.tools{flex-wrap:wrap}.tools button{flex:1}}""",encoding="utf-8")

(root/"src"/"offline-reader.js").write_text("""'use strict';
const $=id=>document.getElementById(id),id=new URL(location.href).searchParams.get('id')||'';let data=null,showOriginal=false,exporting=false;
const NS='http://www.w3.org/2000/svg',svg=(tag,attrs={})=>{const n=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs))n.setAttribute(k,String(v));return n};
function colorFor(fill){const c=String(fill||'#ffffff').replace('#','');if(!/^[0-9a-f]{6}$/i.test(c))return'#151515';const l=parseInt(c.slice(0,2),16)*.2126+parseInt(c.slice(2,4),16)*.7152+parseInt(c.slice(4,6),16)*.0722;return l<125?'#fff':'#151515'}
function fitDom(el,region,page){const scale=el.parentElement.clientHeight/Math.max(1,page.height),manual=Number(region.userStyle?.fontSizeImagePx);if(manual>0){el.style.fontSize=(manual*scale)+'px';return}let lo=3,hi=(region.referenceLineHeight?Math.max(12,Math.min(28,region.referenceLineHeight*scale*.95)):Math.max(14,Math.min(32,el.clientHeight*.52))),best=lo;for(let i=0;i<9;i++){const m=(lo+hi)/2;el.style.fontSize=m+'px';if(el.scrollHeight<=el.clientHeight+1&&el.scrollWidth<=el.clientWidth+1){best=m;lo=m}else hi=m}el.style.fontSize=best+'px'}
function makePage(page,pi){const wrap=document.createElement('article');wrap.className='page';const img=document.createElement('img');img.className='source';img.src=page.imageUrl;img.alt='หน้า '+(pi+1);img.crossOrigin='anonymous';const layer=document.createElement('div');layer.className='translated-layer';const mask=svg('svg',{viewBox:'0 0 1 1',preserveAspectRatio:'none'});mask.classList.add('mask');const defs=svg('defs');mask.append(defs);layer.append(mask);for(const [ri,r] of page.regions.entries()){if(r.erasePatch?.png){const p=document.createElement('img'),b=r.erasePatch.bbox;p.className='patch';p.src='data:image/png;base64,'+r.erasePatch.png;Object.assign(p.style,{left:b.x0*100+'%',top:b.y0*100+'%',width:(b.x1-b.x0)*100+'%',height:(b.y1-b.y0)*100+'%'});layer.append(p)}else{const group=svg('g');if(r.polygon?.length>=3){const cid='offline-clip-'+pi+'-'+ri,clip=svg('clipPath',{id:cid,clipPathUnits:'userSpaceOnUse'});clip.append(svg('polygon',{points:r.polygon.map(p=>p.join(',')).join(' ')}));defs.append(clip);group.setAttribute('clip-path','url(#'+cid+')')}const b=r.eraseBox;group.append(svg('rect',{x:b.x0,y:b.y0,width:b.x1-b.x0,height:b.y1-b.y0,fill:r.fillColor||'#fff'}));mask.append(group);for(const x of r.eraseBoxes||[])mask.append(svg('rect',{x:x.x0,y:x.y0,width:x.x1-x.x0,height:x.y1-x.y0,fill:r.fillColor||'#fff'}))}const b=r.userStyle?.box||r.safeBox,t=document.createElement('div');t.className='translation';t.textContent=r.text;t.style.color=colorFor(r.fillColor);Object.assign(t.style,{left:b.x0*100+'%',top:b.y0*100+'%',width:(b.x1-b.x0)*100+'%',height:(b.y1-b.y0)*100+'%'});layer.append(t);t._region=r}wrap.append(img,layer);const refit=()=>{for(const x of layer.querySelectorAll('.translation'))fitDom(x,x._region,page)};img.addEventListener('load',refit);new ResizeObserver(refit).observe(wrap);return wrap}
function render(){document.body.classList.toggle('show-original',showOriginal);$('toggle').textContent=showOriginal?'ดูคำแปล':'ดูต้นฉบับ';const f=document.createDocumentFragment();data.pages.forEach((p,i)=>f.append(makePage(p,i)));$('pages').replaceChildren(f);$('status').textContent=`${data.pages.length} หน้า • เก็บในเครื่อง • เปิดได้โดยไม่ใช้อินเทอร์เน็ต`}
function pathMask(ctx,r,w,h){if(!r.polygon?.length||r.polygon.length<3)return false;ctx.beginPath();r.polygon.forEach(([x,y],i)=>{const X=x*w,Y=y*h;i?ctx.lineTo(X,Y):ctx.moveTo(X,Y)});ctx.closePath();ctx.clip();return true}
function wrapChars(ctx,text,maxWidth){const lines=[];for(const paragraph of String(text||'').split('\\n')){let line='';for(const ch of [...paragraph]){const next=line+ch;if(line&&ctx.measureText(next).width>maxWidth){lines.push(line);line=ch}else line=next}lines.push(line||' ')}return lines}
function fitCanvas(ctx,r,page,box){const W=(box.x1-box.x0)*page.width-4,H=(box.y1-box.y0)*page.height-4,manual=Number(r.userStyle?.fontSizeImagePx),family='\"Leelawadee UI\",\"Noto Sans Thai\",Tahoma,\"Yu Gothic\",sans-serif';const works=size=>{ctx.font=`500 ${size}px ${family}`;const lines=wrapChars(ctx,r.text,W);return {ok:lines.length*size*1.35<=H&&Math.max(0,...lines.map(x=>ctx.measureText(x).width))<=W,lines}};if(manual>0){const q=works(manual);return {size:manual,lines:q.lines,family}}let lo=3,hi=r.referenceLineHeight?Math.max(12,Math.min(28,r.referenceLineHeight*.95)):Math.max(14,Math.min(32,H*.52)),best=lo,bestLines=[];for(let i=0;i<10;i++){const m=(lo+hi)/2,q=works(m);if(q.ok){best=m;bestLines=q.lines;lo=m}else hi=m}if(!bestLines.length)bestLines=works(best).lines;return {size:best,lines:bestLines,family}}
async function bitmapFromData(base64){const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0)),blob=new Blob([bytes],{type:'image/png'});return createImageBitmap(blob)}
async function renderPng(page,mode){const response=await fetch(page.imageUrl);if(!response.ok)throw Error('อ่านภาพ Offline ไม่สำเร็จ');const blob=await response.blob(),bitmap=await createImageBitmap(blob),canvas=document.createElement('canvas');canvas.width=page.width||bitmap.width;canvas.height=page.height||bitmap.height;const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();if(mode!=='original'){for(const r of page.regions){if(r.erasePatch?.png){const patch=await bitmapFromData(r.erasePatch.png),b=r.erasePatch.bbox;ctx.drawImage(patch,b.x0*canvas.width,b.y0*canvas.height,(b.x1-b.x0)*canvas.width,(b.y1-b.y0)*canvas.height);patch.close()}else{ctx.save();if(r.polygon?.length>=3)pathMask(ctx,r,canvas.width,canvas.height);const b=r.eraseBox;ctx.fillStyle=r.fillColor||'#fff';ctx.fillRect(b.x0*canvas.width,b.y0*canvas.height,(b.x1-b.x0)*canvas.width,(b.y1-b.y0)*canvas.height);ctx.restore();ctx.fillStyle=r.fillColor||'#fff';for(const x of r.eraseBoxes||[])ctx.fillRect(x.x0*canvas.width,x.y0*canvas.height,(x.x1-x.x0)*canvas.width,(x.y1-x.y0)*canvas.height)}if(mode==='translated'){const box=r.userStyle?.box||r.safeBox,fit=fitCanvas(ctx,r,page,box),cx=(box.x0+box.x1)*canvas.width/2,boxH=(box.y1-box.y0)*canvas.height,lineH=fit.size*1.35,total=fit.lines.length*lineH;ctx.font=`500 ${fit.size}px ${fit.family}`;ctx.fillStyle=colorFor(r.fillColor);ctx.textAlign='center';ctx.textBaseline='middle';let y=box.y0*canvas.height+(boxH-total)/2+lineH/2;for(const line of fit.lines){ctx.fillText(line,cx,y,(box.x1-box.x0)*canvas.width-4);y+=lineH}}}}return new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('สร้าง PNG ไม่สำเร็จ')),'image/png'))}
$('toggle').onclick=()=>{showOriginal=!showOriginal;document.body.classList.toggle('show-original',showOriginal);$('toggle').textContent=showOriginal?'ดูคำแปล':'ดูต้นฉบับ'};
$('export').onclick=async()=>{if(exporting||!data)return;exporting=true;$('export').disabled=true;$('status').classList.remove('error');const mode=$('exportMode').value;try{const start=await window.harvestInternal.offlineExportStart(id,mode);if(start.cancelled)return;for(let i=0;i<data.pages.length;i++){$('status').textContent=`Export ${i+1}/${data.pages.length}…`;const blob=await renderPng(data.pages[i],mode),bytes=await blob.arrayBuffer();await window.harvestInternal.offlineExportPage(start.token,i,bytes)}const done=await window.harvestInternal.offlineExportFinish(start.token);$('status').textContent=`Export แล้ว ${done.written} หน้า • เปิดโฟลเดอร์ให้แล้ว`}catch(e){$('status').classList.add('error');$('status').textContent='Export ไม่สำเร็จ: '+e.message}finally{exporting=false;$('export').disabled=false}};
(async()=>{try{data=await window.harvestInternal.offlineProject(id);$('title').textContent=data.project.title||'Offline Reader';$('sub').textContent=data.project.url;render()}catch(e){$('status').classList.add('error');$('status').textContent='เปิดงาน Offline ไม่ได้: '+e.message}})();
""",encoding="utf-8")

print("patched offline library, auto restore, reader and PNG export")
