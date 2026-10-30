'use strict';
const signature=row=>JSON.stringify([row.text,row.bbox]);
function glyphSize(row){
 const lines=row.recognitionLines||[];
 const sizes=lines.filter(l=>l.bbox).map(l=>row.orientation==='vertical'?l.bbox.x1-l.bbox.x0:l.bbox.y1-l.bbox.y0).filter(n=>Number.isFinite(n)&&n>0).sort((a,b)=>a-b);
 return sizes.length?sizes[Math.floor(sizes.length/2)]:0;
}
function markEffectCandidates(rows){
 // Relative size is meaningful only when several confirmed dialogue regions
 // on this page establish a reference. This is a review gate, not an SFX label.
 const sizes=rows.filter(r=>r.placement?.surfaceValidated&&r.placement.surfaceType==='bubble'&&r.confidence>=85&&String(r.text||'').replace(/\s/g,'').length>=6).map(glyphSize).filter(Boolean).sort((a,b)=>a-b);
 return rows.map(row=>{
  const clean={...row};delete clean.effectCandidate;
  if(sizes.length<3||row.reviewed||row.contentOverride||['bubble','sfx','watermark','non-text'].includes(row.kind)||row.placement?.surfaceType!=='scene'||row.placement.surfaceValidated!==false)return clean;
  const text=String(row.text||'').replace(/\s/g,''),size=glyphSize(row),reference=sizes[Math.floor(sizes.length/2)];
  if(!/\p{L}/u.test(text)||/\p{N}/u.test(text)||text.length>8||(row.recognitionLines||[]).length!==1||size/reference<3)return clean;
  return {...clean,effectCandidate:{reason:'large-unboxed-lettering',scaleRatio:size/reference,referenceGlyphSize:reference,signature:signature(row)},reviewRequired:true};
 });
}
function pendingEffect(row){return !row.reviewed&&!row.contentOverride&&row.effectCandidate?.signature===signature(row);}
function needsEffectReview(rows){
 const sizes=rows.filter(r=>r.confidence>=85&&String(r.text||'').replace(/\s/g,'').length>=6).map(glyphSize).filter(Boolean).sort((a,b)=>a-b);
 if(sizes.length<3)return false;
 return rows.some(r=>!r.reviewed&&!r.contentOverride&&r.kind!=='sfx'&&/\p{L}/u.test(r.text||'')&&!/\p{N}/u.test(r.text||'')&&String(r.text||'').replace(/\s/g,'').length<=8&&r.recognitionLines?.length===1&&glyphSize(r)>=3*sizes[Math.floor(sizes.length/2)]);
}
module.exports={markEffectCandidates,pendingEffect,needsEffectReview};
