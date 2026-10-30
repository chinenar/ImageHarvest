'use strict';
const {_electron:electron}=require('playwright-core'),assert=require('node:assert/strict'),path=require('node:path');
const {createTranslationOverlay}=require('../src/translation-overlay.cjs');
(async()=>{
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const app=await electron.launch({args:[path.resolve('.'),'--eiw-test'],env});
 try{
  const next=app.waitForEvent('window');
  await app.evaluate(async({BrowserWindow})=>{const w=new BrowserWindow({show:false,width:1100,height:800,webPreferences:{backgroundThrottling:false,partition:'font-scale-test'}});await w.loadURL('about:blank');});
  const page=await next;
  await page.setContent('<style>body{margin:0}img{display:block}</style><img id="source" width="600" height="300">');
  await page.evaluate(()=>{const c=document.createElement('canvas');c.width=600;c.height=300;const ctx=c.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,600,300);document.querySelector('img').src=c.toDataURL();});
  await page.waitForFunction(()=>document.querySelector('img').naturalWidth===600);
  await page.evaluate(`window.overlay=(${createTranslationOverlay.toString()})();`);
  const measurements=[];
  for(const scale of [1,.6,1.5])measurements.push(await page.evaluate(async scale=>{
   const img=document.querySelector('img');img.style.width=600*scale+'px';img.style.height=300*scale+'px';
   const boxes=[{x0:.05,y0:.05,x1:.45,y1:.9},{x0:.55,y0:.05,x1:.95,y1:.9}];
   overlay.apply({id:'test',sourceUrl:img.src,documentUrl:location.href,width:600,height:300,targetLanguage:'th',regions:boxes.map((b,i)=>({id:String(i),text:i?'ทดสอบการวางข้อความภาษาไทยหลายบรรทัด ให้ขนาดสัมพันธ์กับภาพเมื่อย่อและขยาย':'...เอาล่ะ',original:'source',bbox:b,safeBox:b,eraseBox:b,polygon:[],paintMode:'glyph-patch',fillColor:'#ffffff',referenceLineHeight:30}))});
   await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));await overlay.whenReady('test');
   return [...document.getElementById('__harvestts_translation_overlay__').shadowRoot.querySelectorAll('.text')].map(el=>({size:Number(el.dataset.fontSize)/scale,warning:el.dataset.fitWarning}));
  },scale));
  for(const m of measurements)for(let i=0;i<m.length;i++){assert.ok(Math.abs(m[i].size-measurements[0][i].size)<.4,JSON.stringify(measurements));assert.equal(m[i].warning,'false');}
  const manual=await page.evaluate(async()=>{overlay.setRegionStyle('test','0',{fontSizeImagePx:22});await overlay.whenReady('test');return Number(document.getElementById('__harvestts_translation_overlay__').shadowRoot.querySelector('.text').dataset.fontSize);});
  assert.equal(manual,33);
  const word=await page.evaluate(async()=>{
   const img=document.querySelector('img');img.style.width='600px';img.style.height='300px';
   const b={x0:.1,y0:.05,x1:.24,y1:.9};
   overlay.clear();overlay.apply({id:'words',sourceUrl:img.src,documentUrl:location.href,width:600,height:300,targetLanguage:'th',regions:[{id:'thai',text:'เห็นชุดเมดนั่นไหม? ดูบรรยากาศบ้างสิ',original:'source',bbox:b,safeBox:b,eraseBox:b,polygon:[],paintMode:'glyph-patch',fillColor:'#ffffff',referenceLineHeight:40}]});
   await overlay.whenReady('words');
   const span=document.getElementById('__harvestts_translation_overlay__').shadowRoot.querySelector('.text span'),start=span.textContent.indexOf('บรรยากาศ'),range=document.createRange();
   range.setStart(span.firstChild,start);range.setEnd(span.firstChild,start+'บรรยากาศ'.length);
   return {lines:new Set([...range.getClientRects()].map(r=>Math.round(r.top))).size,warning:span.parentElement.dataset.fitWarning};
  });
  assert.equal(word.lines,1,'Thai word must not split across lines');assert.equal(word.warning,'false');
  for(const angle of [68,-90])for(const scale of [.6,1,1.5]){
   const result=await page.evaluate(async({angle,scale})=>{
    overlay.clear();const img=document.querySelector('img');img.style.width=600*scale+'px';img.style.height=300*scale+'px';const b={x0:.25,y0:.1,x1:.75,y1:.9};
    overlay.apply({id:'slanted',sourceUrl:img.src,documentUrl:location.href,width:600,height:300,targetLanguage:'th',regions:[{id:'note',text:'ไม่รู้สิ',original:'I do not know',bbox:b,safeBox:b,eraseBox:b,polygon:[],paintMode:'glyph-patch',fillColor:'#fff',referenceLineHeight:30,rotatedTextBox:{cx:300,cy:150,width:220,height:30,angle}}]});
    await overlay.whenReady('slanted');const el=document.getElementById('__harvestts_translation_overlay__').shadowRoot.querySelector('.text'),m=new DOMMatrix(getComputedStyle(el).transform);return {angle:Math.atan2(m.b,m.a)*180/Math.PI,width:parseFloat(el.style.width),warning:el.dataset.fitWarning};
   },{angle,scale});assert.ok(Math.abs(result.angle-angle)<.01);assert.ok(Math.abs(result.width-220*scale)<.1);assert.equal(result.warning,'false');
  }
  console.log('PASS: Thai words remain whole; automatic font scale is stable at 60%, 100%, 150%; manual size remains in image pixels.');
 }finally{await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
