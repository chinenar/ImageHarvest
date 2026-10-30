'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),sharp=require('sharp'),fs=require('node:fs'),path=require('node:path');
const {resolveReadingUnits}=require('../src/reading-units.cjs');const {LocalOcrBackend,runtimeRoot}=require('../src/ocr-backend.cjs');const {TextPlacementPlanner}=require('../src/text-placement.cjs');const {contentRole}=require('../src/ocr-content-role.cjs');const {OcrTranslationService}=require('../src/ocr-translation.cjs');const {ensureContinuousReader}=require('../src/reader-mode.cjs');
const l=(text,x0,y0,x1,y1)=>({text,bbox:{x0,y0,x1,y1},confidence:98});

test('placement without text refinement runs one final surface pass and preserves competition geometry',async()=>{
 const {planReadingPage}=require('../src/reader-quality.cjs');const calls=[];
 const source=[{id:'a',text:'Hello',confidence:99,bbox:{x0:10,y0:10,x1:50,y1:30}}];
 const backend={layoutSafe:async(image,rows,options)=>{calls.push(options);assert.deepEqual(rows[0].bbox,source[0].bbox);return {width:100,height:80,regions:[{id:'a',placement:{surfaceType:'bubble',safeBox:{x0:5,y0:5,x1:55,y1:35},eraseBox:source[0].bbox}}]};}};
 const result=await planReadingPage(backend,Buffer.alloc(0),source);
 assert.equal(calls.length,1);assert.equal(calls[0].includeSplitHints,false);
 assert.equal(result.regions[0].placement.normalized.safeBox.x1,.55);
 assert.deepEqual(result.changes,[]);assert.equal(source[0].placement,undefined);
});
test('complementary OCR fragments compose one paragraph while original readings stay unchanged',()=>{
 const rows=[{id:'a',text:'I lost my\nyears',bbox:{x0:10,y0:10,x1:95,y1:72},recognitionLines:[l('I lost my',10,10,95,27),l('years',10,55,42,72)]},{id:'b',text:'parents\nold so I\nfacility',bbox:{x0:10,y0:28,x1:110,y1:94},recognitionLines:[l('parents',10,30,105,47),l('old so I',45,55,110,72),l('facility',20,77,100,94)]}];const saved=structuredClone(rows);
 const placements=rows.map(r=>({id:r.id,placement:{surfaceKey:'caption',surfaceValidated:true}}));const result=resolveReadingUnits(rows,placements);
 assert.equal(result.regions.length,1);assert.match(result.regions[0].text,/I lost my\nparents\nyears old so I\nfacility/);assert.equal(result.regions[0].sourceObservations.length,2);assert.deepEqual(rows,saved);assert.equal(result.regions[0].translationRecord,undefined);
});
test('tesseract word-only fragments on one validated speech line are recomposed before translation',()=>{
 const rows=[
  {id:'a',text:'...A',bbox:{x0:34,y0:40,x1:86,y1:76},confidence:91,words:[l('...A',34,40,86,76)]},
  {id:'b',text:'LRlGHT.',bbox:{x0:92,y0:40,x1:184,y1:76},confidence:90,words:[l('LRlGHT.',92,40,184,76)]}
 ];
 const placements=rows.map(r=>({id:r.id,placement:{surfaceType:'bubble',surfaceKey:'same-balloon',surfaceValidated:true,eraseBox:{x0:10,y0:10,x1:210,y1:120}}}));
 const result=resolveReadingUnits(rows,placements);
 assert.equal(result.regions.length,1);assert.equal(result.regions[0].text,'...A LRlGHT.');assert.deepEqual(result.regions[0].sourceRegionIds,['a','b']);
});
test('distant word-only regions on the same broad speech surface stay independent',()=>{
 const rows=[
  {id:'left',text:'LEFT',bbox:{x0:20,y0:40,x1:85,y1:110},confidence:96,words:[l('LEFT',22,45,80,70)]},
  {id:'right',text:'RIGHT',bbox:{x0:135,y0:42,x1:200,y1:112},confidence:96,words:[l('RIGHT',140,47,195,72)]}
 ];
 const placements=rows.map(r=>({id:r.id,placement:{surfaceType:'bubble',surfaceKey:'same-wide-balloon',surfaceValidated:true,eraseBox:{x0:0,y0:0,x1:220,y1:180}}}));
 assert.equal(resolveReadingUnits(rows,placements).regions.length,2);
});
test('contained shortened duplicate lines cannot become additional translation boxes',()=>{
 const rows=[{id:'full',text:'The reason why I\nregained',bbox:{x0:10,y0:10,x1:150,y1:65},recognitionLines:[l('The reason why I',10,10,150,30),l('regained',35,40,115,60)]},{id:'fragment',text:'The rea\nreg',bbox:{x0:8,y0:8,x1:72,y1:65},recognitionLines:[l('The rea',10,10,72,30),l('reg',35,40,65,60)]}];
 const result=resolveReadingUnits(rows,[]);assert.equal(result.regions.length,1);assert.equal(result.regions[0].text,'The reason why I\nregained');assert.equal(result.regions[0].unitSuppressedLines.length,2);
});
test('neighboring independent bubbles are not merged because their rectangles touch',()=>{
 const rows=[{id:'a',text:'Hello',bbox:{x0:10,y0:10,x1:80,y1:60},recognitionLines:[l('Hello',10,10,80,30)]},{id:'b',text:'World',bbox:{x0:65,y0:40,x1:130,y1:100},recognitionLines:[l('World',65,65,130,90)]}];assert.equal(resolveReadingUnits(rows,[]).regions.length,2);
});
test('a number hallucinated by one invert pass is review-only even beside a white surface',()=>{
 const row={text:'4',recognitionEngine:'paddleocr',reviewRequired:true,confidence:80,placement:{surfaceType:'bubble',confidence:.99,reviewRequired:false},alternatives:[{engine:'paddleocr',variant:'original',text:''},{engine:'paddleocr',variant:'contrast',text:''},{engine:'paddleocr',variant:'invert',text:'4'}]};assert.equal(contentRole(row).role,'uncertain');assert.equal(contentRole({...row,reviewed:true}).excluded,false);
});
test('raster patches and raw observation payloads never go to the text translation provider',async()=>{
 const service=new OcrTranslationService({google:{translate:async rows=>{assert.equal(rows[0].placement,undefined);assert.equal(rows[0].sourceObservations,undefined);return [{id:'x',translation:'สวัสดี'}];}}});
 const result=await service.translate([{id:'x',text:'Hello',confidence:99,placement:{erasePatch:{png:'PRIVATE_PIXELS'}},sourceObservations:[{secret:'RAW_PIXELS'}]}],{provider:'google',targetLanguage:'th'});assert.equal(result.translated,1);
});
test('unsupported readers keep their existing mode without guessed DOM changes',async()=>{let called=false;const result=await ensureContinuousReader({getURL:()=> 'https://example.com/read/2',executeJavaScript:async()=>{called=true;}});assert.equal(result.supported,false);assert.equal(called,false);});
const ready=fs.existsSync(path.join(runtimeRoot(),'Scripts/python.exe'));

test('paragraph cleanup preserves artwork between measured lines while erasing source glyphs',{skip:!ready},async()=>{
 const image=await sharp(Buffer.from('<svg width="240" height="220"><rect width="240" height="220" fill="#aaa"/><rect x="15" y="15" width="210" height="190" fill="white" stroke="black"/><rect x="60" y="45" width="15" height="25"/><rect x="60" y="145" width="15" height="25"/><circle cx="100" cy="110" r="16" fill="none" stroke="black" stroke-width="3"/></svg>')).png().toBuffer();
 const rows=[{id:'a',text:'A\nB',bbox:{x0:45,y0:40,x1:150,y1:180},recognitionLines:[l('A',45,40,150,75),l('B',45,140,150,180)]}];
 const backend=new LocalOcrBackend();try{
  const result=await backend.layoutSafe(image,rows,{includeSplitHints:false}),p=result.regions[0].placement,patch=p.erasePatch;
  assert.notEqual(p.paintMode,'none');assert.ok(patch.ownership.unreadShapePixels>0);
  const {data,info}=await sharp(Buffer.from(patch.png,'base64')).raw().toBuffer({resolveWithObject:true});
  const alpha=(x,y)=>data[((y-patch.bbox.y0)*info.width+x-patch.bbox.x0)*4+3];
  for(let y=90;y<=130;y++)for(let x=80;x<=120;x++)assert.equal(alpha(x,y),0,'artwork must remain untouched');
  assert.equal(alpha(65,55),255);assert.equal(alpha(65,155),255);
  const b=p.safeBox;
  assert.ok(Math.min(b.x1,119)<=Math.max(b.x0,81)||Math.min(b.y1,129)<=Math.max(b.y0,91),'text must avoid the artwork including its empty interior');
  assert.ok(b.x0>=45&&b.x1<=150&&b.y0>=40&&b.y1<=180,'text must stay near its source');
 }finally{backend.close();}
});

test('partially clipped glyphs are not discarded as artwork',{skip:!ready},async()=>{
 const image=await sharp(Buffer.from('<svg width="160" height="110"><rect width="160" height="110" fill="white"/><rect x="45" y="30" width="12" height="40"/></svg>')).png().toBuffer();
 const rows=[{id:'a',text:'I',bbox:{x0:40,y0:40,x1:70,y1:62},recognitionLines:[l('I',40,40,70,62)]}];
 const backend=new LocalOcrBackend();try{
  const p=(await backend.layoutSafe(image,rows,{includeSplitHints:false})).regions[0].placement;
  assert.notEqual(p.paintMode,'none');assert.equal(p.erasePatch.ownership.unreadShapePixels,0);assert.ok(p.erasePatch.pixels>100);
 }finally{backend.close();}
});

test('cleanup padding cannot erase a neighboring word, including a review-only neighbor',{skip:!ready},async()=>{
 const image=await sharp(Buffer.from('<svg width="180" height="100"><rect width="180" height="100" fill="white"/><rect x="35" y="30" width="12" height="30"/><rect x="90" y="30" width="12" height="30"/></svg>')).png().toBuffer();
 const rows=[{id:'own',text:'A',bbox:{x0:30,y0:25,x1:85,y1:65},recognitionLines:[l('A',30,25,85,65)]},{id:'peer',text:'B',bbox:{x0:89,y0:25,x1:110,y1:65},recognitionLines:[l('B',89,25,110,65)],excludeFromLayoutCompetition:true}];
 const backend=new LocalOcrBackend();try{
  const result=await backend.layoutSafe(image,rows,{includeSplitHints:false}),p=result.regions[0].placement,patch=p.erasePatch;
  assert.ok(patch.ownership.protectedPixels>0);assert.equal(patch.ownership.ambiguousPixels,0);assert.notEqual(p.paintMode,'none');
  const {data,info}=await sharp(Buffer.from(patch.png,'base64')).raw().toBuffer({resolveWithObject:true});
  for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++)if(x+patch.bbox.x0>=89)assert.equal(data[(y*info.width+x)*4+3],0);
  assert.equal(result.regions[1].placement.paintMode,'none');
 }finally{backend.close();}
});

test('connected ink shared by two readings cannot be assigned or painted automatically',{skip:!ready},async()=>{
 const image=await sharp(Buffer.from('<svg width="180" height="100"><rect width="180" height="100" fill="white"/><rect x="35" y="30" width="12" height="30"/><rect x="75" y="30" width="12" height="30"/><rect x="45" y="43" width="32" height="4"/></svg>')).png().toBuffer();
 const rows=[{id:'own',text:'A',bbox:{x0:30,y0:25,x1:66,y1:65},recognitionLines:[l('A',30,25,66,65)]},{id:'peer',text:'B',bbox:{x0:64,y0:25,x1:91,y1:65},recognitionLines:[l('B',64,25,91,65)]}];
 const backend=new LocalOcrBackend();try{
  const result=await backend.layoutSafe(image,rows,{includeSplitHints:false});
  for(const r of result.regions){assert.equal(r.placement.paintMode,'none');assert.equal(r.placement.cleanupReview,'shared-ink-needs-review');assert.ok(r.placement.erasePatch.ownership.ambiguousPixels>0);assert.equal(contentRole({text:'A',reviewed:true,placement:r.placement}).excluded,true);}
 }finally{backend.close();}
});
test('real glyph patches do not fill the bubble rectangle; normal captions never split',{skip:!ready},async()=>{
 const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="430"><rect width="600" height="430" fill="#aaa"/><rect x="40" y="50" width="240" height="310" fill="white" stroke="black" stroke-width="4"/><g font-family="Arial" font-size="25" fill="black"><text x="75" y="115">HELLO WORLD</text><text x="90" y="165">ONE CAPTION</text><text x="100" y="215">THIRD LINE</text><text x="90" y="265">FINAL LINE</text><text x="370" y="160">SCENE</text></g></svg>');const image=await sharp(svg).png().toBuffer();const backend=new LocalOcrBackend();try{
 const regions=[{id:'caption',text:'HELLO WORLD\nONE CAPTION\nTHIRD LINE\nFINAL LINE',bbox:{x0:70,y0:88,x1:262,y1:270},recognitionLines:[l('HELLO WORLD',70,88,262,120),l('ONE CAPTION',85,139,270,171),l('THIRD LINE',95,188,264,222),l('FINAL LINE',85,238,256,270)]},{id:'scene',text:'SCENE',bbox:{x0:365,y0:130,x1:460,y1:164},recognitionLines:[l('SCENE',365,130,460,164)]}];
 const result=await backend.layoutSafe(image,regions);const caption=result.regions[0].placement;assert.equal(caption.splitHints.length,0);assert.equal(caption.surfaceValidated,true);assert.ok(caption.safeBox.x0>=42&&caption.safeBox.x1<=278);assert.ok(caption.safeBox.y0>=52&&caption.safeBox.y1<=358);assert.ok(caption.erasePatch.png);assert.ok(caption.erasePatch.pixels>100);assert.ok(caption.erasePatch.pixels<(caption.erasePatch.bbox.x1-caption.erasePatch.bbox.x0)*(caption.erasePatch.bbox.y1-caption.erasePatch.bbox.y0)*.6);
 const {data,info}=await sharp(Buffer.from(caption.erasePatch.png,'base64')).ensureAlpha().raw().toBuffer({resolveWithObject:true});let opaque=0;for(let i=3;i<data.length;i+=4)if(data[i])opaque++;assert.equal(opaque,caption.erasePatch.pixels);assert.equal(info.channels,4);
 }finally{backend.close();}
});

test('dark source buttons keep a dark background descriptor for readable white translated text',{skip:!ready},async()=>{
 const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#555"/><rect x="60" y="55" width="200" height="90" rx="12" fill="#08090a"/><text x="115" y="114" font-family="Arial" font-size="44" fill="white">NO</text></svg>');const image=await sharp(svg).png().toBuffer();const backend=new LocalOcrBackend();try{const result=await backend.layoutSafe(image,[{id:'dark',text:'NO',bbox:{x0:110,y0:74,x1:184,y1:120},recognitionLines:[l('NO',110,74,184,120)]}]);const p=result.regions[0].placement;assert.ok(p.erasePatch?.png);const rgb=p.fillColor.slice(1).match(/../g).map(v=>parseInt(v,16));assert.ok(rgb.reduce((a,b)=>a+b,0)/3<110,JSON.stringify({fillColor:p.fillColor,method:p.erasePatch.method}));assert.equal(p.fillColor,p.erasePatch.backgroundColor);}finally{backend.close();}
});


test('MangaDex reader cycles single-page mode to Long Strip before translation',async()=>{
 let step=0;
 const modes=['Single Page','Double Page','Long Strip'];
 const wc={
  getURL:()=> 'https://mangadex.org/chapter/example-id/1',
  executeJavaScript:async()=>({mode:modes[Math.min(step++,modes.length-1)]})
 };
 const result=await ensureContinuousReader(wc);
 assert.equal(result.supported,true);
 assert.equal(result.changed,true);
 assert.equal(result.previous,'Single Page');
 assert.equal(result.mode,'Long Strip');
 assert.equal(step,4); // final call verifies/repairs scroll after Long Strip is active
});
