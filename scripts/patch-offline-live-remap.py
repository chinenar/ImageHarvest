from pathlib import Path

p=Path(r"E:\Shared\ExportImagefromWeb\src\main.cjs")
s=p.read_text(encoding="utf-8")

old="""async function restoreHarvestOfflineOverlay(tab){
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
}"""

new="""async function harvestOfflineLiveReaderPages(wc,documentUrl,expectedCount=0){
  const options={selector:'',backgrounds:true,canvases:false,smartBackgrounds:true,adaptiveBackgrounds:true};
  let best=[];
  for(let attempt=0;attempt<4;attempt++){
    if(wc.isDestroyed())break;
    const snap=await withTimeout(wc.executeJavaScript(`(${collector})(${JSON.stringify(options)})`,true),12000,'หน้าเว็บไม่ตอบสนองระหว่างกู้งานแปล').catch(()=>null);
    const rows=[];
    for(const raw of snap?.items||[]){
      const url=imageURL(raw.url,documentUrl);
      if(url)rows.push({...raw,url});
    }
    const pages=selectMangaPages(rows);
    if(pages.length>best.length)best=pages;
    if(best.length&&(expectedCount<=0||best.length>=expectedCount))break;
    await delay(180*(attempt+1));
  }
  return best;
}
function harvestOfflineMatchLivePages(savedPages,livePages){
  const used=new Set(),result=[];
  const size=item=>({w:Math.max(Number(item?.width)||0,Number(item?.filterHints?.displayWidth)||0),h:Math.max(Number(item?.height)||0,Number(item?.filterHints?.displayHeight)||0)});
  for(let i=0;i<savedPages.length;i++){
    const page=savedPages[i];let match=-1;
    match=livePages.findIndex((x,j)=>!used.has(j)&&String(x.url||'')===String(page.sourceUrl||''));
    if(match<0&&livePages.length===savedPages.length&&!used.has(i))match=i;
    if(match<0){
      const target=size(page),targetAspect=target.w&&target.h?target.w/target.h:0;
      let best=Infinity;
      for(let j=0;j<livePages.length;j++){
        if(used.has(j))continue;
        const cur=size(livePages[j]),aspect=cur.w&&cur.h?cur.w/cur.h:0;
        const aspectCost=targetAspect&&aspect?Math.abs(Math.log(aspect/targetAspect))*30:0;
        const widthCost=target.w&&cur.w?Math.abs(Math.log(cur.w/target.w))*4:0;
        const heightCost=target.h&&cur.h?Math.abs(Math.log(cur.h/target.h))*4:0;
        const orderCost=Math.abs(j-(Number(page.index)||i))*1.5,score=aspectCost+widthCost+heightCost+orderCost;
        if(score<best){best=score;match=j;}
      }
    }
    if(match>=0){used.add(match);result.push(livePages[match]);}else result.push(null);
  }
  return result;
}
async function restoreHarvestOfflineOverlay(tab){
  if(!tab||tab.kind!=='web'||tab.view.webContents.isDestroyed())return null;
  const wc=tab.view.webContents,url=wc.getURL()||tab.url||'',documentKey=harvestOfflineDocumentKey(url);
  if(!/^https?:/i.test(url)||tab.offlineOverlayDocument===documentKey)return null;
  const active=harvestTranslationJobFor(tab);if(active?.running)return null;
  const row=await harvestOfflineFindByUrl(url);if(!row)return null;
  const saved=await harvestOfflineReadProject(row.id),manifest=saved.manifest,settings=manifest.settings||HARVEST_TRANSLATE_DEFAULTS;
  if(!sameHarvestTranslationPage(manifest.source?.url||row.url,url))return null;
  sendHarvestTranslation(tab,{type:'restore-start',message:'พบคำแปลที่บันทึกไว้ • กำลังวางกลับบนหน้าเดิม…'});
  await require('./reader-mode.cjs').ensureContinuousReader(wc).catch(()=>{});
  if(wc.isDestroyed()||!sameHarvestTranslationPage(url,wc.getURL()))return null;
  const savedPages=(manifest.pages||[]).filter(page=>page?.ocr?.regions?.length&&!page.error);
  const livePages=await harvestOfflineLiveReaderPages(wc,url,savedPages.length);
  const matches=harvestOfflineMatchLivePages(savedPages,livePages);
  const job={id:manifest.jobId||('offline-'+row.id),dir:saved.dir,sourceUrl:manifest.source?.url||row.url,manifest,running:false,persistent:true,abort:new AbortController()};
  harvestTranslationJobs.set(tab.id,job);
  await wc.executeJavaScript(`window.__harvestTsTranslationOverlay||(window.__harvestTsTranslationOverlay=(${createTranslationOverlay.toString()})(${readerDocumentKey.toString()}))`).catch(()=>{});
  let regions=0,pages=0,drawn=0,mapped=0,pending=0;
  for(let i=0;i<savedPages.length;i++){
    const page=savedPages[i],live=matches[i];
    try{
      const overlaySource=live?{...page,sourceUrl:live.url,source:live.source||page.source}:page;
      if(live)mapped++;
      const rendered=await prepareOverlayStyles(tab,overlayPage(overlaySource,{documentUrl:job.sourceUrl,targetLanguage:settings.targetLanguage||'th'}));
      for(const region of rendered.regions||[])region.userStyle=saved.project.styles?.[String(page.id)]?.[String(region.id)]||region.userStyle||null;
      if(!rendered.regions.length)continue;
      const state=await wc.executeJavaScript(`window.__harvestTsTranslationOverlay?.apply(${JSON.stringify(rendered)},${JSON.stringify({fontScale:settings.fontScale||1,visible:!settings.showOriginal})})`);
      regions+=rendered.regions.length;pages++;drawn+=Number(state?.pageDrawn)||0;if(state?.pending)pending++;
    }catch{}
  }
  tab.offlineProjectId=row.id;
  if(mapped>0||drawn>0)tab.offlineOverlayDocument=documentKey;
  if(regions){
    const message=drawn
      ? `โหลดคำแปลเดิมแล้ว • ${pages} หน้า • แสดง ${drawn} จุด`
      : mapped
        ? `โหลดคำแปลเดิมแล้ว • รอภาพหน้าอ่านแสดง ${pending||pages} หน้า`
        : 'พบคำแปลเดิมแล้ว • กำลังรอหน้าอ่านโหลดภาพ';
    sendHarvestTranslation(tab,{type:'complete',jobId:job.id,total:manifest.pages.length,ready:pages,failed:0,translatedRegions:regions,translationFailed:0,message});
  }
  return {id:row.id,pages,regions,drawn,mapped,livePages:livePages.length,pending};
}"""

if old not in s:
    raise SystemExit("restore function anchor missing")
s=s.replace(old,new,1)
p.write_text(s,encoding="utf-8")
print("patched offline live-page remapping")
