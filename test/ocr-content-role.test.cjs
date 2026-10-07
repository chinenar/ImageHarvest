'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {contentRole,translationEligible}=require('../src/ocr-content-role.cjs');
const {OcrTranslationService}=require('../src/ocr-translation.cjs');
test('confirmed publisher mark is excluded without treating ordinary dialogue, color or SFX as watermark',()=>{
 assert.equal(contentRole({text:'RITHAR\nSCANS'}).role,'watermark');
 assert.equal(contentRole({text:'RITHA\nSCAN'}).role,'watermark','retain the confirmed clipped reading of the same publisher logo');
 for(const r of [{text:'What’s that?'},{text:'AH'},{text:'SCANS'},{text:'He scans the area.'},{text:'RITHAR SCANS',kind:'bubble'},{text:'RITHAR SCANS',contentOverride:true},{text:'RITHAR SCANS',placement:{surfaceType:'bubble'}},{text:'ガッ',confidence:null}])assert.equal(translationEligible(r),true);
 assert.equal(translationEligible({text:'dialogue',kind:'watermark'}),false);assert.equal(translationEligible({text:'Ji\nLil |',confidence:63,reviewRequired:true}),false);
 assert.equal(translationEligible({text:'Ji\nLil |',confidence:63,reviewRequired:true},{includeUncertain:true}),true);
 assert.equal(translationEligible({text:'AH',confidence:60,reviewRequired:true,reviewed:true}),true);
 assert.equal(translationEligible({text:'RITHAR SCANS'},{includeUncertain:true}),false);
});
test('translation never submits skipped marks/artwork and retains explicit skip reasons without changing OCR',async()=>{
 const sent=[],service=new OcrTranslationService({google:{translate:async rows=>{sent.push(...rows);return rows.map(r=>({id:r.id,translation:'คำพูด'}));}}});
 const regions=[{id:'speech',text:'AH',confidence:95},{id:'mark',text:'RITHAR\nSCANS'},{id:'art',text:'Ji\nLil |',confidence:63,reviewRequired:true},{id:'manual',text:'x',kind:'non-text'}],before=structuredClone(regions);
 const result=await service.translate(regions);assert.deepEqual(sent.map(r=>r.id),['speech']);assert.equal(result.translated,1);assert.deepEqual(result.skipped.map(r=>r.role),['watermark','uncertain','non-text']);assert.deepEqual(regions,before);
});

test('strong speech-bubble geometry can rescue a slightly low OCR confidence without rescuing weak surfaces',()=>{
 const strong={text:'JE NE VEUX PAS',confidence:74,reviewRequired:true,placement:{surfaceType:'bubble',confidence:.91,reviewRequired:false}};
 const weak={text:'garbled',confidence:74,reviewRequired:true,placement:{surfaceType:'bubble',confidence:.64,reviewRequired:true}};
 assert.equal(translationEligible(strong),true);
 assert.equal(contentRole(strong).role,'content');
 assert.equal(translationEligible(weak),false);
 assert.equal(contentRole(weak).role,'uncertain');
});

test('punctuation and symbol-only reactions are preserved from the source image instead of translated or repainted',()=>{
 for(const text of ['!?','?!','?!!','…','- 2','33','100%']){
  const role=contentRole({text,confidence:100,reviewRequired:false});
  assert.equal(role.role,'literal-mark',text);
  assert.equal(role.excluded,true,text);
  assert.equal(translationEligible({text,confidence:100}),false,text);
 }
 assert.equal(translationEligible({text:'Room 2',confidence:100}),true);
 assert.equal(translationEligible({text:'第2話',confidence:100}),true);
 assert.equal(translationEligible({text:'!?',contentOverride:true,confidence:100}),true);
});

test('OCR disagreement that turns a reaction mark into dash/digits never reaches the translation provider',async()=>{
 const sent=[],service=new OcrTranslationService({google:{translate:async rows=>{sent.push(...rows);return rows.map(r=>({id:r.id,translation:'ผิด'}));}}});
 const region={id:'reaction',text:'- 2',confidence:85,reviewRequired:true,recognitionEngine:'paddleocr',bbox:{x0:126,y0:3,x1:257,y1:54},
  alternatives:[{engine:'tesseract.js',text:'',confidence:72},{engine:'paddleocr',text:'- 2',confidence:85},{engine:'paddleocr',text:'C 2',confidence:91},{engine:'paddleocr',text:'2',confidence:49}]};
 const result=await service.translate([region]);
 assert.equal(sent.length,0);
 assert.equal(result.translated,0);
 assert.equal(result.skipped[0].role,'uncertain');
 assert.equal(result.skipped[0].reason,'nonlexical-reading-needs-review');
});
