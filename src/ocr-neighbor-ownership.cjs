'use strict';
const {intersection,area}=require('./ocr-review.cjs');
function neighborOwnership(detection){
 const supported=new Map();
 for(const box of detection.boxes){
  if(box.orientation==='vertical'||box.segmentation||(box.lines?.length||0)<2)continue;
  const lines=(box.discoveryLines||[]).filter(l=>l.polygon?.length===4&&l.detectionConfidence>=.85&&
   box.lines.some(own=>intersection(own.coreBbox||own.bbox,l.bbox)/Math.max(1,area(own.coreBbox||own.bbox))>.7));
  if(lines.length>=2)supported.set(box,lines);
 }
 return {...detection,boxes:detection.boxes.map(box=>{
  const own=supported.get(box);if(!own)return box;
  const foreign=[...supported].filter(([other])=>other!==box&&intersection(other.bbox,box.bbox)>0).flatMap(([,lines])=>lines).filter(line=>
   intersection(line.bbox,box.bbox)>0&&own.every(l=>intersection(l.bbox,line.bbox)/Math.max(1,Math.min(area(l.bbox),area(line.bbox)))<.08));
  if(!foreign.length)return box;
  const bounds=[box.bbox,...own.map(l=>l.bbox)];
  return {...box,detectorBBox:box.detectorBBox||box.bbox,
   bbox:{x0:Math.min(...bounds.map(b=>b.x0)),y0:Math.min(...bounds.map(b=>b.y0)),x1:Math.max(...bounds.map(b=>b.x1)),y1:Math.max(...bounds.map(b=>b.y1))},
   excludedPolygons:[...(box.excludedPolygons||[]),...foreign.map(l=>l.polygon)],neighborOwnership:true};
 })};
}
module.exports={neighborOwnership};
