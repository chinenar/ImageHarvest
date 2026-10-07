'use strict';
const {_electron}=require('playwright-core');
const http=require('node:http');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
let app,server;
(async()=>{
 const png=await fs.readFile(path.join(__dirname,'fixtures','first.png'));
 server=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://127.0.0.1');
  if(u.pathname.startsWith('/img/')){res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store'});res.end(png);return;}
  res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});
  res.end(`<!doctype html><style>body{margin:0}.page{display:block;width:600px;height:800px;margin:0 auto 8px}</style>
  <main data-total-pages="4">${[1,2,3,4].map(i=>`<img class="page" data-image-src="/img/${i}">`).join('')}</main>
  <script>const io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting&&!e.target.src)setTimeout(()=>e.target.src=e.target.dataset.imageSrc,60)}),{rootMargin:'220px'});document.querySelectorAll('.page').forEach(x=>io.observe(x));</script>`);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${server.address().port}/read/1`, userData=await fs.mkdtemp(path.join(os.tmpdir(),'ih-adaptive-production-'));
 async function run(){
  const env={...process.env,EIW_TEST_USER_DATA:userData};delete env.ELECTRON_RUN_AS_NODE;
  app=await _electron.launch({args:[root,'--eiw-test'],env});
  const page=await app.firstWindow();await page.waitForFunction(()=>!!window.eiw);
  await app.evaluate((_,url)=>global.__eiwTest.openPage({url,backend:'electron',show:false}),url);
  const out=await app.evaluate(()=>global.__eiwTest.scan({autoScroll:true,backgrounds:false,canvases:false,maxSteps:40,waitMs:350}));
  await app.close();app=null;return out;
 }
 const first=await run();
 assert.equal(first.items.filter(x=>x.width>=240&&x.height>=240).length,4);
 assert.equal(first.adaptive.outcome,'usable');
 assert.equal(first.adaptive.declaredTotalMatched,true);
 assert.ok(first.adaptive.attempts.some(x=>x.strategy==='lazy-attributes'));
 assert.equal(first.adaptive.strategySource,'page-observation');
 const second=await run();
 assert.equal(second.adaptive.outcome,'usable');
 assert.equal(second.adaptive.strategySource,'site-history');
 assert.equal(second.items.filter(x=>x.width>=240&&x.height>=240).length,4);
 console.log(JSON.stringify({first:{count:first.items.length,steps:first.steps,adaptive:first.adaptive},second:{count:second.items.length,steps:second.steps,adaptive:second.adaptive}},null,2));
 await fs.rm(userData,{recursive:true,force:true});
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;}).finally(async()=>{if(app)await app.close().catch(()=>{});if(server){server.closeAllConnections?.();await new Promise(r=>server.close(r));}});