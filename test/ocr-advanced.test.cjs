'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const sharp=require('sharp');
const {planTiles,mergeTileObservations}=require('../src/comic-text-detector.cjs');
const {reconcileDiscovery,discoverText}=require('../src/ocr-discovery.cjs');
const {prepareCrop,validateCrop}=require('../src/ocr-crop.cjs');
const {LocalOcrBackend,runtimeRoot}=require('../src/ocr-backend.cjs');
const {PREPROCESSING,chooseReadings,EnhancedMangaOcrPool,refineBalloonGroups}=require('../src/enhanced-manga-ocr.cjs');
const {confirmedDiscoveryLines,deduplicateReadings,shouldPromoteContainerReading}=require('../src/enhanced-manga-ocr.cjs');
const ready=fs.existsSync(path.join(runtimeRoot(),'Scripts/python.exe'));

test('a long-strip proposal cannot trigger balloon analysis over an entire chapter',async()=>{
 let calls=0;
 const b={x0:100,y0:100,x1:900,y1:8900};
 const candidate={bbox:b,lines:Array.from({length:4},()=>({bbox:b}))};
 const result=await refineBalloonGroups(Buffer.alloc(0),{width:1000,height:9000,boxes:[candidate]}, {request:async()=>{calls++;}});
 assert.equal(calls,0);assert.equal(result.boxes.length,1);assert.deepEqual(result.boxes[0].bbox,b);
 assert.equal(result.boxes[0].segmentationSkipped,'large-context');assert.equal(result.boxes[0].reviewRequired,true);
});

test('display-font recovery reads the complete crop after detector fragments, preserving alternatives and review status',async()=>{
 const calls=[];
 const backend={status:async()=>({ready:true}),read:async(image,options)=>{
  calls.push(options);
  const m=await sharp(image).metadata(),text=options.recognizeOnly?'GRAAAAAH!!!':options.variant.startsWith('wide')?'GRAA':'';
  const confidence=text?(options.recognizeOnly?92:100):0;
  return {engine:'paddleocr',text,confidence,lines:text?[{text,confidence,bbox:{x0:12,y0:12,x1:m.width-12,y1:m.height-12}}]:[]};
 }};
 const image=await sharp({create:{width:800,height:400,channels:3,background:'white'}}).png().toBuffer();
 const pool=new EnhancedMangaOcrPool({backend,langPath:path.resolve(__dirname,'../assets/tessdata'),languages:['eng'],concurrency:1});
 pool.detectPage=async()=>({width:800,height:400,boxes:[{bbox:{x0:100,y0:100,x1:700,y1:300},orientation:'horizontal',displayFont:true,discoveryOnly:true,lineOnly:true,reviewRequired:true,observedBy:['glyph-components'],lines:[]}],tiles:[]});
 try{
  const [result]=await pool.recognizePages([{filePath:image}]);assert.equal(result.error,undefined);
  assert.equal(result.regions.length,1);
  const row=result.regions[0];assert.equal(row.text,'GRAAAAAH!!!');assert.equal(row.selectionReason,'display-font-recovery');assert.equal(row.reviewRequired,true);
  assert.ok(row.observedBy.includes('glyph-components'));
  assert.equal(calls.filter(c=>c.recognizeOnly).length,2);
  assert.ok(row.alternatives.some(r=>r.text==='GRAA'),'partial detector reading must remain reviewable');
  assert.ok(row.recognitionLines.every(l=>l.bbox.x0>=0&&l.bbox.x1<=800&&l.bbox.y0>=0&&l.bbox.y1<=400));
 }finally{await pool.close();}
});
test('recover an agreeing colored speech line from a broad proposal containing unreliable effects',()=>{
 const bbox={x0:241,y0:191,x1:350,y1:290},line=(text,confidence,box=bbox)=>({text,confidence,bbox:box});
 const reading=(variant,lines)=>({engine:'paddleocr',variant,textLines:lines});
 const recovered=confirmedDiscoveryLines([reading('original',[line('#',22,{x0:209,y0:49,x1:373,y1:204}),line("What's that?",94)]),reading('contrast',[line('H',30),line("What's that?",98)]),reading('grayscale',[line("What's fhat?",91)])]);
 assert.equal(recovered.length,1);assert.equal(recovered[0].text,"What's that?");assert.deepEqual(recovered[0].bbox,bbox);
 assert.equal(confirmedDiscoveryLines([reading('original',[line('FAKE',99),line('FAKE',99)])]).length,0,'duplicates from one version cannot confirm a line');
});
test('same-position CTD/Paddle duplicate dialogue keeps one reading and both observations',()=>{
 const a={text:'AH...',discoveryOnly:true,bbox:{x0:1244,y0:773,x1:1319,y1:818},orientation:'horizontal'},b={text:'AH..',bbox:{x0:1246,y0:775,x1:1308,y1:817},orientation:'horizontal'};
 const result=deduplicateReadings([a,b]);assert.equal(result.length,1);assert.equal(result[0].text,'AH...');assert.equal(result[0].duplicateObservations.length,1);assert.equal(result[0].reviewRequired,true);
 assert.equal(deduplicateReadings([a,{...b,bbox:{x0:1330,y0:775,x1:1392,y1:817}}]).length,2,'repeated adjacent speech stays separate');
 assert.equal(deduplicateReadings([a,{...b,text:'UH...'}]).length,2,'different contained readings remain reviewable');
});
test('detail scans cover normal pages in both axes, long pages, and scaled source coordinates',()=>{
 for(const [w,h]of [[1800,2400],[2400,1800],[900,16000]]){
  const tiles=planTiles(w,h,{detail:true});assert.deepEqual(tiles[0],{left:0,top:0,width:w,height:h,scanType:'full'});assert.ok(tiles.length>2);
  for(let y=0;y<h;y+=97)for(let x=0;x<w;x+=97)assert.ok(tiles.slice(1).some(t=>x>=t.left&&x<t.left+t.width&&y>=t.top&&y<t.top+t.height));
  const scaled=planTiles(w*2,h*2,{detail:true,sourceScale:2});assert.deepEqual(scaled,tiles.map(t=>({...t,left:t.left*2,top:t.top*2,width:t.width*2,height:t.height*2})));
 }
 assert.equal(planTiles(721,662,{detail:true}).length,1);
});
test('complete detail observations win at seams without joining two nearby units',()=>{
 const full={bbox:{x0:90,y0:500,x1:300,y1:550},scanType:'full',detectionConfidence:.99};
 const detail={...full,bbox:{x0:100,y0:505,x1:295,y1:547},scanType:'detail',detectionConfidence:.8};
 const clipped={...detail,bbox:{x0:100,y0:505,x1:240,y1:547},tileClipped:true};
 const near={...detail,bbox:{x0:301,y0:505,x1:410,y1:547}};
 const result=mergeTileObservations([full,clipped,detail,near]);assert.equal(result.length,2);assert.ok(result.includes(detail));assert.ok(result.includes(near));
});
test('independent Paddle discoveries retain missing lines and flag cross-balloon conflicts',()=>{
 const box=(x0,y0,x1,y1)=>({x0,y0,x1,y1});
 const ctd={boxes:[{bbox:box(10,10,100,100)},{bbox:box(110,10,200,100)}]};
 const line=(bbox,variant='original')=>({bbox,coreBbox:bbox,orientation:'horizontal',detectionConfidence:.9,variant});
 const r=reconcileDiscovery(ctd,[line(box(20,20,80,40)),line(box(40,50,175,70)),line(box(220,130,370,150)),line(box(225,155,365,175),'clahe'),line(box(221,130,371,150),'clahe')]);
 assert.equal(r.discovery.covered.length,1);assert.equal(r.discovery.conflicts.length,1);assert.equal(r.supplemental.length,1);
 assert.equal(r.supplemental[0].lines.length,2);assert.equal(r.supplemental[0].reviewRequired,true);assert.equal(r.boxes.length,3);
 assert.ok(ctd.boxes.every(b=>r.boxes.some(after=>JSON.stringify(after.bbox)===JSON.stringify(b.bbox))));
});
test('padded Paddle lines supporting small CTD glyph maps cannot create duplicate paragraphs',()=>{
 const ctd={boxes:[{bbox:{x0:324,y0:171,x1:372,y1:190},lines:[{bbox:{x0:324,y0:171,x1:372,y1:190},coreBbox:{x0:329,y0:176,x1:368,y1:186},orientation:'horizontal'}]}]};
 const r=reconcileDiscovery(ctd,[{bbox:{x0:318,y0:165,x1:379,y1:195},coreBbox:{x0:318,y0:165,x1:379,y1:195},orientation:'horizontal',detectionConfidence:.9}]);
 assert.equal(r.supplemental.length,0);assert.equal(r.discovery.covered.length,1);assert.equal(r.boxes.length,1);
});
test('preview reconstructs the exact scaled and masked recognition crop',async()=>{
 const source=path.join(__dirname,'fixtures/ocr-thai-bubble.png');
 const crop={rectangle:{left:195,top:175,width:330,height:170},width:497,border:12,inputScale:2,ownedPolygons:[[[200,180],[515,180],[510,325],[200,325]]],excludedPolygons:[[[200,180],[215,180],[215,200],[200,200]]],maskPadding:8,maskLines:[{coreBbox:{x0:210,y0:180,x1:505,y1:324}}]};
 validateCrop(crop,721,662);
 const original=await prepareCrop(source,crop);
 const scaled=await sharp(source).resize(1442,1324).png().toBuffer();
 const prepared=await prepareCrop(scaled,{...crop,rectangle:Object.fromEntries(Object.entries(crop.rectangle).map(([k,v])=>[k,v*2])),ownedPolygons:crop.ownedPolygons.map(p=>p.map(v=>v.map(n=>n*2))),excludedPolygons:crop.excludedPolygons.map(p=>p.map(v=>v.map(n=>n*2))),maskLines:crop.maskLines.map(l=>({coreBbox:Object.fromEntries(Object.entries(l.coreBbox).map(([k,v])=>[k,v*2]))}))},{prepared:true});
 assert.deepEqual(original,prepared);
 for(const invalid of [{...crop,width:Infinity},{...crop,rectangle:{left:-1,top:0,width:10,height:10}},{...crop,inputScale:5},{...crop,maskLines:[{coreBbox:{x0:0,y0:0,x1:1e9,y1:5}}]}])assert.throws(()=>validateCrop(invalid,721,662));
});
test('a unique detector container may recover clipped manga dialogue but cannot replace it with a shorter/noisy read',()=>{
 const narrow={text:'NT FOKO\nY OF YOU!!',confidence:96};
 const recovered={text:"I WONT FORGIVE\nANY OF YOU!!",confidence:76};
 assert.equal(shouldPromoteContainerReading(narrow,recovered,{coverage:.46}),true);
 assert.equal(shouldPromoteContainerReading(narrow,{text:'NOISE',confidence:99},{coverage:.46}),false);
 assert.equal(shouldPromoteContainerReading(narrow,recovered,{coverage:.9}),false);
 assert.equal(shouldPromoteContainerReading(narrow,recovered,{coverage:.46,shared:true}),false);
});
test('position-aligned reading votes work across recrops rather than comparing crop pixels',()=>{
 const a={x0:100,y0:200,x1:250,y1:220};
 const read=(text,confidence,bbox,variant)=>({text,confidence,variant,engine:'paddleocr',textLines:[{text,confidence,bbox}]});
 const chosen=chooseReadings([read('TRUE',89,a,'original'),read('TRVE',99,a,'invert'),read('TRUE',92,{x0:101,y0:199,x1:251,y1:221},'original-recrop')],{text:'TRVE',confidence:50});
 assert.equal(chosen.text,'TRUE');
});
test('supplemental Japanese artwork cannot promote Manga OCR hallucinations without supporting recognition',async()=>{
 const calls=[];
 const backend={status:async()=>({ready:true}),read:async(_image,options)=>{calls.push(options.engine);return options.engine==='manga'?{engine:'manga-ocr',text:'こんにちは。',confidence:null,lines:[]}:{engine:'paddleocr',text:'',confidence:0,lines:[]};}};
 const pool=new EnhancedMangaOcrPool({backend,langPath:path.resolve(__dirname,'../assets/tessdata'),languages:['jpn'],concurrency:1});
 pool.detectPage=async()=>({width:900,height:520,boxes:[{bbox:{x0:10,y0:400,x1:100,y1:500},orientation:'vertical',detectionConfidence:.9,lineOnly:true,discoveryOnly:true,lines:[]}],tiles:[]});
 try{const [r]=await pool.recognizePages([{filePath:path.join(__dirname,'fixtures/ocr-layout.png')}]);assert.equal(r.error,undefined);assert.equal(r.regions.length,0);assert.ok(r.rejectedRegions.some(r=>r.selectionReason==='unsupported-japanese-proposal'));assert.deepEqual(calls,['paddle'],'reject artwork before any generative recognition or retries');}finally{await pool.close();}
});
test('recognition geometry uses the actual rounded crop height for vertical mapping',async()=>{
 const backend={status:async()=>({ready:true}),read:async image=>{const m=await sharp(image).metadata(),bbox={x0:12,y0:12,x1:m.width-12,y1:m.height-12};return {engine:'paddleocr',text:'ภาษาไทย',confidence:99,lines:[{text:'ภาษาไทย',confidence:99,bbox,polygon:[[12,12],[m.width-12,12],[m.width-12,m.height-12],[12,m.height-12]]}]};}};
 const pool=new EnhancedMangaOcrPool({backend,langPath:path.resolve(__dirname,'../assets/tessdata'),languages:['tha'],concurrency:1});
 try{const [r]=await pool.recognizePages([{filePath:path.join(__dirname,'fixtures/ocr-thai-bubble.png')}],{rectangle:{left:205,top:177,width:321,height:173}});assert.equal(r.error,undefined);assert.equal(r.regions[0].recognitionLines[0].bbox.y1,362);assert.equal(r.regions[0].alternatives.find(a=>a.variant==='original').lines[0].polygon[2][1],362);}finally{await pool.close();}
});
test('independent discovery reports progress and stops between preprocessing scans',async()=>{
 const controller=new AbortController(),progress=[];
 const backend={detect:async()=>{controller.abort();return {lines:[]};}};
 await assert.rejects(discoverText(path.join(__dirname,'fixtures/ocr-layout.png'),backend,{signal:controller.signal,onScan:p=>progress.push(p)}),/ยกเลิก/);
 assert.ok(progress.some(p=>p.engine==='CTD'));assert.equal(progress.filter(p=>p.engine==='Paddle').length,1);
});
test('all preprocessing previews preserve dimensions and originals; thresholds stay binary',{skip:!ready},async()=>{
 const backend=new LocalOcrBackend(),source=await sharp(path.join(__dirname,'fixtures/ocr-thai-bubble.png')).extract({left:200,top:170,width:320,height:170}).png().toBuffer();
 try{
  const raw=await sharp(source).removeAlpha().raw().toBuffer();
  for(const variant of PREPROCESSING){const p=await backend.preview(source,{variant}),buffer=Buffer.from(p.dataUrl.split(',')[1],'base64');assert.equal(p.width,320);assert.equal(p.height,170);
   const pixels=await sharp(buffer).removeAlpha().raw().toBuffer();if(variant==='original')assert.deepEqual(pixels,raw);
   if(['adaptive','otsu'].includes(variant))assert.ok(pixels.every(v=>v===0||v===255));
  }
  await assert.rejects(backend.preview(source,{variant:'invalid'}),/Unsupported/);
 }finally{backend.close();}
});
test('colored outlined balloons split using their edges instead of a white-interior assumption',{skip:!ready},async()=>{
 const image=await sharp(Buffer.from('<svg width="540" height="240"><defs><linearGradient id="g"><stop stop-color="#849db4"/><stop offset="1" stop-color="#c58b87"/></linearGradient></defs><rect width="540" height="240" fill="white"/><ellipse cx="135" cy="120" rx="115" ry="100" stroke="black" stroke-width="4" fill="url(#g)"/><ellipse cx="405" cy="120" rx="115" ry="100" stroke="black" stroke-width="4" fill="url(#g)"/><g stroke="black" stroke-width="5"><path d="M70 85H200M75 125H195M340 85H470M345 125H465"/></g></svg>')).png().toBuffer();
 const lines=[[70,80,200,92],[75,120,195,132],[340,80,470,92],[345,120,465,132]].map(([x0,y0,x1,y1])=>({bbox:{x0,y0,x1,y1},coreBbox:{x0,y0,x1,y1}}));
 const backend=new LocalOcrBackend();try{const r=await backend.request({op:'segment',image:image.toString('base64'),lines});assert.equal(r.groups.length,2,JSON.stringify(r));assert.equal(r.surfaceMode,'edge-outline');assert.ok(r.groups.every(g=>g.length===2));}finally{backend.close();}
});
test('a continuous paragraph inside one colored ellipse is never divided into lobes',{skip:!ready},async()=>{
 const image=await sharp(Buffer.from('<svg width="420" height="330"><rect width="420" height="330" fill="white"/><ellipse cx="210" cy="165" rx="190" ry="145" fill="#a4a6bc" stroke="black" stroke-width="4"/><g stroke="black" stroke-width="4"><path d="M110 95H310M80 135H340M95 175H325M105 215H315"/></g></svg>')).png().toBuffer();
 const lines=[[110,90,310,100],[80,130,340,140],[95,170,325,180],[105,210,315,220]].map(([x0,y0,x1,y1])=>({bbox:{x0,y0,x1,y1},coreBbox:{x0,y0,x1,y1}}));
 const backend=new LocalOcrBackend();try{const r=await backend.request({op:'segment',image:image.toString('base64'),lines});assert.equal(r.groups.length,0);}finally{backend.close();}
});
