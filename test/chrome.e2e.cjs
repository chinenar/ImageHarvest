'use strict';
const { _electron } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'test-results', `chrome-${Date.now()}`);
const tests = [], hash = b => crypto.createHash('sha256').update(b).digest('hex');
const pass = name => { tests.push(name); console.log('PASS:', name); };
let app, server, page, profile;
(async () => {
  await fs.mkdir(out, { recursive: true });
  const bytes = await fs.readFile(path.join(__dirname, 'fixtures/first.png'));
  const requests = new Map(); let base;
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost'); requests.set(u.pathname, (requests.get(u.pathname)||0)+1);
    if (u.pathname === '/reader') {
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.setHeader('Set-Cookie','ih_session=owned-test; HttpOnly; SameSite=Lax; Path=/');
      res.end(`<!doctype html><title>Anti-inspect test fixture</title><style>body{margin:0}.reader-page{height:580px}canvas{display:block;width:420px;height:560px}</style>
      <main class="reading-strip"><img width="420" height="560" src="/protected.png">
      ${[1,2,3].map(i=>`<div class="reader-page"><canvas width="1" height="1" data-page="${i}" aria-label="Page ${i}"></canvas></div>`).join('')}
      <img width="420" height="560" src="/redirect.png"></main><script>
      window.__eiwCollector={poison:true}; document.documentElement.dataset.checks='0';
      setInterval(()=>{document.documentElement.dataset.checks=String(+document.documentElement.dataset.checks+1); if(outerWidth-innerWidth>160||outerHeight-innerHeight>160) location.replace('about:blank');},500);
      const io=new IntersectionObserver(es=>es.forEach(e=>{const c=e.target;if(!e.isIntersecting){c.width=c.height=1;return;}setTimeout(()=>{c.width=420;c.height=560;const x=c.getContext('2d');x.fillStyle=['#243247','#29442b','#533440'][+c.dataset.page-1];x.fillRect(0,0,420,560);},150);}),{rootMargin:'600px'});document.querySelectorAll('canvas').forEach(c=>io.observe(c));
      </script>`); return;
    }
    if (u.pathname === '/errors') { res.setHeader('Content-Type','text/html');res.end('<title>HTTP failures</title><img width="420" height="560" src="/denied.png"><img width="420" height="560" src="/large.png"><img width="420" height="560" src="/rate.png"><img width="420" height="560" src="/later.png"><img width="420" height="560" data-src="/never-requested.png">');return; }
    if (u.pathname === '/taint') { res.setHeader('Content-Type','text/html');res.end(`<title>Tainted Canvas fixture</title><canvas id="c" width="420" height="560"></canvas><script>const i=new Image();i.onload=()=>{document.getElementById('c').getContext('2d').drawImage(i,0,0);document.documentElement.dataset.ready='yes'};i.src='http://localhost:${server.address().port}/public.png';</script>`);return; }
    if (u.pathname === '/blank') { res.setHeader('Content-Type','text/html');res.end('<title>Leaving</title><script>setTimeout(()=>location.replace("about:blank"),100)</script>');return; }
    if (u.pathname === '/gate') { res.end('<title>Open in Browser</title>Open Chrome');return; }
    if (u.pathname === '/denied.png') { res.writeHead(403);res.end('Denied');return; }
    if (u.pathname === '/rate.png') { res.writeHead(429);res.end('Limited');return; }
    if (u.pathname === '/large.png') { res.writeHead(200,{'Content-Length':34*1024*1024});res.end(bytes);return; }
    if (u.pathname === '/protected.png' && (!req.headers.cookie?.includes('ih_session=owned-test')||!req.headers.referer?.startsWith(base))) {res.writeHead(403);res.end('No session');return;}
    if (u.pathname === '/redirect.png') {res.writeHead(302,{Location:'/public.png'});res.end();return;}
    res.setHeader('Content-Type','image/png');res.end(bytes);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const launch=process.argv[2]?{executablePath:path.resolve(process.argv[2]),args:['--eiw-test'],env}:{args:[root,'--eiw-test'],env};
  app=await _electron.launch(launch);page=await app.firstWindow();await page.waitForFunction(()=>!!window.eiw);
  await page.selectOption('#browserMode','chrome');await page.fill('#url',`${base}/reader`);
  await page.click('#advancedToggle');await page.fill('#waitMs','600');await page.fill('#maxSteps','50');
  await page.click('#scan');
  await page.waitForFunction(()=>!busy,null,{timeout:60000});
  const items=await page.evaluate(()=>all);assert.equal(items.filter(x=>x.source==='canvas').length,3,await page.textContent('#status'));
  pass('Chrome backend scans all three lazy Canvas pages through the actual UI');
  const info=await app.evaluate(()=>global.__eiwTest.chromeInfo());profile=info.profile;
  assert.ok(/ImageHarvest-Chrome-/.test(profile));assert.equal(info.status,200);assert.equal(info.url,`${base}/reader`);
  const dom=await app.evaluate(()=>global.__eiwTest.runPage('({checks:+document.documentElement.dataset.checks,url:location.href,ua:navigator.userAgent,node:typeof require,ipc:typeof window.eiw})'));
  assert.ok(dom.checks>=4);assert.match(dom.ua,/Chrome\//);assert.doesNotMatch(dom.ua,/Electron|Edg\//);
  assert.equal(dom.node,'undefined');assert.equal(dom.ipc,'undefined');
  pass('Real Chrome, separate profile and isolated DOM work while dimension detector keeps running');
  for(const item of items){const data=await app.evaluate(async(_,id)=>{const x=await global.__eiwTest.getImage(id);return{hex:x.buffer.toString('hex'),ext:x.ext,length:x.buffer.length};},item.id);assert.equal(data.ext,'png');assert.ok(data.length>100);if(item.source==='img')assert.equal(hash(Buffer.from(data.hex,'hex')),hash(bytes));}
  pass('Canvas PNG, authenticated images and redirects keep valid bytes');
  await app.evaluate((_,folder)=>global.__eiwTest.setOutput(folder),out);
  await page.fill('#setName','Chrome export');await page.click('#reverseOrder');
  const selected=await page.evaluate(()=>exportItems().map(x=>x.id));await page.click('#download');await page.waitForFunction(()=>!busy);
  const report=JSON.parse(await fs.readFile(path.join(out,'Chrome export/report.json'),'utf8'));
  assert.equal(report.failed,0);assert.equal(report.saved,selected.length);pass('Chrome results use existing reverse-order and export workflow');
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.show();w.focus();});
  await page.screenshot({path:path.join(out,'chrome-ui.png')});
  await app.evaluate((_,url)=>global.__eiwTest.openPage({url,backend:'chrome'}),`${base}/errors`);
  const bad=await app.evaluate(()=>global.__eiwTest.scan({autoScroll:false}));
  const failure=async suffix=>app.evaluate(async(_,id)=>{try{await global.__eiwTest.getImage(id);return '';}catch(e){return e.message;}},bad.items.find(x=>x.url.endsWith(suffix)).id);
  assert.match(await failure('/denied.png'),/403/);assert.match(await failure('/large.png'),/32 MB/);assert.match(await failure('/rate.png'),/429/);
  const before=requests.get('/later.png')||0;assert.equal(await failure('/later.png'),'');assert.equal(requests.get('/later.png')||0,before);
  assert.match(await failure('/never-requested.png'),/429/);assert.equal(requests.get('/never-requested.png')||0,0);
  pass('Chrome enforces 403/size/429 for new requests; previously captured originals remain readable without replay');
  await app.evaluate((_,url)=>global.__eiwTest.openPage({url,backend:'chrome'}),`${base}/taint`);
  let ready=false;for(let n=0;n<30;n++){ready=await app.evaluate(()=>global.__eiwTest.runPage("document.documentElement.dataset.ready==='yes'"));if(ready)break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(ready,true);
  const protection=await app.evaluate(()=>global.__eiwTest.runPage("(()=>{try{document.getElementById('c').toDataURL();return ''}catch(e){return e.name}})()"));
  assert.equal(protection,'SecurityError');
  const taint=await app.evaluate(()=>global.__eiwTest.scan({autoScroll:false,canvases:true}));assert.equal(taint.items.length,0);
  pass('CDP does not bypass the browser origin-clean restriction on tainted Canvas');
  await app.evaluate((_,url)=>global.__eiwTest.openPage({url,backend:'chrome'}),`${base}/blank`);
  await new Promise(r=>setTimeout(r,500));
  assert.equal((await app.evaluate(()=>global.__eiwTest.chromeInfo())).url,'about:blank');
  const blankResult=await page.evaluate(()=>window.eiw.scan({autoScroll:false}));assert.equal(blankResult.ok,false);
  assert.match(await page.inputValue('#url'),/\/blank$/);pass('Website about:blank navigation is not blocked or silently bypassed; source URL is retained');
  const gate=await app.evaluate((_,url)=>global.__eiwTest.openPage({url,backend:'chrome'}),`${base}/gate`);
  assert.equal(gate.gated,true);const gateResult=await page.evaluate(()=>window.eiw.scan({autoScroll:false}));assert.equal(gateResult.ok,false);
  pass('Access-gate pages are reported instead of false successful scans');
  await app.evaluate((_,url)=>global.__eiwTest.openPage({url,backend:'electron',show:false}),`${base}/reader`);
  assert.equal((await app.evaluate(()=>global.__eiwTest.getState())).browserMode,'electron');pass('Switching back to the embedded browser still works');
  await app.evaluate(()=>global.__eiwTest.closeChrome());assert.equal(await fs.stat(profile).then(()=>true,()=>false),false);
  pass('Closing app Chrome cleans up its temporary profile without touching personal profiles');
  await fs.writeFile(path.join(out,'results.json'),JSON.stringify({passed:tests.length,tests,detector:dom,devtoolsPanelRequested:false,siteScriptsModified:false,profileCleaned:true},null,2));
  console.log(`ALL ${tests.length} CHROME CHECKS PASSED. Artifacts: ${out}`);
})().catch(async e=>{console.error(e.stack||e);process.exitCode=1;await fs.writeFile(path.join(out,'failure.txt'),String(e.stack||e)).catch(()=>{});if(page)await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}).finally(async()=>{if(app)await app.close().catch(()=>{});if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}});
