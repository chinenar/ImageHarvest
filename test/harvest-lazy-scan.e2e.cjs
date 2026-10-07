'use strict';
const { _electron: electron }=require('playwright-core');
const http=require('node:http'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
let app,server;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  server=http.createServer((req,res)=>{
    const u=new URL(req.url,'http://127.0.0.1');
    if(u.pathname==='/lazy'){
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.end(`<!doctype html><html><head><style>
        html,body{margin:0;background:#ddd}main{width:620px;margin:auto}
        img{display:block;width:600px;height:900px;margin:0 auto;background:white}
      </style></head><body><main id="reader" class="manga-reader"></main><script>
        let loaded=0,busy=false;const total=30,reader=document.getElementById('reader');
        function appendBatch(){
          const end=Math.min(total,loaded+10);
          for(let i=loaded+1;i<=end;i++){const img=document.createElement('img');img.alt='PAGE '+i;img.src='/page-'+i+'.svg';reader.append(img)}
          loaded=end;window.__loadedPages=loaded;
        }
        appendBatch();
        addEventListener('scroll',()=>{
          if(busy||loaded>=total)return;
          const root=document.scrollingElement;
          if(root.scrollTop+innerHeight<root.scrollHeight-80)return;
          busy=true;setTimeout(()=>{appendBatch();busy=false},2200);
        },{passive:true});
      </script></body></html>`);
      return;
    }
    if(/^\/page-\d+[.]svg$/.test(u.pathname)){
      res.setHeader('Content-Type','image/svg+xml');
      const n=(u.pathname.match(/\d+/)||['0'])[0];
      res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect width="600" height="900" fill="white"/><text x="300" y="450" text-anchor="middle" font-size="80">PAGE ${n}</text></svg>`);
      return;
    }
    res.writeHead(404);res.end();
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  const env={...process.env,EIW_TEST_USER_DATA:path.join(root,'test-results','harvest-lazy-scan-profile')};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({args:[root,'--eiw-test'],env,timeout:45000});
  const page=await app.firstWindow();await page.waitForFunction(()=>!!window.eiw);
  const layout=await page.evaluate(()=>window.eiw.harvestTsLayout({visible:true,bounds:{x:20,y:120,width:900,height:700}}));assert.equal(layout.ok,true);
  const created=await page.evaluate(url=>window.eiw.harvestTsCreate({url,activate:true}),base+'/lazy');assert.equal(created.ok,true);
  let guestId=0;
  for(let i=0;i<100&&!guestId;i++){guestId=await app.evaluate(({webContents},prefix)=>webContents.getAllWebContents().find(w=>w.getURL()===prefix)?.id||0,base+'/lazy');if(!guestId)await sleep(80)}
  assert.ok(guestId,'HarvestTS guest not ready');
  await app.evaluate(async({webContents},id)=>{const wc=webContents.fromId(id);if(wc.isLoading())await new Promise(r=>wc.once('did-stop-loading',r));},guestId);
  await sleep(250);
  const initial=await app.evaluate(({webContents},id)=>webContents.fromId(id).executeJavaScript('window.__loadedPages'),guestId);assert.equal(initial,10);
  const scan=await app.evaluate(()=>global.__eiwTest.harvestTranslationScan());
  const loadedAfter=await app.evaluate(({webContents},id)=>webContents.fromId(id).executeJavaScript('window.__loadedPages'),guestId);
  assert.equal(scan.pages.length,30,'bottom verification must discover all lazy batches '+JSON.stringify({fastPath:scan.fastPath,steps:scan.steps,loadedAfter}));
  assert.equal(scan.fastPath,false,'fast path must fall back after the end probe grows');
  const restored=await app.evaluate(({webContents},id)=>webContents.fromId(id).executeJavaScript('document.scrollingElement.scrollTop'),guestId);
  assert.ok(restored<=2,'scan must restore the user scroll position');
  console.log('PASS: HarvestTS end probe rejects false completeness and scans all 30 lazy pages');
})().catch(e=>{console.error(e.stack||e);process.exitCode=1}).finally(async()=>{try{await app?.close()}catch{};try{server?.closeAllConnections?.();await new Promise(r=>server?.close(r))}catch{}});
