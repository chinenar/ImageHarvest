'use strict';
// Resolve layout units from positioned OCR observations, never from translations.
// Raw readings are retained in sourceObservations; any changed unit invalidates
// its old translation record and must be translated again.
const {createHash}=require('node:crypto');
const compact=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const area=b=>b?Math.max(0,b.x1-b.x0)*Math.max(0,b.y1-b.y0):0;
const intersection=(a,b)=>a&&b?Math.max(0,Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0))*Math.max(0,Math.min(a.y1,b.y1)-Math.max(a.y0,b.y0)):0;
const valid=b=>b&&['x0','y0','x1','y1'].every(k=>Number.isFinite(b[k]))&&area(b)>0;
function union(boxes){return {x0:Math.min(...boxes.map(b=>b.x0)),y0:Math.min(...boxes.map(b=>b.y0)),x1:Math.max(...boxes.map(b=>b.x1)),y1:Math.max(...boxes.map(b=>b.y1))};}
function rawLines(row={}){
 const observations=(row.alternatives||[]).filter(a=>a.engine===row.recognitionEngine&&a.lines?.length&&!a.error);
 const exact=observations.filter(a=>compact(a.text)===compact(row.text)).sort((a,b)=>(b.confidence||0)-(a.confidence||0))[0];
 const chosen=exact?.lines||row.recognitionLines||[];
 // Tesseract baseline rows often expose only positioned words, while Paddle
 // exposes recognitionLines. Treat those words as line observations too so
 // fragments from one speech line can be reunited before translation.
 const fallback=chosen.length?chosen:(row.words||[]).map(w=>({text:w.text,bbox:w.bbox,confidence:Number(w.confidence??row.confidence)||0,wordFallback:true}));
 return fallback.filter(l=>valid(l.bbox)&&String(l.text||'').trim()).map(l=>({...l,bbox:{...l.bbox}}));
}
function sameLine(a,b,orientation='horizontal'){
 if(orientation==='vertical'){
  const aw=a.bbox.x1-a.bbox.x0,bw=b.bbox.x1-b.bbox.x0;
  return Math.abs(a.bbox.x0+a.bbox.x1-b.bbox.x0-b.bbox.x1)/2<=Math.max(4,Math.min(aw,bw)*.46)&&intersection(a.bbox,b.bbox)/Math.max(1,Math.min(area(a.bbox),area(b.bbox)))>.55;
 }
 const ah=a.bbox.y1-a.bbox.y0,bh=b.bbox.y1-b.bbox.y0;
 const cy=b=>(b.y0+b.y1)/2;
 return Math.abs(cy(a.bbox)-cy(b.bbox))<=Math.max(4,Math.min(ah,bh)*.46)&&intersection(a.bbox,b.bbox)/Math.max(1,Math.min(area(a.bbox),area(b.bbox)))>.55;
}
function equivalentFragment(a,b){
 const x=compact(a.text),y=compact(b.text);if(!x||!y)return false;
 if(x===y||x.includes(y)||y.includes(x))return true;
 const [short,long]=x.length<y.length?[x,y]:[y,x];let prefix=0;while(prefix<short.length&&short[prefix]===long[prefix])prefix++;
 return short.length>=3&&prefix/short.length>=.60&&long.length>=short.length*1.4;
}
function composeLines(lines,orientation='horizontal'){
 const kept=[],suppressed=[];
 for(const line of [...lines].sort((a,b)=>compact(b.text).length-compact(a.text).length||(b.confidence||0)-(a.confidence||0))){
  if(Number.isFinite(line.confidence)&&line.confidence<78){suppressed.push({...line,reason:'weak-line-observation'});continue;}
  const other=kept.find(k=>sameLine(k,line,orientation)&&equivalentFragment(k,line));
  if(other){suppressed.push({...line,reason:'covered-line-observation'});continue;}
  kept.push(line);
 }
 if(orientation==='vertical'){
  const columns=[];
  for(const line of [...kept].sort((a,b)=>b.bbox.x1-a.bbox.x1||a.bbox.y0-b.bbox.y0)){
   const column=columns.find(c=>{
    const a=c[0].bbox,b=line.bbox;
    return Math.max(0,Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0))/Math.max(1,Math.min(a.x1-a.x0,b.x1-b.x0))>.5;
   });
   if(column)column.push(line);else columns.push([line]);
  }
  const output=columns.map(c=>{c.sort((a,b)=>a.bbox.y0-b.bbox.y0);return {text:c.map(l=>l.text.trim()).join(''),bbox:union(c.map(l=>l.bbox)),confidence:c.reduce((s,l)=>s+(l.confidence||0),0)/c.length};});
  return {text:output.map(l=>l.text).join('\n'),lines:output,raw:kept,suppressed};
 }
 const heights=kept.map(l=>l.bbox.y1-l.bbox.y0).sort((a,b)=>a-b),tolerance=Math.max(4,(heights[Math.floor(heights.length/2)]||12)*.48),groups=[];
 for(const l of kept.sort((a,b)=>(a.bbox.y0+a.bbox.y1)-(b.bbox.y0+b.bbox.y1)||a.bbox.x0-b.bbox.x0)){
  const cy=(l.bbox.y0+l.bbox.y1)/2;let g=groups.find(g=>Math.abs(g.cy-cy)<=tolerance);
  if(!g){g={cy,items:[]};groups.push(g);}g.items.push(l);
 }
 const output=groups.sort((a,b)=>a.cy-b.cy).map(g=>{g.items.sort((a,b)=>a.bbox.x0-b.bbox.x0);return {text:g.items.map(l=>l.text.trim()).join(' '),bbox:union(g.items.map(l=>l.bbox)),confidence:g.items.reduce((s,l)=>s+(l.confidence||0),0)/g.items.length};});
 return {text:output.map(l=>l.text).join('\n'),lines:output,raw:kept,suppressed};
}
function resolveReadingUnits(rows=[],placements=[]){
 const surfaces=new Map(placements.map(r=>[String(r.id),r.placement]));
 const lines=rows.map(rawLines),parent=rows.map((_,i)=>i);
 const find=i=>parent[i]===i?i:(parent[i]=find(parent[i]));
 const members=rows.map((_,i)=>[i]),shared=new Map();
 const samePositionedObservation=(i,j)=>{
  const key=i<j?i+'|'+j:j+'|'+i;
  if(!shared.has(key))shared.set(key,lines[i].some(x=>lines[j].some(y=>sameLine(x,y,rows[i].orientation)&&equivalentFragment(x,y))));
  return shared.get(key);
 };
 const distinctBalloonParts=(a,b)=>Boolean(a.segmentation)&&Boolean(b.segmentation)&&
  Boolean(a.containerId)&&a.containerId===b.containerId&&Number.isInteger(a.part)&&Number.isInteger(b.part)&&a.part!==b.part;
 const merge=(i,j)=>{
  const ai=find(i),bi=find(j);if(ai===bi)return;
  // A broad third reading must not bridge detector-confirmed balloon parts.
  // Conflicting part observations can join only when their own positioned
  // evidence establishes that they are duplicates.
  if(members[ai].some(x=>members[bi].some(y=>distinctBalloonParts(rows[x],rows[y])&&!samePositionedObservation(x,y))))return;
  parent[bi]=ai;members[ai].push(...members[bi]);members[bi]=[];
 };
 for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++){
  const a=rows[i],b=rows[j];if(a.reviewed||b.reviewed||a.partialReadingEvidence||b.partialReadingEvidence||!lines[i].length||!lines[j].length||a.layoutSplit||b.layoutSplit)continue;
  if((a.orientation||'horizontal')!==(b.orientation||'horizontal'))continue;
  const overlap=intersection(a.bbox,b.bbox)/Math.max(1,Math.min(area(a.bbox),area(b.bbox)));
  const sameObservation=samePositionedObservation(i,j);
  if(distinctBalloonParts(a,b)&&!sameObservation)continue;
  // The enhanced recognizer has already resolved these paragraphs. A broad
  // connected white surface is not evidence that their sentences belong together.
  if(a.localizationRefinement&&b.localizationRefinement&&!sameObservation)continue;
  const pa=surfaces.get(String(a.id)),pb=surfaces.get(String(b.id));
  const shapeOverlap=intersection(pa?.eraseBox,pb?.eraseBox)/Math.max(1,area(pa?.eraseBox)+area(pb?.eraseBox)-intersection(pa?.eraseBox,pb?.eraseBox));
  const sameSurface=Boolean((pa?.surfaceValidated&&pb?.surfaceValidated&&pa?.surfaceKey&&pa.surfaceKey===pb.surfaceKey)||(pa?.surfaceType==='bubble'&&pb?.surfaceType==='bubble'&&pa?.surfaceValidated&&pb?.surfaceValidated&&shapeOverlap>=.88));
  if(a.orientation==='vertical'){
   // Never apply horizontal paragraph adjacency to vertical columns. Shared
   // positioned evidence permits duplicate removal, not cross-bubble merging.
   if(sameObservation)merge(i,j);
   continue;
  }
  const cx=b=>(b.x0+b.x1)/2,aw=a.bbox.x1-a.bbox.x0,bw=b.bbox.x1-b.bbox.x0,ah=a.bbox.y1-a.bbox.y0,bh=b.bbox.y1-b.bbox.y0;
  const aligned=Math.abs(cx(a.bbox)-cx(b.bbox))<Math.min(aw,bw)*.38;
  const xOverlap=Math.max(0,Math.min(a.bbox.x1,b.bbox.x1)-Math.max(a.bbox.x0,b.bbox.x0))/Math.max(1,Math.min(aw,bw));
  const yOverlap=Math.max(0,Math.min(a.bbox.y1,b.bbox.y1)-Math.max(a.bbox.y0,b.bbox.y0))/Math.max(1,Math.min(ah,bh));
  const gapX=Math.max(0,Math.max(a.bbox.x0,b.bbox.x0)-Math.min(a.bbox.x1,b.bbox.x1)),gapY=Math.max(0,Math.max(a.bbox.y0,b.bbox.y0)-Math.min(a.bbox.y1,b.bbox.y1)),lineH=Math.max(ah,bh);
  const charWidth=Math.max(4,Math.min(aw/Math.max(1,compact(a.text).length),bw/Math.max(1,compact(b.text).length)));
  const sameLineGap=Math.max(12,Math.min(lineH*.68,charWidth*2.35));
  const adjacentSameLine=yOverlap>=.52&&gapX<=sameLineGap;
  const adjacentStacked=xOverlap>=.35&&gapY<=Math.max(16,lineH*.95)&&Math.abs(cx(a.bbox)-cx(b.bbox))<=Math.max(aw,bw)*.72;
  if(overlap<.30&&!(sameSurface&&(adjacentSameLine||adjacentStacked)))continue;
  if(sameObservation||(sameSurface&&((aligned&&overlap>.5)||adjacentSameLine||adjacentStacked)))merge(i,j);
 }
 const groups=new Map();rows.forEach((r,i)=>{const f=find(i);if(!groups.has(f))groups.set(f,[]);groups.get(f).push(i);});
 const output=[],changes=[];
 for(const indices of groups.values()){
  if(indices.length===1){output.push(rows[indices[0]]);continue;}
  const original=indices.map(i=>rows[i]),orientation=original[0].orientation||'horizontal',composed=composeLines(indices.flatMap(i=>lines[i]),orientation);
  if(!composed.text){output.push(...original);continue;}
  const best=[...original].sort((a,b)=>compact(b.text).length-compact(a.text).length)[0];
  const bbox=union(composed.lines.map(l=>l.bbox));for(const k of ['x0','y0'])bbox[k]=Math.max(0,Math.floor(bbox[k]-2));for(const k of ['x1','y1'])bbox[k]=Math.ceil(bbox[k]+2);
  const id='unit-'+createHash('sha256').update(original.map(r=>r.id).join('|')+'|'+composed.text).digest('hex').slice(0,16);
  const unit={...best,id,text:composed.text,bbox,orientation,words:[],recognitionLines:composed.lines,unitSourceLines:composed.raw,sourceRegionIds:original.map(r=>r.id),sourceObservations:original.map(r=>({...r,placement:undefined,translation:undefined,translationRecord:undefined})),unitResolution:'positioned-lines',unitSuppressedLines:composed.suppressed,reviewRequired:Boolean(original.some(r=>r.reviewRequired)),placement:undefined};
  delete unit.translation;delete unit.translationRecord;delete unit.alternatives;delete unit.contentRole;
  output.push(unit);changes.push({id,parents:unit.sourceRegionIds,reason:'overlapping-readings-of-one-paragraph'});
 }
 return {regions:output,changes};
}
module.exports={rawLines,composeLines,resolveReadingUnits,area,intersection,valid,union};
