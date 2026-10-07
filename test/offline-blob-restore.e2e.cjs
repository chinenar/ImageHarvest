'use strict';
const { _electron: electron } = require('playwright-core');
const http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,'test-results','offline-blob-restore'),profile=path.join(out,'profile');
let app,server;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  await fs.rm(out,{recursive:true,force:true});await fs.mkdir(out,{recursive:true});
  server=http.createServer((req,res)=>{
    if(req.url!='/chapter'){res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end(`<!doctype html><html><head><title>Offline blob restore fixture</title>
      <style>html,body{margin:0;background:#ddd}main{width:620px;margin:auto}.page{display:block;width:600px;height:900px;margin:0 auto}</style>
      </head><body><main class="manga-reader"><img class="page" alt="PAGE 1"><img class="page" alt="PAGE 2"></main>
      <script>
      const svg=n=>'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect width="600" height="900" fill="white"/><ellipse cx="300" cy="180" rx="160" ry="85" fill="white" stroke="black"/><text x="300" y="190" text-anchor="middle" font-size="30">PAGE '+n+'</text></svg>';
      document.querySelectorAll('img').forEach((img,i)=>img.src=URL.createObjectURL(new Blob([svg(i+1)],{type:'image/svg+xml'})));
      </script></body></html>`);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port,url=base+'/chapter';
  const id='aaaaaaaaaaaaaaaaaaaaaaaa',dir=path.join(profile,'harvestts','offline-library',id);await fs.mkdir(dir,{recursive:true});
  const bbox={x0:180,y0:100,x1:420,y1:245};
  const region=(rid,text)=>({id:rid,text,translation:'แปลแล้ว',kind:'bubble',confidence:99,bbox,translationRecord:{status:'translated',sourceText:text,imageDigest:'digest',bbox},placement:{surfaceType:'bubble',paintMode:'flat-fill-polygon',fillColor:'#ffffff',confidence:.99,eraseBox:bbox,safeBox:bbox,polygon:[[160,80],[440,80],[440,265],[160,265]],sourceEraseBoxes:[bbox]}});
  const manifest={version:5,jobId:'saved-job',source:{url,title:'Saved fixture'},settings:{targetLanguage:'th',fontScale:1,showOriginal:false},pages:[
    {id:'saved-p1',index:0,file:'0001.png',source:'img',sourceUrl:'blob:'+base+'/stale-one',width:600,height:900,imageDigest:'digest',ocr:{regions:[region('r1','HELLO ONE')]}},
    {id:'saved-p2',index:1,file:'0002.png',source:'img',sourceUrl:'blob:'+base+'/stale-two',width:600,height:900,imageDigest:'digest',ocr:{regions:[region('r2','HELLO TWO')]}}
  ]};
  const now=Date.now(),project={version:1,id,documentKey:url,url,title:'Saved fixture',createdAt:now,updatedAt:now,pages:2,sizeBytes:0,targetLanguage:'th',styles:{}};
  await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify(manifest,null,2));await fs.writeFile(path.join(dir,'project.json'),JSON.stringify(project,null,2));
  await fs.writeFile(path.join(profile,'harvestts','offline-library','index.json'),JSON.stringify({version:1,items:[{id,documentKey:url,url,title:'Saved fixture',createdAt:now,updatedAt:now,pages:2,sizeBytes:0,targetLanguage:'th'}]},null,2));
  const env={...process.env,EIW_TEST_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({args:[root,'--eiw-test'],env,timeout:45000});const page=await app.firstWindow();await page.waitForFunction(()=>!!window.eiw);
  const layout=await page.evaluate(()=>window.eiw.harvestTsLayout({visible:true,bounds:{x:20,y:120,width:900,height:650}}));assert.equal(layout.ok,true);
  const created=await page.evaluate(url=>window.eiw.harvestTsCreate({url,activate:true}),url);assert.equal(created.ok,true);
  let guestId=0;for(let i=0;i<120&&!guestId;i++){guestId=await app.evaluate(({webContents},url)=>webContents.getAllWebContents().find(w=>w.getURL()===url)?.id||0,url);if(!guestId)await sleep(80);}
  assert.ok(guestId);
  let state=null;
  for(let i=0;i<80;i++){
    state=await app.evaluate(({webContents},id)=>webContents.fromId(id)?.executeJavaScript('window.__harvestTsTranslationOverlay?.stats?.()||null'),guestId);
    if(state?.drawn>=2)break;await sleep(150);
  }
  assert.ok(state,'offline overlay was not created');assert.equal(state.total,2);assert.equal(state.drawn,2);
  const sources=await app.evaluate(({webContents},id)=>webContents.fromId(id).executeJavaScript('[...document.images].map(x=>x.src)'),guestId);
  assert.ok(sources.every(x=>x.startsWith('blob:')));assert.ok(!sources.includes(manifest.pages[0].sourceUrl));
  console.log('PASS: saved translations remap stale blob image URLs and appear automatically');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{try{await app?.close()}catch{};try{server?.close()}catch{}});
