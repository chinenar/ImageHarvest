'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),sharp=require('sharp');
const {reconcileDiscovery}=require('../src/ocr-discovery.cjs');
const {mergeLineObservations,groupLines,refineBlocks}=require('../src/comic-text-detector.cjs');
const {composeLines,resolveReadingUnits}=require('../src/reading-units.cjs');
const {exclamationMark}=require('../src/ocr-punctuation.cjs');
const {resolveVerticalOwnership}=require('../src/ocr-reading-ownership.cjs');
const {obliqueOwnership}=require('../src/ocr-oblique-ownership.cjs');
const {neighborOwnership}=require('../src/ocr-neighbor-ownership.cjs');
const {rejoinParagraphs}=require('../src/ocr-paragraph-rejoin.cjs');
const {refineSparseGeometry}=require('../src/ocr-sparse-geometry.cjs');
const {displayBoxes}=require('../src/ocr-display-geometry.js');
const {outline,contains}=require('../src/ocr-display-geometry.js');
const {translationEligible}=require('../src/ocr-content-role.cjs');
const {fragmentOwner}=require('../src/ocr-fragment-ownership.cjs');
const {prepareCrop,validateCrop}=require('../src/ocr-crop.cjs');
const {smallCjkCandidate,confirmedCjk}=require('../src/ocr-region-language.cjs');
const {cropLines,lineBelongsToNeighbor}=require('../src/ocr-crop-lines.cjs');
const {originalIsSupported}=require('../src/ocr-retry-policy.cjs');
const {chooseReadings,confirmedDiscoveryLines,deduplicateReadings}=require('../src/enhanced-manga-ocr.cjs');
const {needsNumericProbe,verifiedNumeric}=require('../src/ocr-numeric-evidence.cjs');
const {repairEllipsis}=require('../src/ocr-ellipsis.cjs');
const {repairWordSpacing}=require('../src/ocr-word-spacing.cjs');
const {recoverWeakLines}=require('../src/ocr-line-recovery.cjs');
const b=(x0,y0,x1,y1)=>({x0,y0,x1,y1});
const line=(bbox,orientation='horizontal')=>({bbox,coreBbox:bbox,orientation,detectionConfidence:.9,confidence:98});

test('weak line recovery needs two distinct agreeing reads and independent baseline support',async()=>{
 const bbox=b(10,60,150,90),chosen={text:'One\nTwo\nONater Edge!',textLines:[{text:'One',confidence:99,bbox:b(10,0,100,20)},{text:'Two',confidence:99,bbox:b(10,30,100,50)},{text:'ONater Edge!',confidence:91,bbox}]};
 const baseline={text:'One\nTwo\nWater Edge!',confidence:77},candidate={lines:[line(bbox)]},options={width:200,height:200};
 const read=(variant)=>Promise.resolve({text:'Water Edge!',confidence:97,inferenceFingerprint:variant,engine:'paddleocr',textLines:[{text:'Water Edge!',bbox,confidence:97}]});
 const fixed=await recoverWeakLines(chosen,baseline,candidate,read,options);
 assert.equal(fixed.text,'One\nTwo\nWater Edge!');assert.equal(fixed.lineRecoveryEvidence.length,1);assert.equal(chosen.textLines[2].text,'ONater Edge!');
 assert.equal(await recoverWeakLines(chosen,{...baseline,text:'Something else'},candidate,read,options),chosen);
 assert.equal(await recoverWeakLines(chosen,baseline,candidate,()=>read('same'),options),chosen);
 const noCall=()=>{throw Error('unnecessary probe');};
 assert.equal(await recoverWeakLines(chosen,{...baseline,confidence:undefined},candidate,noCall,options),chosen);
 assert.equal(await recoverWeakLines(chosen,baseline,{...candidate,segmentation:'split'},noCall,options),chosen);
});

test('word spacing requires two readings and a larger source gap at the same character boundary',async()=>{
 const source=async spaced=>sharp(Buffer.from(`<svg width="100" height="40"><rect width="100" height="40" fill="white"/>${(spaced?[10,20,30,50,60]:[10,20,30,40,50]).map(x=>`<rect x="${x}" y="5" width="6" height="20"/>`).join('')}</svg>`)).png().toBuffer();
 const bbox=b(9,3,68,28),chosen={text:'ABCDE',textLines:[{text:'ABCDE',bbox,confidence:99}]};
 const read=(key,text='ABC DE')=>({engine:'paddleocr',inferenceFingerprint:key,textLines:[{text,bbox,confidence:98}]});
 const reads=[read('a'),read('b')],image=await source(true);
 const result=await repairWordSpacing(image,chosen,reads);
 assert.equal(result.text,'ABC DE');assert.equal(result.spacingEvidence.length,1);assert.equal(chosen.text,'ABCDE');
 assert.equal(await repairWordSpacing(await source(false),chosen,reads),chosen);
 assert.equal(await repairWordSpacing(image,chosen,[read('a'),read('a')]),chosen);
 assert.equal(await repairWordSpacing(image,chosen,[read('a')]),chosen);
 assert.equal(await repairWordSpacing(image,chosen,[read('a','AB CDE'),read('b','AB CDE')]),chosen);
 assert.equal(await repairWordSpacing(image,chosen,[read('a','ABC DF'),read('b','ABC DF')]),chosen);
});

test('ellipsis requires three aligned source dots plus an existing same-position reading',async()=>{
 const source=async count=>sharp(Buffer.from(`<svg width="90" height="40"><rect width="90" height="40" fill="white"/>${[10,20,30].map(x=>`<rect x="${x}" y="5" width="6" height="20"/>`).join('')}${Array.from({length:count},(_,i)=>`<rect x="${45+i*7}" y="22" width="3" height="3"/>`).join('')}</svg>`)).png().toBuffer();
 const bbox=b(9,3,67,28),chosen={text:'ABC.',textLines:[{text:'ABC.',bbox,confidence:98}]},readings=[{textLines:[{text:'ABC...',bbox,confidence:95}]}];
 const fixed=await repairEllipsis(await source(3),chosen,readings);
 assert.equal(fixed.text,'ABC...');assert.equal(fixed.punctuationEvidence.length,1);
 for(const count of [0,1,2,4])assert.equal(await repairEllipsis(await source(count),chosen,readings),chosen);
 assert.equal(await repairEllipsis(await source(3),chosen,[]),chosen);
 assert.equal(await repairEllipsis(await source(3),chosen,[{textLines:[{text:'ABD...',bbox,confidence:95}]}]),chosen);
 assert.equal(await repairEllipsis(await source(3),chosen,[{textLines:[{text:'ABC...',bbox:b(200,3,267,28),confidence:95}]}]),chosen);
 assert.equal(chosen.text,'ABC.');
});

test('leading slash is removed only when a crop-spanning border precedes three source dots',async()=>{
 const source=async border=>sharp(Buffer.from(`<svg width="120" height="60"><rect width="120" height="60" fill="white"/>${border?'<rect x="5" width="3" height="60"/>':''}${[35,50,65].map(x=>`<rect x="${x}" y="15" width="6" height="20"/>`).join('')}${[14,21,28].map(x=>`<rect x="${x}" y="32" width="3" height="3"/>`).join('')}</svg>`)).png().toBuffer();
 const bbox=b(5,10,85,38),chosen={text:'/...ABC',textLines:[{text:'/...ABC',bbox,confidence:96}]},reads=[{textLines:[{text:'...ABC',bbox:b(14,15,76,36),confidence:95}]}];
 assert.equal((await repairEllipsis(await source(true),chosen,reads)).text,'...ABC');
 assert.equal(await repairEllipsis(await source(false),chosen,reads),chosen);
});

test('numeric ambiguity requires an existing numeric reading and two positioned cross-model confirmations',()=>{
 const chosen={text:'-qq'},alternative={text:'-99',confidence:83};
 assert.equal(needsNumericProbe(chosen,[alternative]),true);
 for(const value of ['qq','Hello','-AB','-99'])assert.equal(needsNumericProbe({text:value},[alternative]),false);
 assert.equal(needsNumericProbe(chosen,[]),false);
 const probe=key=>({text:'-99',confidence:98,model:'PP-OCRv5/zh',inferenceFingerprint:key,engine:'paddleocr',textLines:[{text:'-99',bbox:b(10,10,80,50)}]});
 assert.equal(verifiedNumeric(chosen,[probe('a'),probe('b')]).text,'-99');
 assert.equal(verifiedNumeric(chosen,[probe('a'),probe('a')]),null);
 assert.equal(verifiedNumeric(chosen,[probe('a'),{...probe('b'),text:'-98'}]),null);
 assert.equal(verifiedNumeric(chosen,[probe('a'),{...probe('b'),confidence:75}]),null);
 assert.equal(verifiedNumeric(chosen,[probe('a'),{...probe('b'),textLines:[{bbox:b(200,10,270,50)}]}]),null);
});

test('verified numeric evidence owns an overlapping ambiguous duplicate, never a neighboring or manual reading',()=>{
 const verified={text:'-99',bbox:b(0,0,80,60),orientation:'horizontal',discoveryOnly:true,numericEvidence:{confirmed:true}};
 const raw={text:'-qq',bbox:b(5,5,75,55),orientation:'horizontal'};
 const result=deduplicateReadings([verified,raw]);assert.equal(result.length,1);assert.equal(result[0].text,'-99');assert.equal(result[0].duplicateObservations[0],raw);
 assert.equal(deduplicateReadings([{...verified,numericEvidence:undefined},raw]).length,2);
 assert.equal(deduplicateReadings([verified,{...raw,bbox:b(90,0,160,50)}]).length,2);
 assert.equal(deduplicateReadings([verified,{...raw,reviewed:true}]).length,2);
 const positioned={...verified,recognitionLines:[{bbox:b(0,0,80,40)}]};
 assert.equal(deduplicateReadings([positioned,{...raw,orientation:'vertical',recognitionLines:[{bbox:b(5,5,75,45)}]}]).length,1);
 assert.equal(deduplicateReadings([positioned,{...raw,orientation:'vertical',recognitionLines:[{bbox:b(5,5,25,55)}]}]).length,2);
});

test('supplemental substring at the same source position belongs to the complete line',()=>{
 const owner={recognitionLines:[{text:'PRACTICALLY',confidence:99,bbox:b(0,0,100,25)}]};
 const fragment={discoveryOnly:true,recognitionLines:[{text:'ALLY',bbox:b(60,0,100,25)}]};
 assert.equal(fragmentOwner(fragment,[owner,fragment]),owner);
 assert.equal(fragmentOwner({...fragment,reviewed:true},[owner]),null);
 assert.equal(fragmentOwner({...fragment,recognitionLines:[{text:'ALLY',bbox:b(60,50,100,75)}]},[owner]),null);
 assert.equal(fragmentOwner(fragment,[{recognitionLines:[{...owner.recognitionLines[0],confidence:70}]}]),null);
});

test('sparse high-confidence glyph does not lend a large artwork box its confidence',()=>{
 const glyph={text:'5',confidence:97,bbox:b(10,70,30,95)};
 const row={text:'5',bbox:b(0,0,150,150),detectionConfidence:.4,recognitionEngine:'paddleocr',recognitionLines:[glyph],discoveryLines:[{...glyph,detectionConfidence:.8}],alternatives:['a','b'].map(inferenceFingerprint=>({engine:'paddleocr',text:'5',textLines:[glyph],inferenceFingerprint}))};
 const result=refineSparseGeometry(row,{width:200,height:200});
 assert.deepEqual(result.bbox,b(7,67,33,98));assert.deepEqual(result.detectorBBox,row.bbox);
 assert.equal(result.text,'5');assert.equal(translationEligible(result),false);
 assert.equal(translationEligible({...result,reviewed:true,contentOverride:true}),true);
 for(const change of [{reviewed:true},{contentOverride:true},{segmentation:{}},{orientation:'vertical'},{detectionConfidence:.9},{discoveryLines:[]},{bbox:b(5,65,40,100)},{alternatives:row.alternatives.map(r=>({...r,inferenceFingerprint:'same'}))}]){
  const input={...row,...change};assert.equal(refineSparseGeometry(input,{width:200,height:200}),input);
 }
 assert.deepEqual(row.bbox,b(0,0,150,150));
});

test('display line geometry becomes invalid after text or bounding-box edits',()=>{
 const row={text:'one two',bbox:b(0,0,100,100)};
 row.displayGeometry={signature:JSON.stringify([row.text,row.bbox]),boxes:[b(0,0,40,20),b(50,50,100,70)]};
 assert.equal(displayBoxes(row).length,2);
 assert.deepEqual(displayBoxes({...row,text:'edited'}),[row.bbox]);
 assert.deepEqual(displayBoxes({...row,bbox:b(1,1,90,90)}),[b(1,1,90,90)]);
});

test('paragraph outline follows line extents and selects the gap without selecting neighboring space',()=>{
 const row={text:'one two',bbox:b(0,0,100,100)};
 row.displayGeometry={signature:JSON.stringify([row.text,row.bbox]),boxes:[b(0,0,40,20),b(20,40,100,60)]};
 assert.ok(outline(row).length>4);
 assert.equal(contains(row,30,25),true);
 assert.equal(contains(row,80,10),false);
 assert.equal(contains(row,5,50),false);
 assert.equal(contains(row,80,50),true);
 assert.equal(contains({...row,text:'edited'},80,10),true);
});

test('neighbor crop excludes supported foreign lines without changing overlapping own lettering',()=>{
 const observed=bbox=>({...line(bbox),polygon:[[bbox.x0,bbox.y0],[bbox.x1,bbox.y0],[bbox.x1,bbox.y1],[bbox.x0,bbox.y1]]});
 const left={bbox:b(0,0,110,80),lines:[line(b(0,0,90,20)),line(b(0,30,90,50))],discoveryLines:[observed(b(0,0,95,20)),observed(b(0,30,95,50))]};
 const right={bbox:b(90,0,200,100),lines:[line(b(105,55,200,70)),line(b(105,80,200,95))],discoveryLines:[observed(b(105,55,200,70)),observed(b(105,80,200,95))]};
 const input={boxes:[left,right]},saved=structuredClone(input),out=neighborOwnership(input);
 assert.equal(out.boxes[0].excludedPolygons.length,1);
 assert.deepEqual(input,saved);
 assert.equal(neighborOwnership({boxes:[left,{...right,orientation:'vertical'}]}).boxes[0].excludedPolygons,undefined);
 assert.equal(neighborOwnership({boxes:[left,{...right,discoveryLines:right.discoveryLines.map(l=>({...l,detectionConfidence:.4}))}]}).boxes[0].excludedPolygons,undefined);
});

test('paragraph rejoin requires aligned fragments and a single validated bubble',async()=>{
 const fragment=bbox=>({bbox,containerId:'parent',containerBBox:b(0,0,120,150),lines:[line(bbox)]});
 const input={boxes:[fragment(b(10,10,100,30)),fragment(b(10,60,100,80))]};
 const backend=placement=>({layoutSafe:async(bytes,rows)=>({regions:rows.map((r,i)=>({...r,placement:placement(i)}))})});
 const bubble={surfaceType:'bubble',surfaceValidated:true,surfaceKey:'one'};
 const result=await rejoinParagraphs(__filename,input,backend(()=>bubble));
 assert.equal(result.boxes.length,1);assert.equal(result.boxes[0].sourceDetectorFragments.length,2);
 assert.equal(input.boxes.length,2);
 for(const placement of [()=>({...bubble,surfaceValidated:false}),i=>({...bubble,surfaceKey:String(i)}),()=>({...bubble,splitHints:[{}]}),()=>({...bubble,surfaceType:'scene'})]){
  assert.equal(await rejoinParagraphs(__filename,input,backend(placement)),input);
 }
 const noCall={layoutSafe:()=>{throw Error('should not probe unrelated geometry');}};
 for(const boxes of [[input.boxes[0],fragment(b(110,60,200,80))],input.boxes.map(x=>({...x,orientation:'vertical'})),[input.boxes[0],fragment(b(10,120,100,140))]]){
  assert.equal((await rejoinParagraphs(__filename,{boxes},noCall)).boxes.length,2);
 }
});

test('skip variants only for independent exact readings covering every source line',()=>{
 const candidate={detectionConfidence:.9,lines:[line(b(10,10,80,30)),line(b(10,40,80,60))]};
 const read={engine:'paddleocr',text:'Hello\nworld!',confidence:98,lines:candidate.lines};
 const baseline={text:'Hello world!',confidence:92};
 assert.equal(originalIsSupported(read,baseline,candidate),true);
 for(const changed of [{...read,text:'Hello world'},{...read,lines:read.lines.slice(0,1)},{...read,confidence:null},{...read,confidence:undefined},{...read,confidence:94}])assert.equal(originalIsSupported(changed,baseline,candidate),false);
 for(const key of ['discoveryOnly','lineOnly','displayFont','reviewRequired'])assert.equal(originalIsSupported(read,baseline,{...candidate,[key]:true}),false);
 assert.equal(originalIsSupported(read,{...baseline,confidence:undefined},candidate),false);
 assert.equal(originalIsSupported(read,baseline,{...candidate,lines:candidate.lines.map(l=>({...l,detectionConfidence:undefined}))}),false);
});

test('identical prepared pixels cannot outvote a different reading or confirm a discovery',()=>{
 const original={engine:'paddleocr',text:'wrong',confidence:90,variant:'original',inferenceFingerprint:'same'};
 const alias={...original,variant:'grayscale',inferenceReused:true};
 const independent={...original,text:'correct',confidence:98,variant:'contrast',inferenceFingerprint:'different'};
 assert.equal(chooseReadings([original,alias,independent],{confidence:0}).text,'correct');
 const observation={...original,textLines:[{text:'wrong',confidence:99,bbox:b(0,0,80,20)}]};
 assert.deepEqual(confirmedDiscoveryLines([observation,{...observation,variant:'grayscale'}]),[]);
 assert.equal(confirmedDiscoveryLines([observation,{...observation,variant:'contrast',inferenceFingerprint:'different'}]).length,1);
});

test('positioned CJK labels can establish script despite a damaged neighbor, but one label or reused inference cannot',()=>{
 const labels=[{text:'名前：',confidence:98,bbox:b(10,20,50,35)},{text:'体力：',confidence:97,bbox:b(10,50,50,65)}];
 const probes=[{text:'broken 名前 体力',confidence:77,textLines:labels,inferenceFingerprint:'original'},
  {text:'different 名前 体力',confidence:78,textLines:structuredClone(labels),inferenceFingerprint:'contrast'}];
 assert.equal(confirmedCjk(probes),true);
 assert.equal(confirmedCjk([probes[0],{...probes[1],inferenceFingerprint:'original'}]),false);
 assert.equal(confirmedCjk(probes.map(r=>({...r,textLines:r.textLines.slice(0,1)}))),false);
 assert.equal(confirmedCjk([probes[0],{...probes[1],textLines:labels.map(l=>({...l,bbox:{...l.bbox,y0:l.bbox.y0+100,y1:l.bbox.y1+100}}))}]),false);
});

test('padding cannot import a line owned by the neighboring label, while edge overhang and unowned lines survive',()=>{
 const own={bbox:b(566,1393,643,1492)},neighbor={bbox:b(566,1378,603,1401)};
 assert.equal(lineBelongsToNeighbor(b(569,1385,603,1396),own,[own,neighbor]),true);
 assert.equal(lineBelongsToNeighbor(b(568,1399,611,1416),own,[own,neighbor]),false);
 assert.equal(lineBelongsToNeighbor(b(569,1385,603,1396),own,[own]),false);
});

test('fullwidth and ASCII punctuation agree without changing the retained source spelling',()=>{
 const line=(text,confidence)=>({text,confidence,bbox:b(0,0,100,20)});
 const reads=[{text:'ク',confidence:95,textLines:[line('ク',95)]},{text:'ランク：',confidence:84,textLines:[line('ランク：',84)]},{text:'ランク:',confidence:88,textLines:[line('ランク:',88)]}];
 assert.equal(chooseReadings(reads,{}).text,'ランク:');
 const conflicted=reads.map((r,i)=>({...r,text:'different paragraph '+i}));
 assert.equal(chooseReadings(conflicted,{}).text,'ランク:','positioned consensus must recover a clipped one-glyph line');
 assert.equal(chooseReadings(conflicted.slice(0,2),{}).text,'different paragraph 0','a solitary longer reading is insufficient');
});

test('small mixed-script regions require agreement and cannot promote Latin, digits or solitary CJK guesses',()=>{
 const read=text=>({text,confidence:94});
 assert.ok(confirmedCjk([read('魔法防御力: レベル:'),read('魔法防御力:レベル:')]));
 assert.ok(confirmedCjk([read('攻撃力:魔法攻撃力:'),read('攻撃力:魔法攻撃力:')]));
 for(const pair of [[read('Level 12'),read('Level 12')],[read('一'),read('一')],[read('魔法防御力'),read('普通の会話です')],[read('魔法防御力'),{text:'魔法防御力',confidence:30}]])assert.equal(confirmedCjk(pair),false);
 assert.ok(smallCjkCandidate({detectedLanguage:'ja',lines:[line(b(0,0,100,12))]}));
 assert.equal(smallCjkCandidate({detectedLanguage:'ja',lines:[line(b(0,0,100,70))]}),false);
});

test('complete independent line bounds preserve trailing marks without undoing shared-row cuts',()=>{
 const original={...line(b(20,20,80,32)),cutEdge:'x0'},candidate={lines:[original],discoveryLines:[line(b(5,15,90,37))]};
 const [crop]=cropLines(candidate);assert.deepEqual(crop.coreBbox,b(20,15,90,37));assert.equal(crop.cutEdge,'x0');assert.deepEqual(original.coreBbox,b(20,20,80,32));
});

test('polygon crops preserve slanted ink while excluding the overlapping neighbor rectangle',async()=>{
 const input=await sharp(Buffer.from('<svg width="100" height="100"><rect width="100" height="100" fill="white"/><rect x="40" y="40" width="10" height="10"/><rect x="70" y="40" width="10" height="10"/></svg>')).png().toBuffer();
 const crop={rectangle:{left:0,top:0,width:100,height:100},width:100,border:12,inputScale:1,ownedPolygons:[[[10,0],[90,80],[80,90],[0,10]]]};
 validateCrop(crop,100,100);
 const {data,info}=await sharp(await prepareCrop(input,crop)).raw().toBuffer({resolveWithObject:true});
 const pixel=(x,y)=>data[((y+12)*info.width+x+12)*info.channels];
 assert.ok(pixel(44,44)<20);assert.ok(pixel(74,44)>240);
 assert.throws(()=>validateCrop({...crop,ownedPolygons:[[[NaN,0],[0,1],[1,1],[1,0]]]},100,100));
});

test('oblique ownership requires parallel lines confirmed across variants',()=>{
 const obs=(x,variant)=>({bbox:b(x,20,x+50,130),polygon:[[x,20],[x+50,120],[x+40,130],[x-10,30]],variant,detectionConfidence:.8});
 const detection={width:250,height:200,boxes:[{bbox:b(10,15,130,140),orientation:'horizontal',lines:[line(b(20,20,120,130))]},{bbox:b(100,90,160,150),lines:[]}],discovery:{observations:[obs(30,'original'),obs(30,'clahe'),obs(60,'original'),obs(60,'clahe')]}};
 const result=obliqueOwnership(detection);assert.equal(result.boxes[0].ownedPolygons.length,2);assert.ok(result.boxes[1].excludedPolygons.length);assert.equal(detection.boxes[0].ownedPolygons,undefined);
 const protectedBox={...detection.boxes[1],lines:[line(b(100,90,160,110)),line(b(100,120,160,140))],discoveryLines:[{bbox:b(100,90,150,130),detectionConfidence:.97}]};
 assert.equal(obliqueOwnership({...detection,boxes:[detection.boxes[0],protectedBox]}).boxes[1].excludedPolygons,undefined);
 const single=obliqueOwnership({...detection,discovery:{observations:[obs(30,'original'),obs(60,'original')]}});assert.equal(single.boxes[0].ownedPolygons,undefined);
});

test('independent whole-line evidence rejoins slanted fragments only within their shared container',()=>{
 const containerBBox=b(100,90,400,160),lines=[line(b(110,135,180,155)),line(b(200,110,390,140))];
 const boxes=lines.map(l=>({bbox:l.bbox,lines:[l],orientation:'horizontal',containerId:'speech',containerBBox}));
 const observation=line(b(95,85,405,165)),saved=structuredClone(boxes);
 const result=reconcileDiscovery({boxes},[observation]);
 assert.equal(result.boxes.length,1);assert.deepEqual(result.boxes[0].bbox,observation.bbox);assert.equal(result.boxes[0].lines.length,2);assert.deepEqual(boxes,saved);
 const separate=boxes.map((v,i)=>({...v,containerId:'speaker-'+i}));
 const conflict=reconcileDiscovery({boxes:separate},[observation]);assert.equal(conflict.boxes.length,2);assert.equal(conflict.discovery.conflicts.length,1);
});
test('an independently detected short first line inside a paragraph container is not another paragraph',()=>{
 const body=line(b(100,150,400,180));
 const ctd={boxes:[{bbox:body.bbox,lines:[body],containerId:'paragraph',containerBBox:b(95,95,405,185),orientation:'horizontal'}]};
 const result=reconcileDiscovery(ctd,[line(b(210,100,290,140))]);
 assert.equal(result.boxes.length,1);assert.equal(result.boxes[0].bbox.y0,100);assert.equal(result.supplemental.length,0);
});
test('recognizer coverage repairs a narrow line without expanding through another owner',()=>{
 const l=line(b(110,60,290,80)),source={bbox:b(100,50,300,90),lines:[l],orientation:'horizontal'};
 const observation=line(b(80,45,330,95));
 assert.deepEqual(reconcileDiscovery({boxes:[source]},[observation]).boxes[0].bbox,observation.bbox);
 const neighbor={bbox:b(315,50,420,90),lines:[line(b(320,60,410,80))],orientation:'horizontal'};
 const result=reconcileDiscovery({boxes:[source,neighbor]},[line(b(80,45,410,95))]);
 assert.equal(result.boxes.length,2);assert.ok(result.boxes.some(r=>JSON.stringify(r.bbox)===JSON.stringify(source.bbox)));
});
test('a status value cannot join an effect with a different glyph scale',()=>{
 assert.equal(groupLines([line(b(50,10,100,40)),line(b(20,70,180,260))]).length,2);
});
test('duplicate detail subsets retain one canonical paragraph, including its heading',()=>{
 const lines=[line(b(100,20,300,40)),line(b(80,55,320,75)),line(b(100,90,300,110))];
 const boxes=[{bbox:b(70,10,330,120),orientation:'horizontal',detectionConfidence:.9},{bbox:b(150,45,390,125),orientation:'horizontal',detectionConfidence:.8}];
 const result=refineBlocks(boxes,lines);assert.equal(result.length,1);assert.equal(result[0].lines.length,3);
});
test('vertical tile fragments recover full columns without joining adjacent columns or separated bubbles',()=>{
 const result=mergeLineObservations([line(b(100,0,125,900),'vertical'),line(b(99,450,126,1400),'vertical'),line(b(150,0,175,1400),'vertical'),line(b(100,1600,125,1900),'vertical')]);
 assert.equal(result.length,3);assert.ok(result.some(r=>r.coreBbox.y0===0&&r.coreBbox.y1===1400&&r.coreBbox.x0===99));
});
test('vertical composition reads down a column then right to left and retains its orientation',()=>{
 const read=(text,box)=>({...line(box,'vertical'),text});
 const right=read('日本語',b(100,10,120,100)),left=read('文章',b(60,10,80,80));
 assert.equal(composeLines([left,right],'vertical').text,'日本語\n文章');
 const rows=[{id:'full',orientation:'vertical',text:'日本語\n文章',bbox:b(60,10,120,100),recognitionLines:[right,left]},{id:'fragment',orientation:'vertical',text:'日本語',bbox:right.bbox,recognitionLines:[right]}];
 const result=resolveReadingUnits(rows);assert.equal(result.regions.length,1);assert.equal(result.regions[0].orientation,'vertical');assert.equal(result.regions[0].text,'日本語\n文章');
});
test('source geometry distinguishes a complete exclamation from a colon or a single stem',async()=>{
 const draw=async shape=>sharp(Buffer.from(`<svg width="100" height="150"><rect width="100" height="150" fill="white"/>${shape}</svg>`)).png().toBuffer();
 const stem='<rect x="44" y="20" width="12" height="65" fill="black"/>',dot='<circle cx="50" cy="110" r="7" fill="black"/>';
 assert.equal(await exclamationMark(await draw(stem+dot)),true);
 assert.equal(await exclamationMark(await draw('<circle cx="50" cy="60" r="7" fill="black"/>'+dot)),false);
 assert.equal(await exclamationMark(await draw(stem)),false);
});
test('complete positioned columns own partial readings even when OCR disagrees on characters',()=>{
 const read=(text,box)=>({...line(box,'vertical'),text});
 const full={text:'完整的直排文字\n另外一列文字',orientation:'vertical',bbox:b(40,0,100,600),recognitionLines:[read('完整的直排文字',b(80,0,100,600)),read('另外一列文字',b(40,0,60,500))]};
 const fragment={text:'直排文宇',orientation:'vertical',bbox:b(78,200,102,560),recognitionLines:[read('直排文宇',b(78,200,102,560))]};
 const neighbor={...fragment,bbox:b(110,200,134,560),recognitionLines:[read('直排文宇',b(110,200,134,560))]};
 const result=resolveVerticalOwnership([full,fragment,neighbor]);
 assert.equal(result.length,2);assert.equal(result[0].duplicateObservations.length,1);assert.equal(result[0].reviewRequired,true);assert.equal(full.duplicateObservations,undefined);
});
test('a clipped horizontal glyph observation cannot outvote the complete vertical column',()=>{
 const whole=line(b(100,0,125,300),'vertical'),fragment={...line(b(102,250,124,290)),tileClipped:true};
 const result=mergeLineObservations([whole,fragment]);assert.equal(result.length,1);assert.equal(result[0].orientation,'vertical');
});

test('unclaimed vertical headings retain direction without absorbing a horizontal neighbor',()=>{
 const result=refineBlocks([], [line(b(100,10,120,90),'vertical'),line(b(20,10,80,30))]);
 assert.equal(result.length,2);
 assert.equal(result.find(r=>r.bbox.x0===100).orientation,'vertical');
 assert.equal(result.find(r=>r.bbox.x0===20).orientation,'horizontal');
});

test('a close terminal glyph joins only its aligned column and preserves observations',()=>{
 const rows=[line(b(100,0,120,300),'vertical'),line(b(102,310,118,330)),
   line(b(140,0,160,300),'vertical'),line(b(102,365,118,380)),line(b(121,310,139,330))];
 const saved=structuredClone(rows),result=mergeLineObservations(rows);
 assert.equal(result.length,4);
 const column=result.find(r=>r.orientation==='vertical'&&r.coreBbox.x0===100);
 assert.equal(column.coreBbox.y1,330);assert.equal(column.lineObservations.length,2);
 assert.deepEqual(rows,saved);
});

test('ambiguous terminal glyphs cannot connect overlapping column proposals',()=>{
 const rows=[line(b(100,0,120,300),'vertical'),line(b(110,0,130,300),'vertical'),line(b(108,305,122,320))];
 assert.equal(mergeLineObservations(rows).length,3);
});

test('reported vertical screenshots preserve complete columns without duplicate blocks',()=>{
 const fixture=require('./fixtures/ocr-vertical-column-geometry.json');
 const expected=[2,3,2,1];
 for(const [i,c] of fixture.cases.entries()){
   const saved=structuredClone(c);
   const lines=mergeLineObservations(c.lines),boxes=refineBlocks(c.rawBlocks,lines);
   assert.equal(boxes.length,expected[i],c.id);
   assert.ok(boxes.every(r=>r.orientation==='vertical'),c.id);
   for(const line of lines)assert.ok(boxes.some(r=>r.lines?.includes(line)),c.id+' lost line');
   assert.deepEqual(c,saved);
 }
});
