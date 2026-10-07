'use strict';
const sharp=require('sharp');
const {translationEligible}=require('./ocr-content-role.cjs');
const {rawLines,resolveReadingUnits,composeLines,area,intersection,valid}=require('./reading-units.cjs');
function observation(row){const lines=row.unitSourceLines?.length?row.unitSourceLines:rawLines(row);return {id:row.id,text:row.text,bbox:row.bbox,orientation:row.orientation,layoutSplit:Boolean(row.layoutSplit),segmentationLocked:row.unitResolution==='positioned-lines',excludeFromLayoutCompetition:!translationEligible({...row,placement:undefined}),zonePolygon:row.zonePolygon,recognitionLines:lines.length?lines:(row.words?.filter(w=>w.bbox)||[])};}
const invalidated=row=>{const copy={...row};delete copy.translation;delete copy.translationRecord;delete copy.placement;delete copy.contentRole;return copy;};
function readLanguage(row,sourceLanguage){if(['en','fr','th'].includes(sourceLanguage))return sourceLanguage;const l=row.recognitionLanguages?.[0];return ({fra:'fr',eng:'en',tha:'th',ja:'japan',jpn:'japan',fr:'fr',en:'en',th:'th'})[l]||'en';}
async function readCrop(backend,image,b,options){
 const m=await sharp(image).metadata();const x0=Math.max(0,Math.floor(b.x0)-6),y0=Math.max(0,Math.floor(b.y0)-6),x1=Math.min(m.width,Math.ceil(b.x1)+6),y1=Math.min(m.height,Math.ceil(b.y1)+6);
 const crop=await sharp(image).extract({left:x0,top:y0,width:x1-x0,height:y1-y0}).png().toBuffer();
 const read=await backend.read(crop,options);return {...read,lines:(read.lines||[]).map(l=>({...l,bbox:{x0:l.bbox.x0+x0,y0:l.bbox.y0+y0,x1:l.bbox.x1+x0,y1:l.bbox.y1+y0}}))};
}
function normalizePlacement(p,width,height){
 const b=v=>v&&Object.fromEntries(Object.entries(v).map(([k,n])=>[k,Math.max(0,Math.min(1,n/(k[0]==='x'?width:height)))]));
 return {...p,normalized:{eraseBox:b(p.eraseBox),safeBox:b(p.safeBox),polygon:(p.polygon||[]).map(([x,y])=>[x/width,y/height])}};
}
function guardCollisions(rows){
 // Disjoint source boxes may trim layout padding. Inseparable conflicting OCR
 // remains available for review, not painted twice or counted as complete.
 for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++){
  const a=rows[i],b=rows[j],pa=a.placement,pb=b.placement;if(!pa||!pb||!a.text?.trim()||!b.text?.trim()||!translationEligible(a)||!translationEligible(b))continue;
  if(intersection(pa.safeBox,pb.safeBox)<1)continue;
  const sourceOverlap=intersection(a.bbox,b.bbox)/Math.max(1,Math.min(area(a.bbox),area(b.bbox)));
  if(sourceOverlap>.32){
   const weak=(a.confidence||0)===(b.confidence||0)?(a.text.length<b.text.length?a:b):((a.confidence||0)<(b.confidence||0)?a:b);
   weak.layoutIssue='overlapping-source-readings-need-review';weak.placement={...weak.placement,paintMode:'none',reviewRequired:true};continue;
  }
  const ax=(a.bbox.x0+a.bbox.x1)/2,bx=(b.bbox.x0+b.bbox.x1)/2,ay=(a.bbox.y0+a.bbox.y1)/2,by=(b.bbox.y0+b.bbox.y1)/2;
  const horizontal=Math.abs(ax-bx)/Math.max(1,(a.bbox.x1-a.bbox.x0+b.bbox.x1-b.bbox.x0)/2)>Math.abs(ay-by)/Math.max(1,(a.bbox.y1-a.bbox.y0+b.bbox.y1-b.bbox.y0)/2);
  const first=horizontal?ax<bx:ay<by,lo=first?pa:pb,hi=first?pb:pa;
  const from=horizontal?'x0':'y0',to=horizontal?'x1':'y1',cut=horizontal?(ax+bx)/2:(ay+by)/2;
  const lb={...lo.safeBox,[to]:Math.min(lo.safeBox[to],cut-2)},hb={...hi.safeBox,[from]:Math.max(hi.safeBox[from],cut+2)};
  if(valid(lb)&&valid(hb)){lo.safeBox=lb;hi.safeBox=hb;}else{a.layoutIssue='invalid-placement-zone';b.layoutIssue='invalid-placement-zone';}
 }
 return rows;
}
async function planReadingPage(backend,image,source,{signal,refineText=false,sourceLanguage='auto',onRefine}={}){
 const started=Date.now();let rows=source.map(r=>({...r}));
 let layout=await backend.layoutSafe(image,rows.map(observation),{signal});const changes=[];
 if(refineText){
  const units=resolveReadingUnits(rows,layout.regions);rows=units.regions;changes.push(...units.changes);
  // Only conflicted paragraph crops pay for a new reading. Never run an extra
  // full-page recognizer to paper over a geometry bug.
  for(let i=0;i<rows.length;i++)if(rows[i].unitResolution==='positioned-lines'){
   const row=rows[i];onRefine?.({id:row.id,reason:'paragraph-recovery'});
   try{const read=await readCrop(backend,image,row.bbox,{engine:'paddle',language:readLanguage(row,sourceLanguage),variant:'original',signal});
    if(read.confidence>=85&&read.text?.trim().length>=row.text.trim().length*.8){const combined=composeLines(read.lines);if(combined.text)rows[i]={...invalidated(row),text:combined.text,confidence:Math.round(read.confidence),recognitionLines:combined.lines,unitSourceLines:read.lines,localizationRefinement:'recovered-complete-paragraph',reviewRequired:false};}
   }catch(error){if(signal?.aborted)throw error;rows[i]={...row,refinementError:error.message,reviewRequired:true};}
  }
  if(units.changes.length)layout=await backend.layoutSafe(image,rows.map(observation),{signal});
  const byId=new Map(layout.regions.map(r=>[r.id,r.placement]));const refined=[];
  for(const row of rows){
   const hints=byId.get(row.id)?.splitHints||[];if(hints.length!==2){refined.push(row);continue;}
   const children=[];onRefine?.({id:row.id,reason:'connected-balloon-recovery'});
   try{
    for(const [i,hint] of hints.entries()){
     if(signal?.aborted)throw Error('ยกเลิก OCR');
     const read=await backend.read(Buffer.from(hint.image,'base64'),{engine:'paddle',language:readLanguage(row,sourceLanguage),variant:'original',signal});
     if(!read.text?.trim()||read.confidence<80)throw Error('อ่านข้อความของแต่ละบับเบิลยังไม่ชัดเจน');
     const lines=(read.lines||[]).map(l=>({...l,bbox:{x0:l.bbox.x0+hint.bbox.x0,y0:l.bbox.y0+hint.bbox.y0,x1:l.bbox.x1+hint.bbox.x0,y1:l.bbox.y1+hint.bbox.y0}}));
     const composed=composeLines(lines);if(!composed.text)throw Error('ไม่พบข้อความที่ยืนยันได้ในบับเบิลย่อย');
     const b={x0:Math.floor(Math.min(...lines.map(l=>l.bbox.x0))),y0:Math.floor(Math.min(...lines.map(l=>l.bbox.y0))),x1:Math.ceil(Math.max(...lines.map(l=>l.bbox.x1))),y1:Math.ceil(Math.max(...lines.map(l=>l.bbox.y1)))};
     children.push({...invalidated(row),id:row.id+'::lobe-'+(i+1),parentRegionId:row.id,sourceRegionIds:[row.id],sourceObservations:[{id:row.id,text:row.text,bbox:row.bbox}],text:composed.text,bbox:b,confidence:Math.round(read.confidence),words:[],alternatives:[],recognitionLines:composed.lines,unitSourceLines:lines,layoutSplit:true,zonePolygon:hint.polygon,unitResolution:hint.reason,reviewRequired:false});
    }
    refined.push(...children);changes.push({id:row.id,children:children.map(r=>r.id),reason:'connected-balloon-recovery'});
   }catch(error){if(signal?.aborted)throw error;refined.push({...row,layoutIssue:'connected-balloons-need-review',refinementError:error.message});}
  }
  rows=refined;
 }
 layout=await backend.layoutSafe(image,rows.map(observation),{signal,includeSplitHints:false});
 const placements=new Map(layout.regions.map(r=>[r.id,r.placement]));
 rows=rows.map(row=>{const p=placements.get(row.id);if(!p)return {...row,layoutIssue:'no-placement'};const {splitHints,...clean}=p;return {...row,placement:{...clean,surfaceId:p.surfaceKey||'region-'+row.id,activeSubSurfaceId:row.layoutSplit?row.id:'',placementZone:true}};});
 rows=guardCollisions(rows).map(r=>({...r,placement:r.placement&&normalizePlacement(r.placement,layout.width,layout.height)}));
 return {width:layout.width,height:layout.height,regions:rows,changes,ms:Date.now()-started,error:'',engine:'closed-pixel-surface-v2'};
}
module.exports={planReadingPage,guardCollisions,observation};
