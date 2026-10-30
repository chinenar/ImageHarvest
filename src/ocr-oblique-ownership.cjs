'use strict';
const {area,intersection}=require('./ocr-review.cjs');
function extendLine(p,width,height){
 const [a,b,c,d]=p,dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy),pad=Math.hypot(d[0]-a[0],d[1]-a[1])*.65;
 return p.map(([x,y],i)=>{const direction=i===0||i===3?-1:1;return [Math.max(0,Math.min(width,x+direction*dx/length*pad)),Math.max(0,Math.min(height,y+direction*dy/length*pad))];});
}
function obliqueOwnership(detection){
 const observations=(detection.discovery?.observations||[]).filter(l=>{
  if(l.polygon?.length!==4||l.tileClipped||l.detectionConfidence<.6)return false;
  const [a,b]=l.polygon,angle=Math.abs(Math.atan2(b[1]-a[1],b[0]-a[0]));
  return angle>Math.PI/9&&angle<Math.PI*4/9;
 });
 const owners=new Map();
 for(const box of detection.boxes){
  if(box.orientation==='vertical'||box.lines?.length!==1)continue;
  const supported=observations.filter(l=>intersection(l.bbox,box.bbox)/Math.max(1,area(l.bbox))>.65&&new Set(observations.filter(o=>intersection(l.bbox,o.bbox)/Math.max(1,Math.max(area(l.bbox),area(o.bbox)))>.8).map(o=>o.variant)).size>=2);
  const lines=[];
  for(const line of supported.sort((a,b)=>b.detectionConfidence-a.detectionConfidence)){
   if(lines.some(l=>intersection(l.bbox,line.bbox)/Math.max(1,Math.max(area(l.bbox),area(line.bbox)))>.8))continue;
   lines.push(line);
  }
  // Multiple parallel slanted lines establish text ownership, rather than a
  // lone decorative stroke. Original polygons remain available for review.
  if(lines.length<2)continue;
  const angles=lines.map(l=>Math.atan2(l.polygon[1][1]-l.polygon[0][1],l.polygon[1][0]-l.polygon[0][0]));
  if(Math.max(...angles)-Math.min(...angles)>Math.PI/18)continue;
  owners.set(box,lines.map(l=>{const polygon=extendLine(l.polygon,detection.width,detection.height);return {...l,polygon,bbox:{x0:Math.min(...polygon.map(p=>p[0])),y0:Math.min(...polygon.map(p=>p[1])),x1:Math.max(...polygon.map(p=>p[0])),y1:Math.max(...polygon.map(p=>p[1]))}};}));
 }
 return {...detection,boxes:detection.boxes.map(box=>{
  const own=owners.get(box),foreign=[...owners].filter(([b])=>b!==box).flatMap(([,lines])=>lines).filter(l=>intersection(l.bbox,box.bbox)>0&&!((box.lines?.length||0)>=2&&(box.discoveryLines||[]).some(own=>own.detectionConfidence>=.9&&intersection(own.bbox,l.bbox)/Math.max(1,area(own.bbox))>.08)));
  if(!own&&!foreign.length)return box;
  return {...box,...(own?{bbox:{x0:Math.min(...own.map(l=>l.bbox.x0)),y0:Math.min(...own.map(l=>l.bbox.y0)),x1:Math.max(...own.map(l=>l.bbox.x1)),y1:Math.max(...own.map(l=>l.bbox.y1))},ownedPolygons:own.map(l=>l.polygon),localizationRefinement:'parallel-oblique-polygons'}:{}),excludedPolygons:foreign.map(l=>l.polygon),reviewRequired:true};
 })};
}
module.exports={obliqueOwnership};
