'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {LocalOcrBackend,runtimeRoot}=require('../src/ocr-backend.cjs');
const {EnhancedMangaOcrPool,postprocessReading,chooseReadings,refineBalloonGroups}=require('../src/enhanced-manga-ocr.cjs');
const {detectText}=require('../src/comic-text-detector.cjs');
const sharp=require('sharp');
const ready=fs.existsSync(path.join(runtimeRoot(),'Scripts/python.exe'));
test('GPU memory exhaustion replays the same request once on CPU without hiding other errors',{skip:!ready},()=>{
 const result=require('node:child_process').spawnSync(path.join(runtimeRoot(),'Scripts/python.exe'),[path.join(__dirname,'ocr-worker-fallback.py')],{encoding:'utf8',windowsHide:true});
 assert.equal(result.status,0,result.stderr||result.stdout);
});
test('GPU read queue batches compatible crops and keeps each response attached to its input',async()=>{
 const b=new LocalOcrBackend();b.batchEnabled=true;const calls=[];
 b.request=async data=>{calls.push(data);return data.items.map(r=>({text:Buffer.from(r.image,'base64').toString(),variant:r.variant,language:r.language}));};
 try{
  const results=await Promise.all([b.read(Buffer.from('first'),{language:'th',variant:'original'}),b.read(Buffer.from('second'),{language:'th',variant:'contrast'}),b.read(Buffer.from('third'),{language:'en'})]);
  assert.deepEqual(results.map(r=>r.text),['first','second','third']);assert.deepEqual(calls.map(c=>c.items.length),[2,1]);
  assert.equal(results[1].variant,'contrast');assert.equal(results[2].language,'en');
  await assert.rejects(b.readBatch([{image:Buffer.alloc(1),language:'en'},{image:Buffer.alloc(1),language:'th'}]),/one engine and language/);
  b.request=async()=>[];await assert.rejects(b.readBatch([{image:Buffer.alloc(1)}]),/incomplete/);
 }finally{b.close();}
});
test('cancelling queued GPU crops rejects the complete queue before starting inference',async()=>{
 const b=new LocalOcrBackend();b.batchEnabled=true;let calls=0;b.request=async()=>{calls++;return [];};
 const controller=new AbortController(),reads=[b.read(Buffer.alloc(1),{signal:controller.signal}),b.read(Buffer.alloc(1),{signal:controller.signal})];
 controller.abort();await Promise.all(reads.map(p=>assert.rejects(p,/ยกเลิก/)));assert.equal(calls,0);assert.equal(b.readQueue.length,0);
});
test('missing optional runtime fails explicitly without claiming an enhanced result',async()=>{
 const b=new LocalOcrBackend({python:path.join(__dirname,'missing-python.exe')});
 await assert.rejects(b.status(),/ยังไม่ได้ติดตั้ง/);assert.equal(b.child,undefined);
});
test('local worker shares concurrent initialization and recovers after cancellation',{skip:!ready},async()=>{
 const b=new LocalOcrBackend();
 try{
  const statuses=await Promise.all([b.status(),b.status(),b.status()]);assert.ok(statuses.every(s=>s.ready));
  const signal=new AbortController();const pending=b.read(fs.readFileSync(path.join(__dirname,'fixtures/ocr-layout.png')),{engine:'manga',signal:signal.signal});
  setTimeout(()=>signal.abort(),20);await assert.rejects(pending,/ยกเลิก/);
  assert.ok((await b.status()).ready,'an old process exit must not reject a replacement worker request');
 }finally{b.close();}
});
test('real enhanced OCR preserves Japanese vertical coordinates without inventing confidence',{skip:!ready},async()=>{
 const pool=new EnhancedMangaOcrPool({langPath:path.resolve(__dirname,'../assets/tessdata'),languages:['jpn'],concurrency:1});
 try{
  const [r]=await pool.recognizePages([{filePath:path.join(__dirname,'fixtures/ocr-layout.png')}],{mode:'vertical',rectangle:{left:700,top:50,width:120,height:175}});
  assert.equal(r.error,undefined);assert.equal(r.regions[0].text,'こんにちは世界です');assert.equal(r.regions[0].confidence,null);
  assert.ok(r.regions[0].bbox.x0>=700&&r.regions[0].bbox.x1<=820);assert.ok(r.regions[0].alternatives.some(a=>a.engine==='tesseract.js'));
  assert.equal(r.regions[0].reviewRequired,true);assert.deepEqual(r.regions[0].words,[]);
 }finally{await pool.close();}
});
test('real enhanced Thai reading removes duplicate diacritics and agrees by source line',{skip:!ready},async()=>{
 const pool=new EnhancedMangaOcrPool({langPath:path.resolve(__dirname,'../assets/tessdata'),languages:['tha'],concurrency:1});
 try{
  const [r]=await pool.recognizePages([{filePath:path.join(__dirname,'fixtures/ocr-thai-bubble.png')}]);assert.equal(r.error,undefined);
  assert.equal(r.regions[0].text,'พวกแกทุกคนน่าจะ\nรู้เรื่องกองกำลังอิสรภาพ\nของจักรวรรดิกัน');
  assert.equal(r.regions.length,1);assert.ok(r.passes.some(p=>p.name==='tesseract-baseline'));assert.ok(r.passes.some(p=>p.name==='paddle-original'));
  assert.ok(r.regions[0].recognitionLines.every(l=>l.bbox.x0>180&&l.bbox.y0>150&&l.bbox.x1<540&&l.bbox.y1<350));
 }finally{await pool.close();}
});
test('cropped Thai bubble remains one complete paragraph with tone marks and original-image coordinates',{skip:!ready},async()=>{
 const pool=new EnhancedMangaOcrPool({langPath:path.resolve(__dirname,'../assets/tessdata'),languages:['tha'],concurrency:1});
 try{
  for(const crop of [{left:159,top:126,width:410,height:255},{left:165,top:140,width:410,height:255},{left:185,top:165,width:350,height:180}]){
   const image=await sharp(path.join(__dirname,'fixtures/ocr-thai-bubble.png')).extract(crop).png().toBuffer();
   const [r]=await pool.recognizePages([{filePath:image}]);assert.equal(r.error,undefined);assert.equal(r.regions.length,1);
   const region=r.regions[0];assert.equal(region.text,'พวกแกทุกคนน่าจะ\nรู้เรื่องกองกำลังอิสรภาพ\nของจักรวรรดิกัน');
   assert.equal(region.recognitionLines.length,3);assert.equal(region.localizationRefinement,'recognizer-line-bounds');
   assert.ok(region.bbox.x0<=region.detectorBBox.x0&&region.bbox.y0<region.detectorBBox.y0);
   assert.ok(region.bbox.x0>=0&&region.bbox.y0>=0&&region.bbox.x1<=crop.width&&region.bbox.y1<=crop.height);
   assert.ok(region.recognitionLines.every(l=>l.bbox.x0>=region.bbox.x0&&l.bbox.y0>=region.bbox.y0&&l.bbox.x1<=region.bbox.x1&&l.bbox.y1<=region.bbox.y1));
  }
 }finally{await pool.close();}
});
const files='test-results/new-sets/set-4/files.json';
test('connected staggered balloons split by their white lobes and retain shared-line portions',{skip:!ready||!fs.existsSync(files)},async()=>{
 const source=JSON.parse(fs.readFileSync(files))[1],backend=new LocalOcrBackend();
 try{
  const detected=await detectText(source),refined=await refineBalloonGroups(source,detected,backend),parts=refined.boxes.filter(b=>b.segmentation&&b.bbox.y0>2300&&b.bbox.y0<2650);
  assert.equal(parts.length,2);assert.ok(parts[0].bbox.x0>parts[1].bbox.x0);assert.equal(parts[0].containerId,parts[1].containerId);
  assert.equal(parts[0].lines.length,5);assert.equal(parts[1].lines.length,4);
 }finally{backend.close();}
});
test('Japanese vertical dialogue stays separate across a broad, offset balloon connection',{skip:!ready},async()=>{
 const fixture=require('./fixtures/ocr-ja-connected.json'),file=path.join(__dirname,'fixtures/ocr-ja-connected.png');
 const pool=new EnhancedMangaOcrPool({langPath:path.resolve(__dirname,'../assets/tessdata'),languages:['jpn'],concurrency:1});
 pool.detectPage=async()=>structuredClone(fixture);
 try{const [r]=await pool.recognizePages([{filePath:file}]);assert.equal(r.error,undefined);assert.equal(r.regions.length,2);assert.ok(r.regions.every(r=>r.segmentation==='balloon-boundaries'));assert.deepEqual(r.regions.map(r=>r.text),fixture.expected);assert.ok(r.regions[0].bbox.x0>r.regions[1].bbox.x1);fs.mkdirSync(path.resolve('test-results/ocr-advanced'),{recursive:true});fs.writeFileSync(path.resolve('test-results/ocr-advanced/ja-connection-fixed.json'),JSON.stringify({...r,imageDigest:require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex')},null,2));}finally{await pool.close();}
});
