'use strict';
const {_electron:electron}=require('playwright-core');
const path=require('node:path');
const fs=require('node:fs/promises');
const http=require('node:http');
const assert=require('node:assert/strict');
const sharp=require('sharp');
const {editDistance}=require('../src/ocr-review.cjs');
const root=path.resolve(__dirname,'..'),out=path.join(root,'test-results','ocr-lab');
let app,server;
async function screenshot(page,file){
 if(process.env.EIW_OCR_CAPTURE_DIAGNOSTICS==='0'){
  const state=await page.evaluate(()=>({status:document.getElementById('status').textContent,run:activeRun(),canvas:{width:document.getElementById('canvas').width,height:document.getElementById('canvas').height}}));
  await fs.writeFile(file.replace(/\.png$/,'.state.json'),JSON.stringify(state,null,2));return;
 }
 const png=await app.evaluate(async({webContents},url)=>{const wc=webContents.getAllWebContents().find(w=>w.getURL()===url);return (await wc.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64');},page.url());
 await fs.writeFile(file,Buffer.from(png,'base64'));
}
(async()=>{
 await fs.mkdir(out,{recursive:true});
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 app=await electron.launch({...(process.env.EIW_OCR_EXE?{executablePath:process.env.EIW_OCR_EXE}:{}),args:process.env.EIW_OCR_EXE?['--eiw-test']:[root,'--eiw-test'],env,timeout:45000});
 const main=await app.firstWindow();await main.waitForFunction(()=>!!window.eiw);
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(win=>{win.webContents.setBackgroundThrottling(false);win.hide();}));
 assert.equal((await main.evaluate(()=>window.eiw.ocrLabOpen())).ok,true);
 let lab;
 for(let i=0;i<50&&!lab;i++){lab=app.windows().find(p=>p.url().endsWith('/ocr-lab.html'));if(!lab)await new Promise(r=>setTimeout(r,100));}
 assert.ok(lab,'OCR Lab window missing');await lab.waitForFunction(()=>!!window.ocrLab);
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(win=>{win.webContents.setBackgroundThrottling(false);win.hide();}));
 const info=await lab.evaluate(()=>window.ocrLab.info());assert.ok(info.appVersion);await lab.waitForFunction(v=>document.querySelector('.eyebrow').textContent.includes(v),info.appVersion);
 await lab.locator('#engine').selectOption('baseline');
 const errors=[];lab.on('pageerror',e=>errors.push(e.message));
 const imported=await app.evaluate(async(_electron,files)=>global.__eiwTest.ocrLabAddFiles(files),[path.join(root,'test','fixtures','ocr-thai-bubble.png')]);
 await lab.evaluate(rows=>addPages(rows),imported);
 await lab.waitForFunction(()=>!document.getElementById('canvas').hidden);
 await lab.locator('#jpn').uncheck();await lab.locator('#eng').uncheck();await lab.locator('#fra').uncheck();
 await lab.locator('#run').click();
 await lab.waitForFunction(()=>current()?.regions.length>0&&!busy,{},{timeout:90000});
 const result=await lab.evaluate(()=>({regions:current().regions,runs:current().runs}));
 assert.ok(result.regions.some(r=>r.text.includes('พวกแกทุกคน')),'Thai text not found');
 assert.ok(result.runs[0].passes.length===3);
 assert.equal(result.runs[0].appVersion,info.appVersion);
 const truth={id:'truth-bubble',text:'พวกแกทุกคนน่าจะ\nรู้เรื่องกองกำลังอิสรภาพ\nของจักรวรรดิกัน',bbox:{x0:210,y0:180,x1:505,y1:324},orientation:'horizontal',kind:'bubble',reviewed:true};
 await lab.evaluate(t=>{current().truth=[t];current().complete=true;document.getElementById('complete').checked=true;renderPages();return measure();},truth);
 const initial=await lab.evaluate(()=>current().metrics);
 assert.equal(initial.recall,1);assert.equal(initial.targetMet,false);assert.equal(initial.extra.length,0);
 assert.ok(initial.characterAccuracy>.9&&initial.characterAccuracy<1,'tone errors must remain visible in the accuracy score');
 const baseline={...imported[0],dataUrl:undefined,imageBase64:(await fs.readFile(path.join(root,'test','fixtures','ocr-thai-bubble.png'))).toString('base64'),regions:result.regions,rawRegions:structuredClone(result.regions),truth:[truth],complete:true,runs:result.runs,history:[]};
 await fs.writeFile(path.join(out,'thai-baseline-review.json'),JSON.stringify({schema:'imageharvest.ocr-review',version:1,pages:[baseline]},null,2));
 // Re-OCR a hand-drawn region: its coordinates must remain in original-image pixels.
 const roi=await lab.evaluate(()=>window.ocrLab.run({id:current().id,languages:['tha'],mode:'horizontal',bbox:{x0:200,y0:170,x1:520,y1:340}}));
 assert.ok(roi.regions[0].bbox.x0>=200&&roi.regions[0].bbox.y0>=170,'ROI coordinates lost origin');
 const cacheStarted=performance.now();
 const cached=await lab.evaluate(()=>window.ocrLab.run({id:current().id,languages:['tha'],mode:'horizontal',bbox:{x0:200,y0:170,x1:520,y1:340}}));
 const cachedRoundTripMs=Math.round(performance.now()-cacheStarted);
 assert.equal(cached.cacheHit,true);assert.deepEqual(cached.regions,roi.regions);assert.equal(cached.originalMs,roi.ms);
 const fresh=await lab.evaluate(()=>window.ocrLab.run({id:current().id,languages:['tha'],mode:'horizontal',bbox:{x0:200,y0:170,x1:520,y1:340},useCache:false}));
 assert.equal(fresh.cacheHit,false);assert.deepEqual(fresh.regions,roi.regions);
 await fs.writeFile(path.join(out,'cache-verification.json'),JSON.stringify({appVersion:info.appVersion,cacheHit:cached.cacheHit,cachedRoundTripMs,freshMs:fresh.ms,regionsUnchanged:true},null,2));
 const scaled=await lab.evaluate(()=>window.ocrLab.run({id:current().id,languages:['tha'],mode:'horizontal',bbox:{x0:200,y0:170,x1:520,y1:340},imageScale:2}));
 assert.equal(scaled.cacheHit,false,'image scale must invalidate cache');
 assert.ok(scaled.regions.every(r=>r.bbox.x0>=200&&r.bbox.y0>=170&&r.bbox.x1<=520&&r.bbox.y1<=340),'scaled coordinates must return to original-image pixels');
 // Keep the editable OCR separate from the original recognition observations.
 await lab.evaluate(t=>{current().regions=[{...t,id:'corrected-bubble'}];renderList();return measure();},truth);
 assert.equal(await lab.evaluate(()=>current().metrics.targetMet),true);
 const before=await lab.evaluate(()=>JSON.stringify(current().rawRegions));
 await lab.locator('#regions button').first().click();await lab.locator('#splitX').click();
 assert.equal(await lab.evaluate(()=>current().regions.length),2);assert.equal(await lab.evaluate(()=>current().complete),true);
 assert.equal(await lab.evaluate(()=>JSON.stringify(current().rawRegions)),before);
 await lab.locator('#kind').selectOption('watermark');await lab.locator('#apply').click();
 assert.equal(await lab.evaluate(()=>selected().kind),'watermark');assert.equal(await lab.evaluate(()=>selected().contentRole.excluded),true);
 assert.equal(await lab.evaluate(()=>JSON.stringify(current().rawRegions)),before,'marking watermark must not change raw observations');
 await lab.locator('#kind').selectOption('text');await lab.locator('#apply').click();
 assert.equal(await lab.evaluate(()=>selected().contentOverride),true,'a user can restore wrongly excluded text');
 assert.ok(await lab.locator('#regionMeta').textContent().then(s=>s.includes('แยกกรอบด้วยมือ')));
 // Save/reopen a portable project including its original image bytes.
 const project=path.join(out,'sample-review.json');
 await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},project);
 await lab.locator('#save').click();await lab.waitForFunction(()=>document.getElementById('status').textContent.startsWith('บันทึกแล้ว'));
 await lab.locator('#load').click();await lab.waitForFunction(()=>pages.length===2);
 assert.equal(await lab.evaluate(()=>current().digest),imported[0].digest);
 await screenshot(lab,path.join(out,'lab.png'));
 assert.deepEqual(errors,[]);
 // Capture the actual HarvestTS guest and preserve its viewport/scroll origin.
 server=http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<body style="margin:0;background:white;height:2200px"><h1>OCR CAPTURE FIXTURE</h1></body>');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${server.address().port}/`;
 await main.evaluate(()=>window.eiw.harvestTsLayout({visible:true,bounds:{x:220,y:116,width:900,height:700}}));
 assert.equal((await main.evaluate(url=>window.eiw.harvestTsCreate({url,activate:true}),url)).ok,true);
 await app.evaluate(async({webContents},url)=>{
  let wc;for(let i=0;i<100&&!wc;i++){wc=webContents.getAllWebContents().find(w=>w.getURL()===url);if(!wc)await new Promise(r=>setTimeout(r,50));}
  if(wc.isLoading())await new Promise(resolve=>wc.once('did-stop-loading',resolve));
  await wc.executeJavaScript('scrollTo(0,300)');
 },url);
 const [captured]=await lab.evaluate(()=>window.ocrLab.capture());
 assert.equal(captured.source.url,url);assert.equal(captured.source.scrollY,300);assert.equal(captured.width,900);assert.equal(captured.height,700);
 const visibility=await app.evaluate(async({webContents},url)=>webContents.getAllWebContents().find(w=>w.getURL()===url).executeJavaScript("getComputedStyle(document.getElementById('__harvestts_manga_translate__')).visibility"),url);
 assert.equal(visibility,'visible','launcher visibility must be restored after capture');
 // AVIF must preserve the source digest and work for both original and 2x OCR.
 const avif=path.join(out,'thai.avif');await sharp(path.join(root,'test','fixtures','ocr-thai-bubble.png')).avif({quality:85}).toFile(avif);
 const [avifPage]=await app.evaluate(async(_electron,files)=>global.__eiwTest.ocrLabAddFiles(files),[avif]);
 assert.equal(avifPage.width,imported[0].width);assert.equal(avifPage.height,imported[0].height);
 const avifRead=await lab.evaluate(id=>window.ocrLab.run({id,languages:['tha']}),avifPage.id);
 assert.ok(avifRead.regions.some(r=>r.text.includes('พวกแกทุกคน')));
 const avifScaled=await lab.evaluate(id=>window.ocrLab.run({id,languages:['tha'],imageScale:2,bbox:{x0:200,y0:170,x1:520,y1:340}}),avifPage.id);
 assert.ok(avifScaled.regions.every(r=>r.bbox.x0>=200&&r.bbox.y0>=170&&r.bbox.x1<=520&&r.bbox.y1<=340));
 const long=path.join(out,'long.png'),layout=await fs.readFile(path.join(root,'test','fixtures','ocr-layout.png'));
 await sharp({create:{width:900,height:16000,channels:3,background:'#fff'}}).composite([{input:layout,left:0,top:900},{input:layout,left:0,top:14500}]).png().toFile(long);
 const longPages=await app.evaluate(async(_electron,files)=>global.__eiwTest.ocrLabAddFiles(files),[long]);await lab.evaluate(rows=>addPages(rows),longPages);
 await lab.waitForFunction(()=>current()?.height===16000&&document.getElementById('canvas').style.height!=='');
 const longRead=await lab.evaluate(()=>window.ocrLab.run({id:current().id,languages:['eng','fra','jpn','tha']}));
 assert.equal(longRead.regions.length,8);assert.ok(longRead.detection.tiles.length>1);
 const point=await lab.evaluate(r=>{
  current().regions=r.regions;current().rawRegions=structuredClone(r.regions);scale=4;paint();renderList();
  const foot=r.regions.find(r=>r.text==='HELLO WORLD'&&r.bbox.y0>14500);selectRegion(foot.id,true);selectedId='';
  const canvas=document.getElementById('canvas'),rect=canvas.getBoundingClientRect(),b=foot.bbox;
  return {id:foot.id,x:rect.left+(b.x0+b.x1)*scale/2,y:rect.top+(b.y0+b.y1)*scale/2,bitmapHeight:canvas.height,displayHeight:parseFloat(canvas.style.height)};
 },longRead);
 assert.ok(point.bitmapHeight<=16384);assert.equal(point.displayHeight,64000);
 await lab.mouse.click(point.x,point.y);assert.equal(await lab.evaluate(()=>selectedId),point.id);
 await screenshot(lab,path.join(out,'long-zoom.png'));
 const manga='C:/Users/jinna/Downloads/manga test ocr/1/1 _ Chapter 2 - Itoko no Onee-chan ni Amaechau_ - MangaDex_2026-10-05T20-58-55/0001.jpg';
 if(await fs.stat(manga).then(()=>true,()=>false)){
  const original=await app.evaluate(async(_electron,files)=>global.__eiwTest.ocrLabAddFiles(files),[manga]);await lab.evaluate(rows=>addPages(rows),original);
  const real=await lab.evaluate(()=>window.ocrLab.run({id:current().id,languages:['eng','fra','jpn','tha']}));
  const head=real.regions.find(r=>r.text.startsWith('HEIN')),body=real.regions.find(r=>r.text.startsWith('POURQUOI'));
  assert.ok(head&&body);assert.ok(head.bbox.y1<body.bbox.y0);assert.equal(head.containerId,body.containerId);
  await lab.evaluate(r=>{current().regions=r.regions;current().rawRegions=structuredClone(r.regions);current().runs=[r];renderPages();renderList();},real);
  await screenshot(lab,path.join(out,'real-manga.png'));
 }
 // Optional engines must also work from Electron and the packaged ASAR.
 const runtime=path.join(process.env.LOCALAPPDATA,'ImageHarvest/ocr-runtime/Scripts/python.exe');
 if(await fs.stat(runtime).then(()=>true,()=>false)){
  const enhanced=await lab.evaluate(id=>window.ocrLab.run({id,languages:['tha'],engine:'enhanced',preprocessing:'all',imageScale:2,bbox:{x0:200,y0:170,x1:520,y1:340}}),imported[0].id);
  assert.ok(editDistance(enhanced.regions[0].text,truth.text)<=3,'scaled Thai crop lost substantial text');assert.ok(enhanced.engine.includes('paddleocr'));
  if(process.env.EIW_EXPECT_OCR_GPU==='1')assert.equal(enhanced.performance.acceleration.engine,'cuda','installed OCR must run on the validated GPU runtime');
  if(editDistance(enhanced.regions[0].text,truth.text))assert.equal(enhanced.regions[0].reviewRequired,true,'recognizer disagreement must remain visible');
  assert.ok(enhanced.regions[0].bbox.x0>=200&&enhanced.regions[0].bbox.y0>=170&&enhanced.regions[0].bbox.x1<=520&&enhanced.regions[0].bbox.y1<=340);
  assert.ok(enhanced.regions[0].recognitionLines.every(l=>l.bbox.x0>180&&l.bbox.y0>150&&l.bbox.y1<350));
  const alternatives=enhanced.regions[0].alternatives;
  for(const variant of ['original','grayscale','contrast','invert','clahe','adaptive','otsu'])assert.ok(alternatives.some(a=>a.variant===variant&&!a.error),'missing preprocessing '+variant);
  const originalReading=alternatives.find(a=>a.variant==='original'),adaptiveReading=alternatives.find(a=>a.variant==='adaptive');
  assert.ok(originalReading.lines.every(l=>l.polygon.every(([x,y])=>x>180&&x<540&&y>140&&y<360)),'line polygons must be in source pixels, including 2x runs');
  const previews=await lab.evaluate(async({id,original,adaptive})=>({original:await window.ocrLab.preview({id,crop:original.crop,variant:'original'}),adaptive:await window.ocrLab.preview({id,crop:adaptive.crop,variant:'adaptive'})}),{id:imported[0].id,original:originalReading,adaptive:adaptiveReading});
  assert.equal(previews.original.width,originalReading.crop.width+24);assert.equal(previews.adaptive.width,previews.original.width);assert.equal(previews.adaptive.height,previews.original.height);
  const thresholdPixels=await sharp(Buffer.from(previews.adaptive.dataUrl.split(',')[1],'base64')).removeAlpha().raw().toBuffer();assert.ok(thresholdPixels.every(v=>v===0||v===255));
  const invalidPreview=await lab.evaluate(async({id,crop})=>{try{await window.ocrLab.preview({id,crop:{...crop,rectangle:{left:-100,top:0,width:20,height:20}},variant:'original'});return false;}catch{return true;}},{id:imported[0].id,crop:originalReading.crop});assert.equal(invalidPreview,true);
  await lab.evaluate(async({result,id})=>{await selectPage(id);const p=current();p.runs.push(result);p.activeRun=p.runs.length-1;p.regions=structuredClone(result.regions);p.rawRegions=structuredClone(result.regions);document.getElementById('layer').value='regions';renderPasses();renderList();selectRegion(p.regions[0].id);},{result:enhanced,id:imported[0].id});
  if(process.env.EIW_EXPECT_OCR_GPU==='1')assert.match(await lab.locator('#runHistory').inputValue().then(()=>lab.locator('#runHistory option:checked').textContent()),/GPU/);
  await lab.locator('#alternatives details').first().click();assert.ok(await lab.locator('#alternatives pre').first().textContent());
  const originalDetails=lab.locator('#alternatives details').filter({has:lab.locator('summary', {hasText:'ภาพเดิม •'})}).first();
  await originalDetails.locator('summary').click();await originalDetails.getByRole('button',{name:'ดูภาพที่ใช้ OCR'}).click();
  await originalDetails.locator('img').waitFor();assert.ok(await originalDetails.locator('img').getAttribute('src').then(s=>s.startsWith('data:image/png;base64,')));
  const rawBefore=await lab.evaluate(()=>JSON.stringify(current().runs.at(-1).regions));
  await lab.locator('#alternatives button').first().click();assert.equal(await lab.evaluate(()=>JSON.stringify(current().runs.at(-1).regions)),rawBefore);
  await lab.locator('#viewRun').click();assert.equal(await lab.locator('#layer').inputValue(),'rawRegions');assert.ok(await lab.locator('#pass option').count()>3);
  await screenshot(lab,path.join(out,'enhanced-comparison.png'));
  const cropped=path.join(out,'thai-cropped.png');await sharp(path.join(root,'test/fixtures/ocr-thai-bubble.png')).extract({left:159,top:126,width:410,height:255}).png().toFile(cropped);
  const croppedPages=await app.evaluate(async(_electron,files)=>global.__eiwTest.ocrLabAddFiles(files),[cropped]);await lab.evaluate(rows=>addPages(rows),croppedPages);
  const croppedRun=await lab.evaluate(()=>window.ocrLab.run({id:current().id,languages:['tha'],engine:'enhanced',imageScale:2}));
  assert.equal(croppedRun.regions.length,1,'small screenshot must not split or duplicate a continuous paragraph');
  assert.equal(croppedRun.regions[0].text,truth.text);assert.equal(croppedRun.regions[0].localizationRefinement,'recognizer-line-bounds');
  assert.ok(croppedRun.regions[0].bbox.x1<=410&&croppedRun.regions[0].bbox.y1<=255);assert.ok(croppedRun.regions[0].detectorBBox.x1<=410);
  await lab.evaluate(async({result,id})=>{await selectPage(id);current().regions=structuredClone(result.regions);current().rawRegions=structuredClone(result.regions);current().runs=[result];current().activeRun=0;document.getElementById('engine').value='enhanced';document.getElementById('imageScale').value='2';document.getElementById('layer').value='rawRegions';renderPages();renderPasses();document.getElementById('layer').onchange();fit();selectRegion(result.regions[0].id);document.getElementById('viewport').scrollTo(0,0);},{result:croppedRun,id:croppedPages[0].id});
  assert.equal(await lab.evaluate(()=>current().width),410);assert.ok(await lab.locator('#canvas').evaluate(c=>parseFloat(c.style.width)<=410));
  await screenshot(lab,path.join(out,'thai-cropped-fixed.png'));
  await fs.writeFile(path.join(out,'thai-cropped-fixed.json'),JSON.stringify(croppedRun,null,2));
 }
 assert.deepEqual(errors,[]);
 const comparison=path.join(root,'test-results/engine-comparison/comparison-review.json');
 if(await fs.stat(comparison).then(()=>true,()=>false)){
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},comparison);
  await lab.locator('#load').click();await lab.waitForFunction(()=>current()?.measurementScope==='recognition-only');
  await lab.waitForFunction(()=>document.getElementById('metrics').textContent.includes('เฉลยเฉพาะคำอ่าน'));
  assert.equal(await lab.locator('#complete').isDisabled(),true);assert.ok(!await lab.locator('#metrics').textContent().then(s=>s.includes('ผ่านเป้าหมาย 99%')));
 }
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify({initial,roi:roi.regions,errors},null,2));
 console.log('PASS: Thai OCR, original pixel coordinates, truthful metrics, split, immutable raw results, portable save/load, real manga separation');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(app)await app.close();if(server)server.close();});
