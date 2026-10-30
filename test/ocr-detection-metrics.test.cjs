'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {evaluateDetection}=require('../scripts/ocr-detection-metrics.cjs');
const r=(id,text,box)=>({id,text,box});
const ref=(units,coverage='complete-page',extra={})=>({units,coverage,...extra});
test('one giant box cannot detect two distinct units',()=>{
 const m=evaluateDetection([r('p','AB',[0,0,100,10])],ref([r('a','A',[0,0,50,10]),r('b','B',[50,0,100,10])]));
 assert.equal(m.matches.length,1);assert.equal(m.recall,.5);assert.equal(m.missing.length,1);assert.deepEqual(m.merges[0].unitIds,['a','b']);
});
test('lexically correct clipped crop reports deficient extent',()=>{
 const m=evaluateDetection([r('p','HELLO',[0,0,70,10])],ref([r('t','HELLO',[0,0,100,10])]));
 assert.equal(m.cer.value,0);assert.equal(m.matches[0].incompleteCrop,true);assert.equal(m.unitCoverage[0].fraction,.7);
});
test('duplicate observations are separate from split halves',()=>{
 const t=[r('t','AB',[0,0,100,10])];
 const duplicate=evaluateDetection([r('p1','AB',[0,0,100,10]),r('p2','AB',[0,0,100,10])],ref(t));
 assert.equal(duplicate.duplicatePairs.length,1);assert.equal(duplicate.splits.length,0);assert.equal(duplicate.falsePositives.length,1);assert.equal(duplicate.cer.extraCharacters,2);
 const split=evaluateDetection([r('p1','A',[0,0,50,10]),r('p2','B',[50,0,100,10])],ref(t));
 assert.equal(split.splits.length,1);assert.equal(split.duplicatePairs.length,0);assert.equal(split.unitCoverage[0].fraction,1);
});
test('partial annotation does not invent a full-page denominator or false positives',()=>{
 const m=evaluateDetection([r('p','A',[0,0,10,10]),r('unknown','B',[20,0,30,10]),r('bad','X',[40,0,50,10])],ref([r('t','A',[0,0,10,10])],'partial',{negative:[[40,0,50,10]]}));
 assert.equal(m.fullPageUnits,null);assert.equal(m.recall,null);assert.equal(m.precision,null);assert.equal(m.annotatedRecall,1);
 assert.deepEqual(m.unscoredOutputs,['unknown']);assert.deepEqual(m.falsePositives,['bad']);assert.equal(m.cer.extraCharacters,1);
});
test('complete empty page scores every output while partial page scores only annotated negatives',()=>{
 const outputs=[r('p','art',[0,0,10,10])];
 const complete=evaluateDetection(outputs,ref([]));assert.deepEqual(complete.falsePositives,['p']);assert.equal(complete.cer.value,null);assert.equal(complete.precision,0);
 const partial=evaluateDetection(outputs,ref([],'partial',{negative:[[0,0,10,10]]}));assert.deepEqual(partial.falsePositives,['p']);assert.equal(partial.cer.extraCharacters,3);
});
test('ignore areas exclude unannotated output but cannot hide known truth',()=>{
 const m=evaluateDetection([r('a','A',[0,0,10,10]),r('ignored','B',[20,0,30,10])],ref([r('t','A',[0,0,10,10])],'partial',{ignore:[[0,0,30,10]]}));
 assert.equal(m.rawOutputs,2);assert.equal(m.evaluatedOutputs,1);assert.equal(m.matches.length,1);assert.deepEqual(m.ignoredOutputs,['ignored']);
});
test('missing text contributes character deletions and coverage must be explicit',()=>{
 const m=evaluateDetection([],ref([r('t','ABC',[0,0,10,10])]));assert.equal(m.cer.missingCharacters,3);assert.equal(m.cer.value,1);assert.equal(m.unitCoverage[0].noCoverage,true);
 assert.throws(()=>evaluateDetection([],{}),/coverage/);
});
test('detection-only truth matches without inventing transcription errors',()=>{
 const m=evaluateDetection([r('p','unverified reading',[0,0,10,10])],ref([r('t',null,[0,0,10,10])]));
 assert.equal(m.recall,1);assert.equal(m.matches[0].edits,null);assert.equal(m.cer.value,null);assert.equal(m.cer.errors,null);assert.equal(m.cer.matchedEdits,0);assert.equal(m.cer.extraCharacters,0);assert.deepEqual(m.cer.untranscribedUnits,['t']);
 const missing=evaluateDetection([],ref([r('t',null,[0,0,10,10])]));assert.deepEqual(missing.missing,['t']);assert.equal(missing.cer.value,null);
});
test('unmatched output crossing an ignored extent is unscored on a complete page',()=>{
 const m=evaluateDetection([r('p','uncertain',[0,0,10,10])],ref([],'complete-page',{ignore:[[0,0,2,10]]}));
 assert.deepEqual(m.falsePositives,[]);assert.deepEqual(m.unscoredOutputs,['p']);assert.equal(m.precision,null);assert.equal(m.cer.extraCharacters,0);
});
