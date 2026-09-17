'use strict';
const { _electron: electron } = require('playwright-core');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..'), fixtureDir = path.join(__dirname, 'fixtures');
const testRoot = path.join(root, 'test-results', `run-${Date.now()}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hash = buf => crypto.createHash('sha256').update(buf).digest('hex');
let app, server, base;
const requests = new Map(), tests = [];
function pass(name) { tests.push(name); console.log('PASS:', name); }
(async () => {
  await fs.mkdir(testRoot, { recursive: true });
  const images = {};
  for (const name of ['first','second','third','bg','protected','blob','redirect-target','data']) images[name] = await fs.readFile(path.join(fixtureDir, `${name}.png`));
  const data = `data:image/png;base64,${images.data.toString('base64')}`;
  server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost'); requests.set(u.pathname, (requests.get(u.pathname) || 0) + 1);
    if (u.pathname === '/fixture') {
      res.setHeader('Set-Cookie', 'eiwtest=yes; HttpOnly; SameSite=Lax; Path=/');
      res.setHeader('Content-Type','text/html');
      res.end(`<!doctype html><title>Ordered test chapter</title><style>body{margin:0} .reader{width:600px} .reader>img,.reader>picture>img{display:block;width:420px;height:560px} .bg{width:430px;height:520px;background-image:url('/img/bg.png')} .hidden{display:none!important}</style>
        <main class="reader"><img alt="FIRST" src="/img/first.png"><picture><source media="(min-width:1px)" srcset="/img/second.png 1x, /img/second.png?hi=1 2x"><img src="/img/data.png"></picture>
        <img id="lazy" data-src="/img/third.png" width="460" height="580"><img src="/img/first.png"><div class="bg"></div><img src="/img/protected.png"><img id="blob" width="450" height="530"><img src="/redirect.png"><img class="hidden" src="/img/hidden.png"></main>
        <img src="${data}" width="40" height="50"><img src="${data}" width="40" height="50"><img src="/tiny.svg" width="8" height="8">
        <script>const io=new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting){setTimeout(()=>{e.target.src=e.target.dataset.src;},80);io.unobserve(e.target);}}));io.observe(document.getElementById('lazy')); fetch('/img/blob.png').then(r=>r.blob()).then(b=>document.getElementById('blob').src=URL.createObjectURL(b));</script>`);
    } else if (u.pathname === '/nested') {
      res.setHeader('Content-Type','text/html');
      res.end(`<title>Nested reader</title><div style="height:400px;width:500px;overflow:auto"><img src="/img/first.png"><img loading="lazy" src="/img/third.png"></div>`);
    } else if (u.pathname === '/errors') {
      res.setHeader('Content-Type','text/html');
      res.end('<title>Errors</title><img width="300" height="400" src="/bad.png"><img width="300" height="400" src="/large.png"><img width="300" height="400" src="/rate.png"><img width="300" height="400" src="/later.png">');
    } else if (u.pathname === '/bad.png') { res.setHeader('Content-Type','image/png'); res.end('<html>not an image</html>'); }
    else if (u.pathname === '/large.png') { res.setHeader('Content-Type','image/png'); res.setHeader('Content-Length', 34*1024*1024); res.end(images.first); }
    else if (u.pathname === '/rate.png') { res.writeHead(429,{'Retry-After':'60'}); res.end('rate limited'); }
    else if (u.pathname === '/later.png') { res.setHeader('Content-Type','image/png'); res.end(images.first); }
    else if (u.pathname === '/redirect.png') { res.writeHead(302,{Location:'/img/redirect-target.png'}); res.end(); }
    else if (u.pathname === '/tiny.svg') { res.setHeader('Content-Type','image/svg+xml'); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>'); }
    else if (u.pathname.startsWith('/img/')) {
      const name = u.pathname.split('/').pop().replace('.png','');
      if (name==='protected' && (!req.headers.cookie?.includes('eiwtest=yes') || !req.headers.referer?.startsWith(base))) { res.writeHead(403); res.end('cookie/referrer required'); return; }
      if (!images[name]) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type','image/png'); res.setHeader('Cache-Control','public,max-age=3600'); res.end(images[name]);
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); base=`http://127.0.0.1:${server.address().port}`;
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({args:[root,'--eiw-test'],env,timeout:45000});
  const page = await app.firstWindow(); await page.waitForFunction(() => !!window.eiw);
  const setting = await page.evaluate(() => window.eiw.settings()); assert.equal(setting.ok,true); pass('trusted UI IPC bridge works');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].show());
  await page.screenshot({path:path.join(testRoot,'01-home.png')});
  await page.fill('#url',`${base}/fixture`); await page.check('#backgrounds');
  await page.click('#advancedToggle'); await page.fill('#waitMs','350'); await page.fill('#maxSteps','45');
  await page.click('#scan');
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('สแกนเสร็จ'), null, {timeout:45000});
  const items = await page.evaluate(() => all);
  assert.ok(items.length >= 11, `Expected >=11 occurrences, got ${items.length}`);
  assert.ok(items.some(x=>x.url.endsWith('/img/third.png'))); assert.ok(items.some(x=>x.url.endsWith('/img/second.png')));
  assert.ok(items.some(x=>x.source==='background')); assert.ok(items.some(x=>x.url.startsWith('blob:')));
  assert.ok(!items.some(x=>x.url.includes('hidden.png'))); pass('auto-scroll, lazy loading, picture/srcset, background, blob, data and hidden-image filtering');
  const vis = await page.evaluate(()=>visibleItems());
  assert.equal(vis.length, items.length-2); pass('deduplication includes data URLs and repeated page images');
  const firstImage = await app.evaluate(async (_,{id}) => { const x=await global.__eiwTest.getImage(id); return {hex:x.buffer.toString('hex'),mime:x.mime}; },{id:items.find(x=>x.url.endsWith('/img/first.png')).id});
  assert.equal(hash(Buffer.from(firstImage.hex,'hex')),hash(images.first)); pass('image export preserves original bytes');
  const protectedImage = items.find(x=>x.url.endsWith('/img/protected.png'));
  const protectedData = await app.evaluate(async (_,{id})=>{const x=await global.__eiwTest.getImage(id);return x.buffer.length;},{id:protectedImage.id});
  assert.equal(protectedData,images.protected.length); pass('same-session cookies and referrer downloads');
  const redirect = items.find(x=>x.url.endsWith('/redirect.png'));
  assert.equal(await app.evaluate(async (_,{id})=>(await global.__eiwTest.getImage(id)).buffer.length,{id:redirect.id}),images['redirect-target'].length); pass('safe HTTP redirect handling');
  await page.click('#contentPreset');
  const content = await page.evaluate(()=>visibleItems()); assert.ok(content.every(x=>x.width>=300&&x.height>=300)); pass('minimum-dimension content filter');
  await page.locator('.card').first().locator('.card-tools button').last().click();
  assert.equal(await page.inputValue('#sort'),'manual');
  const manualOrder = await page.evaluate(()=>sequence.slice());
  await page.click('#reverseOrder');
  assert.deepEqual(await page.evaluate(()=>sequence.slice()), [...manualOrder].reverse()); pass('one-click reverse flips the collected image order');
  const chosen = await page.evaluate(()=>exportItems()); assert.notEqual(chosen[0].id,content[0].id); pass('manual order controls update export order');
  await app.evaluate((_,folder)=>global.__eiwTest.setOutput(folder),testRoot);
  await page.click('#download');
  await page.waitForFunction(()=>document.getElementById('status').textContent.startsWith('บันทึกเสร็จ'),null,{timeout:60000});
  const folders = (await fs.readdir(testRoot,{withFileTypes:true})).filter(x=>x.isDirectory());
  assert.equal(folders.length,1); const folder=path.join(testRoot,folders[0].name);
  const report=JSON.parse(await fs.readFile(path.join(folder,'report.json'),'utf8'));
  assert.equal(report.failed,0,JSON.stringify(report)); assert.equal(report.saved,chosen.length);
  assert.deepEqual(report.files.map(x=>x.source),chosen.map(x=>x.url));
  assert.ok(report.files.every((x,i)=>x.filename.startsWith(String(i+1).padStart(4,'0')))); pass('UI download writes ordered zero-padded originals and a report');
  await page.screenshot({path:path.join(testRoot,'02-collection.png'),fullPage:true});
  const run2=await app.evaluate((_,ids)=>global.__eiwTest.download({ids,name:'Second run'}),[chosen[0].id]);
  assert.notEqual(run2.folder,folder);assert.equal(run2.saved,1);pass('repeat export creates a new folder without overwriting');
  const renameDir=path.join(testRoot,'rename-fixture'); await fs.mkdir(renameDir);
  await fs.copyFile(path.join(fixtureDir,'first.png'),path.join(renameDir,'1.webp'));
  await fs.copyFile(path.join(fixtureDir,'second.png'),path.join(renameDir,'2.png'));
  await fs.copyFile(path.join(fixtureDir,'third.png'),path.join(renameDir,'10.jpg'));
  await app.evaluate((_,dir)=>global.__eiwTest.setRenameFolder(dir),renameDir);
  const renamed=await app.evaluate(()=>global.__eiwTest.renameImages({reverse:true,start:1,padding:4}));
  assert.equal(renamed.renamed,3); assert.deepEqual((await fs.readdir(renameDir)).sort(),['0001.jpg','0002.png','0003.webp']);
  assert.equal(hash(await fs.readFile(path.join(renameDir,'0001.jpg'))),hash(images.third)); pass('folder renamer uses natural order, reverse mode and collision-safe page names');
  const browserSecurity=await app.evaluate(async ({webContents})=>{const wc=webContents.fromId(global.__eiwTest.getState().browserId);return wc.executeJavaScript('({node:typeof require,bridge:typeof window.eiw})');});
  assert.deepEqual(browserSecurity,{node:'undefined',bridge:'undefined'});pass('remote web pages cannot access Node or app IPC');
  await app.evaluate((_,url)=>global.__eiwTest.openPage({url,show:false}),`${base}/nested`);
  const nested=await app.evaluate(()=>global.__eiwTest.scan({autoScroll:true,waitMs:350,maxSteps:15}));
  assert.equal(nested.items.length,2);assert.ok(nested.items[1].top>nested.items[0].top);pass('nested scroll-reader collection and order');
  const invalid=await app.evaluate(async()=>{try{await global.__eiwTest.scan({selector:'[[['});return false;}catch{return true;}});assert.equal(invalid,true);pass('invalid CSS selector reports an error and releases the job');
  const cancelled=await app.evaluate(async()=>{const task=global.__eiwTest.scan({autoScroll:true,waitMs:500,maxSteps:30});setTimeout(()=>global.__eiwTest.cancel(),650);return task;});assert.equal(cancelled.cancelled,true);pass('scan cancellation returns partial results');
  await app.evaluate((_,url)=>global.__eiwTest.openPage({url,show:false}),`${base}/errors`);
  const errors=await app.evaluate(()=>global.__eiwTest.scan({autoScroll:false}));
  const bad=errors.items.find(x=>x.url.endsWith('/bad.png')),large=errors.items.find(x=>x.url.endsWith('/large.png')),rate=errors.items.find(x=>x.url.endsWith('/rate.png')),later=errors.items.find(x=>x.url.endsWith('/later.png'));
  async function getError(id){return app.evaluate(async(_,id)=>{try{await global.__eiwTest.getImage(id);return '';}catch(e){return e.message;}},id);}
  assert.match(await getError(bad.id),/ไม่ใช่ไฟล์ภาพ/);pass('HTML masquerading as image is rejected');
  assert.match(await getError(large.id),/32 MB/);pass('oversized responses are rejected');
  assert.match(await getError(rate.id),/429/);
  const before=requests.get('/later.png')||0;assert.match(await getError(later.id),/429/);assert.equal(requests.get('/later.png')||0,before);pass('HTTP 429 stops additional downloads from the host');
  await fs.writeFile(path.join(testRoot,'results.json'),JSON.stringify({passed:tests.length,tests,requests:Object.fromEntries(requests)},null,2));
  console.log(`ALL ${tests.length} E2E CHECKS PASSED. Artifacts: ${testRoot}`);
})().catch(async error=>{
  console.error(error.stack||error);process.exitCode=1;
  await fs.mkdir(testRoot,{recursive:true}).catch(()=>{});
  await fs.writeFile(path.join(testRoot,'failure.txt'),String(error.stack||error)).catch(()=>{});
}).finally(async()=>{if(app)await app.close().catch(()=>{});if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}});
