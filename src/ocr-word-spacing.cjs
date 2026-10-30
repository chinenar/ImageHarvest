'use strict';
const {inspectDots}=require('./ocr-ellipsis.cjs');
const {distinctReadings}=require('./ocr-evidence.cjs');
const {intersection,area}=require('./ocr-review.cjs');
const compact=s=>String(s||'').replace(/\s/g,'');
function verifySpaces(scan,line,target){
 const words=target.trim().split(/\s+/),cuts=[];let count=0;
 for(const word of words.slice(0,-1)){count+=word.length;cuts.push(count-1);}
 const results=scan.passes.map(parts=>{
  const glyphs=parts.filter(c=>c.y0>0&&c.y1<scan.h&&c.y1-c.y0>=scan.height*.45&&c.y1-c.y0<=scan.height&&
   c.x0+scan.left>=line.bbox.x0-2&&c.x1+scan.left<=line.bbox.x1+2).sort((a,b)=>a.x0-b.x0);
  if(glyphs.length!==compact(line.text).length)return null;
  const gaps=glyphs.slice(1).map((g,i)=>g.x0-glyphs[i].x1),ordinary=gaps.filter((_,i)=>!cuts.includes(i)).sort((a,b)=>a-b);
  if(!ordinary.length||gaps.some(g=>g<0))return null;
  const heights=glyphs.map(g=>g.y1-g.y0).sort((a,b)=>a-b),height=heights[Math.floor(heights.length/2)],median=ordinary[Math.floor(ordinary.length/2)];
  if(cuts.some(i=>gaps[i]<Math.max(3,height*.25,median*2)||gaps[i]<=Math.max(...ordinary)))return null;
  return cuts.map(i=>({x0:glyphs[i].x1+scan.left,x1:glyphs[i+1].x0+scan.left}));
 });
 if(results.some(r=>!r)||results[0].some((g,i)=>Math.abs(g.x0-results[1][i].x0)>2||Math.abs(g.x1-results[1][i].x1)>2))return null;
 return results[1];
}
async function repairWordSpacing(input,chosen,readings){
 if(!chosen.textLines?.length||chosen.orientation==='vertical')return chosen;
 const distinct=distinctReadings(readings),lines=[],evidence=[];
 for(const line of chosen.textLines){
  if(!/^[A-Za-z]{4,16}$/.test(line.text)){lines.push(line);continue;}
  const candidates=distinct.map(r=>(r.textLines||[]).find(l=>l.confidence>=95&&/^[A-Za-z]+(?: +[A-Za-z]+)+$/.test(l.text)&&compact(l.text)===line.text&&
   intersection(l.bbox,line.bbox)/Math.max(1,Math.max(area(l.bbox),area(line.bbox)))>.6)).filter(Boolean);
  const candidate=candidates.find(c=>candidates.filter(l=>l.text===c.text).length>=2);
  if(!candidate){lines.push(line);continue;}
  const scan=await inspectDots(input,line.bbox),gaps=scan&&verifySpaces(scan,line,candidate.text);
  if(!gaps){lines.push(line);continue;}
  lines.push({...line,text:candidate.text});evidence.push({from:line.text,to:candidate.text,gaps});
 }
 return evidence.length?{...chosen,text:lines.map(l=>l.text).join('\n'),textLines:lines,spacingEvidence:evidence,selectionReason:'source-verified-word-spacing'}:chosen;
}
module.exports={repairWordSpacing,verifySpaces};
