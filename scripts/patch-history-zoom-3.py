from pathlib import Path

p=Path(r"E:\Shared\ExportImagefromWeb\src\main.cjs")
s=p.read_text(encoding="utf-8")

def rep(old,new,label):
    global s
    if old not in s: raise SystemExit("missing "+label)
    s=s.replace(old,new,1)

rep("""function harvestTsState(tab) {
  if (!tab || tab.view.webContents.isDestroyed()) return null;
  const wc = tab.view.webContents;
  return {
    id: tab.id,
    kind: tab.kind || 'web',
    title: wc.getTitle() || tab.title || (tab.kind === 'history' ? 'History' : tab.kind === 'downloads' ? 'Downloads' : tab.kind === 'offline' ? 'Offline' : tab.kind === 'offline-reader' ? 'Offline Reader' : 'แท็บใหม่'),
    url: wc.getURL() || tab.url || '',
    loading: wc.isLoading(),
    canGoBack: wc.canGoBack(),
    canGoForward: wc.canGoForward()
  };
}""","""function harvestTsState(tab) {
  if (!tab || tab.view.webContents.isDestroyed()) return null;
  const wc = tab.view.webContents,nav=wc.navigationHistory;
  const web=tab.kind==='web';
  return {
    id: tab.id,
    kind: tab.kind || 'web',
    title: wc.getTitle() || tab.title || (tab.kind === 'history' ? 'History' : tab.kind === 'downloads' ? 'Downloads' : tab.kind === 'offline' ? 'Offline' : tab.kind === 'offline-reader' ? 'Offline Reader' : 'แท็บใหม่'),
    url: wc.getURL() || tab.url || '',
    loading: wc.isLoading(),
    canGoBack:web?Boolean(nav?.canGoBack?.()):wc.canGoBack(),
    canGoForward:web?Boolean(nav?.canGoForward?.()):wc.canGoForward(),
    zoomFactor:web?normalizeHarvestZoom(tab.zoomFactor||wc.zoomFactor||1):1,
    historyLength:web?Number(nav?.length?.()||0):0,
    historyIndex:web?Number(nav?.getActiveIndex?.()||0):0
  };
}""","state")

rep("""  const tab = { id, kind, view, url, projectId, title: kind === 'history' ? 'History' : kind === 'downloads' ? 'Downloads' : kind === 'offline' ? 'Offline' : kind === 'offline-reader' ? 'Offline Reader' : 'แท็บใหม่', skipNextHistory:input.restored === true };
  harvestTsTabs.set(id, tab);
  bindHarvestTs(tab);
  if (input.activate !== false || !activeHarvestTsId) activeHarvestTsId = id;
  view.webContents.loadURL(url).catch(error => emit('harvestts-error', { id, message: error.message, url }));""","""  const zoomFactor=normalizeHarvestZoom(input.zoomFactor),restoreEntries=kind==='web'&&Array.isArray(input.navigationHistory)?input.navigationHistory.filter(e=>e&&/^https?:\/\//i.test(e.url||'')).slice(0,120).map(e=>({url:String(e.url),title:String(e.title||e.url)})):[];
  const restoreIndex=Math.max(0,Math.min(Math.max(0,restoreEntries.length-1),Number(input.navigationIndex)||0));
  const tab = { id, kind, view, url, projectId, zoomFactor, title: kind === 'history' ? 'History' : kind === 'downloads' ? 'Downloads' : kind === 'offline' ? 'Offline' : kind === 'offline-reader' ? 'Offline Reader' : 'แท็บใหม่', skipNextHistory:input.restored === true };
  harvestTsTabs.set(id, tab);
  bindHarvestTs(tab);
  if(kind==='web')view.webContents.zoomFactor=zoomFactor;
  if (input.activate !== false || !activeHarvestTsId) activeHarvestTsId = id;
  const loadFallback=()=>view.webContents.loadURL(url).catch(error => emit('harvestts-error', { id, message: error.message, url }));
  if(restoreEntries.length&&view.webContents.navigationHistory?.restore){
    view.webContents.navigationHistory.restore({entries:restoreEntries,index:restoreIndex}).catch(error=>{emit('harvestts-error',{id,message:'กู้ประวัติแท็บไม่ได้: '+(error.message||String(error)),url});loadFallback();});
  }else loadFallback();""","create restore")

rep("""  const wc = tab.view.webContents;
  if (input.action === 'back' && wc.canGoBack()) wc.goBack();
  else if (input.action === 'forward' && wc.canGoForward()) wc.goForward();
  else if (input.action === 'reload') wc.isLoading() ? wc.stop() : wc.reload();
  else if (input.action === 'home') wc.loadURL('https://www.google.com/').catch(() => {});
  emitHarvestTs();""","""  const wc = tab.view.webContents,nav=wc.navigationHistory;
  if (input.action === 'back' && (tab.kind==='web'?nav?.canGoBack?.():wc.canGoBack())) (tab.kind==='web'?nav:wc).goBack();
  else if (input.action === 'forward' && (tab.kind==='web'?nav?.canGoForward?.():wc.canGoForward())) (tab.kind==='web'?nav:wc).goForward();
  else if (input.action === 'reload') wc.isLoading() ? wc.stop() : wc.reload();
  else if (input.action === 'home') wc.loadURL('https://www.google.com/').catch(() => {});
  else if (input.action === 'zoom-in') stepHarvestZoom(tab,1);
  else if (input.action === 'zoom-out') stepHarvestZoom(tab,-1);
  else if (input.action === 'zoom-reset') stepHarvestZoom(tab,0);
  emitHarvestTs();""","action zoom history")

rep("""  else if(id==='back'&&wc.canGoBack())wc.goBack();
  else if(id==='forward'&&wc.canGoForward())wc.goForward();""","""  else if(id==='back'&&wc.navigationHistory?.canGoBack?.())wc.navigationHistory.goBack();
  else if(id==='forward'&&wc.navigationHistory?.canGoForward?.())wc.navigationHistory.goForward();""","context nav")

rep("""    if (input.control && ['l','t','w'].includes(key)) {
      event.preventDefault();
      emit('harvestts-shortcut', { key });
      return;
    }""","""    if (input.control && !input.alt && ['+','=','add'].includes(key) && tab.kind==='web') {
      event.preventDefault();stepHarvestZoom(tab,1);return;
    }
    if (input.control && !input.alt && ['-','subtract'].includes(key) && tab.kind==='web') {
      event.preventDefault();stepHarvestZoom(tab,-1);return;
    }
    if (input.control && !input.alt && key==='0' && tab.kind==='web') {
      event.preventDefault();stepHarvestZoom(tab,0);return;
    }
    if (input.control && ['l','t','w'].includes(key)) {
      event.preventDefault();
      emit('harvestts-shortcut', { key });
      return;
    }""","keyboard zoom")

rep("""    if (input.alt && key === 'arrowleft' && wc.canGoBack()) { event.preventDefault(); wc.goBack(); return; }
    if (input.alt && key === 'arrowright' && wc.canGoForward()) { event.preventDefault(); wc.goForward(); }""","""    if (input.alt && key === 'arrowleft' && wc.navigationHistory?.canGoBack?.()) { event.preventDefault(); wc.navigationHistory.goBack(); return; }
    if (input.alt && key === 'arrowright' && wc.navigationHistory?.canGoForward?.()) { event.preventDefault(); wc.navigationHistory.goForward(); }""","alt nav")

rep("""  wc.on('did-finish-load', () => {
    applyHarvestBlocks(tab).catch(() => {});""","""  wc.on('did-finish-load', () => {
    if(tab.kind==='web')wc.zoomFactor=normalizeHarvestZoom(tab.zoomFactor||1);
    applyHarvestBlocks(tab).catch(() => {});""","finish zoom")

p.write_text(s,encoding="utf-8")
print("patched native tab history + zoom behavior")
