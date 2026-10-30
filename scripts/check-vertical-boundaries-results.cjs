'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(process.argv[2]||'test-results/vertical-boundaries-oct09');
const read=name=>JSON.parse(fs.readFileSync(path.join(root,name)));
const reference=require('../test/fixtures/vertical-boundaries/recognition.json');
const literal=s=>String(s).normalize('NFKC').replace(/\s/gu,'');
// An elongated drawn sound mark is not a reliable literal dash count. Report
// exact text separately, never claim this narrower check as full OCR accuracy.
const glyphs=s=>literal(s).replace(/ー/g,'').replace(/[^\p{L}\p{N}]/gu,'');
const results=[];
for(const c of reference.cases){
 const saved=read(c.id+'-ocr-verified.json'),r=saved.result;
 assert.equal(r.error,undefined,c.id);
 assert.equal(r.regions.length,c.segments.length,c.id+' group count');
 assert.deepEqual(r.regions.map(row=>glyphs(row.text)),c.segments.map(glyphs),c.id+' ordered glyphs');
 results.push({id:c.id,groups:r.regions.length,orderedGlyphs:true,
  exactTranscription:r.regions.every((row,i)=>literal(row.text)===literal(c.segments[i])),
  actual:r.regions.map(row=>row.text),expected:c.segments});
}
for(const [attachment,page,side,minEnd] of [[6,4,'right',2780],[7,4,'left',2800],[8,5,'right',1720]]){
 const d=read('native-'+page+'-final.json').segmented;
 const rows=d.boxes.filter(r=>side==='left'?r.bbox.x0<220&&r.bbox.y1>1400:
  r.bbox.x0>1740&&r.bbox.y1>(page===4?1100:700)&&r.bbox.y0<(page===4?2824:1800));
 assert.equal(rows.length,1,'attachment-'+attachment+' duplicates');
 assert.equal(rows[0].orientation,'vertical');
 assert.ok(rows[0].bbox.y1>=minEnd,'attachment-'+attachment+' terminal coverage');
 results.push({id:'attachment-'+attachment,scope:'native geometry only',groups:1,terminalCoverage:true});
}
const d=read('native-4-final.json').segmented;
assert.ok(d.boxes.some(r=>r.bbox.x0>220&&r.bbox.x1<430&&r.bbox.y1>1800),'neighbor balloon must survive');
const result={scope:reference.scope,results,neighborBalloonPreserved:true};
fs.writeFileSync(path.join(root,'verification.json'),JSON.stringify(result,null,2)+'\n');
console.log('8 targeted layout cases passed; exact punctuation:',results.slice(0,5).filter(r=>r.exactTranscription).length+'/5 Japanese crops. Chinese transcription is unscored.');
