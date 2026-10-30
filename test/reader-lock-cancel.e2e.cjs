'use strict';
const {_electron:electron}=require('playwright-core'),http=require('node:http'),path=require('node:path'),assert=require('node:assert/strict'),sharp=require('sharp');
let app,server;const pending=[];
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const image=await sharp({create:{width:600,height:900,channels:3,background:'#fff'}}).png().toBuffer();
 server=http.createServer((req,res)=>{
  if(req.url==='/v1/models'){pending.push(res);return;}
  if(req.url.endsWith('.png')){res.setHeader('Content-Type','image/png');res.end(image);return;}
  res.setHeader('Content-Type','text/html');res.end('<main class="manga-reader"><img src="/a.png" width="600" height="900"><img src="/b.png" width="600" height="900"></main>');
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 app=await electron.launch({args:[path.resolve(__dirname,'..'),'--eiw-test'],env,timeout:45000});const ui=await app.firstWindow();await ui.waitForFunction(()=>!!window.eiw);
 await app.evaluate((_electron,url)=>global.__eiwTest.translationTestEndpoint(url),base);
 await ui.evaluate(()=>window.eiw.harvestTsLayout({visible:true,bounds:{x:20,y:115,width:900,height:700}}));
 await ui.evaluate(url=>window.eiw.harvestTsCreate({url,activate:true}),base+'/reader');
 let id;for(let n=0;n<100&&!id;n++){id=await app.evaluate(({webContents},base)=>webContents.getAllWebContents().find(w=>w.getURL().startsWith(base+'/reader')&&!w.isLoading())?.id,base);if(!id)await delay(100);}assert.ok(id,'reader guest must finish loading before testing cancellation');
 await app.evaluate(()=>{global.__cancelLockJob=global.__eiwTest.harvestTranslationStart().then(()=>({ok:true}),e=>({error:e.message}));return true;});
 let locked=false;
 for(let n=0;n<50;n++){locked=await app.evaluate(async({webContents},id)=>webContents.fromId(id).executeJavaScript('!!window.__harvestTsReaderLock?.stats().locked'),id);if(locked&&pending.length)break;await delay(50);}
 assert.equal(locked,true);await delay(150);
 await app.evaluate(async({webContents},id)=>webContents.fromId(id).executeJavaScript(`(()=>{document.getElementById('__harvestts_reader_lock__').shadowRoot.querySelector('button').click();return true;})()`),id);
 let unlocked=false;
 for(let n=0;n<50;n++){unlocked=await app.evaluate(async({webContents},id)=>webContents.fromId(id).executeJavaScript('!window.__harvestTsReaderLock?.stats().locked && !document.getElementById("__harvestts_reader_lock__")'),id);if(unlocked)break;await delay(50);}
 assert.equal(unlocked,true,'Cancel button must cross the preload boundary and release the real app lock');
 assert.equal((await app.evaluate(()=>global.__eiwTest.harvestTranslationState())).running,false);
 for(const res of pending){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'qwen-text-mock'}]}));}
 const result=await app.evaluate(()=>global.__cancelLockJob);assert.ok(result.error,'cancelled job must not report success');
 console.log('PASS: actual app lock cancel button -> isolated preload IPC -> job abort -> immediate unlock');
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;}).finally(async()=>{for(const res of pending)if(!res.writableEnded)res.end('{}');await app?.close().catch(()=>{});server?.closeAllConnections();server?.close();});
