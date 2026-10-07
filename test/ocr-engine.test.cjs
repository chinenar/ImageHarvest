'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {MangaOcrPool}=require('../src/manga-ocr.cjs');
const fs=require('node:fs');
const {detectText,groupLines,refineBlocks,consolidateBlocks,planTiles,mergeTileObservations}=require('../src/comic-text-detector.cjs');
const sharp=require('sharp'),os=require('node:os');
test('long-page tiles cover both ends and suppress repeats without merging neighboring regions',()=>{
 for(const [w,h]of [[900,16000],[16000,900]]){
  const tiles=planTiles(w,h);assert.ok(tiles.length>1);assert.equal(tiles[0].left,0);assert.equal(tiles[0].top,0);
  assert.equal(tiles.at(-1).left+tiles.at(-1).width,w);assert.equal(tiles.at(-1).top+tiles.at(-1).height,h);
  for(let i=1;i<tiles.length;i++)assert.ok(h>w?tiles[i].top<tiles[i-1].top+tiles[i-1].height:tiles[i].left<tiles[i-1].left+tiles[i-1].width);
 }
 const row=(bbox,tileClipped=false)=>({bbox,tileClipped,detectionConfidence:.8});
 const good=row({x0:10,y0:1000,x1:200,y1:1100});
 const rows=mergeTileObservations([row({x0:11,y0:1000,x1:198,y1:1050},true),good,row({x0:210,y0:1000,x1:300,y1:1100})]);
 assert.equal(rows.length,2);assert.ok(rows.includes(good));
});
test('line grouping keeps a spaced paragraph and retains a heading absent from the line map',()=>{
 const line=(x0,y0,x1,y1)=>({bbox:{x0,y0,x1,y1},coreBbox:{x0:x0+3,y0:y0+3,x1:x1-3,y1:y1-3},detectionConfidence:.8,orientation:'horizontal'});
 assert.equal(groupLines([line(100,603,210,623),line(90,635,230,657),line(90,669,230,690)]).length,1);
 const block={bbox:{x0:889,y0:1519,x1:1059,y1:1701},detectionConfidence:.4};
 const refined=refineBlocks([block],[line(896,1588,992,1605),line(922,1606,960,1624),line(901,1623,981,1643),line(913,1644,970,1664),line(915,1663,972,1682),line(894,1683,992,1701)]);
 assert.equal(refined.length,2);assert.equal(refined[0].uncovered,true);assert.ok(refined[0].bbox.y1<refined[1].bbox.y0);
 assert.equal(refined[0].containerId,refined[1].containerId);
});
test('overlapping block observations sharing a text line form one paragraph; distinct overlapping units stay separate',()=>{
 const line=(x0,y0,x1,y1)=>({bbox:{x0:x0-5,y0:y0-5,x1:x1+5,y1:y1+5},coreBbox:{x0,y0,x1,y1},orientation:'horizontal',detectionConfidence:.8});
 const block=(x0,y0,x1,y1)=>({bbox:{x0,y0,x1,y1},orientation:'horizontal',detectionConfidence:.7});
 const lines=[line(90,70,310,85),line(65,110,337,140),line(110,165,292,180)];
 const blocks=[block(48,62,327,156),block(86,101,308,191)];
 assert.equal(refineBlocks(blocks,lines).length,1);assert.equal(refineBlocks(blocks,lines)[0].lines.length,3);
 assert.equal(consolidateBlocks(blocks,[lines[0],lines[2]]).length,2,'rectangle overlap without a common observed line is insufficient');
 assert.equal(consolidateBlocks([block(0,0,100,100),block(90,0,190,100)],[line(92,20,98,30)]).length,2,'a narrow fragment must not join side-by-side balloons');
 const broad={...block(0,0,400,240),orientation:'vertical'},narrow={...block(50,100,180,220),orientation:'horizontal'};
 const observed=[line(60,110,170,135),line(70,160,160,180)];
 const unique=refineBlocks([broad,narrow],observed).filter(b=>!b.uncovered);
 assert.equal(unique.length,1,'one identical line group must not be repeated under two learned containers');
 assert.equal(unique[0].containerObservations.length,2);
});
test('small Thai screenshots retain all three lines as one unit across crop boundaries and 1x/2x/3x preprocessing',async()=>{
 const crops=[{left:159,top:126,width:410,height:255},{left:159,top:140,width:410,height:255},{left:165,top:140,width:410,height:255},{left:170,top:130,width:400,height:260},{left:185,top:165,width:350,height:180}];
 for(const crop of crops)for(const scale of [1,2,3]){
  const image=await sharp(path.join(__dirname,'fixtures/ocr-thai-bubble.png')).extract(crop).resize(crop.width*scale,crop.height*scale).png().toBuffer();
  const d=await detectText(image,{sourceScale:scale});
  assert.equal(d.boxes.length,1,`crop ${JSON.stringify(crop)} scale ${scale}`);
  const box=d.boxes[0];assert.equal(box.orientation,'horizontal');assert.ok(box.lines.length>=3);
  assert.ok(box.bbox.x0/scale<100&&box.bbox.x1/scale>260);assert.ok(box.bbox.y0/scale<80&&box.bbox.y1/scale>130);
 }
});
test('OCR locates repeated text at a tile overlap and the bottom of a 16000px page without duplicates',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'eiw-long-ocr-')),file=path.join(dir,'long.png');
 const fixture=fs.readFileSync(path.resolve(__dirname,'fixtures/ocr-layout.png'));
 await sharp({create:{width:900,height:16000,channels:3,background:'#fff'}}).composite([{input:fixture,left:0,top:900},{input:fixture,left:0,top:14500}]).png().toFile(file);
 const pool=new MangaOcrPool({langPath:path.resolve(__dirname,'../assets/tessdata'),concurrency:1});
 try{
  const [r]=await pool.recognizePages([{filePath:file}]);assert.equal(r.error,undefined);assert.ok(r.detection.tiles.length>1);
  const hellos=r.regions.filter(r=>r.text==='HELLO WORLD');assert.equal(hellos.length,2);
  assert.ok(hellos.some(r=>r.bbox.y0>=1000&&r.bbox.y1<1100));assert.ok(hellos.some(r=>r.bbox.y0>=14600&&r.bbox.y1<14700));
  assert.equal(r.regions.length,8,'overlapping tiles emitted repeats or lost a text unit');
 }finally{await pool.close();fs.rmSync(file);fs.rmdirSync(dir);}
});
test('real multilingual OCR separates nearby bubbles and recognizes Japanese vertical text',async()=>{
 const pool=new MangaOcrPool({langPath:path.resolve(__dirname,'../assets/tessdata'),concurrency:1});
 try {
  const [result]=await pool.recognizePages([{filePath:path.resolve(__dirname,'fixtures/ocr-layout.png'),width:900,height:520}]);
  assert.equal(result.error,undefined);
  const left=result.regions.find(r=>r.text==='HELLO WORLD'),right=result.regions.find(r=>r.text==='SECOND BUBBLE');
  assert.ok(left&&right);assert.ok(left.bbox.x1<right.bbox.x0,'adjacent balloons were merged');
  assert.ok(result.regions.some(r=>r.orientation==='vertical'&&r.text==='こんにちは\n世界です'));
  assert.ok(result.regions.some(r=>r.text==='ทดสอบข้อความ\nภาษาไทย'));
  assert.equal(result.detection.engine,'comic-text-detector');
  assert.ok(result.passes.some(p=>p.name==='detector'));
  assert.equal(result.regions.length,4,'artwork must not produce extra text regions');
 } finally {await pool.close();}
});
const sample='C:/Users/jinna/Downloads/manga test ocr/1/1 _ Chapter 2 - Itoko no Onee-chan ni Amaechau_ - MangaDex_2026-10-05T20-58-55/0001.jpg';
test('reported manga page keeps HEIN separate from POURQUOI without fragmenting captions',{skip:!fs.existsSync(sample)},async()=>{
 const pool=new MangaOcrPool({langPath:path.resolve(__dirname,'../assets/tessdata'),concurrency:1});
 try{
  const [r]=await pool.recognizePages([{filePath:sample}]);assert.equal(r.error,undefined);
  const head=r.regions.find(r=>r.text.startsWith('HEIN')),body=r.regions.find(r=>r.text.startsWith('POURQUOI'));
  assert.ok(head&&body);assert.ok(head.bbox.y1<body.bbox.y0);assert.ok(!head.text.includes('POURQUOI'));assert.equal(head.containerId,body.containerId);
  assert.ok(r.regions.some(r=>r.text.startsWith('QUAND')&&r.text.includes('TANTE')));
  assert.ok(r.regions.some(r=>r.text.startsWith('ET ELLE')&&r.text.includes('COUSINE')));
  assert.equal(r.regions.length,9,'unrelated artwork or fragmented captions appeared');
 }finally{await pool.close();}
});
