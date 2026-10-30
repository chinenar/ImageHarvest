'use strict';
const fs=require('node:fs/promises');
const {intersection,area}=require('./ocr-review.cjs');
const {reconcilePlacements}=require('./text-placement.cjs');
async function rejoinParagraphs(input,detection,backend,{signal}={}){
 const parents=new Map();
 for(const box of detection.boxes){
  if(!box.containerId||box.discoveryOnly||box.orientation==='vertical'||box.segmentation)continue;
  if(!parents.has(box.containerId))parents.set(box.containerId,[]);
  parents.get(box.containerId).push(box);
 }
 const candidates=[];
 for(const members of parents.values()){
  if(members.length<2||members.length>4)continue;
  const sorted=[...members].sort((a,b)=>a.bbox.y0-b.bbox.y0);
  const heights=members.flatMap(b=>(b.lines||[]).map(l=>l.bbox.y1-l.bbox.y0)).sort((a,b)=>a-b);
  const height=heights[Math.floor(heights.length/2)]||0;
  if(!height||!sorted.slice(1).every((b,i)=>{
   const a=sorted[i].bbox,c=b.bbox;
   return Math.max(0,Math.min(a.x1,c.x1)-Math.max(a.x0,c.x0))/Math.max(1,Math.min(a.x1-a.x0,c.x1-c.x0))>.7&&
    c.y0-a.y1<=height*2.5&&c.y0>=a.y1-height*.25;
  }))continue;
  const parent=members[0].containerBBox;if(!parent)continue;
  const supplemental=detection.boxes.filter(b=>b.discoveryOnly&&b.orientation!=='vertical'&&intersection(b.bbox,parent)/Math.max(1,area(b.bbox))>.8);
  candidates.push([...members,...supplemental]);
 }
 if(!candidates.length)return detection;
 const all=[...new Set(candidates.flat())],ids=new Map(all.map((b,i)=>[b,'fragment-'+i]));
 const layout=await backend.layoutSafe(await fs.readFile(input),all.map(b=>({id:ids.get(b),text:'',bbox:b.bbox,recognitionLines:b.lines||[],orientation:'horizontal'})),{signal});
 const rawSurfaces=new Map(layout.regions.map(r=>[r.id,r.placement]));
 const surfaces=new Map(reconcilePlacements(all.map(b=>({id:ids.get(b),bbox:b.bbox,placement:rawSurfaces.get(ids.get(b))}))).map(r=>[r.id,r.placement])),used=new Set(),joined=[];
 for(const members of candidates){
  if(members.some(b=>used.has(b)))continue;
  const p=members.map(b=>surfaces.get(ids.get(b)));
  if(p.some(s=>!s?.surfaceValidated||s.surfaceType!=='bubble'||!s.surfaceKey||s.surfaceKey!==p[0].surfaceKey||s.splitHints?.length))continue;
  const bounds=members.map(b=>b.bbox);
  joined.push({...members[0],bbox:{x0:Math.min(...bounds.map(b=>b.x0)),y0:Math.min(...bounds.map(b=>b.y0)),x1:Math.max(...bounds.map(b=>b.x1)),y1:Math.max(...bounds.map(b=>b.y1))},
   lines:members.flatMap(b=>b.lines||[]),discoveryLines:members.flatMap(b=>b.discoveryLines||[]),sourceDetectorFragments:members,groupingReason:'aligned-fragments-on-validated-bubble'});
  members.forEach(b=>used.add(b));
 }
 if(!joined.length)return detection;
 // Keep unaffected regions in their detector order; changing batching alone can
 // change recognition even when no geometry was corrected.
 const replacements=new Map(joined.map(b=>[b.sourceDetectorFragments[0],b]));
 return {...detection,boxes:detection.boxes.flatMap(b=>replacements.has(b)?[replacements.get(b)]:used.has(b)?[]:[b])};
}
module.exports={rejoinParagraphs};
