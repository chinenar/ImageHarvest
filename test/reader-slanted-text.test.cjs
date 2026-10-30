'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),sharp=require('sharp');
const {markOverlappingReadings}=require('../src/ocr-overlap-review.cjs');
const {recoverSlantedText}=require('../src/reader-slanted-text.cjs');
test('a contained suffix cannot block its independently read full sentence',()=>{
 const full={id:'full',text:'This sentence ends well',bbox:{x0:10,y0:10,x1:210,y1:40},recognitionLines:[{text:'This sentence ends well',confidence:99,bbox:{x0:10,y0:10,x1:210,y1:40}}]};
 const fragment={id:'fragment',text:'well',bbox:{x0:180,y0:10,x1:210,y1:40},recognitionLines:[{text:'well',confidence:98,bbox:{x0:180,y0:10,x1:210,y1:40}}]};
 const out=markOverlappingReadings([full,fragment]);assert.equal(out[0].overlapReview,undefined);assert.ok(out[1].overlapReview);
 const conflict={...fragment,text:'milk',recognitionLines:[{...fragment.recognitionLines[0],text:'milk'}]};assert.ok(markOverlappingReadings([full,conflict])[0].overlapReview);
});
test('deskew retry accepts only a confident extension and invalidates the old translation',async()=>{
 const image=await sharp({create:{width:300,height:300,channels:3,background:'white'}}).png().toBuffer();
 const row={id:'a',text:'Hell',bbox:{x0:50,y0:50,x1:170,y1:170},translation:'old',translationRecord:{status:'translated'},recognitionLines:[{text:'Hell',confidence:99,bbox:{x0:50,y0:50,x1:170,y1:170},polygon:[[60,50],[170,160],[160,170],[50,60]]}]};
 const backend={read:async()=>({lines:[{text:'Hello',confidence:99,polygon:[[50,100],[160,100],[160,120],[50,120]]}]})};
 const [out]=await recoverSlantedText(backend,image,[row],{sourceLanguage:'en'});assert.equal(out.text,'Hello');assert.equal(out.translation,undefined);assert.equal(out.translationRecord,undefined);assert.equal(out.slantedRecovery.previousText,'Hell');assert.ok(out.bbox.x0>=0&&out.bbox.x1<=300);
 backend.read=async()=>({lines:[{text:'Goodbye',confidence:99,polygon:[[50,100],[160,100],[160,120],[50,120]]}]});assert.equal((await recoverSlantedText(backend,image,[row],{sourceLanguage:'en'}))[0].text,'Hell');
});
