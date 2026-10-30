'use strict';
const {intersection,area}=require('./ocr-review.cjs');
function cropLines(candidate){
 return (candidate.lines||[]).map(line=>{
  const core=line.coreBbox||line.bbox;
  const supporting=(candidate.discoveryLines||[]).filter(l=>{
   const b=l.bbox;
   return intersection(b,core)/Math.max(1,area(core))>.8&&area(b)<area(core)*5;
  }).sort((a,b)=>area(a.bbox)-area(b.bbox))[0];
  if(!supporting)return {coreBbox:core,cutEdge:line.cutEdge};
  const b=supporting.bbox,expanded={x0:Math.min(core.x0,b.x0),y0:Math.min(core.y0,b.y0),x1:Math.max(core.x1,b.x1),y1:Math.max(core.y1,b.y1)};
  // Never undo the source whitespace cut between two owners of one row.
  if(line.cutEdge)expanded[line.cutEdge]=core[line.cutEdge];
  return {coreBbox:expanded,cutEdge:line.cutEdge};
 });
}
function lineBelongsToNeighbor(box,candidate,neighbors){
 const size=Math.max(1,area(box));
 if(intersection(box,candidate.bbox)/size>=.5)return false;
 return neighbors.some(other=>other!==candidate&&intersection(box,other.bbox)/size>.8);
}
module.exports={cropLines,lineBelongsToNeighbor};
