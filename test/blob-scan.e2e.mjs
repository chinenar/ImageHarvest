import {_electron} from 'playwright-core';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const first=await fs.readFile(path.join(root,'test/fixtures/first.png'));
const second=await fs.readFile(path.join(root,'test/fixtures/second.png'));
const server=http.createServer((req,res)=>{
  if(req.url==='/second.png'){res.setHeader('Content-Type','image/png');res.end(second);return;}
  res.setHeader('Content-Type','text/html');
  res.end(`<!doctype html><title>Revoked Blob long reader</title><style>body{margin:0}img{display:block;width:85vw;margin:auto}#a{height:18000px}#b{height:560px}</style><main><img id="a" alt="Page 1"><img id="b" alt="Page 2" src="/second.png"></main><script>
  const bytes=Uint8Array.from(atob('${first.toString('base64')}'),c=>c.charCodeAt(0));const url=URL.createObjectURL(new Blob([bytes],{type:'image/png'}));document.getElementById('a').src=url;
  addEventListener('scroll',()=>{if(scrollY>1000 && !document.documentElement.dataset.revoked){URL.revokeObjectURL(url);document.documentElement.dataset.revoked='yes';}});
  </script>`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
let app;
try{
  app=await _electron.launch(process.argv[2]?{executablePath:path.resolve(process.argv[2]),args:['--eiw-test'],env}:{args:[root,'--eiw-test'],env});
  const page=await app.firstWindow();await page.waitForFunction(()=>!!window.eiw);
  await page.selectOption('#browserMode','electron');
  await app.evaluate((_,url)=>global.__eiwTest.openPage({url,show:false}),base);
  const scan=await app.evaluate(()=>global.__eiwTest.scan({autoScroll:true,canvases:false,waitMs:350,maxSteps:20}));
  assert.equal(scan.truncated,false);assert.equal(scan.items.length,2);assert.ok(scan.steps<20);
  const state=await app.evaluate(()=>global.__eiwTest.runPage('({revoked:document.documentElement.dataset.revoked,scrollY})'));
  assert.equal(state.revoked,'yes');assert.equal(state.scrollY,0);
  const blob=scan.items.find(x=>x.url.startsWith('blob:'));assert.ok(blob);
  const raw=await app.evaluate(async(_,id)=>(await global.__eiwTest.getImage(id)).buffer.toString('hex'),blob.id);
  assert.equal(raw,first.toString('hex'));
  const temp=(await app.evaluate(()=>global.__eiwTest.getState())).canvasTempDir;
  assert.ok((await fs.readdir(temp)).length>0);
  const cleared=await page.evaluate(()=>window.eiw.clearResults());assert.equal(cleared.ok,true);
  assert.equal(await fs.stat(temp).then(()=>true,()=>false),false);
  console.log(`PASS: original blob survives URL revocation; tall reader finishes in ${scan.steps} steps; scroll restored; temp files cleaned`);
}catch(e){console.error(e);process.exitCode=1;}
finally{if(app)await app.close().catch(()=>{});server.closeAllConnections();await new Promise(r=>server.close(r));}
