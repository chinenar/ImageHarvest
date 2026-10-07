'use strict';
const { _electron: electron } = require('playwright-core');
const http = require('node:http'), fs = require('node:fs/promises'), path = require('node:path');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const root = path.resolve(__dirname,'..'), mode = process.argv.includes('--chrome') ? 'chrome' : 'electron';
const executablePath = process.argv.find(x=>x.startsWith('--exe='))?.slice(6);
const out = path.join(root,'test-results',`filter-stream-${mode}-${Date.now()}`);
const passed = [], pass = name => {passed.push(name);console.log('PASS',name);};
let instance,server,ui;
(async()=>{
 await fs.mkdir(out,{recursive:true}); const images={};
 for(const n of ['page','page2','blank','sparse','gray','wide']) images[n]=await fs.readFile(path.join(__dirname,'fixtures',`filter-${n}.png`));
 const svg=(w,h)=>`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="white"/><path d="M10 10L70 60L30 80" fill="black"/></svg>`;
 server=http.createServer((req,res)=>{
  const route=new URL(req.url,'http://fixture.test').pathname;
  if(route.endsWith('.png')) {
   const key=route.includes('dummy')?'gray':route.includes('outbound')||route.includes('support-us')?'wide':route.replace('/filter-','').replace('.png','');
   if(!images[key]){res.writeHead(404);res.end();return;}
   res.setHeader('Content-Type','image/png'); res.end(images[key]); return;
  }
  if(route.endsWith('.svg')) {res.setHeader('Content-Type','image/svg+xml');res.end(svg(route.includes('page')?600:800,800));return;}
  res.setHeader('Content-Type','text/html; charset=utf-8');
  const heading='<title>Filter regression</title><style>body{margin:0}img{display:block}button img,.payment img{width:24px;height:24px}.page{width:314px;height:auto;margin:0}a img{width:500px;height:auto}</style>';
  if(route==='/book') {res.end(heading+`<article><img src="/filter-page2.png" alt="Bonus artwork"><img src="/label_benefit-x.svg" width="32" height="32"><ul class="t-c-preview-slider__scroll"><li><img src="/filter-page.png" alt="preview"></li><li><img src="/filter-sparse.png" alt="preview"></li><li><img src="/filter-blank.png" alt="preview"></li></ul><img src="/img_loading_dummy-x.png"></article>`);return;}
  if(route==='/unknown'){res.end(heading+'<div class="payment"><img src="/visa-white-x.svg" alt="Visa"></div><div><img class="page" src="/filter-page.png" alt="Unlabelled content"></div>');return;}
  if(route!=='/all'){res.writeHead(404);res.end();return;}
  res.end(heading+`<main><button><img src="/google.svg" alt="google authen"></button><div class="payment"><img src="/visa-white-x.svg" alt="Visa"></div><a href="https://outside.invalid/offer" rel="noopener noreferrer"><img src="/outbound.png" alt="Banner 3"></a><img src="/support-us-1.png" alt="Support us"><img class="page" src="/filter-page.png" alt="Page 1"><img class="page" src="/filter-wide.png" alt="Short final strip"><img class="page" src="/page-art.svg" alt="SVG page"><img class="page" src="/filter-blank.png" alt="Page 3"><img class="page" src="/filter-sparse.png" alt="Page 4"><img id="late" class="page" src="/img_loading_dummy-x.png"><img src="/label_benefit-x.svg" width="32" height="32"></main><script>addEventListener('scroll',()=>{if(window.started)return;window.started=true;setTimeout(()=>{document.getElementById('late').src='/filter-page2.png';},500)});</script>`);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r)); const base=`http://127.0.0.1:${server.address().port}`;
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 instance=await electron.launch({...(executablePath?{executablePath,args:['--eiw-test']}:{args:[root,'--eiw-test']}),env});
 ui=await instance.firstWindow();await ui.waitForFunction(()=>!!window.eiw);await ui.waitForTimeout(300);
 const errors=[];ui.on('pageerror',e=>errors.push(e.message));
 await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('eiw://app')).show());
 await ui.selectOption('#browserMode',mode);if(mode==='chrome')await ui.selectOption('#chromeControl','minimal');
 await ui.click('#advancedToggle');await ui.fill('#waitMs','350');await ui.fill('#maxSteps','40');
 await ui.check('#hideChrome');await ui.check('#mainOnly');await ui.fill('#url',base+'/all');
 await ui.evaluate(()=>{window.audit=[];window.eiw.on(e=>{if(e.type==='scan-start'||e.type==='scan-items')window.audit.push({type:e.type,scanId:e.scanId,workspaceId:e.workspaceId,count:e.items?.length,busy});});});
 await ui.click('#scan');
 await ui.waitForFunction(()=>busy && all.length>0 && [...document.querySelectorAll('.thumb img')].some(i=>i.complete&&i.naturalWidth>0),null,{timeout:45000});
 const early=await ui.evaluate(()=>({count:all.length,busy,token:activeScanId}));assert.equal(early.busy,true);
 await ui.screenshot({path:path.join(out,'while-scanning.png')});
 pass('actual image bytes render while scan is still busy, before the final IPC result');
 await ui.waitForFunction(()=>!busy,null,{timeout:60000});
 const result=await ui.evaluate(()=>({all,visible:visibleItems(),audit:window.audit}));
 const labels=result.visible.map(x=>x.label);
 for(const n of ['filter-page.png','filter-page2.png','filter-wide.png','page-art.svg','filter-blank.png','filter-sparse.png'])assert.ok(labels.includes(n),n);
 assert.equal(labels.length,6);assert.ok(result.all.some(x=>x.filterHints.category==='ad'));assert.ok(result.all.some(x=>x.url.includes('support-us-1.png')&&x.filterHints.category==='promo'&&x.filterHints.chrome));
 pass('outbound ads, login/payment icons and placeholders hide; late, small, short and SVG content survive');
 const ids=result.all.map(x=>x.id);
 await instance.evaluate(({BrowserWindow},event)=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('eiw://app')).webContents.send('eiw:event',event),{type:'scan-items',scanId:early.token,workspaceId:'tab-1',items:[{id:'stale',label:'stale'}]});
 await ui.waitForTimeout(200);assert.deepEqual(await ui.evaluate(()=>all.map(x=>x.id)),ids);
 pass('late completed-scan chunks are ignored');
 await ui.check('#hideBlank');await ui.waitForFunction(()=>blankCandidates().length===0,null,{timeout:45000});
 const filtered=await ui.evaluate(()=>visibleItems());assert.equal(filtered.length,5);
 assert.ok(filtered.some(x=>x.label==='filter-sparse.png'));assert.ok(!filtered.some(x=>x.label==='filter-blank.png'));
 assert.equal(await ui.evaluate(()=>all.length),result.all.length);
 await ui.uncheck('#hideBlank');assert.equal(await ui.evaluate(()=>visibleItems().length),6);
 pass('optional pixel filter hides white pages without deleting records, and preserves a one-pixel mark');
 await ui.check('#hideBlank');
 await instance.evaluate((_,dir)=>global.__eiwTest.setOutput(dir),out);await ui.fill('#setName','filtered');await ui.click('#download');
 await ui.waitForFunction(()=>!busy && document.getElementById('status').textContent.startsWith('บันทึกเสร็จ'),null,{timeout:45000});
 const report=JSON.parse(await fs.readFile(path.join(out,'filtered','report.json'),'utf8'));assert.equal(report.saved,5);assert.equal(report.failed,0);
 for(const row of report.files){assert.equal(crypto.createHash('sha256').update(await fs.readFile(path.join(out,'filtered',row.filename))).digest('hex'),row.sha256);}
 pass('export follows filtered UI order and preserves exact bytes');
 await ui.fill('#url',base+'/book');await ui.uncheck('#hideBlank');await ui.click('#scan');await ui.waitForFunction(()=>!busy && all.length>0,null,{timeout:60000});
 const book=await ui.evaluate(()=>visibleItems());assert.equal(book.length,3);assert.ok(book.every(x=>x.width===157&&x.height===224));
 await ui.check('#hideBlank');await ui.waitForFunction(()=>blankCandidates().length===0);assert.equal(await ui.evaluate(()=>visibleItems().length),2);
 await ui.screenshot({path:path.join(out,'small-preview.png'),fullPage:true});
 pass('book-preview region is preferred over sales artwork; 157x224 pages stay at zero minimum size');
 await ui.click('#addTab');await ui.waitForFunction(()=>activeTabId==='tab-2');assert.equal(await ui.isChecked('#hideBlank'),false);
 await ui.click('[data-workspace-id="tab-1"]');await ui.waitForFunction(()=>activeTabId==='tab-1');assert.equal(await ui.isChecked('#hideBlank'),true);
 assert.equal(await ui.evaluate(()=>visibleItems().length),2);pass('new filter state and pixel findings survive a workspace round trip');
 await ui.fill('#url',base+'/unknown');await ui.click('#scan');await ui.waitForFunction(()=>!busy && all.length>0,null,{timeout:60000});
 assert.equal(await ui.evaluate(()=>visibleItems().length),1);assert.equal(await ui.evaluate(()=>mainScope),'unknown');
 pass('unknown layouts retain uncertain content instead of hiding the entire page');
 await ui.uncheck('#hideBlank');await ui.fill('#url',base+'/all');await ui.click('#scan');await ui.waitForFunction(()=>busy && activeScanId && all.length>0,null,{timeout:60000});
 await ui.click('#cancel');await ui.waitForFunction(()=>!busy);assert.ok(await ui.evaluate(()=>all.length>0));
 assert.equal((await instance.evaluate(()=>global.__eiwTest.getState())).count,await ui.evaluate(()=>all.length));
 pass('cancelling a streamed scan keeps partial UI and backend records in sync');
 assert.deepEqual(errors,[]);pass('no renderer errors');
 await fs.writeFile(path.join(out,'results.json'),JSON.stringify({mode,executable:executablePath||'source',passed,early},null,2));
 console.log('ALL',passed.length,'CHECKS PASSED',out);
})().catch(async e=>{console.error(e.stack||e);process.exitCode=1;await ui?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(out,'failure.txt'),e.stack||String(e)).catch(()=>{});}).finally(async()=>{
 if(instance)await instance.close().catch(()=>{});if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
});
