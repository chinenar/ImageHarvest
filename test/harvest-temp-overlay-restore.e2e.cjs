'use strict';
const { _electron: electron }=require('playwright-core');
const http=require('node:http'),path=require('node:path'),fs=require('node:fs/promises'),os=require('node:os'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');let app,server;const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const svg='<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect width="600" height="900" fill="white"/><text x="300" y="300" text-anchor="middle" font-size="56">HELLO</text></svg>';
 server=http.createServer((req,res)=>{if(req.url==='/chapter'){res.setHeader('content-type','text/html');res.end('<main class="manga-reader"><img id="page" src="/page.svg" width="600" height="900"></main>');return;}if(req.url==='/page.svg'){res.setHeader('content-type','image/svg+xml');res.end(svg);return;}res.writeHead(404);res.end();});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const env={...process.env,EIW_TEST_USER_DATA:path.join(root,'test-results','temp-overlay-profile')};delete env.ELECTRON_RUN_AS_NODE;
 await fs.rm(env.EIW_TEST_USER_DATA,{recursive:true,force:true});
 app=await electron.launch({args:[root,'--eiw-test'],env,timeout:45000});const shell=await app.firstWindow();await shell.waitForFunction(()=>!!window.eiw);
 const pid=await app.evaluate(()=>process.pid),tempRoot=path.join(os.tmpdir(),'ImageHarvest','harvestts-translate-test-'+pid),jobDir=path.join(tempRoot,'harvest-1-'+Date.now());await fs.mkdir(jobDir,{recursive:true});
 const bbox={x0:180,y0:240,x1:420,y1:350};
 const record={id:'r1',translation:'สวัสดี',status:'translated',sourceText:'HELLO',sourceTextDigest:'x',bbox:{...bbox},provider:'ai',model:'mock',sourceLanguage:'auto',targetLanguage:'th',imageDigest:'batch:digest-a|digest-b'};
 const region={id:'r1',text:'HELLO',translation:'สวัสดี',bbox:{...bbox},confidence:99,reviewRequired:false,translationRecord:{...record},placement:{surfaceType:'scene',surfaceId:'s1',paintMode:'flat-fill-rect',fillColor:'#ffffff',eraseBox:{x0:160,y0:220,x1:440,y1:370},safeBox:{x0:170,y0:230,x1:430,y1:360},confidence:.95}};
 const manifest={version:5,jobId:'restore-test',source:{url:base+'/chapter',title:'restore'},settings:{engine:'ai',sourceLanguage:'auto',targetLanguage:'th',contentType:'manga',fontScale:1,showOriginal:false},translation:{provider:'ai',regions:1,translated:1,failed:0,status:'translated'},pages:[{id:'p1',index:0,file:'0001.svg',sourceUrl:base+'/page.svg',source:'img',width:600,height:900,imageDigest:'digest-a',ocr:{regions:[region]},translation:{imageDigest:'batch:digest-a|digest-b',items:[{...record}]}}]};
 await fs.writeFile(path.join(jobDir,'manifest.json'),JSON.stringify(manifest,null,2),'utf8');
 await shell.evaluate(()=>window.eiw.harvestTsLayout({visible:true,bounds:{x:20,y:120,width:900,height:700}}));await shell.evaluate(url=>window.eiw.harvestTsCreate({url,activate:true}),base+'/chapter');
 let guest=0;for(let i=0;i<120&&!guest;i++){guest=await app.evaluate(({webContents},prefix)=>webContents.getAllWebContents().find(w=>w.getURL()===prefix)?.id||0,base+'/chapter');if(!guest)await sleep(80)}assert.ok(guest);
 let state=null;for(let i=0;i<80;i++){state=await app.evaluate(({webContents},id)=>webContents.fromId(id).executeJavaScript("window.__harvestTsTranslationOverlay?.stats?.()||null"),guest);if(state?.drawn>0)break;await sleep(100)}
 assert.ok(state?.drawn>0,'temporary translated manifest should be repaired and restored without rerunning AI: '+JSON.stringify(state));
 const repaired=JSON.parse(await fs.readFile(path.join(jobDir,'manifest.json'),'utf8'));assert.equal(repaired.pages[0].ocr.regions[0].translationRecord.imageDigest,'digest-a');
 console.log('PASS: completed batch translations restore on the live page without re-running AI');
})().catch(e=>{console.error(e.stack||e);process.exitCode=1}).finally(async()=>{try{await app?.close()}catch{};try{server?.closeAllConnections?.();await new Promise(r=>server?.close(r))}catch{}});
