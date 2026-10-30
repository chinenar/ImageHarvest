'use strict';
const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
const assert=require('node:assert/strict');
const {_electron:electron}=require('playwright-core');
const {createTranslationOverlay}=require('../src/translation-overlay.cjs');
const root=path.resolve('test-results/reader-pipeline');
async function main(){
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const app=await electron.launch({args:[path.resolve('.'),'--eiw-test'],env});
 const results=[];
 try{for(const c of JSON.parse(fs.readFileSync(path.join(root,'metrics.json')))){
  const folder=path.join(root,c.id),rows=JSON.parse(fs.readFileSync(path.join(folder,'regions.json')));
  fs.writeFileSync(path.join(folder,'layout.html'),'<meta charset="utf-8"><style>body{margin:16px;background:white}img{display:block}</style><img id="source" src="complete-flat-clean.png">');
  const url=pathToFileURL(path.join(folder,'layout.html')).href;
  const nextWindow=app.waitForEvent('window');
  await app.evaluate(async({BrowserWindow},url)=>{const w=new BrowserWindow({show:false,width:900,height:750,webPreferences:{partition:'reader-pipeline-diagnostic',backgroundThrottling:false}});await w.loadURL(url);},url);
  const page=await nextWindow;await page.waitForURL(url);
  await page.waitForFunction(()=>document.getElementById('source').complete&&document.getElementById('source').naturalWidth>0);
  await page.evaluate(`window.pipelineOverlay=(${createTranslationOverlay.toString()})();`);
  const [left,top]=c.crop;
  const normalize=b=>({x0:Math.max(0,(b.x0-left)/c.width),y0:Math.max(0,(b.y0-top)/c.height),x1:Math.min(1,(b.x1-left)/c.width),y1:Math.min(1,(b.y1-top)/c.height)});
  const regions=rows.map(r=>({id:r.id,original:r.text,text:r.translation,bbox:normalize(r.bbox),safeBox:normalize(r.placement.safeBox),eraseBox:normalize(r.bbox),polygon:[],paintMode:'glyph-patch',fillColor:r.placement.fillColor||'#ffffff',referenceLineHeight:r.placement.referenceLineHeight}));
  for(const scale of [1,.6,1.5]){
   const measurements=await page.evaluate(async({width,height,regions,scale,id,protectedArtBoxes})=>{
    const img=document.getElementById('source');img.style.width=width*scale+'px';img.style.height=height*scale+'px';
    window.pipelineOverlay.apply({id,width,height,targetLanguage:'th',sourceUrl:img.src,documentUrl:location.href,regions});
    await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    const stats=await window.pipelineOverlay.whenReady(id);
    const root=document.getElementById('__harvestts_translation_overlay__').shadowRoot;
    const boxes=[...root.querySelectorAll('.text')].map(el=>{const span=el.querySelector('span'),b=el.getBoundingClientRect(),s=span.getBoundingClientRect(),css=getComputedStyle(el),innerW=b.width-parseFloat(css.paddingLeft)-parseFloat(css.paddingRight),innerH=b.height-parseFloat(css.paddingTop)-parseFloat(css.paddingBottom);return {id:el.dataset.regionId,fontSize:Number(el.dataset.fontSize),imageFontSize:Number(el.dataset.fontSize)/scale,fitWarning:el.dataset.fitWarning==='true',overflowX:span.scrollWidth>innerW+1+1/32,overflowY:span.scrollHeight>innerH+1+1/32,box:{x0:b.left,y0:b.top,x1:b.right,y1:b.bottom},textHeight:s.height};});
    let collisions=0;for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){const a=boxes[i].box,b=boxes[j].box;if(Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0)>1/32&&Math.min(a.y1,b.y1)-Math.max(a.y0,b.y0)>1/32)collisions++;}
    const imageBox=img.getBoundingClientRect();let artCollisions=0;
    for(const item of boxes){const b=item.box;for(const [x0,y0,x1,y1] of protectedArtBoxes){const a={x0:imageBox.left+x0*scale,y0:imageBox.top+y0*scale,x1:imageBox.left+x1*scale,y1:imageBox.top+y1*scale};if(Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0)>1/32&&Math.min(a.y1,b.y1)-Math.max(a.y0,b.y0)>1/32)artCollisions++;}}
    return {scale,stats,boxes,collisions,artCollisions};
   },{width:c.width,height:c.height,regions,scale,id:c.id,protectedArtBoxes:c.protectedArtBoxes||[]});
   results.push({id:c.id,blockedInProduction:c.blockedRegions,...measurements});
   if(scale===1)await page.screenshot({path:path.join(folder,'layout-preview.png'),clip:{x:16,y:16,width:c.width,height:c.height}});
  }
  await page.close();
 }}finally{await app.close();}
 fs.writeFileSync(path.join(root,'layout-metrics.json'),JSON.stringify(results,null,2));
 if(process.argv.includes('--assert-placement'))for(const r of results){assert.equal(r.collisions,0,r.id+' text collision');assert.equal(r.artCollisions,0,r.id+' protected artwork collision');assert.equal(r.stats.fitWarnings,0,r.id+' text fit warning');assert.ok(r.boxes.every(b=>!b.overflowX&&!b.overflowY),r.id+' clipped text');}
 console.log(JSON.stringify(results.map(r=>({id:r.id,scale:r.scale,collisions:r.collisions,fonts:r.boxes.map(b=>b.fontSize),warnings:r.stats.fitWarnings})),null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
