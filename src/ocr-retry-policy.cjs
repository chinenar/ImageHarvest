'use strict';
const {intersection,area}=require('./ocr-review.cjs');
const canonical=s=>String(s||'').normalize('NFKC').replace(/\s/gu,'');
function canTryOriginal(baseline,candidate){
 return baseline.confidence>=90&&canonical(baseline.text).length>=6&&
  !candidate.discoveryOnly&&!candidate.lineOnly&&!candidate.displayFont&&!candidate.reviewRequired&&
  Boolean(candidate.lines?.length)&&candidate.lines.every(l=>l.detectionConfidence>=.75);
}
function originalIsSupported(read,baseline,candidate){
 if(!canTryOriginal(baseline,candidate))return false;
 if(read.error||read.engine!=='paddleocr'||!(read.confidence>=95)||!(baseline.confidence>=90))return false;
 const text=canonical(read.text);
 if(text.length<6||text!==canonical(baseline.text))return false;
 if(candidate.discoveryOnly||candidate.lineOnly||candidate.displayFont||candidate.reviewRequired)return false;
 const expected=candidate.lines||[],observed=read.lines||[];
 if(!expected.length||!observed.length)return false;
 // Agreement is insufficient if both readers omitted a detected source line.
 return expected.every(line=>{
  const box=line.coreBbox||line.bbox;
  return box&&line.detectionConfidence>=.75&&observed.some(other=>other.confidence>=85&&other.bbox&&intersection(box,other.bbox)/Math.max(1,area(box))>=.8);
 });
}
module.exports={originalIsSupported,canTryOriginal};
