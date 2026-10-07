'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {RegionStyleStore,regionStyleKey}=require('../src/region-style-store.cjs');
const {extractMarkedTranslations,reusableTranslation}=require('../src/google-web-result.cjs');
const {OcrTranslationService}=require('../src/ocr-translation.cjs');
const {GoogleTranslateWebClient}=require('../src/google-translate-web.cjs');
const marker=n=>'[[IH000009_'+String(n).padStart(4,'0')+']]';
test('Google markers require adjacent boundaries and never shift a missing reply',()=>{
 const items=[{id:'a'},{id:'b'},{id:'c'}];
 const rows=extractMarkedTranslations(marker(1)+'สวัสดี'+marker(2)+'ดีมาก'+marker(4),items,'000009');
 assert.equal(rows[0].translation,'สวัสดี');assert.equal(rows[1].translation,'');assert.equal(rows[2].translation,'');
 assert.ok(extractMarkedTranslations(marker(1)+'x'+marker(2)+'y'+marker(3)+'z'+marker(4),items,'000010').every(r=>!r.translation));
});
test('Google result tolerates whitespace but rejects duplicated markers',()=>{
 const rows=extractMarkedTranslations('[[ IH000009_0001 ]]สวัสดี[[ IH000009_0002 ]]',[{id:'a'}],'000009');assert.equal(rows[0].translation,'สวัสดี');
 assert.equal(extractMarkedTranslations(marker(1)+'a'+marker(1)+'b'+marker(2),[{id:'a'}],'000009')[0].translation,'');
});
test('font edits persist independently, serialize writes and reset one region only',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ih-region-style-test-'));
 try{const file=path.join(dir,'styles.json'),store=new RegionStyleStore(file),page={imageDigest:'digest'},r={text:'Hello',bbox:{x0:1,y0:2,x1:30,y1:40}},a=regionStyleKey(page,r),b=regionStyleKey(page,{...r,text:'Other'});
 await Promise.all([store.set(a,{fontSizeImagePx:32}),store.set(b,{fontSizeImagePx:41})]);
 const loaded=new RegionStyleStore(file);assert.equal((await loaded.get(a)).fontSizeImagePx,32);assert.equal((await loaded.get(b)).fontSizeImagePx,41);
 await loaded.set(a,null);assert.equal(await loaded.get(a),null);assert.equal((await loaded.get(b)).fontSizeImagePx,41);
 await assert.rejects(loaded.set(b,{fontSizeImagePx:Infinity}));assert.equal((await loaded.get(b)).fontSizeImagePx,41);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('provider failure in later batch keeps earlier successful translations',async()=>{
 let calls=0;const service=new OcrTranslationService({google:{translate:async rows=>{calls++;if(calls===2)throw Error('temporary unavailable');return rows.map(r=>({id:r.id,translation:'สวัสดี'}));}}});
 const result=await service.translate(Array.from({length:25},(_,i)=>({id:'r'+i,text:'Hello '+i,confidence:99})),{provider:'google'});
 assert.equal(result.translated,20);assert.equal(result.failed,5);assert.equal(result.items.length,25);assert.match(result.items[24].error,/temporary unavailable/);
});
test('retry reuses only the same image, source, provider, languages and geometry',()=>{
 const options={provider:'google',sourceLanguage:'en',targetLanguage:'th',imageDigest:'abc'},r={text:'Hello',translation:'สวัสดี',bbox:{x0:1,y0:1,x1:30,y1:30}};
 r.translationRecord={...options,status:'translated',sourceText:r.text,bbox:{...r.bbox}};
 assert.equal(reusableTranslation(r,options),true);assert.equal(reusableTranslation(r,{...options,imageDigest:'other'}),false);assert.equal(reusableTranslation({...r,text:'Different'},options),false);assert.equal(reusableTranslation(r,{...options,targetLanguage:'ja'}),false);
});
test('Google worker retries a transient batch once and preserves previous batches',async()=>{
 const c=new GoogleTranslateWebClient({batchItems:1});let calls=0;
 c.translateBatch=async items=>{calls++;if(items[0].id==='b')throw Error('temporary');return [{id:items[0].id,translation:'สวัสดี'}];};
 try{const result=await c.translate([{id:'a',text:'Hello'},{id:'b',text:'Bye'}]);assert.equal(result.length,2);assert.equal(result[0].translation,'สวัสดี');assert.equal(result[1].translation,'');assert.match(result[1].error,/temporary/);assert.equal(calls,3);}finally{c.close();}
});
test('Google missing marker retries only that region without markers',async()=>{
 const c=new GoogleTranslateWebClient();const retried=[];
 c.translateBatch=async()=>[{id:'a',translation:'สวัสดี'},{id:'b',translation:''}];c.translateSingle=async item=>{retried.push(item.id);return {id:item.id,translation:'ลาก่อน'};};
 try{const result=await c.translate([{id:'a',text:'Hello'},{id:'b',text:'Bye'}]);assert.deepEqual(retried,['b']);assert.equal(result[1].translation,'ลาก่อน');}finally{c.close();}
});

test('Thai translations may keep source URLs/usernames without being marked untranslated',()=>{
 const {translationLanguageIssue}=require('../src/ocr-translation.cjs');
 assert.equal(translationLanguageIssue('แปลโดย: KITTYBLUE9','th','TRANSLATED BY: KITTYBLUE9'),'');
 assert.equal(translationLanguageIssue('ลิงก์ PayPal: ลิงก์ KO-FI: PAYPAL.ME/KITTYBLUENINE KO-FI.COM/KITTYBLUE9','th','PayPal LINK: OKo-fi LINK: PAYPAL.ME/KITTYBLUENINE KO-FI.COM/KITTYBLUE9'),'');
 assert.notEqual(translationLanguageIssue('THIS IS STILL ENGLISH','th','THIS IS STILL ENGLISH'),'');
});
test('explicit provider failure is not retried once for every region after its batch retries are exhausted',async()=>{
 let calls=0;const service=new OcrTranslationService({google:{translate:async rows=>{calls++;return rows.map(r=>({id:r.id,translation:'',error:'temporary provider unavailable'}));}}});
 const result=await service.translate([{id:'a',text:'Hello',confidence:99},{id:'b',text:'Bye',confidence:99}]);assert.equal(result.failed,2);assert.equal(calls,1);
});
