'use strict';
const { createHash } = require('node:crypto');
const clean = text => String(text || '').normalize('NFC').replace(/\u0e4d\u0e32/g,'\u0e33').replace(/\s+/gu, '');
const area = b => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
function intersection(a, b) {
  return Math.max(0, Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0)) * Math.max(0, Math.min(a.y1,b.y1)-Math.max(a.y0,b.y0));
}
function iou(a,b) { const n=intersection(a,b); return n / Math.max(1,area(a)+area(b)-n); }
function editDistance(a,b) {
  a=Array.from(clean(a)); b=Array.from(clean(b));
  let prev=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=0;i<a.length;i++) {
    const next=[i+1];
    for(let j=0;j<b.length;j++) next[j+1]=Math.min(next[j]+1,prev[j+1]+1,prev[j]+(a[i]===b[j]?0:1));
    prev=next;
  }
  return prev[b.length];
}
function assignIds(rows,pageIndex=0) {
  return rows.map((r,i)=>({...r,id:`p${pageIndex+1}-${createHash('sha256').update(JSON.stringify([r.bbox,r.text,r.orientation,i])).digest('hex').slice(0,12)}`}));
}
function fusePasses(passes,pageIndex=0) {
  const rows=[];
  for(const pass of passes) for(const row of pass.regions) {
    // Only deduplicate spatially coincident, text-equivalent observations.
    // Containment alone must never discard an adjacent/overlapping speech unit.
    const match=rows.find(r=>iou(r.bbox,row.bbox)>.65 &&
      editDistance(r.text,row.text)/Math.max(1,Array.from(clean(r.text)).length,Array.from(clean(row.text)).length)<.18);
    if(match) {
      match.observedBy.push(pass.name);
      if(row.confidence>match.confidence) Object.assign(match,{text:row.text,confidence:row.confidence,words:row.words,orientation:row.orientation});
    } else {
      // Sparse mode often returns one observation per line of an existing
      // multi-line paragraph. Keep those observations as inspectable alternatives.
      const parent=rows.find(r=>r.text.includes('\n')&&intersection(r.bbox,row.bbox)/Math.max(1,area(row.bbox))>.85&&r.text.split('\n').some(line=>editDistance(line,row.text)/Math.max(1,Array.from(clean(line)).length)<.15));
      if(parent){(parent.alternatives ||= []).push({...row,pass:pass.name});parent.reviewRequired=true;}
      else rows.push({...row,observedBy:[pass.name]});
    }
  }
  rows.sort((a,b)=>a.bbox.y0-b.bbox.y0||b.bbox.x0-a.bbox.x0);
  const selected=rows.filter(row=>{
    if(row.orientation==='vertical'||Array.from(clean(row.text)).length>2)return true;
    const parent=rows.find(r=>r.orientation==='vertical'&&r.confidence>=65&&r.observedBy.some(p=>p.startsWith('vertical-crop-'))&&area(r.bbox)>area(row.bbox)*3&&intersection(r.bbox,row.bbox)/Math.max(1,area(row.bbox))>.9&&clean(r.text).includes(clean(row.text)));
    if(parent){(parent.alternatives ||= []).push({...row,pass:'vertical-seed'});parent.reviewRequired=true;return false;}
    return true;
  });
  const result=assignIds(selected,pageIndex);
  for(const row of result) {
    row.conflicts=result.filter(r=>r!==row && intersection(row.bbox,r.bbox)/Math.max(1,Math.min(area(row.bbox),area(r.bbox)))>.3).map(r=>r.id);
    row.reviewRequired=Boolean(row.reviewRequired||row.conflicts.length||row.confidence<65);
  }
  return result;
}
function evaluateRegions(predicted=[],truth=[],{complete=false,threshold=.5,localizationThreshold=.8}={}) {
  // Maximum-cardinality one-to-one matching. One oversized prediction cannot
  // count as detecting several speech units.
  const edges=truth.map(t=>predicted.map((p,i)=>({i,score:iou(t.bbox,p.bbox)})).filter(e=>e.score>=threshold).sort((a,b)=>b.score-a.score));
  const owners=new Map();
  function match(t,seen) {
    for(const {i} of edges[t]) {
      if(seen.has(i))continue; seen.add(i);
      if(!owners.has(i)||match(owners.get(i),seen)){owners.set(i,t);return true;}
    }
    return false;
  }
  truth.forEach((_,i)=>match(i,new Set()));
  const pairs=[...owners].map(([p,t])=>({predictedId:predicted[p].id,truthId:truth[t].id,iou:iou(predicted[p].bbox,truth[t].bbox),edits:editDistance(predicted[p].text,truth[t].text),p,t}));
  const matchedTruth=new Set(pairs.map(x=>x.t));
  const missing=truth.filter((_,i)=>!matchedTruth.has(i)).map(x=>x.id);
  const extra=predicted.filter((_,i)=>!owners.has(i)).map(x=>x.id);
  let edits=pairs.reduce((n,x)=>n+x.edits,0);
  edits+=truth.filter((_,i)=>!matchedTruth.has(i)).reduce((n,x)=>n+Array.from(clean(x.text)).length,0);
  edits+=predicted.filter((_,i)=>!owners.has(i)).reduce((n,x)=>n+Array.from(clean(x.text)).length,0);
  const chars=truth.reduce((n,x)=>n+Array.from(clean(x.text)).length,0);
  const merges=predicted.filter(p=>truth.filter(t=>intersection(p.bbox,t.bbox)/Math.max(1,area(t.bbox))>.5).length>1).map(x=>x.id);
  const splits=truth.filter(t=>predicted.filter(p=>intersection(p.bbox,t.bbox)/Math.max(1,area(p.bbox))>.5).length>1).map(x=>x.id);
  const recall=truth.length ? pairs.length/truth.length : null;
  const precision=predicted.length ? pairs.length/predicted.length : (truth.length?0:null);
  const cer=chars ? edits/chars : null;
  const locationRecall=truth.length?pairs.filter(p=>p.iou>=localizationThreshold).length/truth.length:null;
  return {complete,threshold,localizationThreshold,locationRecall,expected:truth.length,detected:predicted.length,matched:pairs.length,recall,precision,cer,
    characterAccuracy:cer===null?null:Math.max(0,1-cer),meanIou:pairs.length?pairs.reduce((n,x)=>n+x.iou,0)/pairs.length:null,
    missing,extra,merges,splits,pairs:pairs.map(({p,t,...rest})=>rest),
    targetMet:Boolean(complete&&truth.length&&recall>=.99&&precision>=.99&&locationRecall>=.99&&cer!==null&&cer<=.01&&!merges.length&&!splits.length)};
}
module.exports={area,intersection,iou,editDistance,assignIds,fusePasses,evaluateRegions};
