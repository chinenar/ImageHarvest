'use strict';
const { chromium } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const source = await fs.readFile(path.join(__dirname, '../src/harvest-guest-preload.cjs'), 'utf8');
  const launcherCode = source.slice(source.indexOf('function ensureTranslationLauncher()'), source.indexOf('function handleTranslationProgress('));
  const browser = await chromium.launch({ executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless:true });
  try {
    const page = await browser.newPage();
    await page.setContent('<style>body{margin:0;background:#181921;color:white;font:16px sans-serif}main{height:100vh;display:grid;place-content:center}</style><main>HarvestTS</main>');
    await page.evaluate(`(() => {` + launcherCode + `
      let translationHost, translationShadow, launcherMenuOpen=false, translateSymbolDataUrl='';
      let translateSettings={engine:'ai',sourceLanguage:'auto',targetLanguage:'th',contentType:'manga',fontScale:1};
      let screenLensState={},translationPages=[],translationModelText='',translationScanProgress=0,translationRunning=false;
      const ipcRenderer={invoke:async()=>null};
      ensureTranslationLauncher();
      window.launcherTest={host:translationHost,shadow:translationShadow};
    })()`);
    const geometry = () => page.evaluate(() => {
      const {host,shadow} = launcherTest;
      const rect = el => { const r=el.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}; };
      return {host:rect(host),buttons:[...shadow.querySelectorAll('.toolbtn')].map(rect)};
    });
    const toggle = () => page.evaluate(() => {
      const button=launcherTest.shadow.querySelector('.launcher');
      button.dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:1}));
      button.dispatchEvent(new PointerEvent('pointerup',{button:0,pointerId:1}));
      launcherTest.shadow.querySelector('.quickmenu').classList.remove('opening');
    });
    for (const [width,height] of [[1124,765],[900,700],[390,844],[320,480],[640,280]]) {
      await page.setViewportSize({width,height});
      await page.waitForTimeout(50);
      for(const [x,y] of [[0,0],[.5,0],[1,0],[0,.5],[.5,.5],[1,.5],[0,1],[.5,1],[1,1]]) {
        await page.evaluate(({x,y})=>{
          const {host}=launcherTest, r=host.getBoundingClientRect();
          Object.assign(host.style,{left:(8+x*(innerWidth-r.width-16))+'px',top:(8+y*(innerHeight-r.height-16))+'px',right:'auto',bottom:'auto'});
        },{x,y});
        const before=(await geometry()).host;
        await toggle();
        const result=await geometry();
        assert.deepEqual(result.host,before,'opening must keep the launcher in place');
        const all=[result.host,...result.buttons];
        for(const r of all) assert.ok(r.x>=7.5&&r.y>=7.5&&r.x+r.w<=width-7.5&&r.y+r.h<=height-7.5,JSON.stringify({width,height,x,y,r}));
        for(let a=0;a<all.length;a++) for(let b=a+1;b<all.length;b++) {
          const p=all[a],q=all[b];
          assert.ok(Math.hypot(p.x+p.w/2-q.x-q.w/2,p.y+p.h/2-q.y-q.h/2)>=(p.w+q.w)/2+3,'circular buttons must have a visible gap');
        }
        if(width===1124&&x===0&&y===1){
          const dir=path.resolve(__dirname,'../test-results/launcher-layout');await fs.mkdir(dir,{recursive:true});
          await page.screenshot({path:path.join(dir,'bottom-left.png')});
        }
        await toggle();
      }
    }
    // Exercise actual dragging and preserve the relative position across a resize round trip.
    await page.setViewportSize({width:900,height:700});
    await page.waitForTimeout(50);
    await page.evaluate(()=>Object.assign(launcherTest.host.style,{left:'600px',top:'450px'}));
    await page.mouse.move(627,477);await page.mouse.down();await page.mouse.move(327,277,{steps:5});await page.mouse.up();
    const before=(await geometry()).host;
    await toggle();
    await page.setViewportSize({width:390,height:480});await page.waitForTimeout(50);
    const small=await geometry();assert.ok(small.host.w<before.w,'launcher should scale with viewport');
    for(const r of small.buttons) assert.ok(r.x>=7.5&&r.y>=7.5&&r.x+r.w<=382.5&&r.y+r.h<=472.5,'open menu should reflow on resize');
    await page.setViewportSize({width:900,height:700});await page.waitForTimeout(50);
    const restored=(await geometry()).host;
    assert.ok(Math.abs(before.x-restored.x)<1&&Math.abs(before.y-restored.y)<1,'dragged anchor must survive resize round trip');
    await page.evaluate(()=>launcherTest.shadow.querySelector('.settings-tool').click());
    const panel=await page.evaluate(()=>{const p=launcherTest.shadow.querySelector('.settings-panel'),r=p.getBoundingClientRect();return {hidden:p.hidden,x:r.x,y:r.y,right:r.right,bottom:r.bottom};});
    assert.equal(panel.hidden,false);assert.ok(panel.x>=8&&panel.y>=8&&panel.right<=892&&panel.bottom<=692);
    console.log('PASS: 45 fan layouts, viewport scaling, no launcher jump, no overlap, drag/resize round trip and settings panel');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
