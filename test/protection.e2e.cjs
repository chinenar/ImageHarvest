'use strict';
const {_electron}=require('playwright-core'),fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto'),root=path.resolve(__dirname,'..'),out=path.join(root,'test-results',`generic-${Date.now()}`);
const hash=b=>createHash('sha256').update(b).digest('hex'),tests=[],pass=name=>{tests.push(name);console.log('PASS:',name);};
let app,ui,server;
(async()=>{
  await fs.mkdir(out,{recursive:true});const image=await fs.readFile(path.join(__dirname,'fixtures/first.png'));
  const standalone=await fs.readFile(path.join(root,'test-results/network-audit-1789671945972/d985a728438df1b3.js'));
  const esm=await fs.readFile(path.join(root,'test-results/network-audit-1789671945972/b3e99ed40eccba32.js'));
  const requests=new Map();
  server=http.createServer((req,res)=>{
    const u=new URL(req.url,'http://localhost'),key=req.headers.host+u.pathname;requests.set(key,(requests.get(key)||0)+1);
    if(u.pathname==='/reader'){
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.end(`<!doctype html><title>Generic compatibility fixture</title><style>html{scroll-behavior:smooth}img{display:block;width:420px;height:560px}#space{height:900px}</style>
      <script src="/static/app-renamed.anything?new=build"></script><script>document.documentElement.dataset.api=DisableDevtool.version;document.documentElement.dataset.init=String(DisableDevtool({}).success);document.documentElement.dataset.running=String(DisableDevtool.isRunning);document.documentElement.dataset.styles="0";new MutationObserver(()=>{document.documentElement.dataset.styles=String(+document.documentElement.dataset.styles+1)}).observe(document.documentElement,{attributes:true,attributeFilter:['style']});</script>
      <script type="module">import state from '/arbitrary/12345';document.documentElement.dataset.esm=String(!state.isOpen);</script><script src="/ordinary.js"></script><script src="/unknown.js"></script>
      <main class="reader"><img src="/first.png"><div id="space"></div><img loading="lazy" src="/redirect.png"></main>`);return;
    }
    if(u.pathname==='/static/app-renamed.anything'){res.writeHead(200,{'Content-Type':'text/javascript'});res.end(standalone);return;}
    if(u.pathname==='/arbitrary/12345'){res.writeHead(200,{'Content-Type':'text/javascript'});res.end(esm);return;}
    if(u.pathname==='/ordinary.js'){res.writeHead(200,{'Content-Type':'text/javascript'});res.end('document.documentElement.dataset.ordinary="true";setTimeout(()=>document.documentElement.dataset.timer="true",100);');return;}
    if(u.pathname==='/unknown.js'){res.writeHead(200,{'Content-Type':'text/javascript'});res.end('window.unknownText="DevtoolsDetector";document.documentElement.dataset.unknown="true";');return;}
    if(u.pathname==='/plain'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<title>Plain fixture</title><img width="420" height="560" src="/plain.png">');return;}
    if(u.pathname==='/redirect.png'){res.writeHead(302,{Location:'/second.png'});res.end();return;}
    if(['/first.png','/second.png','/plain.png'].includes(u.pathname)){if(requests.get(key)>1){res.writeHead(403);res.end('No replay permitted');return;}res.writeHead(200,{'Content-Type':'image/png','Content-Length':image.length});res.end(image);return;}
    res.writeHead(404);res.end();
  });
  await new Promise(r=>server.listen(0,r));const port=server.address().port,env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  app=await _electron.launch(process.argv[2]?{executablePath:path.resolve(process.argv[2]),args:['--eiw-test'],env}:{args:[root,'--eiw-test'],env});
  ui=await app.firstWindow();await ui.waitForFunction(()=>!!window.eiw&&!!document.getElementById('scan'));await ui.waitForFunction(()=>document.getElementById('browserMode').value==='chrome');
  assert.equal(await ui.isChecked('#protectionCompatibility'),true);pass('fresh installation defaults to Chrome and generic automatic compatibility');
  for(const host of ['127.0.0.1','localhost']){
    await ui.fill('#url',`http://${host}:${port}/reader`);await ui.click('#open');await ui.waitForFunction(()=>!busy,null,{timeout:45000});await new Promise(r=>setTimeout(r,500));
    const before=await app.evaluate(()=>global.__eiwTest.runPage('({origin:performance.timeOrigin,styles:+document.documentElement.dataset.styles,api:document.documentElement.dataset.api,init:document.documentElement.dataset.init==="true",running:document.documentElement.dataset.running==="true",esm:document.documentElement.dataset.esm==="true",ordinary:document.documentElement.dataset.ordinary==="true",timer:document.documentElement.dataset.timer==="true",unknown:document.documentElement.dataset.unknown==="true"})'));
    assert.equal(before.api,'0.3.9');assert.equal(before.init,true);assert.equal(before.running,false);assert.equal(before.esm,true);assert.equal(before.ordinary,true);assert.equal(before.timer,true);assert.equal(before.unknown,true);
    const info=(await app.evaluate(()=>global.__eiwTest.chromeInfo())).compatibility;assert.equal(info.applied,2);assert.ok(info.unknown>=1);assert.equal(info.error,'');assert.ok(info.events.every(e=>!e.url.includes('?')));
    pass(`same libraries recognized on ${host} with arbitrary renamed paths; ordinary and unknown scripts preserved`);
    await ui.click('#scan');await ui.waitForFunction(()=>!busy,null,{timeout:60000});
    const items=await ui.evaluate(()=>all);assert.equal(items.length,2);assert.ok(items.every(i=>i.fingerprint.length===64));
    const after=await app.evaluate(()=>global.__eiwTest.runPage('({origin:performance.timeOrigin,styles:+document.documentElement.dataset.styles})'));assert.equal(after.origin,before.origin);assert.equal(after.styles,0);
    await ui.uncheck('#dedupe');await app.evaluate((_,folder)=>global.__eiwTest.setOutput(folder),out);await ui.fill('#setName',host);await ui.click('#download');await ui.waitForFunction(()=>!busy);
    const report=JSON.parse(await fs.readFile(path.join(out,host,'report.json'),'utf8'));assert.equal(report.saved,2);assert.equal(report.failed,0);
    for(const f of report.files){assert.equal(hash(await fs.readFile(path.join(out,host,f.filename))),hash(image));assert.equal(f.capturedVia,'chrome-response');}
    for(const suffix of ['/first.png','/second.png','/redirect.png'])assert.equal(requests.get(`${host}:${port}${suffix}`),1);
    pass(`ordered export on ${host}: original response bytes, redirects, no replay, no style mutations`);
    await app.evaluate(()=>global.__eiwTest.closeChrome());
    for(const item of items){const bytes=await app.evaluate(async(_,id)=>(await global.__eiwTest.getImage(id)).buffer.toString('base64'),item.id);assert.equal(hash(Buffer.from(bytes,'base64')),hash(image));}
    pass(`captured collection on ${host} survives closing its Chrome profile`);
  }
  await ui.uncheck('#protectionCompatibility');await ui.fill('#url',`http://127.0.0.1:${port}/plain`);await ui.click('#scan');await ui.waitForFunction(()=>!busy,null,{timeout:60000});
  const info=(await app.evaluate(()=>global.__eiwTest.chromeInfo())).compatibility;assert.equal(info.enabled,false);assert.equal(info.applied,0);assert.ok(info.images.saved>=1);
  assert.ok((await ui.evaluate(()=>all)).every(i=>i.fingerprint.length===64));assert.equal((await ui.evaluate(()=>window.eiw.settings())).data.protectionCompatibility,false);
  pass('turning off script compatibility preserves generic response capture and saves explicit preference');
  await fs.writeFile(path.join(out,'results.json'),JSON.stringify({passed:tests.length,tests},null,2));
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.show();w.focus();});
  await ui.screenshot({path:path.join(out,'generic-ui.png'),timeout:10000});
  console.log(`ALL ${tests.length} GENERIC CHECKS PASSED. Artifacts: ${out}`);
})().catch(async e=>{console.error(e.stack||e);process.exitCode=1;await fs.writeFile(path.join(out,'failure.txt'),String(e.stack||e)).catch(()=>{});}).finally(async()=>{if(app)await app.close().catch(()=>{});if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}});
