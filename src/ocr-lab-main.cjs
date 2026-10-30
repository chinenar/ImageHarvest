'use strict';
const {app,BrowserWindow,ipcMain,dialog,nativeImage,clipboard}=require('electron');
const fs=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {randomUUID,createHash}=require('node:crypto');
const {MangaOcrPool}=require('./manga-ocr.cjs');
const {EnhancedMangaOcrPool,PREPROCESSING,RECOVERY_PREPROCESSING}=require('./enhanced-manga-ocr.cjs');
const {prepareCrop,validateCrop}=require('./ocr-crop.cjs');
const {LocalOcrBackend}=require('./ocr-backend.cjs');
const {evaluateRegions}=require('./ocr-review.cjs');
const {validateRegions}=require('./ocr-translation.cjs');
const {OcrResultCache}=require('./ocr-result-cache.cjs');
const sharp=require('sharp');

function createOcrLab({parent,capture,harvest,translate,translationModels,overlay}) {
  let win=null,running=null;
  const localBackend=new LocalOcrBackend();
  const resultCache=new OcrResultCache();
  const images=new Map();
  const expected=pathToFileURL(path.join(__dirname,'ocr-lab.html')).href;
  function authorize(event) {
    if(!win||win.isDestroyed()||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame||event.senderFrame.url!==expected)throw Error('Unauthorized OCR Lab request');
  }
  function emit(data){if(win&&!win.isDestroyed())win.webContents.send('ocr-lab:progress',data);}
  async function add(buffer,name,source={type:'file'}) {
    if(buffer.length>32*1024*1024)throw Error('ภาพใหญ่เกิน 32 MB');
    const metadata=await sharp(buffer).metadata(),dimensions=metadata.autoOrient||metadata;
    if(dimensions.width*dimensions.height>40000000)throw Error('ภาพเกิน 40 ล้านพิกเซล กรุณาแบ่งภาพ');
    let image=nativeImage.createFromBuffer(buffer);
    if(image.isEmpty())image=nativeImage.createFromBuffer(await sharp(buffer).rotate().png().toBuffer());
    if(image.isEmpty())throw Error('อ่านภาพไม่ได้: '+name);
    const {width,height}=image.getSize();
    if(width*height>40000000)throw Error('ภาพเกิน 40 ล้านพิกเซล กรุณาแบ่งภาพ');
    const digest=createHash('sha256').update(buffer).digest('hex');
    const row={id:randomUUID(),name,width,height,digest,source,buffer};
    images.set(row.id,row);
    return {...row,buffer:undefined,dataUrl:image.toDataURL()};
  }
  function register(name,fn){ipcMain.handle('ocr-lab:'+name,async(event,arg)=>{authorize(event);return fn(arg||{});});}
  register('info',()=>({appVersion:app.getVersion()}));
  register('translation-models',()=>translationModels());
  register('overlay',async({id,regions,targetLanguage='th'})=>{
    if(running)throw Error('รอ OCR หรือการแปลเสร็จก่อน');
    const image=images.get(id);if(!image)throw Error('ไม่พบภาพ');
    return overlay(image,validateRegions(regions,image),{targetLanguage});
  });
  register('translate',async({id,regions,provider='google',sourceLanguage='auto',targetLanguage='th',context='',model='',includeUncertain=false})=>{
    if(running)throw Error('มี OCR หรือการแปลกำลังทำงาน');
    const image=images.get(id);if(!image)throw Error('ไม่พบภาพ');
    const source=validateRegions(regions,image);
    if(!source.length)throw Error('ไม่มีข้อความให้แปล');
    if(typeof context!=='string'||context.length>12000)throw Error('บริบทยาวเกิน 12,000 ตัวอักษร');
    const controller=new AbortController();running=controller;
    try {
      let checked=source;
      if(require('./ocr-effect-candidates.cjs').needsEffectReview(source)){
        emit({busy:true,message:'ตรวจตัวอักษรขนาดใหญ่กับพื้นผิวก่อนส่งแปล'});
        const planned=await require('./reader-quality.cjs').planReadingPage(localBackend,image.buffer,source,{signal:controller.signal});
        checked=planned.regions;
      }
      return await translate(checked,{provider,sourceLanguage,targetLanguage,context,model,includeUncertain:includeUncertain===true,imageDigest:image.digest,signal:controller.signal,
        onProgress:({done,total})=>emit({busy:true,message:`${provider==='ai'?'AI':'Google Translate'} แปล ${done}/${total} กรอบ`})});
    } finally {running=null;}
  });
  register('preview',async({id,crop,variant='original'})=>{
    const image=images.get(id);if(!image)throw Error('ไม่พบภาพ');
    if(variant==='original-recrop')variant='original';
    if(![...PREPROCESSING,...RECOVERY_PREPROCESSING].includes(variant))throw Error('วิธีปรับภาพไม่ถูกต้อง');
    validateCrop(crop,image.width,image.height);
    if(image.width*image.height*(crop.inputScale||1)**2>40000000)throw Error('ภาพ preview เกินขนาด');
    return localBackend.preview(await prepareCrop(image.buffer,crop),{variant});
  });
  register('import',async()=>{
    const result=await dialog.showOpenDialog(win,{properties:['openFile','multiSelections'],filters:[{name:'Images',extensions:['png','jpg','jpeg','webp','bmp','avif']}]});
    const rows=[];
    for(const file of result.filePaths)rows.push(await add(await fs.readFile(file),path.basename(file)));
    return rows;
  });
  register('folder',async()=>{
    const result=await dialog.showOpenDialog(win,{properties:['openDirectory']});
    if(result.canceled)return [];
    const root=result.filePaths[0],files=[];
    async function walk(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())await walk(file);else if(/\.(png|jpe?g|webp|bmp|avif)$/i.test(entry.name))files.push(file);}}
    await walk(root);files.sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
    const rows=[];for(const file of files)rows.push(await add(await fs.readFile(file),path.relative(root,file),{type:'file',filePath:file}));return rows;
  });
  register('clipboard',async()=>{const image=clipboard.readImage();if(image.isEmpty())throw Error('ไม่มีภาพใน Clipboard');return [await add(image.toPNG(),'Clipboard.png',{type:'clipboard'})];});
  register('capture',async()=>{const value=await capture();return [await add(value.buffer,'HarvestTS screenshot.png',value.source)];});
  register('harvest',async()=>{
    const rows=[];
    for(const item of await harvest()){
      const row=await add(item.buffer,item.name,item.source);
      row.regions=item.regions||[];row.rawRegions=structuredClone(row.regions);
      rows.push(row);
    }
    return rows;
  });
  register('run',async({id,mode='multi',languages=['jpn','eng','fra','tha'],bbox,imageScale=1,engine='baseline',preprocessing='auto',useCache=true})=>{
    if(running)throw Error('มี OCR กำลังทำงาน');
    const image=images.get(id);if(!image)throw Error('ไม่พบภาพ');
    const allowed=['jpn','eng','fra','tha'];
    languages=Array.isArray(languages)?languages.filter(x=>allowed.includes(x)):allowed;
    if(!languages.length)throw Error('กรุณาเลือกภาษา');
    if(!['multi','horizontal','vertical'].includes(mode))throw Error('โหมดไม่ถูกต้อง');
    if(!['baseline','enhanced'].includes(engine))throw Error('เอนจินไม่ถูกต้อง');
    if(!['auto','all'].includes(preprocessing))throw Error('การอ่านซ้ำไม่ถูกต้อง');
    imageScale=Number(imageScale);
    if(![1,2,3].includes(imageScale)||image.width*image.height*imageScale*imageScale>40000000)throw Error('ขนาดขยาย OCR เกิน 40 ล้านพิกเซล กรุณาใช้ 1×');
    let rectangle;
    if(bbox){
      const x0=Math.max(0,Math.floor(Number(bbox.x0))),y0=Math.max(0,Math.floor(Number(bbox.y0)));
      const x1=Math.min(image.width,Math.ceil(Number(bbox.x1))),y1=Math.min(image.height,Math.ceil(Number(bbox.y1)));
      if(![x0,y0,x1,y1].every(Number.isFinite)||x1<=x0||y1<=y0)throw Error('กรอบไม่ถูกต้อง');
      rectangle={left:x0,top:y0,width:x1-x0,height:y1-y0};
    }
    const cacheKey=JSON.stringify({digest:image.digest,mode,languages,rectangle,imageScale,engine,preprocessing});
    const cached=useCache?resultCache.get(cacheKey):null;
    if(cached){emit({busy:false,message:'ใช้ผล OCR เดิม • ภาพและการตั้งค่าตรงกัน'});return {...cached,originalMs:cached.ms,ms:0,cacheHit:true,createdAt:new Date().toISOString()};}
    const controller=new AbortController();running=controller;
    const Pool=engine==='enhanced'?EnhancedMangaOcrPool:MangaOcrPool;
    const pool=new Pool({langPath:path.join(__dirname,'..','assets','tessdata'),languages,concurrency:1,backend:localBackend,sourceScale:imageScale,preprocessing});
    emit({busy:true,message:'กำลัง OCR • '+image.name});
    try {
      const prepared=imageScale===1?image.buffer:await sharp(image.buffer).rotate().resize(image.width*imageScale,image.height*imageScale).png().toBuffer();
      if(rectangle)rectangle=Object.fromEntries(Object.entries(rectangle).map(([key,value])=>[key,value*imageScale]));
      const [result]=await pool.recognizePages([{filePath:prepared,width:image.width*imageScale,height:image.height*imageScale}],{mode,rectangle,signal:controller.signal,
        onRegion:({index,total,engine,phase})=>emit({busy:true,message:`${phase||(engine==='enhanced'?'อ่านและเทียบภาพ':'อ่านฐานเดิม')} • ${index}/${total} • ${image.name}`})});
      if(controller.signal.aborted)throw Error('ยกเลิก OCR');
      if(result.error)throw Error(result.error);
      const seen=new WeakSet();
      function remap(value){
        if(!value||typeof value!=='object'||seen.has(value))return;
        seen.add(value);
        for(const field of ['bbox','coreBbox','containerBBox','detectorBBox'])if(value[field]&&!seen.has(value[field])){seen.add(value[field]);for(const key of ['x0','y0','x1','y1'])value[field][key]/=imageScale;}
        if(value.rectangle&&!seen.has(value.rectangle)){seen.add(value.rectangle);for(const key of ['left','top','width','height'])value.rectangle[key]/=imageScale;}
        for(const polygon of [value.polygon,...(value.ownedPolygons||[]),...(value.excludedPolygons||[])])if(polygon&&!seen.has(polygon)){seen.add(polygon);for(const point of polygon){if(!Array.isArray(point)||seen.has(point))continue;seen.add(point);point[0]/=imageScale;point[1]/=imageScale;}}
        if(value.tiles)for(const tile of value.tiles){if(seen.has(tile))continue;seen.add(tile);for(const key of ['left','top','width','height'])tile[key]/=imageScale;}
        for(const [key,child] of Object.entries(value))if(!['bbox','coreBbox','containerBBox','detectorBBox','rectangle','polygon'].includes(key)){
          if(Array.isArray(child))child.forEach(remap);else if(child&&typeof child==='object')remap(child);
        }
      }
      if(imageScale!==1)remap(result);
      if(result.detection){result.detection.width=image.width;result.detection.height=image.height;}
      result.regions=require('./ocr-content-role.cjs').annotateContent(result.regions);
      const stored={...result,languages,mode,imageScale,preprocessing,cacheHit:false,appVersion:app.getVersion(),engine:result.engine||'comic-text-detector+tesseract.js',createdAt:new Date().toISOString(),imageDigest:image.digest};
      resultCache.set(cacheKey,stored);return stored;
    } finally {await pool.close();running=null;emit({busy:false,message:'พร้อมตรวจผล'});}
  });
  register('cancel',()=>{running?.abort();return true;});
  register('evaluate',({regions,truth,complete})=>evaluateRegions(regions,truth,{complete}));
  register('save',async({pages})=>{
    if(!Array.isArray(pages))throw Error('ไม่มีข้อมูล');
    const result=await dialog.showSaveDialog(win,{defaultPath:'ocr-review.json',filters:[{name:'OCR review project',extensions:['json']}]});
    if(result.canceled)return false;
    const stored=pages.map(p=>{
      const original=images.get(p.id);if(!original)throw Error('ไม่พบต้นฉบับ');
      return {...p,dataUrl:undefined,imageBase64:original.buffer.toString('base64'),digest:original.digest,width:original.width,height:original.height,
        metrics:evaluateRegions(p.regions,p.truth,{complete:p.complete})};
    });
    await fs.writeFile(result.filePath,JSON.stringify({schema:'imageharvest.ocr-review',version:1,savedAt:new Date().toISOString(),pages:stored},null,2));
    return result.filePath;
  });
  register('load',async()=>{
    const result=await dialog.showOpenDialog(win,{properties:['openFile'],filters:[{name:'OCR review project',extensions:['json']}]});
    if(result.canceled)return [];
    const stat=await fs.stat(result.filePaths[0]);if(stat.size>150*1024*1024)throw Error('โปรเจกต์ใหญ่เกิน 150 MB');
    const data=JSON.parse(await fs.readFile(result.filePaths[0],'utf8'));
    if(data.schema!=='imageharvest.ocr-review'||data.version!==1||!Array.isArray(data.pages))throw Error('รูปแบบโปรเจกต์ไม่รองรับ');
    const rows=[];
    for(const p of data.pages){
      const original=await add(Buffer.from(p.imageBase64,'base64'),String(p.name||'Image'),p.source);
      if(original.digest!==p.digest)throw Error('ภาพต้นฉบับไม่ตรงกับโปรเจกต์');
      const valid=rows=>Array.isArray(rows)&&rows.every(r=>typeof r.text==='string'&&r.text.length<=20000&&r.bbox&&[r.bbox.x0,r.bbox.y0,r.bbox.x1,r.bbox.y1].every(Number.isFinite)&&r.bbox.x0>=0&&r.bbox.y0>=0&&r.bbox.x1<=original.width&&r.bbox.y1<=original.height&&r.bbox.x1>r.bbox.x0&&r.bbox.y1>r.bbox.y0);
      if(!valid(p.regions)||!valid(p.truth))throw Error('กรอบในโปรเจกต์ไม่ถูกต้อง');
      rows.push({...p,regions:require('./ocr-content-role.cjs').annotateContent(p.regions),imageBase64:undefined,...original});
    }
    return rows;
  });
  return {
    async open(){
      if(win&&!win.isDestroyed()){win.show();win.focus();return true;}
      images.clear();
      win=new BrowserWindow({width:1320,height:900,minWidth:900,minHeight:600,title:'ImageHarvest • OCR Lab',backgroundColor:'#10121c',show:false,
        webPreferences:{partition:'ocr-lab-ui',preload:path.join(__dirname,'ocr-lab-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
      win.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
      win.setMenu(null);win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      win.webContents.on('will-navigate',(event)=>event.preventDefault());
      win.on('closed',()=>{running?.abort();localBackend.close();resultCache.clear();win=null;images.clear();});
      await win.loadFile(path.join(__dirname,'ocr-lab.html'));win.show();return true;
    },
    close(){running?.abort();localBackend.close();if(win&&!win.isDestroyed())win.close();},
    async addFiles(files){const rows=[];for(const file of files)rows.push(await add(await fs.readFile(file),path.basename(file)));return rows;}
  };
}
module.exports={createOcrLab};
