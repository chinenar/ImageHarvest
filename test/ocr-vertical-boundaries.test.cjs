'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {mergeLineObservations,refineBlocks}=require('../src/comic-text-detector.cjs');
const {reconcileDiscovery}=require('../src/ocr-discovery.cjs');
const {refineBalloonGroups,selectVerticalReading,postprocessReading}=require('../src/enhanced-manga-ocr.cjs');
const {LocalOcrBackend,runtimeRoot}=require('../src/ocr-backend.cjs');
const {repairRepeatedVerticalColumn}=require('../src/ocr-vertical-repetition.cjs');
const {materializeWorkerFile}=require('../src/ocr-worker-files.cjs');
const line=(x0,y0,x1,y1,orientation='vertical')=>({bbox:{x0,y0,x1,y1},coreBbox:{x0,y0,x1,y1},orientation,detectionConfidence:.9});

test('close same-column fragments reconnect, but a full glyph-sized gap stays separate',()=>{
 const rows=[line(20,0,32,120),line(20,124,32,280),line(20,310,32,420),line(60,0,72,280)];
 const result=mergeLineObservations(rows);
 assert.equal(result.length,3);
 assert.ok(result.some(r=>r.coreBbox.x0===20&&r.coreBbox.y1===280));
});
test('complete narrow columns suppress broad tile fragments without changing source evidence',()=>{
 const rows=[line(20,0,40,600),line(60,0,80,550),line(15,100,85,300),line(15,100,85,130,'horizontal')];
 const original=structuredClone(rows),result=mergeLineObservations(rows);
 assert.equal(result.length,2);assert.deepEqual(rows,original);
 assert.ok(result.flatMap(r=>r.suppressedLineObservations||[]).some(r=>r.coreBbox.y1===300));
 assert.ok(mergeLineObservations(rows.slice(0,1).concat(rows.slice(2))).some(r=>r.coreBbox.x0===15&&r.coreBbox.y1===300),'one column cannot erase a neighboring reading');
});
test('native long caption columns lose duplicate tile boxes and retain the adjacent balloon',()=>{
 const cases=require('./fixtures/ocr-vertical-boundary-geometry.json').cases;
 for(const c of cases){
  const original=structuredClone(c),lines=mergeLineObservations(c.lines);
  const result=reconcileDiscovery({...c,lines,boxes:refineBlocks(c.rawBlocks,lines)},c.observations);
  const columns=result.boxes.filter(b=>c.id==='native-page-4'?(b.bbox.x1<220&&b.bbox.y1>1400||b.bbox.x0>1740&&b.bbox.y1>1100):c.id==='native-page-5'?(b.bbox.x0>1740&&b.bbox.y1>700&&b.bbox.y0<1800):true);
  assert.equal(columns.length,c.id==='native-page-4'?2:1,c.id);
  assert.ok(columns.every(b=>b.orientation==='vertical'),c.id);
  if(c.id==='native-page-4')assert.ok(result.boxes.some(b=>b.bbox.x0>220&&b.bbox.x1<450&&b.bbox.y1>1800),'adjacent balloon retained');
  assert.deepEqual(c,original);
 }
});
test('a learned vertical block keeps a compact glyph and its long neighboring column together',()=>{
 const rows=[line(80,30,100,60,'horizontal'),line(40,30,60,195)];
 const result=refineBlocks([{bbox:{x0:30,y0:20,x1:110,y1:210},orientation:'vertical',detectionConfidence:.9}],rows);
 assert.equal(result.length,1);assert.equal(result[0].orientation,'vertical');assert.equal(result[0].lines.length,2);
});
test('mixed digits and Latin fragments remain inside their vertical column in source order',()=>{
 const rows=[{...line(20,0,40,500),text:'次の列',confidence:99},
  {...line(70,210,90,450),text:'文字',confidence:99},
  {...line(70,0,90,70),text:'速度',confidence:99},
  {...line(70,80,92,110,'horizontal'),text:'120',confidence:99},
  {...line(70,120,90,180),text:'km',confidence:99}];
 const original=structuredClone(rows),result=postprocessReading({orientation:'vertical',text:'unordered',lines:rows});
 assert.equal(result.text,'速度120km文字\n次の列');assert.deepEqual(rows,original);
});
test('a positioned engine breaks an independent crop vote tie without removing supported small kana',()=>{
 const read=(text,fingerprint)=>({engine:'manga-ocr',text,inferenceFingerprint:fingerprint});
 const wrong=read('何でしょうねこの紙切れは','a'),correct=read('何でしょう？この紙切れは','c');
 const readings=[wrong,read(wrong.text,'b'),correct,read(correct.text,'d')];
 const positioned={engine:'paddleocr',orientation:'vertical',text:'何でしう?\nこの紙切れは',confidence:99};
 const result=selectVerticalReading(wrong,positioned,{readings});
 assert.equal(result.text,correct.text);assert.equal(result.selectionReason,'vertical-positioned-tiebreak');
 assert.equal(selectVerticalReading(wrong,positioned,{readings,baseline:{text:wrong.text,confidence:95}}).text,wrong.text);
 assert.equal(selectVerticalReading(wrong,positioned,{readings:[wrong,read(wrong.text,'b'),correct]}).text,wrong.text);
});
const ready=fs.existsSync(path.join(runtimeRoot(),'Scripts/python.exe'));
test('parallel worker starts preserve a complete cached Python module without rewriting it',async()=>{
 const fsp=require('node:fs/promises'),os=require('node:os');
 const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'ocr-worker-module-')),file=path.join(dir,'worker.py');
 const content=Buffer.from('def layout_safe():\n    return True\n'.repeat(4000));
 try{
  await Promise.all(Array.from({length:12},()=>materializeWorkerFile(file,content)));
  assert.deepEqual(await fsp.readFile(file),content);
  await fsp.utimes(file,new Date(1000000),new Date(1000000));
  await materializeWorkerFile(file,content);
  assert.equal((await fsp.stat(file)).mtimeMs,1000000);
  assert.deepEqual(await fsp.readdir(dir),['worker.py']);
 }finally{await fsp.rm(file,{force:true});await fsp.rmdir(dir);}
});
test('repeated terminal letters require two independent high-confidence readings of the same column',()=>{
 const chosen={text:'オーーッホホホハ！'};
 const first={engine:'paddleocr',inferenceFingerprint:'one',textLines:[{text:'オーッ',confidence:70,bbox:{x0:50,y0:0,x1:70,y1:200}},{text:'ホホホホ!',confidence:87,bbox:{x0:10,y0:0,x1:30,y1:200}}]};
 const second={...first,inferenceFingerprint:'two',textLines:first.textLines.map(l=>({...l,confidence:92}))};
 assert.equal(repairRepeatedVerticalColumn(chosen,first,second).text,'オーーッホホホホ!');
 assert.equal(repairRepeatedVerticalColumn(chosen,first,first),chosen);
 assert.equal(repairRepeatedVerticalColumn(chosen,first,{...second,textLines:second.textLines.map(l=>({...l,bbox:{...l.bbox,x0:200,x1:220}}))}),chosen);
 assert.equal(repairRepeatedVerticalColumn(chosen,first,{...second,textLines:second.textLines.map(l=>({...l,confidence:60}))}),chosen);
 const moderate={...second,textLines:second.textLines.map(l=>({...l,confidence:87}))};
 assert.equal(repairRepeatedVerticalColumn(chosen,first,moderate),chosen);
 const third={...second,inferenceFingerprint:'three',textLines:second.textLines.map(l=>({...l,confidence:81}))};
 assert.equal(repairRepeatedVerticalColumn(chosen,first,moderate,third).text,'オーーッホホホホ!');
 assert.equal(repairRepeatedVerticalColumn(chosen,first,moderate,{...third,inferenceFingerprint:'one'}),chosen);
});
test('native connected balloons split at the source gap in reading order, while one continuous balloon stays whole',{skip:!ready},async()=>{
 const backend=new LocalOcrBackend();
 try{for(const c of require('./fixtures/vertical-boundaries/segmentation.json').cases){
  const result=await refineBalloonGroups(path.resolve(c.file),structuredClone(c.detected),backend);
  const boxes=result.boxes.filter(b=>b.orientation==='vertical');
  assert.equal(boxes.length,c.id==='native-4'?1:2,c.id);
  if(boxes.length===2){
   assert.ok(boxes[0].bbox.x1>boxes[1].bbox.x1,c.id+' reads right to left');
   if(c.id!=='native-1'){
    const upper=boxes[0].lines.find(l=>l.cutEdge),lower=boxes[1].lines.find(l=>l.cutEdge);
    assert.ok(upper&&lower,c.id+' preserves both split column parts');
    assert.equal(upper.coreBbox.y1,lower.coreBbox.y0,c.id+' has one source boundary');
   }
  }
 }}finally{backend.close();}
});
