'use strict';
const { ChromeBrowser } = require('../src/chrome-browser.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const root=path.resolve(__dirname,'..'), out=path.join(root,'test-results',`sites-${Date.now()}`);
const hash=b=>createHash('sha256').update(b).digest('hex'), checks=[];
const pass=name=>{checks.push(name);console.log('PASS:',name)};
let browser, server;
(async()=>{
  await fs.mkdir(out,{recursive:true});
  const image=await fs.readFile(path.join(__dirname,'fixtures/first.png'));
  const requests=[];
  server=http.createServer((req,res)=>{
    requests.push(req.url);
    if(req.url==='/reader'){
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.end(`<!doctype html><title>Native response fixture</title><style>html{scroll-behavior:smooth}body{margin:0}img{display:block;width:420px;height:560px}</style><main class="reader"><img src="/one.png"><div style="height:1400px"></div><img loading="lazy" src="/two.png"></main><script>window.changes=0;new MutationObserver(()=>{window.changes++}).observe(document.documentElement,{attributes:true,attributeFilter:['style']});</script>`);return;
    }
    if(req.url==='/one.png'||req.url==='/two.png'){
      // Browser's first image request succeeds; any subsequent downloader replay fails.
      if(requests.filter(x=>x===req.url).length>1){res.writeHead(403);res.end('No replays');return;}
      res.writeHead(200,{'Content-Type':'image/png','Content-Length':image.length});res.end(image);return;
    }
    res.writeHead(404);res.end('Not found');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  browser=new ChromeBrowser();browser.site='ntrnaja';await browser.start();
  await browser.page.goto(base+'/reader');
  const profile=browser.profile, originalStyle=await browser.page.getAttribute('html','style');
  const timeOrigin=await browser.page.evaluate(()=>performance.timeOrigin);
  const scroll=await fs.readFile(path.join(root,'src/scroll.js'),'utf8');
  await browser.evaluate(`(${scroll})('init')`);
  for(let i=0;i<8;i++){await browser.evaluate(`(${scroll})('step')`);await new Promise(r=>setTimeout(r,200));}
  await browser.page.waitForFunction(()=>[...document.images].every(i=>i.complete&&i.naturalWidth>0));
  await browser.settleImages();
  for(const name of ['one.png','two.png']){
    const loaded=await browser.loadedImage(base+'/'+name);
    assert.ok(loaded,'Expected cached '+name);assert.equal(hash(loaded.buffer),hash(image));
    await fs.writeFile(path.join(out,name),loaded.buffer);
    assert.equal(requests.filter(x=>x==='/'+name).length,1);
  }
  pass('native Chrome image responses export byte-identical files with zero replay requests');
  await browser.evaluate(`(${scroll})('restore')`);
  const after=await browser.page.evaluate(()=>({changes:window.changes,origin:performance.timeOrigin,top:scrollY}));
  assert.equal(after.changes,0);assert.equal(after.origin,timeOrigin);assert.equal(after.top,0);
  assert.equal(await browser.page.getAttribute('html','style'),originalStyle);
  pass('auto-scroll and restore do not edit style or reload a smooth-scrolling page');
  await browser.page.goto(base+'/empty');await new Promise(r=>setTimeout(r,100));
  assert.equal(await browser.loadedImage(base+'/one.png'),null);
  pass('full navigation invalidates stale native-response entries');
  await browser.close();assert.equal(await fs.stat(profile).then(()=>true,()=>false),false);
  pass('native-response disk cache and temporary Chrome profile are cleaned on close');
  await fs.writeFile(path.join(out,'results.json'),JSON.stringify({passed:checks.length,checks},null,2));
  console.log(`ALL ${checks.length} SITE CHECKS PASSED. Artifacts: ${out}`);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}});
