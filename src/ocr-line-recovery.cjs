'use strict';
const {intersection,area,editDistance}=require('./ocr-review.cjs');
const {distinctReadings}=require('./ocr-evidence.cjs');
const compact=s=>String(s||'').normalize('NFKC').replace(/\s/g,'').toLowerCase();
async function recoverWeakLines(chosen,baseline,candidate,readLine,{width,height,scale=1}={}){
 if(candidate.segmentation||candidate.orientation==='vertical'||!(baseline.confidence>=60)||!chosen.textLines?.length)return chosen;
 if(chosen.textLines.filter(l=>l.confidence>=95).length<2)return chosen;
 const lines=[...chosen.textLines],evidence=[];let attempts=0;
 for(let i=0;i<lines.length&&attempts<2;i++){
  const line=lines[i];if(!(line.confidence>=60&&line.confidence<93)||compact(baseline.text).includes(compact(line.text)))continue;
  const detector=(candidate.lines||[]).filter(l=>l.detectionConfidence>=.75&&intersection(l.bbox,line.bbox)/Math.max(1,area(l.bbox))>.75).sort((a,b)=>intersection(b.bbox,line.bbox)/area(b.bbox)-intersection(a.bbox,line.bbox)/area(a.bbox))[0];
  if(!detector)continue;
  const a=detector.bbox,box={x0:Math.max(0,a.x0-6*scale),y0:Math.max(0,a.y0-2*scale),x1:Math.min(width,Math.max(a.x1,line.bbox.x1)+6*scale),y1:Math.min(height,a.y1+6*scale)};
  attempts++;
  const probes=await Promise.all(['original','contrast'].map(variant=>readLine(variant,box)));
  if(distinctReadings(probes).length!==2||probes.some(r=>r.error||!(r.confidence>=90)||r.textLines?.length!==1))continue;
  const text=probes[0].text,key=compact(text),original=compact(line.text);
  if(!key||key===original||compact(probes[1].text)!==key||!compact(baseline.text).includes(key)||editDistance(key,original)/Math.max(key.length,original.length)>.3)continue;
  lines[i]={...line,text,confidence:Math.min(...probes.map(p=>p.confidence)),bbox:box};
  evidence.push({from:line.text,to:text,box,probes});
 }
 return evidence.length?{...chosen,text:lines.map(l=>l.text).join('\n'),textLines:lines,lineRecoveryEvidence:evidence,selectionReason:'independently-supported-line-recovery'}:chosen;
}
module.exports={recoverWeakLines};
