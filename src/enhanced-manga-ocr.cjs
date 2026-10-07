'use strict';
const sharp=require('sharp');
const {MangaOcrPool,normalizeText,scriptHint,meaningfulScore}=require('./manga-ocr.cjs');
const {LocalOcrBackend}=require('./ocr-backend.cjs');
const {detectText}=require('./comic-text-detector.cjs');
const {assignIds,editDistance,intersection,area}=require('./ocr-review.cjs');
const {discoverText}=require('./ocr-discovery.cjs');
const {prepareCrop}=require('./ocr-crop.cjs');
const PREPROCESSING=['original','grayscale','contrast','invert','clahe','adaptive','otsu'];

const compact=text=>normalizeText(text).replace(/\s+/gu,'');
function confirmedDiscoveryLines(readings){
 const observations=readings.flatMap(r=>r.error||r.engine!=='paddleocr'?[]:(r.textLines||[]).filter(l=>l.confidence>=90&&meaningfulScore(l.text)>=3).map(l=>({...l,variant:r.variant})));
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
  const duplicate=selected.find(other=>Boolean(row.discoveryOnly)!==Boolean(other.discoveryOnly)&&row.orientation===other.orientation&&canonical(row.text)&&canonical(row.text)===canonical(other.text)&&intersection(row.bbox,other.bbox)/Math.max(1,Math.min(area(row.bbox),area(other.bbox)))>.95&&Math.min(area(row.bbox),area(other.bbox))/Math.max(1,Math.max(area(row.bbox),area(other.bbox)))>.7);
  if(!duplicate){selected.push(row);continue;}
  // Prefer the independently supported complete reading and keep both
  // observations, including punctuation disagreements, available for review.
  const best=compact(row.text).length>compact(duplicate.text).length?row:duplicate;
  const observation=best===row?duplicate:row;
  const kept={...best,duplicateObservations:[...(duplicate.duplicateObservations||[]),observation],reviewRequired:true};
  selected[selected.indexOf(duplicate)]=kept;
 }
 return selected;
}
function disagreement(a,b){return editDistance(a,b)/Math.max(1,Array.from(compact(a)).length,Array.from(compact(b)).length);}
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
  const valid=readings.filter(r=>!r.error&&compact(r.text));
  if(!valid.length){const empty=readings.find(r=>!r.error);return empty?{...empty,selectionReason:'additional-engine-found-no-text'}:{...baseline,selectionReason:'no-additional-reading'};}
  // Agreement across preprocessing variants beats a solitary model score.
  const ranked=valid.map(r=>({...r,agreement:valid.filter(other=>compact(r.text)===compact(other.text)).length})).sort((a,b)=>b.agreement-a.agreement||(b.confidence||0)-(a.confidence||0));
  if(valid.length>=2&&ranked[0].textLines?.length){
    let changed=false;
    const lines=ranked[0].textLines.map(line=>{
      const matching=valid.map(r=>r.textLines?.filter(other=>intersection(line.bbox,other.bbox)/Math.max(1,Math.min(area(line.bbox),area(other.bbox)))>.6&&disagreement(line.text,other.text)<.45)
        .sort((a,b)=>disagreement(a.text,line.text)-disagreement(b.text,line.text))[0]).filter(Boolean);
      const voted=matching.map(r=>({...r,votes:matching.filter(o=>compact(o.text)===compact(r.text)).length})).sort((a,b)=>b.votes-a.votes||b.confidence-a.confidence);
      if(voted[0]?.votes>=2){changed||=compact(voted[0].text)!==compact(line.text);return voted[0];}return line;
    });
    if(changed)return {...ranked[0],text:lines.map(l=>l.text).join('\n'),textLines:lines,variant:'line-consensus',selectionReason:'position-aligned-line-agreement',confidence:lines.reduce((n,l)=>n+l.confidence,0)/lines.length};
  }
  if(allowBaseline&&ranked[0].agreement===1&&valid.length>1&&baseline.confidence>=90&&compact(baseline.text))return {...baseline,engine:'tesseract.js',selectionReason:'high-confidence-baseline-with-variant-conflict'};
  return {...ranked[0],selectionReason:ranked[0].agreement>1?'preprocessing-agreement':'single-reading-review'};
}
async function refineBalloonGroups(input,detected,backend,{signal}={}){
  const boxes=[];
  for(const c of detected.boxes){
    if(signal?.aborted)throw Error('ยกเลิก OCR');
    if((c.lines?.length||0)<4){boxes.push(c);continue;}
    const b=c.bbox,padX=Math.max(48,(b.x1-b.x0)*.5),padY=Math.max(64,(b.y1-b.y0)*.55);
    const left=Math.max(0,Math.floor(b.x0-padX)),top=Math.max(0,Math.floor(b.y0-padY));
    const width=Math.min(detected.width,Math.ceil(b.x1+padX))-left,height=Math.min(detected.height,Math.ceil(b.y1+padY))-top;
    const vertical=c.orientation==='vertical';
    const source=await sharp(input).extract({left,top,width,height}).png().toBuffer();
    const image=vertical?await sharp(source).rotate(90).png().toBuffer():source;
    const local=box=>({x0:box.x0-left,y0:box.y0-top,x1:box.x1-left,y1:box.y1-top});
    const rotated=box=>{const b=local(box);return vertical?{x0:height-b.y1,y0:b.x0,x1:height-b.y0,y1:b.x1}:b;};
    const result=await backend.request({op:'segment',image:image.toString('base64'),lines:c.lines.map(l=>({...l,bbox:rotated(l.bbox),coreBbox:rotated(l.coreBbox||l.bbox)}))},{signal});
    if(result.groups.length<2){boxes.push({...c,segmentationCheck:result.reason,segmentationSurface:result.surfaceMode});continue;}
    for(const [part,lines]of result.groups.entries()){
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
  constructor(options={}){super(options);this.backend=options.backend||new LocalOcrBackend();this.ownBackend=!options.backend;this.retryVariants=options.retryVariants!==false;this.sourceScale=options.sourceScale||1;this.discovery=options.discovery!==false;this.preprocessing=options.preprocessing||'auto';}
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
    if(!options.rectangle)detection=await refineBalloonGroups(page.filePath,detection,this.backend,options);
    const segmentationFinished=Date.now();
    const rows=[],rejected=[],baselineRows=[...original.regions,...original.rejectedRegions],alternatePasses=new Map(),meta=await sharp(page.filePath).metadata();
    const selected=this.languages;
    const japaneseRows=baselineRows.filter(r=>['ja','cjk'].includes(r.script)).length;
    const pageJapanese=selected.includes('jpn')&&japaneseRows>=2&&japaneseRows/Math.max(1,baselineRows.length)>=.3;
    const jobs=[];
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
      const language=single==='jpn'||baseline.script==='ja'||baseline.script==='cjk'||original.detection.pageLanguage==='ja'||pageJapanese?'ja':single==='tha'||baseline.script==='th'||original.detection.pageLanguage==='th'?'th':single==='fra'?'fr':'en';
      const padding=language==='th'?12*this.sourceScale:6*this.sourceScale,readings=[],cropCache=new Map();
      const readVariant=async(variant,{scale=language==='th'?1.5:2,pad=padding,engine=language==='ja'?'manga':'paddle',lang=language==='ja'?'japan':language,verification=false}={})=>{
        const left=Math.max(0,Math.floor(b.x0)-pad),top=Math.max(0,Math.floor(b.y0)-pad),width=Math.min(meta.width,Math.ceil(b.x1)+pad)-left,height=Math.min(meta.height,Math.ceil(b.y1)+pad)-top;
        const cropWidth=Math.max(1,Math.min(1000,Math.round(width*scale/this.sourceScale),Math.floor(Math.sqrt(2000000*width/height)),Math.floor(4000*width/height))),cropMeta={rectangle:{left,top,width,height},width:cropWidth,border:12,inputScale:this.sourceScale,
          maskLines:candidate.segmentation?candidate.lines.map(l=>({coreBbox:l.coreBbox||l.bbox,cutEdge:l.cutEdge})):undefined,maskPadding:8};
        const key=JSON.stringify(cropMeta);
        if(!cropCache.has(key))cropCache.set(key,prepareCrop(page.filePath,cropMeta,{prepared:true}));
        const crop=await cropCache.get(key),cropDimensions=await sharp(crop).metadata(),cropScale=cropWidth/width,cropScaleY=(cropDimensions.height-24)/height;
        const globalBox=a=>({x0:Math.max(0,left+(a.x0-12)/cropScale),y0:Math.max(0,top+(a.y0-12)/cropScaleY),x1:Math.min(meta.width,left+(a.x1-12)/cropScale),y1:Math.min(meta.height,top+(a.y1-12)/cropScaleY)});
        try{
          const read=postprocessReading({...await this.backend.read(crop,{engine,language:lang,variant,signal:options.signal})});
          return {...read,text:normalizeText(read.text),variant,verification,crop:cropMeta,coordinateSpace:'original-image',
            lines:read.lines?.map(l=>({...l,bbox:globalBox(l.bbox),polygon:l.polygon?.map(([x,y])=>[left+(x-12)/cropScale,top+(y-12)/cropScaleY])})),
            textLines:read.textLines?.map(l=>({...l,bbox:globalBox(l.bbox)})),suppressedLines:read.suppressedLines?.map(l=>({...l,bbox:globalBox(l.bbox),polygon:undefined}))};
        }catch(error){if(options.signal?.aborted)throw error;return {variant,text:'',error:error.message,crop:cropMeta};}
      };
      // Verify an uncertain Japanese proposal before running a generative
      // recognizer. The same acceptance gate used to run after every retry.
      let support=null;
      const verify=language==='ja'&&candidate.lineOnly&&(candidate.discoveryOnly||!baseline.text||baseline.confidence<45);
      if(verify)support=await readVariant('original',{engine:'paddle',lang:'japan',verification:true});
      const verificationFailed=verify&&!(support.confidence>=75&&['ja','cjk'].includes(scriptHint(support.text)));
      readings.push(...await Promise.all((verificationFailed?[]:language==='ja'||!this.retryVariants?['original']:['original','contrast','invert']).map(variant=>readVariant(variant))));
      if(readings.length&&readings.every(r=>r.error))throw Error(readings[0].error);
      let chosen=verificationFailed?{...baseline,text:'',confidence:0,engine:'tesseract.js',selectionReason:'unsupported-japanese-proposal'}:chooseReadings(readings,{...baseline,engine:'tesseract.js'},{allowBaseline:language!=='th'});
      const stable=readings.filter(r=>!r.error&&r.confidence>=85&&compact(r.text)===compact(chosen.text)).length>=2;
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
        chosen=chooseReadings(readings,{...baseline,engine:'tesseract.js'},{allowBaseline:language!=='th'});
      }
      // Manga OCR always emits text, even on blank artwork. Do not promote
      // its output for uncertain line-only proposals without supporting OCR.
      if(verify){
        if(support.confidence>=75&&['ja','cjk'].includes(scriptHint(support.text)))readings.push(support);
        else {readings.push(support);chosen={...baseline,text:'',confidence:0,engine:'tesseract.js',selectionReason:'unsupported-japanese-proposal'};}
      }
      const disagree=readings.some(r=>!r.error&&disagreement(r.text,chosen.text)>.02)||disagreement(baseline.text,chosen.text)>.02;
      const recovered=candidate.discoveryOnly&&language!=='ja'&&(chosen.confidence||0)<75?confirmedDiscoveryLines(readings):[];
      if(recovered.length)chosen={...chosen,engine:'paddleocr',model:readings.find(r=>r.engine==='paddleocr')?.model,text:recovered.map(l=>l.text).join('\n'),textLines:recovered,confidence:recovered.reduce((sum,l)=>sum+l.confidence,0)/recovered.length,selectionReason:'confirmed-discovery-line-recovery'};
      const confidence=chosen.confidence===null?null:Math.round(chosen.confidence||0);
      const row={...baseline,...candidate,bbox:{...b},text:chosen.text,confidence,script:scriptHint(chosen.text),recognitionEngine:chosen.engine,recognitionModel:chosen.model,
        recognitionLanguages:[language],recognitionLines:chosen.textLines||[],selectionReason:chosen.selectionReason,alternatives:[{...baseline,engine:'tesseract.js'},...readings],
        observedBy:[candidate.discoveryOnly?'paddle-text-detector':'comic-text-detector',chosen.engine],retryApplied:readings.length>(language==='ja'?1:3),reviewRequired:Boolean(disagree||candidate.reviewRequired||candidate.lineOnly||confidence===null||confidence<85||!chosen.text),disagreement:disagree};
      if(!candidate.segmentation&&chosen.engine==='paddleocr'){
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
        row.detectorBBox={...b};row.localizationRefinement='confirmed-line-bounds';
        row.bbox={x0:Math.max(0,Math.floor(Math.min(...recovered.map(l=>l.bbox.x0))-3*this.sourceScale)),y0:Math.max(0,Math.floor(Math.min(...recovered.map(l=>l.bbox.y0))-3*this.sourceScale)),x1:Math.min(meta.width,Math.ceil(Math.max(...recovered.map(l=>l.bbox.x1))+3*this.sourceScale)),y1:Math.min(meta.height,Math.ceil(Math.max(...recovered.map(l=>l.bbox.y1))+3*this.sourceScale))};
      }
      // Baseline word coordinates are observations of its own reading. They
      // must not be presented as alignment for a different recognizer's text.
      if(chosen.engine!=='tesseract.js')row.words=[];
      const rejectedDiscovery=candidate.discoveryOnly&&(!compact(chosen.text)||language!=='ja'&&(meaningfulScore(chosen.text)<2||confidence<75)||language==='th'&&scriptHint(chosen.text)!=='th'||language==='ja'&&!['ja','cjk'].includes(scriptHint(chosen.text)));
      return {row,rejectedDiscovery,readings};
    };
    const completed=new Array(jobs.length);let cursor=0;
    const worker=async()=>{while(cursor<jobs.length){const index=cursor++;completed[index]=await processCandidate(jobs[index]);}};
    await Promise.all(Array.from({length:Math.min(jobs.length,backendStatus.capabilities?.batch?2:1)},()=>worker()));
    // Preserve source order, stable IDs, variant votes and response provenance.
    for(const {row,rejectedDiscovery,readings} of completed){
      if(rejectedDiscovery)rejected.push({...row,rejectionReason:'supplemental-detection-not-confirmed-by-reading'});else rows.push(row);
      for(const r of readings){const name=(r.engine==='manga-ocr'?'manga':'paddle')+'-'+r.variant+(r.verification?'-verification':'');if(!alternatePasses.has(name))alternatePasses.set(name,[]);alternatePasses.get(name).push({...row,text:r.text,confidence:r.confidence,error:r.error,recognitionLines:r.textLines||[],crop:r.crop,alternatives:undefined});}
    }
    const regions=assignIds(deduplicateReadings(rows),page.pageIndex||0);
    const finalStatus=await this.backend.status();
    const backend=Object.fromEntries(Object.entries(this.backend.stats?.()||{}).map(([key,value])=>[key,Object.fromEntries(Object.entries(value).map(([field,total])=>[field,total-(before[key]?.[field]||0)]))]));
    return {regions,text:regions.map(r=>r.text).join('\n\n'),rejectedRegions:[...original.rejectedRegions,...rejected],detection,
      performance:{baselineAndDiscoveryMs:baselineFinished-started,segmentationMs:segmentationFinished-baselineFinished,recognitionMs:Date.now()-segmentationFinished,acceleration:finalStatus.acceleration,backend},
      engine:'comic-text-detector+manga-ocr+paddleocr',passes:[{name:'tesseract-baseline',regions:original.regions},
        {name:'detector',regions:assignIds(detection.boxes.map(c=>({...c,text:'',confidence:Math.round(c.detectionConfidence*100)})))},
        ...(detection.discovery?[{name:'paddle-discovery',regions:assignIds(detection.discovery.observations.map(c=>({...c,text:'',confidence:Math.round(c.detectionConfidence*100)})))}]:[]),
        ...[...alternatePasses].map(([name,values])=>({name,regions:assignIds(values,page.pageIndex||0)})),{name:'rejected-supplemental',regions:assignIds(rejected,page.pageIndex||0)},{name:'selected',regions}]};
  }
  async close(){await super.close();if(this.ownBackend)this.backend.close();}
}
module.exports={EnhancedMangaOcrPool,refineBalloonGroups,chooseReadings,disagreement,postprocessReading,confirmedDiscoveryLines,deduplicateReadings,PREPROCESSING};
