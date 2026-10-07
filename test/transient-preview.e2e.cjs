'use strict';
const {_electron}=require('playwright-core');
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
let app,server,hits=0;
(async()=>{
 const png=await fs.readFile(path.join(__dirname,'fixtures','first.png'));
 server=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://127.0.0.1');
  if(u.pathname==='/reader'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<title>Transient preview</title><main class="reader"><img width="420" height="560" data-src="/flaky.png"></main>');return;}
  if(u.pathname==='/flaky.png'){hits++;if(hits===1){res.writeHead(403);res.end('not ready');return;}res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store'});res.end(png);return;}
  res.writeHead(404);res.end();
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${server.address().port}/reader`;
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 app=await _electron.launch({args:[root,'--eiw-test'],env});
 const page=await app.firstWindow();await page.waitForFunction(()=>!!window.eiw);
 await page.selectOption('#browserMode','electron');
 await app.evaluate((_,url)=>global.__eiwTest.openPage({url,backend:'electron',show:false}),url);
 const scan=await app.evaluate(()=>global.__eiwTest.scan({autoScroll:false,backgrounds:false,canvases:false}));
 assert.equal(scan.items.length,1);
 await page.waitForFunction(()=>{const img=document.querySelector('.card .thumb img');return img&&img.complete&&img.naturalWidth>0;},null,{timeout:8000});
 const ui=await page.evaluate(()=>({error:!!document.querySelector('.card .image-error'),state:document.querySelector('.card-state')?.textContent||'',src:document.querySelector('.card .thumb img')?.src||''}));
 assert.ok(hits>=2,`expected retry, got ${hits} request(s)`);
 assert.equal(ui.error,false);assert.equal(ui.state,'');
 const bytes=await app.evaluate(async(_,id)=>(await global.__eiwTest.getImage(id)).buffer.length,scan.items[0].id);
 assert.equal(bytes,png.length);
 console.log(JSON.stringify({pass:true,hits,ui,bytes},null,2));
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;}).finally(async()=>{if(app)await app.close().catch(()=>{});if(server){server.closeAllConnections?.();await new Promise(r=>server.close(r));}});