from pathlib import Path

p=Path(r"E:\Shared\ExportImagefromWeb\src\main.cjs")
s=p.read_text(encoding="utf-8")

old="""function harvestTabsPayload() {
  const tabs = [...harvestTsTabs.values()].map(tab => {
    if (!tab || tab.view.webContents.isDestroyed()) return null;
    const wc = tab.view.webContents;
    const url = wc.getURL() || tab.url || '';
    if (!/^https?:\/\//i.test(url)) return null;
    return { url, title:wc.getTitle() || tab.title || url };
  }).filter(Boolean).slice(0,25);
  const currentTabs = [...harvestTsTabs.values()];
  const activeIndex = Math.max(0, currentTabs.findIndex(x => x.id === activeHarvestTsId));
  return { version:1, savedAt:Date.now(), activeIndex:Math.min(activeIndex, Math.max(0,tabs.length-1)), tabs };
}"""
new="""function harvestTabsPayload() {
  const source=[...harvestTsTabs.values()].filter(tab=>tab&&tab.kind==='web'&&!tab.view.webContents.isDestroyed()&&/^https?:\/\//i.test(tab.view.webContents.getURL()||tab.url||'')).slice(0,25);
  const tabs=source.map(tab=>{
    const wc=tab.view.webContents,url=wc.getURL()||tab.url||'',history=harvestNavigationSnapshot(tab);
    return {url,title:wc.getTitle()||tab.title||url,zoomFactor:normalizeHarvestZoom(tab.zoomFactor||wc.zoomFactor||1),history};
  });
  let activeIndex=source.findIndex(x=>x.id===activeHarvestTsId);if(activeIndex<0)activeIndex=0;
  return {version:2,savedAt:Date.now(),activeIndex:Math.min(activeIndex,Math.max(0,tabs.length-1)),tabs};
}"""
if old not in s: raise SystemExit("payload anchor missing")
s=s.replace(old,new,1)

old="""    const data = await readHarvestJson(harvestTsTabsFile, { version:1, tabs:[], activeIndex:0 });
    const tabs = Array.isArray(data.tabs) ? data.tabs.filter(x => x && /^https?:\/\//i.test(x.url || '')).slice(0,25) : [];
    if (!tabs.length) return harvestTsSnapshot();
    const created = [];
    for (const row of tabs) {
      const snap = createHarvestTsTab({ url:row.url, activate:false, skipSave:true, skipEmit:true, restored:true });
      const last = snap.tabs[snap.tabs.length - 1];
      if (last) created.push(last.id);
    }"""
new="""    const data = await readHarvestJson(harvestTsTabsFile, { version:2, tabs:[], activeIndex:0 });
    const tabs = Array.isArray(data.tabs) ? data.tabs.filter(x => x && /^https?:\/\//i.test(x.url || '')).slice(0,25) : [];
    if (!tabs.length) return harvestTsSnapshot();
    const created = [];
    for (const row of tabs) {
      const entries=Array.isArray(row.history?.entries)?row.history.entries.filter(e=>e&&/^https?:\/\//i.test(e.url||'')).slice(0,120):[];
      const snap = createHarvestTsTab({ url:row.url, activate:false, skipSave:true, skipEmit:true, restored:true, navigationHistory:entries, navigationIndex:row.history?.index, zoomFactor:row.zoomFactor });
      const last = snap.tabs[snap.tabs.length - 1];
      if (last) created.push(last.id);
    }"""
if old not in s: raise SystemExit("restore anchor missing")
s=s.replace(old,new,1)

p.write_text(s,encoding="utf-8")
print("patched tab payload + restore")
