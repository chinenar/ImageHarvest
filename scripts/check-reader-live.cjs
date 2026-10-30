'use strict';
// Complete production pipeline on two real pages; no fixed translations or forced roles.
const fs=require('node:fs'),path=require('node:path');
if(!process.versions.electron){
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const child=require('node:child_process').spawn(require('electron'),[__filename],{env,stdio:'inherit'});
 child.on('exit',code=>{process.exitCode=code??1;});
}else{
 const {app,BrowserWindow}=require('electron');
 app.setPath('userData',path.resolve('test-results/reader-pipeline/live-profile'));
 app.on('window-all-closed',()=>{});
 app.whenReady().then(async()=>{
  const {EnhancedMangaOcrPool}=require('../src/enhanced-manga-ocr.cjs');
  const {LocalOcrBackend}=require('../src/ocr-backend.cjs');
  const {planReadingPage}=require('../src/reader-quality.cjs');
  const {GoogleTranslateWebPool}=require('../src/google-translate-web.cjs');
  const {OcrTranslationService}=require('../src/ocr-translation.cjs');
  const {overlayPage,createTranslationOverlay}=require('../src/translation-overlay.cjs');
  const sharp=require('sharp'),backend=new LocalOcrBackend(),google=new GoogleTranslateWebPool({size:2});
  const pool=new EnhancedMangaOcrPool({langPath:path.resolve('assets/tessdata'),languages:['eng'],recognitionLanguage:'en',concurrency:1,backend});
  const service=new OcrTranslationService({google}),root=path.resolve('test-results/reader-pipeline/live');fs.mkdirSync(root,{recursive:true});
  const base=JSON.parse(fs.readFileSync('test-results/reader-pipeline/new-page-ocr.json')).source;
  const reports=[];
  try{for(const name of ['0003.png','0004.png']){
   const source=path.join(path.dirname(base),name),image=fs.readFileSync(source),meta=await sharp(image).metadata();
   const id=path.basename(name,'.png'),imageDigest=require('node:crypto').createHash('sha256').update(image).digest('hex');
   console.log('OCR',name);const started=Date.now();
   const cached=process.env.READER_REUSE_OCR&&fs.existsSync(path.join(root,id+'-ocr.json'));const [ocr]=cached?[JSON.parse(fs.readFileSync(path.join(root,id+'-ocr.json')))]:await pool.recognizePages([{filePath:source}]);if(ocr.error)throw Error(ocr.error);fs.writeFileSync(path.join(root,id+'-ocr.json'),JSON.stringify(ocr));
   const ocrMs=Date.now()-started;console.log('Layout',name,ocr.regions.length);
   const planned=await planReadingPage(backend,image,ocr.regions,{sourceLanguage:'en',refineText:true});
   console.log('Translation',name);
   const translation=await service.translate(planned.regions,{sourceLanguage:'en',targetLanguage:'th',imageDigest});
   const byId=new Map(translation.items.map(r=>[r.id,r]));
   const regions=planned.regions.map(r=>({...r,translation:byId.get(r.id)?.translation,translationRecord:byId.get(r.id)}));
   const page={id,width:meta.width,height:meta.height,imageDigest,ocr:{regions}};
   fs.copyFileSync(source,path.join(root,name));
   const html=path.join(root,id+'.html');fs.writeFileSync(html,'<meta charset="utf-8"><style>body{margin:0;overflow:hidden}img{display:block}</style><img id="source" src="'+name+'">');
   const url=require('node:url').pathToFileURL(html).href;page.sourceUrl=require('node:url').pathToFileURL(path.join(root,name)).href;
   const payload=overlayPage(page,{documentUrl:url,targetLanguage:'th'});
   if(name==='0004.png')for(const prefix of ['Pun (i think)',"I don't know",'A labeat']){
    const expected=regions.find(r=>r.text.startsWith(prefix));
    if(!expected||!payload.regions.some(r=>r.id===expected.id))throw Error('Reported missing text still skipped: '+prefix);
   }
   const win=new BrowserWindow({show:false,width:meta.width,height:meta.height,useContentSize:true,webPreferences:{backgroundThrottling:false}});
   await win.loadURL(url);win.setContentSize(meta.width,meta.height);await win.webContents.executeJavaScript('document.body.style.zoom='+Math.min(1,980/meta.height));
   const stats=await win.webContents.executeJavaScript(`(async()=>{const img=document.getElementById('source');await img.decode();window.overlay=(${createTranslationOverlay.toString()})();overlay.apply(${JSON.stringify(payload)});await document.fonts.ready;const stats=await overlay.whenReady(${JSON.stringify(id)});const boxes=[...document.getElementById('__harvestts_translation_overlay__').shadowRoot.querySelectorAll('.text')].map(e=>({id:e.dataset.regionId,font:e.dataset.fontSize,warning:e.dataset.fitWarning}));return {...stats,boxes};})()`);
   await new Promise(resolve=>setTimeout(resolve,250));
   fs.writeFileSync(path.join(root,id+'-translated.png'),(await win.webContents.capturePage({x:0,y:0,width:Math.ceil(meta.width*Math.min(1,980/meta.height)),height:Math.ceil(meta.height*Math.min(1,980/meta.height))})).toPNG());win.destroy();
   const summary={name,ocrReused:Boolean(cached),ocrMs,layoutMs:planned.ms,translationMs:translation.ms,ocrRegions:regions.length,translated:translation.translated,failed:translation.failed,painted:payload.regions.length,stats,regions:regions.map(r=>({id:r.id,text:r.text,translation:r.translation,paintMode:r.placement?.paintMode,cleanup:r.placement?.erasePatch?.method,review:r.placement?.cleanupReview||r.placement?.layoutReview,ownership:r.placement?.erasePatch?.ownership}))};
   reports.push(summary);fs.writeFileSync(path.join(root,id+'-result.json'),JSON.stringify({source,page,translation,summary},null,2));
   fs.writeFileSync(path.join(root,'summary.json'),JSON.stringify(reports,null,2));console.log(JSON.stringify({...summary,regions:undefined}));
  }
  fs.writeFileSync(path.join(root,'report.html'),'<meta charset="utf-8"><title>ผลทดสอบแปลทั้งหน้า</title><style>body{font:16px Tahoma;max-width:1500px;margin:30px auto}section{display:flex;gap:12px}img{width:49%;object-fit:contain;align-self:start}</style><h1>OCR → Google Translate → คลีน → ลงคำ</h1><p>ผลอัตโนมัติจริง กรอบที่ยังไม่มั่นใจคงต้นฉบับไว้ ตัวเลขกรอบไม่ใช่คะแนนความแม่นทั้งหน้า</p>'+reports.map(r=>'<h2>'+r.name+'</h2><p>'+(r.ocrReused?'รอบนี้ใช้ผล OCR ที่บันทึกไว้ แปลและจัดหน้าใหม่ · ':'')+'แปล '+r.translated+' / ลงคำ '+r.painted+' / OCR '+(r.ocrMs/1000).toFixed(1)+'s / จัดหน้าและคลีน '+(r.layoutMs/1000).toFixed(1)+'s / แปล '+(r.translationMs/1000).toFixed(1)+'s</p><section><img src="'+r.name+'"><img src="'+r.name.replace('.png','-translated.png')+'"></section>').join(''));
  if(reports.some(r=>r.failed||!r.painted||r.stats.fitWarnings))throw Error('Translation/rendering failure; inspect live summary');
 }finally{google.close();await pool.close();backend.close();}
 }).then(()=>app.exit(0)).catch(e=>{console.error(e);app.exit(1);});
}
