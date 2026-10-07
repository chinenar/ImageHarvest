'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const sharp=require('sharp');
const {LocalOcrBackend,runtimeRoot}=require('../src/ocr-backend.cjs');
const {TextPlacementPlanner,reconcilePlacements,placementStats,splitConnectedBubbleSurfaces,materializePlacementZones}=require('../src/text-placement.cjs');

const bubble=(id,bbox,polygon,confidence=.9)=>({
 id,bbox,
 placement:{
  surfaceType:'bubble',shape:'polygon',polygon,eraseBox:{x0:0,y0:0,x1:100,y1:100},
  safeBox:bbox,fillColor:'#ffffff',flatFillSafe:true,requiresInpaint:false,
  paintMode:'flat-fill-polygon',confidence,reviewRequired:false,detectionMode:'test'
 }
});

test('text region inside an existing balloon reuses that balloon surface',()=>{
 const a=bubble('a',{x0:20,y0:20,x1:60,y1:60},[[10,10],[90,10],[90,90],[10,90]]);
 const scene={id:'b',bbox:{x0:62,y0:25,x1:82,y1:55},placement:{
  surfaceType:'scene',shape:'rect',eraseBox:{x0:60,y0:20,x1:85,y1:60},safeBox:{x0:60,y0:20,x1:85,y1:60},
  paintMode:'inpaint-rect',requiresInpaint:true,confidence:.86,reviewRequired:false
 }};
 const out=reconcilePlacements([a,scene]);
 assert.equal(out[0].placement.surfaceType,'bubble');
 assert.equal(out[1].placement.surfaceType,'bubble');
 assert.equal(out[0].placement.surfaceId,out[1].placement.surfaceId);
 assert.deepEqual(out[0].placement.surfaceMembers.sort(),['a','b']);
});

test('separate scene text remains a rectangular inpaint surface',()=>{
 const a=bubble('a',{x0:20,y0:20,x1:60,y1:60},[[10,10],[90,10],[90,90],[10,90]]);
 const scene={id:'s',bbox:{x0:180,y0:30,x1:240,y1:60},placement:{
  surfaceType:'scene',shape:'rect',eraseBox:{x0:170,y0:20,x1:250,y1:70},safeBox:{x0:170,y0:20,x1:250,y1:70},
  paintMode:'inpaint-rect',requiresInpaint:true,confidence:.86,reviewRequired:false
 }};
 const [_,out]=reconcilePlacements([a,scene]);
 assert.equal(out.placement.surfaceType,'scene');
 assert.equal(out.placement.shape,'rect');
 assert.match(out.placement.surfaceId,/^scene-/);
});

test('placementStats counts paint-risk buckets',()=>{
 const rows=[
  bubble('a',{x0:1,y0:1,x1:20,y1:20},[[0,0],[30,0],[30,30],[0,30]]),
  {id:'s',placement:{surfaceType:'scene',requiresInpaint:true,reviewRequired:true,flatFillSafe:false}}
 ];
 assert.deepEqual(placementStats(rows),{total:2,bubble:1,scene:1,reviewRequired:1,flatFillSafe:1,requiresInpaint:1});
});

const ready=fs.existsSync(path.join(runtimeRoot(),'Scripts/python.exe'));
test('local layout backend distinguishes closed balloon from unboxed scene text',{skip:!ready},async()=>{
 const svg=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="420">
  <rect width="600" height="420" fill="#8f8f8f"/>
  <ellipse cx="190" cy="170" rx="130" ry="105" fill="#fff" stroke="#111" stroke-width="8"/>
  <rect x="135" y="135" width="110" height="12" fill="#111"/>
  <rect x="125" y="162" width="130" height="12" fill="#111"/>
  <rect x="140" y="189" width="100" height="12" fill="#111"/>
  <rect x="390" y="140" width="120" height="14" fill="#111"/>
  <rect x="405" y="168" width="90" height="14" fill="#111"/>
 </svg>`);
 const image=await sharp(svg).png().toBuffer();
 const backend=new LocalOcrBackend(),planner=new TextPlacementPlanner({backend});
 try{
  const result=await planner.planPage(image,[
   {id:'bubble',text:'HELLO',bbox:{x0:120,y0:125,x1:260,y1:212},orientation:'horizontal'},
   {id:'scene',text:'SCENE',bbox:{x0:380,y0:130,x1:520,y1:192},orientation:'horizontal'}
  ]);
  const byId=new Map(result.regions.map(r=>[r.id,r.placement]));
  assert.equal(byId.get('bubble').surfaceType,'bubble');
  assert.equal(byId.get('bubble').shape,'polygon');
  assert.equal(byId.get('bubble').paintMode,'glyph-patch');
  assert.ok(byId.get('bubble').polygon.length>=6);
  assert.ok(byId.get('bubble').normalized.polygon.every(p=>p.every(v=>v>=0&&v<=1)));
  assert.equal(byId.get('scene').surfaceType,'scene');
  assert.equal(byId.get('scene').shape,'rect');
  assert.equal(byId.get('scene').paintMode,'glyph-patch');
  assert.ok(byId.get('scene').normalized.safeBox.x0>0&&byId.get('scene').normalized.safeBox.x1<=1);
 }finally{backend.close();}
});

test('connected double bubble creates two placement sub-surfaces from OCR word columns',()=>{
 const row={
  id:'double',bbox:{x0:35,y0:45,x1:185,y1:160},text:'LEFT RIGHT',
  words:[
   {text:'A',bbox:{x0:35,y0:50,x1:55,y1:70}},{text:'B',bbox:{x0:40,y0:80,x1:60,y1:100}},{text:'C',bbox:{x0:42,y0:110,x1:62,y1:130}},
   {text:'D',bbox:{x0:155,y0:48,x1:175,y1:68}},{text:'E',bbox:{x0:150,y0:78,x1:170,y1:98}},{text:'F',bbox:{x0:152,y0:108,x1:172,y1:128}}
  ],
  placement:{
   surfaceType:'bubble',shape:'polygon',surfaceId:'bubble-001',
   polygon:[[0,35],[55,5],[95,35],[110,70],[125,35],[165,5],[220,35],[220,165],[165,195],[125,165],[110,130],[95,165],[55,195],[0,165]],
   metrics:{solidity:.82},confidence:.9
  }
 };
 const [out]=splitConnectedBubbleSurfaces([structuredClone(row)]);
 assert.equal(out.placement.subSurfaceCount,2);
 assert.equal(out.placement.splitMode,'connected-bubble-columns');
 assert.equal(out.placement.splitEvidence.kind,'ocr-word-columns');
 assert.ok(out.placement.splitEvidence.pinchRatio<.96);
 assert.ok(out.placement.subSurfaces[0].safeBox.x1<=out.placement.subSurfaces[1].safeBox.x0);
});

test('normal single bubble is not split just because OCR words form left and right clusters',()=>{
 const row={
  id:'single',bbox:{x0:35,y0:45,x1:185,y1:160},text:'ONE BALLOON',
  words:[
   {text:'A',bbox:{x0:35,y0:50,x1:55,y1:70}},{text:'B',bbox:{x0:40,y0:80,x1:60,y1:100}},{text:'C',bbox:{x0:42,y0:110,x1:62,y1:130}},
   {text:'D',bbox:{x0:155,y0:48,x1:175,y1:68}},{text:'E',bbox:{x0:150,y0:78,x1:170,y1:98}},{text:'F',bbox:{x0:152,y0:108,x1:172,y1:128}}
  ],
  placement:{
   surfaceType:'bubble',shape:'polygon',surfaceId:'bubble-001',
   polygon:[[20,20],[200,20],[220,70],[220,140],[200,190],[20,190],[0,140],[0,70]],
   metrics:{solidity:.98},confidence:.9
  }
 };
 const [out]=splitConnectedBubbleSurfaces([structuredClone(row)]);
 assert.equal(out.placement.subSurfaceCount,undefined);
 assert.equal(out.placement.subSurfaces,undefined);
});

test('word-column fallback becomes two independent translation zones before translation',()=>{
 const row={
  id:'merged',text:'LEFT RIGHT',confidence:91,bbox:{x0:30,y0:40,x1:190,y1:150},
  words:[
   {text:'LEFT',bbox:{x0:35,y0:55,x1:75,y1:75}},
   {text:'ONE',bbox:{x0:35,y0:85,x1:70,y1:105}},
   {text:'SIDE',bbox:{x0:38,y0:115,x1:73,y1:135}},
   {text:'RIGHT',bbox:{x0:145,y0:52,x1:185,y1:72}},
   {text:'TWO',bbox:{x0:148,y0:82,x1:180,y1:102}},
   {text:'SIDE',bbox:{x0:150,y0:112,x1:184,y1:132}}
  ],
  placement:{
   surfaceType:'bubble',surfaceId:'bubble-001',shape:'polygon',
   polygon:[[0,35],[55,5],[95,35],[110,70],[125,35],[165,5],[220,35],[220,165],[165,195],[125,165],[110,130],[95,165],[55,195],[0,165]],
   eraseBox:{x0:0,y0:5,x1:220,y1:195},safeBox:{x0:20,y0:20,x1:200,y1:180},fillColor:'#fff',paintMode:'flat-fill-polygon',
   sharedSurface:false,metrics:{solidity:.82},confidence:.9
  }
 };
 const [split]=splitConnectedBubbleSurfaces([structuredClone(row)]);
 const zones=materializePlacementZones([split]);
 assert.equal(zones.length,2);
 assert.deepEqual(zones.map(z=>z.id),['merged::zone-1','merged::zone-2']);
 assert.ok(zones.every(z=>z.parentRegionId==='merged'&&z.placement.placementZone));
 assert.ok(zones[0].bbox.x1<zones[1].bbox.x0);
 assert.match(zones[0].text,/LEFT/);
 assert.match(zones[1].text,/RIGHT/);
 assert.equal(zones[0].placement.surfaceId,zones[1].placement.surfaceId);
 assert.notDeepEqual(zones[0].placement.eraseBox,zones[1].placement.eraseBox);
 assert.ok(zones.every(z=>z.placement.sourceEraseBoxes.length===3));
});

test('two OCR regions on one speech surface keep separate local placement zones',()=>{
 const shared={
  surfaceType:'bubble',surfaceId:'bubble-001',shape:'polygon',polygon:[[0,0],[220,0],[220,180],[0,180]],
  eraseBox:{x0:0,y0:0,x1:220,y1:180},safeBox:{x0:10,y0:10,x1:210,y1:170},fillColor:'#fff',paintMode:'flat-fill-polygon',
  sharedSurface:true,surfaceMembers:['a','b'],confidence:.95
 };
 const zones=materializePlacementZones([
  {id:'a',text:'LEFT',bbox:{x0:20,y0:40,x1:85,y1:110},words:[{text:'LEFT',bbox:{x0:22,y0:45,x1:80,y1:70}}],placement:structuredClone(shared)},
  {id:'b',text:'RIGHT',bbox:{x0:135,y0:42,x1:200,y1:112},words:[{text:'RIGHT',bbox:{x0:140,y0:47,x1:195,y1:72}}],placement:structuredClone(shared)}
 ]);
 assert.equal(zones.length,2);
 assert.ok(zones[0].placement.eraseBox.x1<=110);
 assert.ok(zones[1].placement.eraseBox.x0>=110);
 assert.ok(zones.every(z=>z.placement.sourceEraseBoxes.length===1));
});
