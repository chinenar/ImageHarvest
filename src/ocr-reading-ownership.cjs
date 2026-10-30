'use strict';
const {intersection,area}=require('./ocr-review.cjs');
const lexical=s=>String(s||'').replace(/[^\p{L}\p{N}]/gu,'');
function ownsColumn(parent,fragment){
 const a=parent.bbox,b=fragment.bbox;
 const sameColumn=Math.abs(a.x0+a.x1-b.x0-b.x1)/2<=Math.max(a.x1-a.x0,b.x1-b.x0)*.55;
 return sameColumn&&intersection(a,b)/Math.max(1,area(b))>.72&&lexical(parent.text).length>=lexical(fragment.text).length*.9;
}
function resolveVerticalOwnership(rows){
 const ordered=[...rows].sort((a,b)=>lexical(b.text).length-lexical(a.text).length),kept=[],order=new Map();
 for(const row of ordered){
  const owner=kept.find(parent=>{
   if(parent.orientation!=='vertical'||parent.reviewed||row.reviewed||parent.layoutSplit||row.layoutSplit)return false;
   if(lexical(parent.text).length<Math.max(6,lexical(row.text).length*.95)||intersection(parent.bbox,row.bbox)/Math.max(1,area(row.bbox))<.9)return false;
   const columns=parent.recognitionLines||[],parts=row.recognitionLines||[];
   if(!columns.length||!parts.length)return false;
   if(parts.every(l=>columns.some(c=>ownsColumn(c,l))))return true;
   // The same detector container sometimes emits a horizontal fragment of a
   // vertical heading. Both the source container and complete line coverage
   // are required; rectangle containment alone never establishes ownership.
   return parent.containerId&&parent.containerId===row.containerId&&parts.every(l=>{
    const cover=columns.reduce((sum,c)=>sum+intersection(c.bbox,l.bbox),0);
    return cover/Math.max(1,area(l.bbox))>.75;
   });
  });
  if(!owner){const copy={...row};kept.push(copy);order.set(copy,rows.indexOf(row));continue;}
  owner.duplicateObservations=[...(owner.duplicateObservations||[]),row];
  owner.ownershipResolution='complete-positioned-columns';
  owner.reviewRequired=true;
 }
 return kept.sort((a,b)=>order.get(a)-order.get(b));
}
module.exports={resolveVerticalOwnership};
