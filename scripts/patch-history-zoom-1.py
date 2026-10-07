from pathlib import Path

p = Path(r"E:\Shared\ExportImagefromWeb\src\main.cjs")
s = p.read_text(encoding="utf-8")
old = "function harvestTabsPayload() {"
new = """const HARVEST_ZOOM_LEVELS=[0.5,0.67,0.75,0.8,0.9,1,1.1,1.25,1.5,1.75,2,2.5,3];
function normalizeHarvestZoom(value){
  const n=Number(value);return Number.isFinite(n)?Math.max(.5,Math.min(3,n)):1;
}
function harvestNavigationSnapshot(tab){
  const wc=tab?.view?.webContents;
  if(!wc||wc.isDestroyed()||tab.kind!=='web')return {entries:[],index:0};
  try{
    const all=wc.navigationHistory?.getAllEntries?.()||[],active=wc.navigationHistory?.getActiveIndex?.()??Math.max(0,all.length-1);
    const valid=all.map((entry,sourceIndex)=>({sourceIndex,url:String(entry?.url||''),title:String(entry?.title||entry?.url||'')})).filter(entry=>/^https?:\\/\\//i.test(entry.url));
    if(!valid.length)return {entries:[],index:0};
    let pos=valid.findIndex(entry=>entry.sourceIndex===active);
    if(pos<0){pos=0;for(let i=0;i<valid.length;i++)if(valid[i].sourceIndex<=active)pos=i;}
    const limit=120,start=Math.max(0,Math.min(pos-60,Math.max(0,valid.length-limit))),slice=valid.slice(start,start+limit);
    return {entries:slice.map(({url,title})=>({url,title})),index:Math.max(0,Math.min(slice.length-1,pos-start))};
  }catch{return {entries:[],index:0};}
}
function stepHarvestZoom(tab,direction){
  if(!tab||tab.kind!=='web'||tab.view.webContents.isDestroyed())return false;
  const current=normalizeHarvestZoom(tab.zoomFactor||tab.view.webContents.zoomFactor||1);
  let index=HARVEST_ZOOM_LEVELS.findIndex(x=>Math.abs(x-current)<.001);
  if(index<0){index=HARVEST_ZOOM_LEVELS.reduce((best,x,i)=>Math.abs(x-current)<Math.abs(HARVEST_ZOOM_LEVELS[best]-current)?i:best,0);}
  const next=direction===0?1:HARVEST_ZOOM_LEVELS[Math.max(0,Math.min(HARVEST_ZOOM_LEVELS.length-1,index+(direction>0?1:-1)))];
  tab.zoomFactor=normalizeHarvestZoom(next);tab.view.webContents.zoomFactor=tab.zoomFactor;
  emitHarvestTs();scheduleHarvestTabsSave();return true;
}
function harvestTabsPayload() {"""
if old not in s:
    raise SystemExit("anchor missing")
s = s.replace(old, new, 1)
p.write_text(s, encoding="utf-8")
print("inserted history + zoom helpers")
