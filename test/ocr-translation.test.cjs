'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {OcrTranslationService,translationText,validateRegions}=require('../src/ocr-translation.cjs');
const {HarvestTranslationClient}=require('../src/harvest-translate.cjs');
const region=(id,text='HELLO\nWORLD')=>({id,text,bbox:{x0:1,y0:2,x1:50,y1:60},orientation:'horizontal'});
test('AI model chooser exposes text models and filters image/video/embedding runtimes',async()=>{
 const service=new OcrTranslationService({ai:{listModels:async()=>['qwen-text','qwen-image','nsfw_wan_14b','wan2.2-ti2v','text-embedding-nomic'].map(id=>({id}))}});
 assert.deepEqual(await service.models(),{models:['qwen-text'],preferred:'qwen-text'});
});
test('translation preserves original OCR, coordinates, ids and independent source provenance',async()=>{
 const source=[region('b'),region('a')],frozen=structuredClone(source);
 const service=new OcrTranslationService({google:{translate:async rows=>{assert.equal(rows[0].text,'HELLO WORLD');return rows.toReversed().map(r=>({id:r.id,translation:'สวัสดี'}));}}});
 const result=await service.translate(source,{imageDigest:'imagehash'});
 assert.deepEqual(source,frozen);assert.deepEqual(result.items.map(r=>r.id),['b','a']);assert.equal(result.translated,2);
 assert.equal(result.items[0].sourceText,source[0].text);assert.equal(result.items[0].imageDigest,'imagehash');assert.deepEqual(result.items[0].bbox,source[0].bbox);
 result.items[0].bbox.x0=9;assert.equal(source[0].bbox.x0,1);
});
test('AI gets bounded batches, language names, context and model, including beyond 120 regions',async()=>{
 const calls=[];const service=new OcrTranslationService({ai:{probe:async()=>({model:'text-model'}),translateRegions:async(rows,o)=>{calls.push({rows,o});return rows.map(r=>({id:r.id,translation:'คำแปล'}));}}});
 const result=await service.translate(Array.from({length:125},(_,i)=>region(String(i))),{provider:'ai',context:'school festival',targetLanguage:'th'});
 assert.equal(result.total,125);assert.equal(result.translated,125);assert.equal(calls.length,3);assert.equal(calls[0].rows.length,42);assert.equal(calls[0].o.model,'text-model');assert.equal(calls[0].o.targetLanguage,'Thai');assert.equal(calls[0].o.context,'school festival');
});
test('AI transport-wide batch failures are explicitly marked so the page scheduler can shrink and retry them',async()=>{
 let calls=0;const service=new OcrTranslationService({ai:{translateRegions:async()=>{calls++;throw new Error('Translation API ตอบช้าเกินกำหนด');}}});
 const result=await service.translate([region('a'),region('b')],{provider:'ai',model:'m'});
 assert.equal(calls,1);assert.equal(result.translated,0);assert.equal(result.failed,2);assert.equal(result.transportFailures,2);assert.ok(result.items.every(r=>r.providerTransportFailure));assert.match(result.items[0].error,/ตอบช้า/);
});
test('missing AI ids retry individually; persistent omissions stay failed',async()=>{
 const calls=[];const service=new OcrTranslationService({ai:{translateRegions:async rows=>{calls.push(rows.map(r=>r.id));return rows.length>1?[{id:'a',translation:'หนึ่ง'}]:[];}}});
 const result=await service.translate([region('a'),region('b')],{provider:'ai',model:'m'});
 assert.deepEqual(calls,[['a','b'],['b']]);assert.equal(result.translated,1);assert.equal(result.failed,1);assert.equal(result.items[1].status,'failed');assert.ok(result.items[1].error);
});
test('foreign-script AI answers retry and cannot be counted as successful Thai translations',async()=>{
 let calls=0;const service=new OcrTranslationService({ai:{translateRegions:async rows=>{calls++;return rows.map(r=>({id:r.id,translation:'見たの？あのメイド服きつ。'}));}}});
 const result=await service.translate([region('a')],{provider:'ai',model:'m'});
 assert.equal(calls,2);assert.equal(result.translated,0);assert.equal(result.failed,1);assert.equal(result.items[0].translation,'');assert.ok(result.items[0].rejectedTranslation);assert.match(result.items[0].error,/ภาษา Thai/);
});
test('auto source retries a stubborn Latin OCR line with explicit English before failing Thai validation',async()=>{
 const calls=[];
 const service=new OcrTranslationService({google:{translate:async(rows,options)=>{
  calls.push(options.sourceLanguage);
  return rows.map(r=>({id:r.id,translation:options.sourceLanguage==='en'?'ฉันจะไม่ยกโทษให้พวกแกทุกคน!':'NT FOKO Y ของคุณ!!'}));
 }}});
 const result=await service.translate([region('a','NT FOKO\nY OF YOU!!')],{provider:'google',sourceLanguage:'auto',targetLanguage:'th'});
 assert.equal(result.translated,1);assert.equal(result.failed,0);assert.equal(result.items[0].effectiveSourceLanguage,'en');assert.equal(result.items[0].sourceLanguage,'auto');assert.deepEqual(calls,['auto','auto','en']);
});
test('unknown or repeated reply ids never get attached to other OCR boxes',async()=>{
 for(const reply of [[{id:'alien',translation:'x'}],[{id:'a',translation:'x'},{id:'a',translation:'y'}]]){
  const service=new OcrTranslationService({google:{translate:async()=>reply}});
  await assert.rejects(service.translate([region('a')]),/ID/);
 }
});
test('invalid input is rejected before connecting, blank text skipped, review flags retained',async()=>{
 assert.throws(()=>validateRegions([region('a'),region('a')]),/ID/);
 assert.throws(()=>validateRegions([region('a')],{width:30,height:60}),/กรอบ/);
 assert.throws(()=>validateRegions([region('a','x'.repeat(4001))]),/4,000/);
 const service=new OcrTranslationService({google:{translate:async rows=>rows.map(r=>({id:r.id,translation:'t'}))}});
 const result=await service.translate([region('a',''),{...region('b'),reviewRequired:true}]);
 assert.equal(result.total,1);assert.equal(result.items[0].sourceReviewRequired,true);
 await assert.rejects(service.translate([region('a')],{provider:'other'}),/ผู้ให้บริการ/);
});
test('horizontal and vertical line breaks join correctly without changing source text',()=>{
 assert.equal(translationText(region('a','ただの\n学園祭'),'ja'),'ただの学園祭');
 assert.equal(translationText(region('a','ただの\n学園祭')),'ただの学園祭');
 assert.equal(translationText(region('a','Hello\nworld'),'en'),'Hello world');
 assert.equal(translationText(region('a','พวกแก\nทุกคน'),'th'),'พวกแก ทุกคน');
});
test('cancellation stops before submission and aborts an active AI request',async()=>{
 const controller=new AbortController();controller.abort();
 const service=new OcrTranslationService({google:{translate:()=>assert.fail('submitted cancelled request')}});
 await assert.rejects(service.translate([region('a')],{signal:controller.signal}),/ยกเลิก/);
 const active=new AbortController();let resolveStarted;const started=new Promise(r=>resolveStarted=r);
 const ai=new HarvestTranslationClient({fetchImpl:async(_url,{signal})=>{resolveStarted();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Abort','AbortError')),{once:true}));}});
 const pending=ai.translateRegions([region('a')],{model:'m',signal:active.signal});await started;active.abort();await assert.rejects(pending,/ยกเลิก/);
});
test('LM Studio native adapter disables reasoning only when supported and reads message output',async()=>{
 const calls=[];const ai=new HarvestTranslationClient({fetchImpl:async(url,options)=>{
   calls.push({url,options});
   if(url.endsWith('/api/v1/models'))return new Response(JSON.stringify({models:[{type:'llm',key:'m',capabilities:{reasoning:{allowed_options:['on','off']}}}]}));
   const input=JSON.parse(options.body);assert.equal(input.reasoning,'off');assert.equal(input.store,false);assert.ok(input.system_prompt.includes('Thai'));assert.equal(JSON.parse(input.input).items[0].id,'a');
   return new Response(JSON.stringify({output:[{type:'reasoning',content:'ignored'},{type:'message',content:'{"items":[{"id":"a","translation":"สวัสดี"}]}'}]}));
 }});
 assert.deepEqual(await ai.translateRegions([region('a')],{model:'m'}),[{id:'a',translation:'สวัสดี'}]);
 assert.ok(calls[1].url.endsWith('/api/v1/chat'));
});
test('servers without LM Studio native API continue using chat completions',async()=>{
 const calls=[];const ai=new HarvestTranslationClient({fetchImpl:async(url,options)=>{
   calls.push(url);if(url.endsWith('/api/v1/models'))return new Response('not found',{status:404});
   assert.ok(JSON.parse(options.body).messages);return new Response(JSON.stringify({choices:[{message:{content:'{"items":[{"id":"a","translation":"สวัสดี"}]}'}}]}));
 }});
 assert.equal((await ai.translateRegions([region('a')],{model:'m'}))[0].translation,'สวัสดี');assert.ok(calls[1].endsWith('/v1/chat/completions'));
});
