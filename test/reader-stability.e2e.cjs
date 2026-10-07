'use strict';
const {chromium}=require('playwright-core');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {overlayPage,createTranslationOverlay}=require('../src/translation-overlay.cjs');
const {readerDocumentKey}=require('../src/reader-document.cjs');
const {createReaderInteractionLock}=require('../src/reader-interaction-lock.cjs');
const origin='http://mangadex.org',chapter=origin+'/chapter/dc9ef328-5b11-4f93-8322-1b9b077441ab';
const output=path.resolve(__dirname,'../test-results/reader-stability');
let browser;
(async()=>{
 await fs.mkdir(output,{recursive:true});
 browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
 const page=await browser.newPage({viewport:{width:1000,height:760}});
 await page.route('**/*',async route=>{
  const p=new URL(route.request().url()).pathname;
  if(p.endsWith('.svg'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect width="600" height="900" fill="white"/><ellipse cx="300" cy="200" rx="150" ry="110" fill="white" stroke="black"/><text x="200" y="200" font-size="28">ORIGINAL</text></svg>'});
  if(p==='/style.css')return route.fulfill({contentType:'text/css',body:'body{margin:0;background:#242424}img{display:block;width:60vw;height:auto;margin:auto}footer{height:1200px}'});
  return route.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':"default-src 'none'; img-src 'self' blob:; style-src 'self'; script-src 'none'"},body:'<link rel="stylesheet" href="/style.css"><img id="p1" src="/one.svg"><img id="p2" src="/two.svg"><footer></footer>'});
 });
 await page.goto(chapter+'/1');
 const make=i=>{const b={x0:180,y0:120,x1:420,y1:270};return overlayPage({id:'page-'+i,source:'img',sourceUrl:origin+(i===1?'/one.svg':'/two.svg'),width:600,height:900,imageDigest:'image-'+i,ocr:{regions:[{id:'r-'+i,text:'ORIGINAL',translation:'ทดสอบคำแปลหน้า '+i,bbox:b,confidence:99,placement:{surfaceType:'bubble',confidence:.99,eraseBox:b,safeBox:b,polygon:[[180,120],[420,120],[420,270],[180,270]],fillColor:'#ffffff'},translationRecord:{status:'translated',sourceText:'ORIGINAL',bbox:b,imageDigest:'image-'+i}}]}},{documentUrl:chapter+'/1'});};
 const payloads=[make(1),make(2)];
 await page.evaluate(`(()=>{window.overlay=(${createTranslationOverlay.toString()})(${readerDocumentKey.toString()});window.lock=(${createReaderInteractionLock.toString()})(${readerDocumentKey.toString()});return true;})()`);
 for(const payload of payloads)await page.evaluate(p=>window.overlay.apply(p),payload);
 const read=()=>page.evaluate(()=>{
  const root=document.getElementById('__harvestts_translation_overlay__').shadowRoot;
  const text=root.querySelector('.text'),image=document.querySelector('#p1');
  return {stats:overlay.stats(),text:text?.getBoundingClientRect().toJSON(),image:image?.getBoundingClientRect().toJSON(),y:scrollY};
 });
 const initial=await read();assert.equal(initial.stats.drawn,2);
 await page.evaluate(()=>{scrollTo({top:1000,behavior:'instant'});history.replaceState({},'',location.pathname.replace(/\/1$/,'/2'));});
 await page.waitForTimeout(900);
 let state=await read();assert.equal(state.stats.drawn,2,'page-number URL update must not clear the chapter');
 assert.ok(Math.abs(initial.text.y-state.text.y-1000)<1,'text must move with its image');
 await page.evaluate(()=>scrollTo(0,0));await page.waitForTimeout(150);state=await read();assert.equal(state.stats.drawn,2);
 await page.setViewportSize({width:750,height:700});await page.waitForTimeout(150);state=await read();
 assert.ok(Math.abs(state.text.x-(state.image.x+state.image.width*.3))<1,'resized text remains image-relative');
 // Reader virtualization removes/remounts the DOM node; retain results, not detached elements.
 await page.evaluate(()=>{window.savedImage=document.querySelector('#p1');savedImage.remove();});await page.waitForTimeout(100);
 assert.equal((await read()).stats.total,2);assert.equal((await read()).stats.drawn,1);
 await page.evaluate(()=>document.body.prepend(savedImage));await page.waitForTimeout(150);assert.equal((await read()).stats.drawn,2);
 // Actual user input is blocked during work, while scanner-controlled scroll is allowed.
 await page.evaluate(()=>{scrollTo(0,0);lock.acquire('job-A');});
 await page.mouse.move(380,380);await page.mouse.wheel(0,550);await page.keyboard.press('PageDown');await page.waitForTimeout(100);
 assert.equal(await page.evaluate(()=>scrollY),0,'wheel and keyboard must not move the locked page');
 await page.evaluate(()=>scrollTo({top:400,behavior:'instant'}));await page.waitForTimeout(100);
 assert.equal(await page.evaluate(()=>scrollY),400,'scanner may scroll while collecting pages');
 await page.evaluate(()=>lock.freeze('job-A'));
 await page.evaluate(()=>scrollTo({top:800,behavior:'instant'}));await page.waitForTimeout(150);
 assert.equal(await page.evaluate(()=>scrollY),400,'post-scan lock rejects scrollbar/programmatic drift');
 assert.equal(await page.evaluate(()=>lock.release('stale-job')),false,'old finally must not unlock a newer job');
 let cancelled=false;
 await page.exposeFunction('recordCancel',()=>{cancelled=true;});
 await page.evaluate(()=>document.addEventListener('__harvestts_reader_cancel',e=>{recordCancel();lock.release(e.detail.jobId);},{once:true}));
 await page.locator('#__harvestts_reader_lock__ button').click();assert.equal(cancelled,true);
 assert.equal(await page.evaluate(()=>lock.stats().locked),false);
 await page.mouse.move(380,380);await page.mouse.wheel(0,250);await page.waitForTimeout(250);
 assert.ok(await page.evaluate(()=>scrollY>400),'scrolling is restored after cancellation');
 assert.equal((await read()).stats.drawn,2,'unlocked scrolling keeps the overlay');
 // Other application UI can still scroll, even when the reader itself is locked.
 await page.evaluate(()=>{const tool=document.createElement('div');tool.id='__harvestts_manga_translate__';tool.style.cssText='position:fixed;right:20px;bottom:20px;width:180px;height:120px;overflow:auto;overscroll-behavior:contain;z-index:2147483646;background:white';const content=document.createElement('div');content.style.height='700px';content.textContent='APP TOOL';tool.append(content);document.documentElement.append(tool);lock.acquire('job-B');lock.freeze('job-B');});
 const beforeTool=await page.evaluate(()=>scrollY);
 await page.mouse.move(660,650);await page.mouse.wheel(0,200);await page.waitForTimeout(200);
 assert.ok(await page.evaluate(()=>document.getElementById('__harvestts_manga_translate__').scrollTop>0),'tool panel remains usable');
 assert.equal(await page.evaluate(()=>scrollY),beforeTool,'tool wheel cannot scroll the reader');
 await page.evaluate(()=>lock.release('job-B'));
 // Failed work follows the same token-safe release path.
 await page.evaluate(()=>{lock.acquire('job-error');try{throw Error('fixture');}catch{}finally{lock.release('job-error');}});
 assert.equal(await page.evaluate(()=>lock.stats().locked),false);
 await page.evaluate(()=>{document.getElementById('__harvestts_manga_translate__').remove();scrollTo(0,0);});await page.waitForTimeout(150);
 await page.screenshot({path:path.join(output,'unlocked-translated.png')});
 // Same-chapter lazy remount is allowed, but a truly different chapter clears all old text.
 await page.evaluate(()=>history.pushState({},'',location.pathname.replace('dc9ef328','ab9ef328')));await page.waitForTimeout(900);
 assert.equal((await page.evaluate(()=>overlay.stats())).total,0,'different chapter must clear stale content');
 await fs.writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,initial,afterSameChapter:state,checks:['chapter-position','scroll','resize','virtualized-remount','lock-wheel-keyboard','scan-scroll','freeze','cancel','tool-panel','error-unlock','chapter-change']},null,2));
 console.log('PASS: same-chapter URL, scrolling, resize, virtualization, input lock, scan scrolling, freeze, cancel, error unlock, tool panel, and different-chapter clearing');
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;}).finally(async()=>{await browser?.close();});
