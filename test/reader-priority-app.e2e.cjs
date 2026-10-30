'use strict';
const { _electron: electron } = require('playwright-core');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const fixture = path.join(__dirname, 'fixtures', 'first.png');
const out = path.join(root, 'test-results', `harvest-translation-${Date.now()}`);
let app, server;
const translationRequests=[];

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await fs.mkdir(out, { recursive:true });
  const image = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect width="600" height="900" fill="white"/><ellipse cx="300" cy="200" rx="190" ry="110" fill="white" stroke="black" stroke-width="3"/><text x="300" y="185" text-anchor="middle" font-family="Arial" font-size="32">A DUEL</text><text x="300" y="225" text-anchor="middle" font-family="Arial" font-size="32">CHALLENGE!</text><ellipse cx="300" cy="600" rx="200" ry="110" fill="white" stroke="black" stroke-width="3"/><text x="300" y="585" text-anchor="middle" font-family="Arial" font-size="30">WHAT IS THE</text><text x="300" y="625" text-anchor="middle" font-family="Arial" font-size="30">MEANING OF THIS?</text></svg>')).png().toBuffer();
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if(u.pathname==='/v1/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'qwen-text-mock'}]}));return;}
    if(u.pathname==='/v1/chat/completions'){
      let raw='';req.on('data',data=>raw+=data);req.on('end',()=>{const body=JSON.parse(raw),content=String(body.messages.at(-1).content||'');let input=null;try{input=JSON.parse(content)}catch{};res.setHeader('Content-Type','application/json');if(!input?.items){res.end(JSON.stringify({choices:[{message:{content:'READY'}}]}));return;}translationRequests.push(input);res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({items:input.items.map(r=>({id:r.id,translation:'คำท้าดวล'}))})}}]}));});return;
    }
    if (u.pathname === '/chapter') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html>
        <html><head><title>Harvest translate fixture</title>
        <style>html,body{margin:0;background:#eee}main{width:620px;margin:auto}.page{display:block;width:600px;height:900px;margin:0 auto}</style>
        </head><body><main class="manga-reader">
          <img class="page" alt="PAGE 1" src="/page1.png">
          <img class="page" alt="PAGE 2" src="/page2.png">
        </main></body></html>`);
      return;
    }
    if (u.pathname === '/page1.png' || u.pathname === '/page2.png') {
      res.setHeader('Content-Type','image/png');
      res.setHeader('Cache-Control','no-store');
      res.end(image);
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({...(env.EIW_OCR_EXE?{executablePath:env.EIW_OCR_EXE}:{}),args:env.EIW_OCR_EXE?['--eiw-test']:[root, '--eiw-test'], env, timeout:45000 });
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!window.eiw);
  await app.evaluate((_electron,endpoint)=>global.__eiwTest.translationTestEndpoint(endpoint),base);

  const layout = await page.evaluate(async () => window.eiw.harvestTsLayout({
    visible:true, bounds:{ x:20, y:120, width:900, height:700 }
  }));
  assert.equal(layout.ok, true, JSON.stringify(layout));

  const created = await page.evaluate(async url => window.eiw.harvestTsCreate({ url, activate:true }), `${base}/chapter`);
  assert.equal(created.ok, true, JSON.stringify(created));

  let guestId = 0;
  for (let i = 0; i < 100 && !guestId; i++) {
    guestId = await app.evaluate(({ webContents }, prefix) => {
      const row = webContents.getAllWebContents().find(wc => (wc.getURL() || '').startsWith(prefix));
      return row?.id || 0;
    }, `${base}/chapter`);
    if (!guestId) await sleep(100);
  }
  assert.ok(guestId, 'HarvestTS BrowserView was not created');

  await app.evaluate(async ({ webContents }, id) => {
    const wc = webContents.fromId(id);
    if (!wc) throw new Error('guest webContents missing');
    if (wc.isLoading()) await new Promise(resolve => wc.once('did-stop-loading', resolve));
  }, guestId);

  const host = await app.evaluate(async ({ webContents }, id) => {
    const wc = webContents.fromId(id);
    return wc.executeJavaScript(`(() => {
      const el=document.getElementById('__harvestts_manga_translate__');
      return el ? { exists:true, position:getComputedStyle(el).position, right:el.style.right, bottom:el.style.bottom } : {exists:false};
    })()`, true);
  }, guestId);
  assert.equal(host.exists, true, 'floating Manga Translate launcher was not injected');
  assert.equal(host.position, 'fixed');

  await app.evaluate(() => {global.__readerLockTestJob=global.__eiwTest.harvestTranslationStart();global.__readerLockTestJob.catch(()=>{});return true;});
  let lockSeen=false;
  for(let n=0;n<40;n++){
    lockSeen=await app.evaluate(async({webContents},id)=>webContents.fromId(id).executeJavaScript('Boolean(window.__harvestTsReaderLock?.stats().locked)'),guestId);
    if(lockSeen)break;await sleep(50);
  }
  assert.equal(lockSeen,true,'real Harvest job must lock reader input');
  const result = await app.evaluate(() => global.__readerLockTestJob);
  const released=await app.evaluate(async({webContents},id)=>webContents.fromId(id).executeJavaScript('!window.__harvestTsReaderLock?.stats().locked && !document.getElementById("__harvestts_reader_lock__")'),guestId);
  assert.equal(released,true,'completed Harvest job must unlock the reader');
  assert.equal(result.total, 2, JSON.stringify(result));
  assert.equal(result.ready, 2, JSON.stringify(result));
  assert.equal(result.failed, 0, JSON.stringify(result));
  assert.equal(result.modelConnected, true, JSON.stringify(result));
  assert.ok(result.ocr.regions>0,'fixture must actually reach the OCR-to-translation stage');
  assert.equal(result.translation.translated,result.ocr.regions,JSON.stringify(result));
  assert.equal(result.translation.failed,0,JSON.stringify(result));
  assert.match(result.model, /qwen/i, JSON.stringify(result));

  const state = await app.evaluate(() => global.__eiwTest.harvestTranslationState());
  assert.ok(state && state.manifest, JSON.stringify(state));
  assert.equal(state.running, false);
  assert.equal(state.manifest.pages.length, 2);
  assert.ok(state.manifest.pages.every(x => x.file && !x.error), JSON.stringify(state.manifest.pages));
  assert.equal(state.manifest.translationApi.endpoint, 'http://127.0.0.1:1234');
  assert.equal(state.manifest.translationApi.connected, true);
  assert.ok(state.manifest.pages.every(p=>p.ocr.regions.every(r=>r.translation&&r.translationRecord.sourceText===r.text&&r.translationRecord.imageDigest===p.imageDigest)));
  assert.ok(translationRequests.length>0,'AI completion was never called');
  const overlay=await app.evaluate(async({webContents},id)=>webContents.fromId(id).executeJavaScript(`(() => {const host=document.getElementById('__harvestts_translation_overlay__');return {stats:window.__harvestTsTranslationOverlay.stats(),texts:[...host.shadowRoot.querySelectorAll('.text span')].map(n=>n.textContent),fonts:[...host.shadowRoot.querySelectorAll('.text')].map(n=>Number(n.dataset.fontSize))};})()`),guestId);
  assert.equal(overlay.stats.drawn,result.translation.translated);assert.ok(overlay.texts.every(t=>t==='คำท้าดวล'));assert.ok(overlay.fonts.every(f=>f>=8));
  assert.ok(state.manifest.pages.every(p=>!p.overlay.error&&p.overlay.drawn>0));

  const requestsBeforeRetry=translationRequests.length;
  const retry=await app.evaluate(()=>global.__eiwTest.harvestTranslationRetry());
  assert.equal(retry.failed,0);assert.equal(retry.translated,result.translation.translated);
  assert.equal(translationRequests.length,requestsBeforeRetry,'successful regions must not be translated again');
  const fontEdit=await app.evaluate(async({webContents},id)=>{
    const wc=webContents.fromId(id);
    await wc.executeJavaScript("(() => {const root=document.getElementById('__harvestts_translation_overlay__').shadowRoot;root.querySelector('.text').click();const slider=root.querySelector('[data-action=region-font-size]');slider.value='28';slider.dispatchEvent(new Event('input',{bubbles:true}));slider.dispatchEvent(new Event('change',{bubbles:true}));})()",true);
    for(let n=0;n<40;n++){
      const state=await wc.executeJavaScript("(() => {const root=document.getElementById('__harvestts_translation_overlay__').shadowRoot;return {status:root.querySelector('.editor-status').textContent,font:root.querySelector('.text').dataset.fontSize,manual:root.querySelector('.text').dataset.manualFont};})()");
      if(state.status.startsWith('บันทึกแล้ว')||state.status.startsWith('บันทึกไม่ได้'))return state;
      await new Promise(r=>setTimeout(r,100));
    }
    throw Error('Style save ACK missing');
  },guestId);
  assert.match(fontEdit.status,/^บันทึกแล้ว/);assert.equal(fontEdit.manual,'true');assert.equal(Number(fontEdit.font),28);
  const storagePath=await app.evaluate(({app})=>app.getPath('userData'));
  const persisted=JSON.parse(await fs.readFile(path.join(storagePath,'harvestts','region-fonts.json'),'utf8'));
  assert.ok(Object.keys(persisted.entries).length>0);
  console.log('PASS: actual isolated guest font edit -> verified main IPC -> persistent store -> ACK; cached retry makes no new provider requests');

  await page.evaluate(()=>window.eiw.ocrLabOpen());const lab=app.windows().find(p=>p.url().endsWith('/ocr-lab.html'));assert.ok(lab);await lab.waitForFunction(()=>!!window.ocrLab);
  await lab.locator('#harvest').click();await lab.waitForFunction(()=>document.querySelector('#status').textContent.includes('นำเข้า 2 ภาพแล้ว'));
  await lab.locator('#showOnWeb').click();await lab.waitForFunction(()=>document.querySelector('#status').textContent.includes('วางคำแปลบนเว็บแล้ว'));
  const labButtonStatus=await lab.locator('#status').textContent();
  const imported=await lab.evaluate(()=>window.ocrLab.harvest());assert.equal(imported.length,2);
  const placed=await lab.evaluate(p=>window.ocrLab.overlay({id:p.id,regions:p.regions,targetLanguage:'th'}),imported[0]);assert.ok(placed.drawn>0,'reviewed Harvest result must reconnect to its image');
  await app.evaluate(async({webContents},id)=>webContents.fromId(id).executeJavaScript('scrollTo(0,0)'),guestId);
  const [capture]=await lab.evaluate(()=>window.ocrLab.capture());
  const block={id:'captured-region',text:'A DUEL',translation:'คำท้าดวล',bbox:{x0:200,y0:150,x1:350,y1:230},confidence:99,reviewed:true};block.translationRecord={status:'translated',sourceText:block.text,imageDigest:capture.digest,bbox:{...block.bbox}};
  const capturedOverlay=await lab.evaluate(({p,r})=>window.ocrLab.overlay({id:p.id,regions:[r],targetLanguage:'th'}),{p:capture,r:block});assert.ok(capturedOverlay.drawn>0,'captured viewport must reconnect using its scroll origin');

  const files = await fs.readdir(state.dir);
  assert.ok(files.includes('manifest.json'));
  assert.equal(files.filter(x => /^[0-9]{4}[.]/.test(x)).length, 2, files.join(','));

  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify({ host, result, state,overlay,capturedOverlay,labButtonStatus }, null, 2));
  console.log('PASS: HarvestTS floating launcher injected');
  console.log('PASS: Start invokes Harvest scan and finds 2 manga pages');
  console.log('PASS: per-page preparation reaches ready state');
  console.log('PASS: HarvestTS OCR invokes AI completions through the shared pipeline and preserves source/image/region links (mock provider)');
  console.log('ARTIFACTS:', out);
})().catch(async error => {
  console.error(error.stack || error);
  process.exitCode = 1;
  await fs.mkdir(out, { recursive:true }).catch(() => {});
  await fs.writeFile(path.join(out, 'failure.txt'), String(error.stack || error)).catch(() => {});
}).finally(async () => {
  if (app) await app.close().catch(() => {});
  if (server) {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
});
