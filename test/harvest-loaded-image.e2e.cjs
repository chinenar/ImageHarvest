'use strict';
const { _electron: electron }=require('playwright-core');
const http=require('node:http'),path=require('node:path'),assert=require('node:assert/strict'),fs=require('node:fs');
const root=path.resolve(__dirname,'..');
let app,server,imageRequests=0;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const svg='<svg xmlns="http://www.w3.org/2000/svg" width="700" height="1100"><rect width="700" height="1100" fill="white"/><text x="350" y="550" text-anchor="middle" font-size="72">PROTECTED PAGE</text></svg>';
 server=http.createServer((req,res)=>{
   if(req.url==='/'){
     res.setHeader('Content-Type','text/html; charset=utf-8');
     res.end('<!doctype html><style>body{margin:0}img{display:block;width:700px;height:1100px;margin:auto}</style><main class="manga-reader"><img id="page" src="/protected.svg" width="700" height="1100" alt="001"></main>');
     return;
   }
   if(req.url==='/protected.svg'){
     imageRequests++;
     if(imageRequests>1){res.writeHead(403,{'Content-Type':'text/plain'});res.end('hotlink blocked');return;}
     res.writeHead(200,{'Content-Type':'image/svg+xml','Cache-Control':'no-store'});
     res.end(svg);return;
   }
   res.writeHead(404);res.end();
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 const profile=path.join(root,'test-results','harvest-loaded-image-profile');fs.rmSync(profile,{recursive:true,force:true});
 const env={...process.env,EIW_TEST_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
 app=await electron.launch({args:[root,'--eiw-test'],env,timeout:45000});
 const shell=await app.firstWindow();await shell.waitForFunction(()=>!!window.eiw);
 await shell.evaluate(()=>window.eiw.harvestTsLayout({visible:true,bounds:{x:20,y:120,width:900,height:700}}));
 await shell.evaluate(url=>window.eiw.harvestTsCreate({url,activate:true}),base+'/');
 let guestId=0;
 for(let i=0;i<240&&!guestId;i++){
   guestId=await app.evaluate(({webContents},prefix)=>webContents.getAllWebContents().find(w=>w.getURL().startsWith(prefix))?.id||0,base);
   if(!guestId)await sleep(75);
 }
 const urls=await app.evaluate(({webContents})=>webContents.getAllWebContents().map(w=>({id:w.id,url:w.getURL(),type:w.getType()})));
 assert.ok(guestId,'HarvestTS guest not ready '+JSON.stringify(urls));
 await app.evaluate(async({webContents},id)=>{const wc=webContents.fromId(id);if(wc.isLoading())await new Promise(r=>wc.once('did-stop-loading',r));await wc.executeJavaScript('document.querySelector("#page")?.complete');},guestId);
 await sleep(400);
 assert.equal(imageRequests,1,'reader itself should load the protected image once');
 const acquired=await app.evaluate(()=>global.__eiwTest.harvestTranslationAcquireFirst());
 assert.ok(acquired.bytes>100,'translation acquisition should reuse loaded Chromium bytes');
 assert.equal(imageRequests,1,'translation must not issue a second hotlink request that would receive 403');
 assert.ok(Number(acquired.imageStore?.hits)>=1,'HarvestTS image response store should serve the acquisition');
 console.log('PASS: HarvestTS translation reuses Chromium-loaded image bytes and avoids hotlink 403');
})().catch(e=>{console.error(e.stack||e);process.exitCode=1}).finally(async()=>{try{await app?.close()}catch{};try{server?.closeAllConnections?.();await new Promise(r=>server?.close(r))}catch{}});
