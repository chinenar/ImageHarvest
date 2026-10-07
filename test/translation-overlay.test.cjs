'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {overlayPage}=require('../src/translation-overlay.cjs');
const {normalizeRegionStyle}=require('../src/region-style-store.cjs');
const {annotateContent,contentRole}=require('../src/ocr-content-role.cjs');
test('confirmed watermark is not promoted to dialogue by an inferred closed surface',()=>{
 const [mark]=annotateContent([{text:'RITHA\nSCAN'}]);
 assert.equal(contentRole({...mark,placement:{surfaceType:'bubble'}}).excluded,true);
 assert.equal(contentRole({...mark,kind:'bubble',placement:{surfaceType:'bubble'}}).excluded,false);
 assert.equal(contentRole({...mark,contentOverride:true,placement:{surfaceType:'bubble'}}).excluded,false);
});
const region=(id,extra={})=>({id,text:'HELLO',translation:'สวัสดี',bbox:{x0:20,y0:30,x1:80,y1:70},translationRecord:{status:'translated',sourceText:'HELLO',imageDigest:'digest',bbox:{x0:20,y0:30,x1:80,y1:70}},...extra});
test('overlay retains matching translation provenance and excludes failed, stale, watermark and uncertain readings',()=>{
 const rows=[region('good'),region('mark',{kind:'watermark'}),region('uncertain',{confidence:30,reviewRequired:true}),region('old',{text:'CHANGED'}),region('failed',{translationRecord:{status:'failed'}}),region('moved',{bbox:{x0:21,y0:30,x1:80,y1:70}}),region('wrong-image',{translationRecord:{status:'translated',sourceText:'HELLO',imageDigest:'other'}})];
 const page=overlayPage({id:'p',sourceUrl:'https://example.test/page.png',width:100,height:200,imageDigest:'digest',ocr:{regions:rows}});
 assert.deepEqual(page.regions.map(r=>r.id),['good']);assert.deepEqual(page.regions[0].safeBox,{x0:.2,y0:.15,x1:.8,y1:.35});
});
test('partial shared balloon covers only successfully translated source bounds',()=>{
 const placement={surfaceId:'bubble',sharedSurface:true,surfaceType:'bubble',eraseBox:{x0:0,y0:0,x1:100,y1:200},safeBox:{x0:0,y0:0,x1:100,y1:200}};
 const good=region('good',{placement}),missing=region('missing',{placement,translation:''});
 const page=overlayPage({id:'p',width:100,height:200,imageDigest:'digest',ocr:{regions:[good,missing]}});
 assert.equal(page.regions.length,1);assert.deepEqual(page.regions[0].eraseBox,page.regions[0].bbox);
});

test('bubble overlay erases OCR glyph boxes that spill slightly outside the detected polygon',()=>{
 const spill=region('spill',{
  words:[{text:'HELLO',bbox:{x0:15,y0:38,x1:45,y1:55}}],
  placement:{
   surfaceType:'bubble',surfaceId:'bubble-1',shape:'polygon',paintMode:'flat-fill-polygon',fillColor:'#ffffff',confidence:.95,
   polygon:[[20,20],[80,20],[80,80],[20,80]],eraseBox:{x0:20,y0:20,x1:80,y1:80},safeBox:{x0:25,y0:25,x1:75,y1:75},
   speechSurface:{eraseBox:{x0:20,y0:20,x1:80,y1:80}},
   sourceEraseBoxes:[{x0:15,y0:38,x1:45,y1:55}]
  }
 });
 const page=overlayPage({id:'p',width:100,height:100,imageDigest:'digest',ocr:{regions:[spill]}});
 assert.equal(page.regions.length,1);
 assert.equal(page.regions[0].eraseBoxes.length,1);
 assert.ok(page.regions[0].eraseBoxes[0].x0<page.regions[0].polygon[0][0]);
 assert.ok(page.regions[0].eraseBoxes[0].x0>=.14);
});

test('materialized zones remain independent in the live translation overlay',()=>{
 const placement=(surfaceId,erase,safe,polygon)=>({
  surfaceType:'bubble',surfaceId,sharedSurface:true,surfaceMembers:['a','b'],placementZone:true,
  shape:'polygon',paintMode:'flat-fill-polygon',fillColor:'#ffffff',confidence:.95,
  eraseBox:erase,safeBox:safe,polygon,sourceEraseBoxes:[erase]
 });
 const a=region('a',{bbox:{x0:10,y0:20,x1:40,y1:55},translationRecord:{status:'translated',sourceText:'HELLO',imageDigest:'digest',bbox:{x0:10,y0:20,x1:40,y1:55}},placement:placement('bubble-1',{x0:5,y0:10,x1:48,y1:80},{x0:10,y0:20,x1:45,y1:70},[[5,10],[48,10],[48,80],[5,80]])});
 const b=region('b',{bbox:{x0:60,y0:20,x1:90,y1:55},translationRecord:{status:'translated',sourceText:'HELLO',imageDigest:'digest',bbox:{x0:60,y0:20,x1:90,y1:55}},placement:placement('bubble-1',{x0:52,y0:10,x1:95,y1:80},{x0:55,y0:20,x1:90,y1:70},[[52,10],[95,10],[95,80],[52,80]])});
 const page=overlayPage({id:'p',width:100,height:100,imageDigest:'digest',ocr:{regions:[a,b]}});
 assert.equal(page.regions.length,2);
 assert.ok(page.regions[0].safeBox.x1<=.45);
 assert.ok(page.regions[1].safeBox.x0>=.55);
});

test('region style accepts normalized box overrides with or without a manual font size',()=>{
 const box={x0:.1,y0:.2,x1:.7,y1:.8};
 assert.deepEqual(normalizeRegionStyle({box}),{box});
 assert.deepEqual(normalizeRegionStyle({fontSizeImagePx:18.25,box}),{fontSizeImagePx:18.25,box});
 assert.deepEqual(normalizeRegionStyle({text:'แก้คำแปลแล้ว',box}),{text:'แก้คำแปลแล้ว',box});
 assert.throws(()=>normalizeRegionStyle({box:{x0:-.1,y0:0,x1:.5,y1:.5}}),/กรอบข้อความ/);
});
