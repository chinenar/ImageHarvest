from pathlib import Path

main=Path(r"E:\Shared\ExportImagefromWeb\src\main.cjs")
s=main.read_text(encoding="utf-8")
old="""  ipcMain.removeHandler('harvest-guest:translation-start');
  ipcMain.removeHandler('harvest-guest:translation-retry');"""
new="""  ipcMain.removeHandler('harvest-guest:zoom');
  ipcMain.handle('harvest-guest:zoom',(event,input={})=>{
    const tab=harvestGuestTab(event),direction=Math.sign(Number(input.direction)||0);
    stepHarvestZoom(tab,direction);return harvestTsState(tab);
  });
  ipcMain.removeHandler('harvest-guest:translation-start');
  ipcMain.removeHandler('harvest-guest:translation-retry');"""
if old not in s: raise SystemExit("guest zoom anchor missing")
s=s.replace(old,new,1)
main.write_text(s,encoding="utf-8")

guest=Path(r"E:\Shared\ExportImagefromWeb\src\harvest-guest-preload.cjs")
s=guest.read_text(encoding="utf-8")
old="""let lastSuggestions = [];

function visible(el){"""
new="""let lastSuggestions = [];
let lastZoomWheelAt = 0;
addEventListener('wheel',event=>{
  if(!event.ctrlKey)return;
  event.preventDefault();
  const now=Date.now();if(now-lastZoomWheelAt<90)return;lastZoomWheelAt=now;
  ipcRenderer.invoke('harvest-guest:zoom',{direction:event.deltaY<0?1:-1}).catch(()=>{});
},{capture:true,passive:false});

function visible(el){"""
if old not in s: raise SystemExit("guest preload anchor missing")
s=s.replace(old,new,1)
guest.write_text(s,encoding="utf-8")
print("patched guest ctrl-wheel zoom")
