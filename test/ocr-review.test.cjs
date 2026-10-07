'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {regionsFromBlocks,scriptHint,meaningfulScore}=require('../src/manga-ocr.cjs');
const {fusePasses,evaluateRegions,editDistance}=require('../src/ocr-review.cjs');
const box=(x0,y0,x1,y1)=>({x0,y0,x1,y1});
const row=(id,text,bbox,confidence=90)=>({id,text,bbox,confidence,orientation:'horizontal'});

test('retain short, low-confidence and more than 120 observations',()=>{
 const paragraphs=Array.from({length:125},(_,i)=>({text:i%2?'!':'あ',confidence:15,bbox:box(0,i*10,8,i*10+8)}));
 const result=regionsFromBlocks([{paragraphs}]);
 assert.equal(result.length,125);assert.ok(result.every(r=>r.reviewRequired));assert.equal(new Set(result.map(r=>r.id)).size,125);
 assert.equal(scriptHint('ข้อความ'),'th');assert.ok(meaningfulScore('ข้อความ')>0);
});
test('separate adjacent balloons that OCR grouped into one paragraph',()=>{
 const word=(text,bbox)=>({text,bbox,confidence:90});
 const a=word('LEFT',box(10,10,50,30)),b=word('RIGHT',box(120,10,170,30));
 const result=regionsFromBlocks([{paragraphs:[{text:'LEFT RIGHT',bbox:box(10,10,170,30),lines:[{words:[a,b]}]}]}]);
 assert.deepEqual(result.map(r=>r.text),['LEFT','RIGHT']);
});
test('keep paragraphs separate even when boxes overlap; preserve vertical word order',()=>{
 const paragraphs=[{text:'a',bbox:box(0,0,10,20)},{text:'b',bbox:box(8,0,18,20)}];
 assert.equal(regionsFromBlocks([{paragraphs}]).length,2);
 const vertical=regionsFromBlocks([{paragraphs:[{lines:[{words:[{text:'下',bbox:box(0,20,10,30),confidence:90},{text:'上',bbox:box(0,0,10,10),confidence:90}]}]}]}],0,{orientation:'vertical'});
 assert.equal(vertical[0].text,'上下');assert.equal(vertical[0].orientation,'vertical');
});
test('fuse duplicates while preserving conflicting/contained speech units',()=>{
 const a=row('a','Hello',box(0,0,60,20));const b=row('b','Hello',box(1,0,61,20));
 const c=row('c','Hello world',box(0,0,100,20));
 const rows=fusePasses([{name:'auto',regions:[a]},{name:'sparse',regions:[b,c]}]);
 assert.equal(rows.length,2);assert.equal(rows[0].observedBy.length,2);assert.ok(rows.every(r=>r.reviewRequired));
});
test('a merged prediction cannot claim recall for two truths',()=>{
 const truth=[row('t1','left',box(0,0,50,30)),row('t2','right',box(50,0,100,30))];
 const metrics=evaluateRegions([row('p1','left right',box(0,0,100,30))],truth,{complete:true});
 assert.equal(metrics.matched,1);assert.equal(metrics.recall,.5);assert.deepEqual(metrics.merges,['p1']);assert.equal(metrics.targetMet,false);
});
test('perfect OCR requires complete reference; extra/missing text hurts character accuracy',()=>{
 const truth=[row('t','日本語 Thai',box(0,0,100,20))];const predicted=[row('p','日本語\nThai',box(0,0,100,20))];
 assert.equal(evaluateRegions(predicted,truth).targetMet,false);
 assert.equal(evaluateRegions(predicted,truth,{complete:true}).targetMet,true);
 assert.equal(evaluateRegions([],truth).characterAccuracy,0);
 assert.ok(evaluateRegions([...predicted,row('extra','wrong',box(200,0,250,20))],truth,{complete:true}).characterAccuracy<1);
 assert.equal(editDistance('こんにちは','こんにちわ'),1);
});
test('correct text in a poorly localized box cannot pass the goal',()=>{
 const truth=[row('t','Hello',box(0,0,100,20))];
 const metrics=evaluateRegions([row('p','Hello',box(0,0,70,20))],truth,{complete:true});
 assert.equal(metrics.recall,1);assert.equal(metrics.characterAccuracy,1);assert.equal(metrics.locationRecall,0);assert.equal(metrics.targetMet,false);
});
