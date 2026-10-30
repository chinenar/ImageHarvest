'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),sharp=require('sharp');
const {prepareCleanupMasks}=require('../src/reader-cleanup-masks.cjs');
const image=()=>sharp({create:{width:100,height:80,channels:3,background:'white'}}).png().toBuffer();
const row={id:'a',bbox:{x0:10,y0:15,x1:70,y1:50}};
test('confirmed neighboring paragraphs remain separate on a shared white surface',()=>{
 const {resolveReadingUnits}=require('../src/reading-units.cjs');
 const make=(id,text,x)=>({id,text,localizationRefinement:'recognizer-line-bounds',bbox:{x0:x,y0:10,x1:x+80,y1:90},recognitionLines:[{text,confidence:99,bbox:{x0:x,y0:10,x1:x+80,y1:30}}]});
 const rows=[make('a','One sentence',10),make('b','Another sentence',85)];
 const placements=rows.map(r=>({id:r.id,placement:{surfaceValidated:true,surfaceKey:'white'}}));
 assert.equal(resolveReadingUnits(rows,placements).regions.length,2);
});
test('crop rereading maps polygons and rectangles into the same page coordinates',()=>{
 const {positionLine}=require('../src/reader-quality.cjs');
 const line={text:'Hello',bbox:{x0:2,y0:3,x1:32,y1:18},polygon:[[2,3],[32,3],[32,18],[2,18]]};
 const mapped=positionLine(line,500,700);
 assert.deepEqual(mapped.bbox,{x0:502,y0:703,x1:532,y1:718});
 assert.deepEqual(mapped.polygon,[[502,703],[532,703],[532,718],[502,718]]);
 assert.deepEqual(line.polygon[0],[2,3]);
});
test('cleanup probability crop retains source coordinates and skips excluded readings',async()=>{
 let calls=0;const out=await prepareCleanupMasks(await image(),[row,{...row,id:'b',excludeFromLayoutCompetition:true}],{detect:async(buffer,options)=>{
  calls++;assert.equal(options.includeSegmentation,true);const m=await sharp(buffer).metadata();assert.equal(m.width,100);assert.equal(m.height,80);return {segmentation:buffer};
 }});
 assert.equal(calls,1);assert.deepEqual(out[0].cleanupProbability.bbox,{x0:0,y0:0,x1:100,y1:80});assert.equal(out[1].cleanupProbability,undefined);assert.equal(row.cleanupProbability,undefined);
});
test('unavailable segmentation falls back per region and records its cause',async()=>{
 const [out]=await prepareCleanupMasks(await image(),[row],{detect:async()=>{throw Error('model unavailable');}});
 assert.equal(out.cleanupModelError,'model unavailable');assert.equal(out.cleanupProbability,undefined);
});
test('cancellation during inference propagates instead of falling back',async()=>{
 const controller=new AbortController();await assert.rejects(prepareCleanupMasks(await image(),[row],{signal:controller.signal,detect:async()=>{controller.abort();return {};}}),/ยกเลิก/);
});
