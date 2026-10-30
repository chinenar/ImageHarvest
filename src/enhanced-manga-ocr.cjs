'use strict';
const sharp=require('sharp');
const {MangaOcrPool,normalizeText,scriptHint,meaningfulScore}=require('./manga-ocr.cjs');
const {LocalOcrBackend}=require('./ocr-backend.cjs');
const {detectText}=require('./comic-text-detector.cjs');
const {assignIds,editDistance,intersection,area}=require('./ocr-review.cjs');
const {discoverText}=require('./ocr-discovery.cjs');
const {prepareCrop}=require('./ocr-crop.cjs');
const {exclamationMark}=require('./ocr-punctuation.cjs');
const {resolveVerticalOwnership}=require('./ocr-reading-ownership.cjs');
const {obliqueOwnership}=require('./ocr-oblique-ownership.cjs');
const {neighborOwnership}=require('./ocr-neighbor-ownership.cjs');
const {rejoinParagraphs}=require('./ocr-paragraph-rejoin.cjs');
const {refineSparseGeometry}=require('./ocr-sparse-geometry.cjs');
const {fragmentOwner}=require('./ocr-fragment-ownership.cjs');
const {needsNumericProbe,verifiedNumeric,sameNumericHypothesis}=require('./ocr-numeric-evidence.cjs');
const {repairEllipsis}=require('./ocr-ellipsis.cjs');
const {repairWordSpacing}=require('./ocr-word-spacing.cjs');
const {recoverWeakLines}=require('./ocr-line-recovery.cjs');
const {recoverRotated,recoverDetail,unrotatePoint,sparseScriptConflict}=require('./ocr-targeted-recovery.cjs');
const {repairTerminalPeriod}=require('./ocr-terminal-period.cjs');
const {markOverlappingReadings}=require('./ocr-overlap-review.cjs');
const {positionedDisplayReading,refineSingleLineGeometry,clippedPunctuationOwner}=require('./ocr-display-font.cjs');
const {smallCjkCandidate,confirmedCjk}=require('./ocr-region-language.cjs');
const {cropLines,lineBelongsToNeighbor}=require('./ocr-crop-lines.cjs');
const {distinctReadings}=require('./ocr-evidence.cjs');
const {originalIsSupported,canTryOriginal}=require('./ocr-retry-policy.cjs');
const {repeatedTerminalColumn,repairRepeatedVerticalColumn}=require('./ocr-vertical-repetition.cjs');
const RECOVERY_PREPROCESSING=['wide','wide-contrast','wide-line','wide-line-contrast'];
const PREPROCESSING=['original','grayscale','contrast','invert','clahe','adaptive','otsu'];

const compact=text=>normalizeText(text).normalize('NFKC').replace(/\s+/gu,'');
function confirmedDiscoveryLines(readings){
 const observations=distinctReadings(readings).flatMap(r=>r.error||r.engine!=='paddleocr'?[]:(r.textLines||[]).filter(l=>l.confidence>=90&&meaningfulScore(l.text)>=3).map(l=>({...l,variant:r.variant})));
 const confirmed=[];
 for(const line of observations.sort((a,b)=>b.confidence-a.confidence)){
  const same=other=>compact(line.text).toLowerCase()===compact(other.text).toLowerCase()&&intersection(line.bbox,other.bbox)/Math.max(1,Math.max(area(line.bbox),area(other.bbox)))>.75;
  if(new Set(observations.filter(same).map(l=>l.variant)).size>=2&&!confirmed.some(same))confirmed.push(line);
 }
 return confirmed.sort((a,b)=>a.bbox.y0-b.bbox.y0||a.bbox.x0-b.bbox.x0);
}
function deduplicateReadings(rows){
 const selected=[],canonical=s=>compact(s).replace(/[^\p{L}\p{N}]/gu,'').toLowerCase();
 for(const row of rows){
  const numericMatch=other=>Boolean(row.numericEvidence?.confirmed&&sameNumericHypothesis(row.text,other.text)||other.numericEvidence?.confirmed&&sameNumericHypothesis(other.text,row.text));
  const duplicate=selected.find(other=>{
   if(row.reviewed||other.reviewed||row.contentOverride||other.contentOverride||Boolean(row.discoveryOnly)===Boolean(other.discoveryOnly))return false;
   const numeric=numericMatch(other),ratio=Math.min(area(row.bbox),area(other.bbox))/Math.max(1,Math.max(area(row.bbox),area(other.bbox)));
   const positionedHorizontal=r=>r.recognitionLines?.length===1&&r.recognitionLines[0].bbox.x1-r.recognitionLines[0].bbox.x0>r.recognitionLines[0].bbox.y1-r.recognitionLines[0].bbox.y0;
   if(row.orientation!==other.orientation&&!(numeric&&positionedHorizontal(row)&&positionedHorizontal(other)))return false;
   return (numeric||canonical(row.text)&&canonical(row.text)===canonical(other.text))&&intersection(row.bbox,other.bbox)/Math.max(1,Math.min(area(row.bbox),area(other.bbox)))>.95&&ratio>(numeric?0.6:0.7);
  });
  if(!duplicate){selected.push(row);continue;}
  // Prefer the independently supported complete reading and keep both
  // observations, including punctuation disagreements, available for review.
  const best=numericMatch(duplicate)?(row.numericEvidence?.confirmed?row:duplicate):compact(row.text).length>compact(duplicate.text).length?row:duplicate;
  const observation=best===row?duplicate:row;
  const kept={...best,duplicateObservations:[...(duplicate.duplicateObservations||[]),observation],reviewRequired:true};
  selected[selected.indexOf(duplicate)]=kept;
 }
 return selected;
}
function disagreement(a,b){return editDistance(a,b)/Math.max(1,Array.from(compact(a)).length,Array.from(compact(b)).length);}
function shouldPromoteContainerReading(narrow,broad,{coverage=1,shared=false}={}){
  if(shared||coverage>=.68||coverage<=.12)return false;
  const current=compact(narrow?.text),expanded=compact(broad?.text),confidence=Number(broad?.confidence)||0;
  if(!expanded||confidence<58)return false;
  const currentChars=meaningfulScore(current),expandedChars=meaningfulScore(expanded);
  if(!currentChars)return expandedChars>=4&&confidence>=75;
  return expandedChars>=currentChars+4&&expandedChars>=currentChars*1.18;
}
function postprocessReading(read){
  if(!read.lines?.length)return read;
  const suppressed=[],kept=read.lines.filter(line=>{
    const b=line.bbox;
    const parent=read.lines.find(other=>{
      if(other===line||Array.from(compact(line.text)).length>2||Array.from(compact(other.text)).length<4||area(b)>area(other.bbox)*.12)return false;
      const a=other.bbox,h=a.y1-a.y0,expanded={...a,y0:a.y0-h*.25,y1:a.y1+h*.25};
      return intersection(expanded,b)/Math.max(1,area(b))>.8;
    });
    if(parent){suppressed.push({...line,reason:'small-fragment-overlapping-line'});return false;}return true;
  });
  const vertical=read.orientation==='vertical'||kept.length&&kept.filter(l=>
    l.bbox.y1-l.bbox.y0>(l.bbox.x1-l.bbox.x0)*1.8).length>kept.length/2;
  if(vertical){
    const columns=[];
    for(const line of [...kept].sort((a,b)=>b.bbox.x0-a.bbox.x0||a.bbox.y0-b.bbox.y0)){
      const column=columns.find(g=>{const a=g[0].bbox,b=line.bbox;return Math.max(0,Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0))/Math.max(1,Math.min(a.x1-a.x0,b.x1-b.x0))>.5;});
      if(column)column.push(line);else columns.push([line]);
    }
    const textLines=columns.map(g=>{
      g.sort((a,b)=>a.bbox.y0-b.bbox.y0);
      return {text:g.map(l=>l.text).join(''),confidence:g.reduce((n,l)=>n+l.confidence,0)/g.length,
        bbox:{x0:Math.min(...g.map(l=>l.bbox.x0)),y0:Math.min(...g.map(l=>l.bbox.y0)),x1:Math.max(...g.map(l=>l.bbox.x1)),y1:Math.max(...g.map(l=>l.bbox.y1))}};
    });
    return {...read,rawText:read.rawText??read.text,rawConfidence:read.rawConfidence??read.confidence,
      text:normalizeText(textLines.map(l=>l.text).join('\n')),orientation:'vertical',lines:kept,textLines,suppressedLines:suppressed,
      confidence:kept.reduce((n,l)=>n+l.confidence,0)/Math.max(1,kept.length)};
  }
  const angles=kept.filter(l=>l.polygon?.length===4).map(l=>Math.atan2(l.polygon[1][1]-l.polygon[0][1],l.polygon[1][0]-l.polygon[0][0])).sort((a,b)=>a-b);
  const angle=angles[Math.floor(angles.length/2)]||0,cos=Math.cos(angle),sin=Math.sin(angle);
  const heights=kept.map(l=>(l.bbox.y1-l.bbox.y0)*cos-(l.bbox.x1-l.bbox.x0)*Math.abs(sin)).sort((a,b)=>a-b);
  const tolerance=Math.max(4,(heights[Math.floor(heights.length/2)]||12)*.5);
  const projected=kept.map(line=>{const b=line.bbox,x=(b.x0+b.x1)/2,y=(b.y0+b.y1)/2;return {line,x:x*cos+y*sin,y:-x*sin+y*cos};}).sort((a,b)=>a.y-b.y);
  const groups=[];for(const item of projected){const group=groups.find(g=>Math.abs(g[0].y-item.y)<tolerance);if(group)group.push(item);else groups.push([item]);}
  const textLines=groups.map(g=>{g.sort((a,b)=>a.x-b.x);return {text:g.map(p=>p.line.text).join(' '),confidence:g.reduce((n,p)=>n+p.line.confidence,0)/g.length,
    bbox:{x0:Math.min(...g.map(p=>p.line.bbox.x0)),y0:Math.min(...g.map(p=>p.line.bbox.y0)),x1:Math.max(...g.map(p=>p.line.bbox.x1)),y1:Math.max(...g.map(p=>p.line.bbox.y1))}};});
  const text=textLines.map(l=>l.text).join('\n');
  return {...read,rawText:read.rawText??read.text,rawConfidence:read.rawConfidence??read.confidence,text:normalizeText(text),lines:kept,textLines,suppressedLines:suppressed,
    confidence:kept.length?kept.reduce((n,l)=>n+l.confidence,0)/kept.length:0};
}
function chooseReadings(readings,baseline,{allowBaseline=true}={}){
  const valid=distinctReadings(readings.filter(r=>!r.error&&compact(r.text)));
  if(!valid.length){const empty=readings.find(r=>!r.error);return empty?{...empty,selectionReason:'additional-engine-found-no-text'}:{...baseline,selectionReason:'no-additional-reading'};}
  // Agreement across preprocessing variants beats a solitary model score.
  const ranked=valid.map(r=>({...r,agreement:valid.filter(other=>compact(r.text)===compact(other.text)).length})).sort((a,b)=>b.agreement-a.agreement||(b.confidence||0)-(a.confidence||0));
  if(valid.length>=2&&ranked[0].textLines?.length){
    let changed=false;
    const lines=ranked[0].textLines.map(line=>{
      const matching=valid.map(r=>r.textLines?.filter(other=>{
        const overlap=intersection(line.bbox,other.bbox)/Math.max(1,Math.min(area(line.bbox),area(other.bbox)));
        const cjk=text=>(String(text).match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu)||[]).length;
        // A clipped one-glyph CJK read can be farther than the edit threshold
        // from the complete same-position line. It still needs two votes below.
        const truncated=cjk(line.text)===1&&cjk(other.text)>=2&&other.confidence>=80&&overlap>.85;
        return overlap>.6&&(disagreement(line.text,other.text)<.45||truncated);
      })
        .sort((a,b)=>disagreement(a.text,line.text)-disagreement(b.text,line.text))[0]).filter(Boolean);
      const voted=matching.map(r=>({...r,votes:matching.filter(o=>compact(o.text)===compact(r.text)).length})).sort((a,b)=>b.votes-a.votes||b.confidence-a.confidence);
      if(voted[0]?.votes>=2){changed||=compact(voted[0].text)!==compact(line.text);return voted[0];}return line;
    });
    if(changed)return {...ranked[0],text:lines.map(l=>l.text).join('\n'),textLines:lines,variant:'line-consensus',selectionReason:'position-aligned-line-agreement',confidence:lines.reduce((n,l)=>n+l.confidence,0)/lines.length};
  }
  if(allowBaseline&&ranked[0].agreement===1&&valid.length>1&&baseline.confidence>=90&&compact(baseline.text))return {...baseline,engine:'tesseract.js',selectionReason:'high-confidence-baseline-with-variant-conflict'};
  return {...ranked[0],selectionReason:ranked[0].agreement>1?'preprocessing-agreement':'single-reading-review'};
}
function selectVerticalReading(chosen,positioned,{readings=[],baseline={}}={}){
  if(positioned.orientation!=='vertical'||!(positioned.confidence>=85)||meaningfulScore(positioned.text)<3)return chosen;
  // A high Paddle score can still omit small kana. Keep a Manga OCR answer
  // supported by another variant/engine instead of overwriting that evidence.
  const lexical=text=>compact(text).normalize('NFKC').replace(/[^\p{L}\p{N}]/gu,'');
  const mangaReads=distinctReadings(readings.filter(r=>!r.error&&r.engine==='manga-ocr'&&meaningfulScore(r.text)>=3));
  let manga=chosen.engine==='manga-ocr'?chosen:[...mangaReads].sort((a,b)=>
    mangaReads.filter(r=>lexical(r.text)===lexical(b.text)).length-mangaReads.filter(r=>lexical(r.text)===lexical(a.text)).length)[0];
  let positionedTiebreak=false;
  // Two equally supported crop readings can differ in a terminal mark. An
  // independently positioned reading may resolve that tie, while a strong
  // baseline or an outright majority still protects small kana from loss.
  const votes=r=>mangaReads.filter(other=>compact(other.text)===compact(r.text)).length;
  const strongest=Math.max(0,...mangaReads.map(votes));
  if(manga&&strongest>=2&&votes(manga)===strongest&&!(baseline.confidence>=85&&lexical(baseline.text)===lexical(manga.text))){
    const tied=mangaReads.filter(r=>votes(r)===strongest);
    const distance=r=>editDistance(compact(r.text),compact(positioned.text));
    const nearest=[...tied].sort((a,b)=>distance(a)-distance(b))[0];
    if(nearest&&distance(nearest)<distance(manga)){manga=nearest;positionedTiebreak=true;}
  }
  const text=lexical(manga?.text);
  const supported=manga&&text&&(
    mangaReads.filter(r=>lexical(r.text)===text).length>=2||
    baseline.confidence>=85&&lexical(baseline.text)===text||
    editDistance(text,lexical(positioned.text))/Math.max(1,text.length,lexical(positioned.text).length)<=.18);
  return supported?{...manga,selectionReason:positionedTiebreak?'vertical-positioned-tiebreak':'vertical-engine-agreement',positionEngine:'paddleocr'}:
    {...positioned,selectionReason:'vertical-column-reading'};
}
async function refineBalloonGroups(input,detected,backend,{signal}={}){
  const boxes=[];
  for(const c of detected.boxes){
    if(signal?.aborted)throw Error('ยกเลิก OCR');
    const widths=(c.lines||[]).map(l=>{const b=l.coreBbox||l.bbox;return b.x1-b.x0;}).sort((a,b)=>a-b);
    const shortSharedRow=widths.length===3&&widths[2]>widths[1]*2;
    if((c.lines?.length||0)<(c.orientation==='vertical'?2:4)&&!shortSharedRow){boxes.push(c);continue;}
    const b=c.bbox,padX=Math.max(48,(b.x1-b.x0)*.5),padY=Math.max(64,(b.y1-b.y0)*.55);
    const left=Math.max(0,Math.floor(b.x0-padX)),top=Math.max(0,Math.floor(b.y0-padY));
    const width=Math.min(detected.width,Math.ceil(b.x1+padX))-left,height=Math.min(detected.height,Math.ceil(b.y1+padY))-top;
    // A merged proposal spanning a long strip is not one balloon context.
    // Keep its observations for review rather than running surface analysis
    // over an entire chapter-sized crop.
    if(width*height>2000000||Math.max(width,height)>4096){
      boxes.push({...c,reviewRequired:true,segmentationSkipped:'large-context'});continue;
    }
    const vertical=c.orientation==='vertical';
    const source=await sharp(input).extract({left,top,width,height}).png().toBuffer();
    const image=vertical?await sharp(source).rotate(90).png().toBuffer():source;
    const local=box=>({x0:box.x0-left,y0:box.y0-top,x1:box.x1-left,y1:box.y1-top});
    const rotated=box=>{const b=local(box);return vertical?{x0:height-b.y1,y0:b.x0,x1:height-b.y0,y1:b.x1}:b;};
    const result=await backend.request({op:'segment',writingDirection:vertical?'vertical':'horizontal',image:image.toString('base64'),lines:c.lines.map(l=>({...l,bbox:rotated(l.bbox),coreBbox:rotated(l.coreBbox||l.bbox)}))},{signal});
    if(result.groups.length<2){boxes.push({...c,segmentationCheck:result.reason,segmentationSurface:result.surfaceMode});continue;}
    const orderedGroups=vertical?[...result.groups].sort((a,b)=>Math.max(...b.map(l=>l.coreBbox.y1))-Math.max(...a.map(l=>l.coreBbox.y1))):result.groups;
    for(const [part,lines]of orderedGroups.entries()){
      const global=box=>vertical?{x0:box.y0+left,y0:height-box.x1+top,x1:box.y1+left,y1:height-box.x0+top}:{x0:box.x0+left,y0:box.y0+top,x1:box.x1+left,y1:box.y1+top};
      const cores=lines.map(l=>global(l.coreBbox));
      const bbox={x0:Math.max(0,Math.floor(Math.min(...cores.map(b=>b.x0))-4)),y0:Math.max(0,Math.floor(Math.min(...cores.map(b=>b.y0))-4)),
        x1:Math.min(detected.width,Math.ceil(Math.max(...cores.map(b=>b.x1))+4)),y1:Math.min(detected.height,Math.ceil(Math.max(...cores.map(b=>b.y1))+4))};
      boxes.push({...c,bbox,lines:lines.map(l=>({...l,bbox:global(l.bbox),coreBbox:global(l.coreBbox),cutEdge:vertical&&l.cutEdge?(l.cutEdge==='x0'?'y1':'y0'):l.cutEdge})),segmentation:result.reason,part,reviewRequired:true});
    }
  }
  return {...detected,boxes,segmentation:'white-balloon-boundaries-and-neck'};
}

class EnhancedMangaOcrPool extends MangaOcrPool {
  constructor(options={}){super(options);this.backend=options.backend||new LocalOcrBackend();this.ownBackend=!options.backend;this.retryVariants=options.retryVariants!==false;this.sourceScale=options.sourceScale||1;this.discovery=options.discovery!==false;this.recognitionLanguage=options.recognitionLanguage;this.preprocessing=options.preprocessing||'auto';}
  async detectPage(input,options){
    if(!this.discovery)return super.detectPage(input,options);
    return discoverText(input,this.backend,{signal:options.signal,sourceScale:this.sourceScale,onScan:({index,total,engine,variant})=>options.onRegion?.({index,total,engine:'discovery',phase:`ค้นหาข้อความ ${engine}${variant?' / '+variant:''}`})});
  }
  async recognizeDetected(page,options){
    const started=Date.now(),before=this.backend.stats?.()||{};
    // Fail explicitly if the optional runtime is missing; do not label a
    // silent Tesseract fallback as the stronger engine.
    const backendStatus=await this.backend.status();
    const original=await super.recognizeDetected(page,options);
    const baselineFinished=Date.now();
    let detection=original.detection;
    if(!options.rectangle)detection=await rejoinParagraphs(page.filePath,detection,this.backend,options);
    if(!options.rectangle)detection=await refineBalloonGroups(page.filePath,detection,this.backend,options);
    if(!options.rectangle)detection=neighborOwnership(obliqueOwnership(detection));
    const segmentationFinished=Date.now();
    const rows=[],rejected=[],baselineRows=[...original.regions,...original.rejectedRegions],alternatePasses=new Map(),meta=await sharp(page.filePath).metadata();
    const selected=this.languages;
    const japaneseRows=baselineRows.filter(r=>['ja','cjk'].includes(r.script)).length;
    const pageJapanese=selected.includes('jpn')&&japaneseRows>=2&&japaneseRows/Math.max(1,baselineRows.length)>=.3;
    const containerCounts=new Map();
    for(const candidate of detection.boxes||[])if(candidate.containerId)containerCounts.set(candidate.containerId,(containerCounts.get(candidate.containerId)||0)+1);
    const jobs=[];let sparseScriptProbes=0;
    // Finish Tesseract work before scheduling GPU crops; its worker maintains
    // mutable language/rectangle settings and must not be shared concurrently.
    for(const [index,candidate] of detection.boxes.entries()){
      if(options.signal?.aborted)throw Error('ยกเลิก OCR');
      const b=candidate.bbox;
      let baseline=baselineRows.find(r=>intersection(b,r.bbox)/Math.max(1,Math.max(area(b),area(r.bbox)))>.8);
      if(!baseline){
        const rectangle={left:Math.floor(b.x0),top:Math.floor(b.y0),width:Math.ceil(b.x1)-Math.floor(b.x0),height:Math.ceil(b.y1)-Math.floor(b.y0)};
        const read=await super.recognizeDetected(page,{...options,rectangle});baseline=read.regions[0]||{text:'',confidence:0,script:'unknown',recognitionLanguages:[]};
      }
      jobs.push({index,candidate,baseline});
    }
    const processCandidate=async({index,candidate,baseline})=>{
      options.onRegion?.({index:index+1,total:jobs.length,engine:'enhanced'});
      if(options.signal?.aborted)throw Error('ยกเลิก OCR');
      const b=candidate.bbox;
      const single=selected.length===1?selected[0]:null;
      let language=this.recognitionLanguage==='zh'||single==='zh'?'zh':single==='jpn'||baseline.script==='ja'?'ja':baseline.script==='cjk'?'zh':original.detection.pageLanguage==='ja'||pageJapanese?'ja':single==='tha'||baseline.script==='th'||original.detection.pageLanguage==='th'?'th':single==='fra'?'fr':'en';
      let regionLanguageEvidence=null;
      const padding=language==='th'?12*this.sourceScale:6*this.sourceScale,readings=[],cropCache=new Map();
      const readVariant=async(variant,{scale=regionLanguageEvidence?3:language==='th'?1.5:2,pad=padding,engine=language==='ja'&&!regionLanguageEvidence?'manga':'paddle',lang=language==='ja'?'japan':language,verification=false,recognizeOnly=false,box=b,rotation=0}={})=>{
        const sourceBox=box||b;
        const left=Math.max(0,Math.floor(sourceBox.x0)-pad),top=Math.max(0,Math.floor(sourceBox.y0)-pad),width=Math.min(meta.width,Math.ceil(sourceBox.x1)+pad)-left,height=Math.min(meta.height,Math.ceil(sourceBox.y1)+pad)-top;
        const cropWidth=Math.max(1,Math.min(1000,Math.round(width*scale/this.sourceScale),Math.floor(Math.sqrt(2000000*width/height)),Math.floor(4000*width/height))),cropMeta={rectangle:{left,top,width,height},width:cropWidth,border:12,inputScale:this.sourceScale,
          rotation,maskLines:candidate.segmentation?(['en','fr'].includes(language)?cropLines(candidate):candidate.lines.map(l=>({coreBbox:l.coreBbox||l.bbox,cutEdge:l.cutEdge}))):undefined,maskPadding:8,ownedPolygons:candidate.ownedPolygons,excludedPolygons:candidate.excludedPolygons};
        const key=JSON.stringify(cropMeta);
        if(!cropCache.has(key))cropCache.set(key,prepareCrop(page.filePath,cropMeta,{prepared:true}));
        const crop=await cropCache.get(key),cropDimensions=await sharp(crop).metadata(),cropScale=cropWidth/width,unrotatedWidth=rotation?cropDimensions.height:cropDimensions.width,unrotatedHeight=rotation?cropDimensions.width:cropDimensions.height,cropScaleY=(unrotatedHeight-24)/height;
        const globalPoint=(x,y)=>{const [a,z]=unrotatePoint(x,y,unrotatedWidth,unrotatedHeight,rotation);return [Math.max(0,Math.min(meta.width,left+(a-12)/cropScale)),Math.max(0,Math.min(meta.height,top+(z-12)/cropScaleY))];};
        const globalBox=a=>{if(rotation&&recognizeOnly)return {...sourceBox};const points=[[a.x0,a.y0],[a.x1,a.y0],[a.x1,a.y1],[a.x0,a.y1]].map(([x,y])=>globalPoint(x,y));return {x0:Math.min(...points.map(p=>p[0])),y0:Math.min(...points.map(p=>p[1])),x1:Math.max(...points.map(p=>p[0])),y1:Math.max(...points.map(p=>p[1]))};};
        try{
          const raw=await this.backend.read(crop,{engine,language:lang,variant,recognizeOnly,signal:options.signal});
          const neighborLines=[];
          const lines=(raw.lines||[]).filter(line=>{
            if(lang!=='japan'||!smallCjkCandidate(candidate,this.sourceScale)||!lineBelongsToNeighbor(globalBox(line.bbox),candidate,detection.boxes))return true;
            neighborLines.push({...line,bbox:globalBox(line.bbox),reason:'padding-captured-neighbor',polygon:undefined});return false;
          });
          const owned=neighborLines.length?{...raw,rawText:raw.text,lines,text:lines.map(l=>l.text).join('\n'),confidence:lines.reduce((n,l)=>n+l.confidence,0)/Math.max(1,lines.length)}:raw;
          const read=postprocessReading({...owned,orientation:rotation?'horizontal':candidate.orientation==='vertical'?'vertical':raw.orientation});
          return {...read,text:normalizeText(read.text),variant,verification,recognizeOnly,crop:cropMeta,coordinateSpace:'original-image',
            neighborLines,
            lines:read.lines?.map(l=>({...l,bbox:globalBox(l.bbox),polygon:l.polygon?.map(([x,y])=>globalPoint(x,y))})),
            textLines:read.textLines?.map(l=>({...l,bbox:globalBox(l.bbox)})),suppressedLines:read.suppressedLines?.map(l=>({...l,bbox:globalBox(l.bbox),polygon:undefined}))};
        }catch(error){if(options.signal?.aborted)throw error;return {variant,text:'',error:error.message,crop:cropMeta};}
      };
      if(['en','fr'].includes(language)&&smallCjkCandidate(candidate,this.sourceScale)){
        const probes=await Promise.all(['original','contrast'].map(variant=>readVariant(variant,{engine:'paddle',lang:'japan',scale:3,verification:true})));
        if(confirmedCjk(probes)){
          const kana=probes.every(r=>/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(r.text));
          regionLanguageEvidence={from:language,to:kana?'ja':'cjk',reason:'small-region-script-agreement'};
          language='ja';readings.push(...probes);
        }
      }
      // Verify an uncertain Japanese proposal before running a generative
      // recognizer. The same acceptance gate used to run after every retry.
      let support=null;
      const weakDetector=Number.isFinite(candidate.detectionConfidence)&&candidate.detectionConfidence<.75&&
        (baseline.confidence<85||!['ja','cjk'].includes(baseline.script));
      const verify=language==='ja'&&!regionLanguageEvidence&&(candidate.lineOnly&&(candidate.discoveryOnly||!baseline.text||baseline.confidence<45)||weakDetector);
      if(verify)support=await readVariant('original',{engine:'paddle',lang:'japan',verification:true});
      const verificationFailed=verify&&!(support.confidence>=75&&['ja','cjk'].includes(scriptHint(support.text)));
      let japanesePartial=[];
      if(verificationFailed&&support.confidence>=55&&['ja','cjk'].includes(scriptHint(support.text))){
        const second=await readVariant('contrast',{engine:'paddle',lang:'japan',verification:true});
        readings.push(second);
        japanesePartial=require('./ocr-japanese-line-recovery.cjs').recoverJapaneseLines([support,second]);
        japanesePartial.sort((a,c)=>candidate.orientation==='vertical'?c.bbox.x0-a.bbox.x0||a.bbox.y0-c.bbox.y0:a.bbox.y0-c.bbox.y0||a.bbox.x0-c.bbox.x0);
      }
      let retryDecision='existing-language-route';
      if(!verificationFailed&&!regionLanguageEvidence){
        const staged=language!=='ja'&&this.retryVariants&&this.preprocessing!=='all'&&process.env.IMAGEHARVEST_OCR_EAGER_VARIANTS!=='1'&&canTryOriginal(baseline,candidate);
        if(staged){
          const original=await readVariant('original');readings.push(original);
          const supported=originalIsSupported(original,baseline,candidate);
          retryDecision=supported?'independent-original-agreement':'needs-variant-verification';
          if(!supported)readings.push(...await Promise.all(['contrast','invert'].map(variant=>readVariant(variant))));
        }else readings.push(...await Promise.all((language==='ja'||!this.retryVariants?['original']:['original','contrast','invert']).map(variant=>readVariant(variant))));
      }
      if(readings.length&&readings.every(r=>r.error))throw Error(readings[0].error);
      let chosen=verificationFailed?{...baseline,text:'',confidence:0,engine:'tesseract.js',selectionReason:'unsupported-japanese-proposal'}:chooseReadings(readings,{...baseline,engine:'tesseract.js'},{allowBaseline:language!=='th'&&!regionLanguageEvidence});
      const stable=distinctReadings(readings).filter(r=>!r.error&&r.confidence>=85&&compact(r.text)===compact(chosen.text)).length>=2;
      // A stable answer from several preprocessing passes is still only one OCR
      // engine. If an independent high-confidence Tesseract read differs by a
      // small amount (typical P/F, I/L, 1/I manga-font confusion), force the
      // extra preprocessing + larger recrop before accepting the word.
      const baselineDisagreement=disagreement(baseline.text,chosen.text);
      const independentCloseConflict=language==='en'&&baseline.confidence>=88&&compact(baseline.text)&&compact(chosen.text)&&baselineDisagreement>.01&&baselineDisagreement<=.20;
      const weak=!compact(chosen.text)||chosen.confidence!==null&&chosen.confidence<92||independentCloseConflict||!stable&&readings.some(r=>!r.error&&disagreement(r.text,chosen.text)>.05)||language==='ja'&&baselineDisagreement>.12||!stable&&baselineDisagreement>.05&&(readings[0]?.confidence||0)<95;
      if(!verificationFailed&&this.retryVariants&&(weak||this.preprocessing==='all')){
        const extraVariants=this.preprocessing==='all'||language!=='ja'?PREPROCESSING:['clahe','adaptive'];
        readings.push(...await Promise.all(extraVariants.filter(v=>!readings.some(r=>r.variant===v)).map(variant=>readVariant(variant))));
        // Only uncertain crops pay for another scale/padding. Coordinates of
        // every alternative are normalized before agreement is evaluated.
        if(weak){const r=await readVariant('original',{scale:language==='th'?2:2.5,pad:padding+4*this.sourceScale});readings.push({...r,variant:'original-recrop'});}
        chosen=chooseReadings(readings,{...baseline,engine:'tesseract.js'},{allowBaseline:language!=='th'&&!regionLanguageEvidence});
      }
      // Retry squeezed Latin display lettering only when the regular reads
      // are weak. Require two agreeing transformed passes, retaining originals.
      if(this.retryVariants&&['en','fr'].includes(language)&&weak){
        const recovered=await Promise.all(['wide','wide-contrast'].map(variant=>readVariant(variant)));
        if(candidate.displayFont||!candidate.discoveryOnly&&Number(candidate.detectionConfidence||0)>=.75&&recovered.every(r=>meaningfulScore(r.text)<3)){
          recovered.push(...await Promise.all(['wide-line','wide-line-contrast'].map(variant=>readVariant(variant,{recognizeOnly:true}))));
        }
        readings.push(...recovered);
        const complete=recovered.filter(r=>r.recognizeOnly);
        // A whole-crop recognizer can collapse repeated letters and marks.
        // Prefer two strong position-aligned detections before that fallback.
        const shape=positionedDisplayReading(recovered)||chooseReadings(complete.length?complete:recovered,{}, {allowBaseline:false});
        if(distinctReadings(recovered).filter(r=>!r.error&&r.confidence>=85&&compact(r.text)===compact(shape.text)).length>=2&&
            meaningfulScore(shape.text)>=3&&(Number(chosen.confidence||0)<75||meaningfulScore(chosen.text)<3)){
          chosen={...shape,selectionReason:'display-font-recovery',shapeRecovery:true};
        }
      }
      // Keep an independently positioned reading for vertical Japanese too.
      // It can recover column order without inventing a horizontal sentence.
      if(language==='ja'&&candidate.orientation==='vertical'&&!verify){
        const vertical=await readVariant('original',{engine:'paddle',lang:'japan'});
        readings.push({...vertical,variant:'vertical-positioned'});
        chosen=selectVerticalReading(chosen,vertical,{readings,baseline});
        if(repeatedTerminalColumn(chosen,vertical)){
          const repeat=await readVariant('contrast',{engine:'paddle',lang:'japan'});
          readings.push({...repeat,variant:'vertical-repetition-contrast'});
          const repaired=repairRepeatedVerticalColumn(chosen,vertical,repeat);
          if(repaired!==chosen)chosen=repaired;
          else{
            const recrop=await readVariant('original',{engine:'paddle',lang:'japan',scale:2.5,pad:padding+4*this.sourceScale});
            readings.push({...recrop,variant:'vertical-repetition-recrop'});
            chosen=repairRepeatedVerticalColumn(chosen,vertical,repeat,recrop);
          }
        }
      }
      // The line map can clip the beginning/end of a stylized sentence even
      // while the learned detector block still encloses the whole balloon.
      // Re-read that exact detector container only when it belongs to this one
      // candidate and is substantially larger; never use an arbitrary page crop.
      const container=candidate.containerBBox,innerArea=area(b),containerArea=container?area(container):0,containerCoverage=containerArea?innerArea/containerArea:1;
      const uniqueContainer=Boolean(candidate.containerId&&containerCounts.get(candidate.containerId)===1);
      if(!verificationFailed&&language!=='ja'&&!candidate.segmentation&&uniqueContainer&&containerArea>innerArea&&containerArea<=innerArea*5&&containerCoverage<.68){
        const first={...await readVariant('original',{box:container,pad:0}),variant:'container-original'};
        const broadReadings=[first];
        let broad=first,promote=shouldPromoteContainerReading(chosen,broad,{coverage:containerCoverage,shared:false});
        // The full detector container is a recovery path, not a normal OCR
        // pass. Usually one read is enough; only pay for contrast/invert when
        // that first broad read is still uncertain or disagrees strongly.
        if(!promote&&this.retryVariants&&(first.error||Number(first.confidence||0)<85||disagreement(first.text,chosen.text)>.16)){
          const variants=['contrast','invert'];
          broadReadings.push(...(await Promise.all(variants.map(variant=>readVariant(variant,{box:container,pad:0})))).map((read,index)=>({...read,variant:'container-'+variants[index]})));
          broad=chooseReadings(broadReadings,{...chosen},{allowBaseline:false});
          promote=shouldPromoteContainerReading(chosen,broad,{coverage:containerCoverage,shared:false});
        }
        if(promote)chosen={...broad,selectionReason:'container-recovery',containerRecovery:true};
        readings.push(...broadReadings);
      }
      // Manga OCR always emits text, even on blank artwork. Do not promote
      // its output for uncertain line-only proposals without supporting OCR.
      if(verify){
        if(support.confidence>=75&&['ja','cjk'].includes(scriptHint(support.text)))readings.push(support);
        else {readings.push(support);chosen={...baseline,text:'',confidence:0,engine:'tesseract.js',selectionReason:'unsupported-japanese-proposal'};}
      }
      if(language==='ja'&&candidate.orientation==='vertical'&&support)chosen=selectVerticalReading(chosen,support,{readings,baseline});
      if(japanesePartial.length)chosen={...support,text:japanesePartial.map(l=>l.text).join('\n'),textLines:japanesePartial,
        confidence:Math.min(...japanesePartial.map(l=>l.confidence)),selectionReason:'confirmed-japanese-partial-lines'};
      const disagree=readings.some(r=>!r.error&&disagreement(r.text,chosen.text)>.02)||disagreement(baseline.text,chosen.text)>.02;
      const recovered=japanesePartial.length?japanesePartial:candidate.discoveryOnly&&language!=='ja'&&(chosen.confidence||0)<75?confirmedDiscoveryLines(readings):[];
      if(recovered.length)chosen={...chosen,engine:'paddleocr',model:readings.find(r=>r.engine==='paddleocr')?.model,text:recovered.map(l=>l.text).join('\n'),textLines:recovered,confidence:recovered.reduce((sum,l)=>sum+l.confidence,0)/recovered.length,selectionReason:'confirmed-discovery-line-recovery'};
      if(language!=='ja'&&/^[!:.•…Il1|\s]{1,5}$/.test(chosen.text||'')&&chosen.crop){
        const pixels=await prepareCrop(page.filePath,chosen.crop,{prepared:true});
        if(await exclamationMark(pixels))chosen={...chosen,text:'!',selectionReason:'source-stem-and-dot',textLines:[{text:'!',confidence:chosen.confidence,bbox:{...b}}]};
      }
      if(!options.rectangle&&language==='en'&&needsNumericProbe(chosen,readings)){
        const probes=await Promise.all(['original','contrast'].map(variant=>readVariant(variant,{engine:'paddle',lang:'zh',verification:true})));
        const numeric=verifiedNumeric(chosen,probes);readings.push(...probes.map(r=>({...r,variant:'numeric-'+r.variant})));
        if(numeric)chosen=numeric;
      }
      if(['en','fr'].includes(language)){
        chosen=await recoverRotated(chosen,candidate,readVariant);
        chosen=await recoverDetail(chosen,readings,candidate,readVariant,{width:meta.width,height:meta.height,scale:this.sourceScale});
        chosen=await recoverWeakLines(chosen,baseline,candidate,(variant,box)=>readVariant(variant,{engine:'paddle',lang:language,recognizeOnly:true,scale:3,pad:0,box}),{width:meta.width,height:meta.height,scale:this.sourceScale});
        chosen=await repairEllipsis(page.filePath,chosen,readings);
        chosen=await repairTerminalPeriod(page.filePath,chosen,readings,readVariant,{width:meta.width,height:meta.height,scale:this.sourceScale});
        chosen=await repairWordSpacing(page.filePath,chosen,readings);
      }
      const confidence=chosen.confidence===null?null:Math.round(chosen.confidence||0);
      const row={...baseline,...candidate,bbox:{...b},text:chosen.text,confidence,script:scriptHint(chosen.text),recognitionEngine:chosen.engine,recognitionModel:chosen.model,numericEvidence:chosen.numericEvidence,punctuationEvidence:chosen.punctuationEvidence,spacingEvidence:chosen.spacingEvidence,lineRecoveryEvidence:chosen.lineRecoveryEvidence,retryDecision,
          recognitionLanguages:regionLanguageEvidence?.to==='cjk'?['ja','zh']:[language],regionLanguageEvidence,textRotation:chosen.textRotation,rotationEvidence:chosen.rotationEvidence,detailEvidence:chosen.detailEvidence,terminalColumnEvidence:chosen.terminalColumnEvidence,orientation:chosen.orientation||candidate.orientation,recognitionLines:chosen.textLines||[],selectionReason:chosen.selectionReason,alternatives:[{...baseline,engine:'tesseract.js'},...readings],
        observedBy:[...new Set([...(candidate.observedBy||[candidate.discoveryOnly?'paddle-text-detector':'comic-text-detector']),chosen.engine,...(chosen.positionEngine?[chosen.positionEngine]:[])])],retryApplied:readings.length>(language==='ja'?1:3),reviewRequired:Boolean(chosen.shapeRecovery||disagree||candidate.reviewRequired||candidate.lineOnly||confidence===null||confidence<85||!chosen.text),disagreement:disagree};
      if(!candidate.segmentation&&!chosen.textRotation&&chosen.engine==='paddleocr'){
        const supported=row.recognitionLines.filter(l=>l.confidence>=85&&compact(l.text).length>=2);
        if(supported.length){
          // Thai tone marks can extend above the recognizer's line polygon.
          // Preserve the detector observation and cover the supported reading
          // with a small font-relative vertical margin for the overlay.
          const bounds=supported.map(l=>{const a=l.bbox,padY=language==='th'?Math.max(2*this.sourceScale,Math.min(12*this.sourceScale,(a.y1-a.y0)*.3)):Math.max(this.sourceScale,(a.y1-a.y0)*.06);return {x0:a.x0-2*this.sourceScale,y0:a.y0-padY,x1:a.x1+2*this.sourceScale,y1:a.y1+padY};});
          row.detectorBBox={...b};row.localizationRefinement='recognizer-line-bounds';
          row.bbox={x0:Math.max(0,Math.floor(Math.min(b.x0,...bounds.map(a=>a.x0)))),y0:Math.max(0,Math.floor(Math.min(b.y0,...bounds.map(a=>a.y0)))),
            x1:Math.min(meta.width,Math.ceil(Math.max(b.x1,...bounds.map(a=>a.x1)))),y1:Math.min(meta.height,Math.ceil(Math.max(b.y1,...bounds.map(a=>a.y1))))};
        }
      }
      if(recovered.length){
        if(japanesePartial.length)row.partialReadingEvidence={reason:'unconfirmed-remainder-of-japanese-proposal',detectorBBox:{...b}};
        row.detectorBBox={...b};row.localizationRefinement='confirmed-line-bounds';
        row.bbox={x0:Math.max(0,Math.floor(Math.min(...recovered.map(l=>l.bbox.x0))-3*this.sourceScale)),y0:Math.max(0,Math.floor(Math.min(...recovered.map(l=>l.bbox.y0))-3*this.sourceScale)),x1:Math.min(meta.width,Math.ceil(Math.max(...recovered.map(l=>l.bbox.x1))+3*this.sourceScale)),y1:Math.min(meta.height,Math.ceil(Math.max(...recovered.map(l=>l.bbox.y1))+3*this.sourceScale))};
      }
      // Baseline word coordinates are observations of its own reading. They
      // must not be presented as alignment for a different recognizer's text.
      if(chosen.engine!=='tesseract.js')row.words=[];
      // Weak single glyphs on artwork are proposals, not accepted text. Keep
      // them in the review payload, including their original observations.
      // This gate also applies to CTD; previously only supplemental boxes had it.
      const unconfirmed=!options.rectangle&&(!compact(chosen.text)||language!=='ja'&&meaningfulScore(chosen.text)>0&&meaningfulScore(chosen.text)<=2&&confidence<85&&baseline.confidence<85);
      const rejectedDiscovery=unconfirmed||(verificationFailed&&!japanesePartial.length)||candidate.discoveryOnly&&(!compact(chosen.text)||language!=='ja'&&(meaningfulScore(chosen.text)<2||confidence<75)||language==='th'&&scriptHint(chosen.text)!=='th'||language==='ja'&&!['ja','cjk'].includes(scriptHint(chosen.text)));
      if(unconfirmed)row.rejectionReason='text-not-confirmed';
      let localized=options.rectangle?row:refineSparseGeometry(row,{width:meta.width,height:meta.height,scale:this.sourceScale});
      if(!options.rectangle)localized=refineSingleLineGeometry(localized,{width:meta.width,height:meta.height,scale:this.sourceScale});
      if(!options.rectangle&&['en','fr'].includes(language)&&localized.sparseReadingReview&&sparseScriptProbes<2){
        sparseScriptProbes++;
        const probes=await Promise.all(['original','contrast'].map(v=>readVariant(v,{engine:'manga',lang:'japan',box:localized.bbox,pad:0,scale:2})));
        localized=sparseScriptConflict(localized,probes);
      }
      if(localized.orientation!=='vertical'&&localized.recognitionLines.length&&compact(localized.recognitionLines.map(l=>l.text).join(' '))===compact(localized.text)){
        localized.displayGeometry={signature:JSON.stringify([localized.text,localized.bbox]),boxes:localized.recognitionLines.map(l=>({...l.bbox}))};
      }
      return {row:localized,rejectedDiscovery,readings};
    };
    const completed=new Array(jobs.length);let cursor=0;
    const worker=async()=>{while(cursor<jobs.length){const index=cursor++;completed[index]=await processCandidate(jobs[index]);}};
    await Promise.all(Array.from({length:Math.min(jobs.length,backendStatus.capabilities?.batch?2:1)},()=>worker()));
    // Preserve source order, stable IDs, variant votes and response provenance.
    for(const {row,rejectedDiscovery,readings} of completed){
      if(rejectedDiscovery)rejected.push({...row,rejectionReason:row.rejectionReason||'supplemental-detection-not-confirmed-by-reading'});else rows.push(row);
      for(const r of readings){const name=(r.engine==='manga-ocr'?'manga':'paddle')+'-'+r.variant+(r.verification?'-verification':'');if(!alternatePasses.has(name))alternatePasses.set(name,[]);alternatePasses.get(name).push({...row,text:r.text,confidence:r.confidence,error:r.error,recognitionLines:r.textLines||[],crop:r.crop,alternatives:undefined});}
    }
    const ownedRows=rows.filter(row=>{
      const owner=fragmentOwner(row,rows)||clippedPunctuationOwner(row,rows);if(!owner)return true;
      rejected.push({...row,rejectionReason:'fragment-already-owned-by-complete-line',ownerBBox:owner.bbox});return false;
    });
    const regions=assignIds(markOverlappingReadings(resolveVerticalOwnership(deduplicateReadings(ownedRows))),page.pageIndex||0);
    const finalStatus=await this.backend.status();
    const inferenceReuse={hits:(finalStatus.inferenceCache?.hits||0)-(backendStatus.inferenceCache?.hits||0),misses:(finalStatus.inferenceCache?.misses||0)-(backendStatus.inferenceCache?.misses||0)};
    const backend=Object.fromEntries(Object.entries(this.backend.stats?.()||{}).map(([key,value])=>[key,Object.fromEntries(Object.entries(value).map(([field,total])=>[field,total-(before[key]?.[field]||0)]))]));
    return {regions,text:regions.map(r=>r.text).join('\n\n'),rejectedRegions:[...original.rejectedRegions,...rejected],detection,
      performance:{baselineAndDiscoveryMs:baselineFinished-started,segmentationMs:segmentationFinished-baselineFinished,recognitionMs:Date.now()-segmentationFinished,acceleration:finalStatus.acceleration,backend,inferenceReuse},
      engine:'comic-text-detector+manga-ocr+paddleocr',passes:[{name:'tesseract-baseline',regions:original.regions},
        {name:'detector',regions:assignIds(detection.boxes.map(c=>({...c,text:'',confidence:Math.round(c.detectionConfidence*100)})))},
        ...(detection.discovery?[{name:'paddle-discovery',regions:assignIds(detection.discovery.observations.map(c=>({...c,text:'',confidence:Math.round(c.detectionConfidence*100)})))}]:[]),
        ...[...alternatePasses].map(([name,values])=>({name,regions:assignIds(values,page.pageIndex||0)})),{name:'rejected-supplemental',regions:assignIds(rejected,page.pageIndex||0)},{name:'selected',regions}]};
  }
  async close(){await super.close();if(this.ownBackend)this.backend.close();}
}
module.exports={RECOVERY_PREPROCESSING,EnhancedMangaOcrPool,refineBalloonGroups,chooseReadings,selectVerticalReading,disagreement,shouldPromoteContainerReading,postprocessReading,confirmedDiscoveryLines,deduplicateReadings,PREPROCESSING};
