'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {markEffectCandidates}=require('../src/ocr-effect-candidates.cjs');
const {translationEligible,contentRole}=require('../src/ocr-content-role.cjs');
const {OcrTranslationService}=require('../src/ocr-translation.cjs');
const row=(text,size,placement={surfaceType:'bubble',surfaceValidated:true})=>({text,kind:'unboxed',confidence:99,bbox:{x0:0,y0:0,x1:100,y1:size},recognitionLines:[{text,bbox:{x0:0,y0:0,x1:100,y1:size},confidence:99}],placement});
test('large unboxed lettering is review-only with measured dialogue context; source and manual decisions survive',()=>{
 const anchors=['Hello world','Good morning','Come with me'].map(t=>row(t,20));
 const effect=row('ドン',100,{surfaceType:'scene',surfaceValidated:false}),saved=structuredClone(effect);
 const candidate=markEffectCandidates([...anchors,effect]).at(-1);
 assert.equal(contentRole(candidate).reason,'possible-sound-effect-needs-review');
 assert.equal(translationEligible(candidate),false);
 assert.equal(translationEligible({...candidate,reviewed:true}),true);
 assert.equal(translationEligible({...candidate,contentOverride:true}),true);
 assert.equal(translationEligible({...candidate,text:'Corrected dialogue'}),true,'stale evidence cannot exclude edited text');
 assert.equal(translationEligible({...candidate,bbox:{...candidate.bbox,y1:40}}),true,'stale evidence cannot exclude edited geometry');
 assert.deepEqual(effect,saved);
 for(const safe of [row('DIE!!',100),row('HEY',20,{surfaceType:'scene',surfaceValidated:false}),row('y-F5y31',100,{surfaceType:'scene',surfaceValidated:false}),{...effect,kind:'bubble'},{...effect,reviewed:true},{...effect,contentOverride:true}])assert.equal(markEffectCandidates([...anchors,safe]).at(-1).effectCandidate,undefined);
 assert.equal(markEffectCandidates([anchors[0],effect]).at(-1).effectCandidate,undefined);
});

test('suspected effect stays out of normal translation, with an explicit uncertain-review override',async()=>{
 const anchors=['Hello world','Good morning','Come with me'].map((t,i)=>({...row(t,20),id:'a'+i}));
 const regions=markEffectCandidates([...anchors,{...row('ドン',100,{surfaceType:'scene',surfaceValidated:false}),id:'effect'}]);
 const sent=[],service=new OcrTranslationService({google:{translate:async rows=>{sent.push(...rows.map(r=>r.id));return rows.map(r=>({id:r.id,translation:'ทดสอบ'}));}}});
 const result=await service.translate(regions);
 assert.deepEqual(sent,['a0','a1','a2']);assert.equal(result.skipped[0].reason,'possible-sound-effect-needs-review');
 assert.equal(translationEligible(regions.at(-1),{includeUncertain:true}),true);
});
