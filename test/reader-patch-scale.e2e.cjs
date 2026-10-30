'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),sharp=require('sharp');
const {_electron:electron}=require('playwright-core');
const {LocalOcrBackend}=require('../src/ocr-backend.cjs');
const {createTranslationOverlay}=require('../src/translation-overlay.cjs');
(async()=>{
 const dir=path.resolve('test-results/reader-pipeline/patch-scale');fs.mkdirSync(dir,{recursive:true});
 const source=await sharp(Buffer.from('<svg width="320" height="160"><rect width="320" height="160" fill="white"/><text x="40" y="90" font-size="48" font-family="Arial" fill="black">HELLO</text></svg>')).png().toBuffer();
 const backend=new LocalOcrBackend();let patch;
 try{const result=await backend.layoutSafe(source,[{id:'text',text:'HELLO',bbox:{x0:38,y0:48,x1:202,y1:93},recognitionLines:[{text:'HELLO',bbox:{x0:38,y0:48,x1:202,y1:93}}]}],{includeSplitHints:false});patch=result.regions[0].placement.erasePatch;}finally{backend.close();}
 assert.ok(patch);fs.writeFileSync(path.join(dir,'source.png'),source);
 await sharp(source).composite([{input:Buffer.from(patch.png,'base64'),left:patch.bbox.x0,top:patch.bbox.y0}]).png().toFile(path.join(dir,'reference.png'));
 fs.writeFileSync(path.join(dir,'index.html'),'<style>body{margin:0;background:white}img{display:block}</style><img id="source" src="source.png">');
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const app=await electron.launch({args:[path.resolve('.'),'--eiw-test'],env});
 try{
  const url=require('node:url').pathToFileURL(path.join(dir,'index.html')).href,next=app.waitForEvent('window');
  await app.evaluate(async({BrowserWindow},url)=>{const w=new BrowserWindow({show:false,width:700,height:500,webPreferences:{partition:"reader-patch-test",backgroundThrottling:false}});await w.loadURL(url);},url);
  const page=await next;await page.waitForURL(url);
  await page.evaluate(`window.overlay=(${createTranslationOverlay.toString()})();`);
  const normalize=b=>Object.fromEntries(Object.entries(b).map(([k,v])=>[k,v/(k[0]==='x'?320:160)]));
  const reports=[];
  for(const scale of [.6,.8,1,1.5]){
   await page.evaluate(async({scale,patch})=>{const img=document.querySelector('img');img.src='source.png';img.style.width=320*scale+'px';await img.decode();overlay.apply({id:'test',sourceUrl:img.src,documentUrl:location.href,width:320,height:160,regions:[{id:'text',text:'',original:'HELLO',bbox:{x0:.1,y0:.2,x1:.7,y1:.7},safeBox:{x0:.1,y0:.2,x1:.7,y1:.7},eraseBox:{x0:.1,y0:.2,x1:.7,y1:.7},polygon:[],fillColor:'#ffffff',paintMode:'glyph-patch',erasePatch:patch}]});await overlay.whenReady('test');}, {scale,patch:{...patch,bbox:normalize(patch.bbox)}});
   const clip={x:0,y:0,width:320*scale,height:160*scale};const actual=await page.screenshot({clip});
   await page.evaluate(async()=>{overlay.clear();const img=document.querySelector('img');img.src='reference.png';await img.decode();});
   const expected=await page.screenshot({clip});const a=await sharp(actual).removeAlpha().raw().toBuffer(),b=await sharp(expected).removeAlpha().raw().toBuffer();
   let ghosts=0;for(let i=0;i<a.length;i+=3)if(b[i]-a[i]>25)ghosts++;
   reports.push({scale,ghostPixels:ghosts});assert.ok(ghosts<=2,JSON.stringify(reports));
  }
  fs.writeFileSync(path.join(dir,'results.json'),JSON.stringify(reports,null,2));console.log('PASS: patch matches native cleanup at 60%, 80%, 100%, 150%',reports);
 }finally{await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
