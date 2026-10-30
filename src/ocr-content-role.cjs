'use strict';
const {pendingEffect}=require('./ocr-effect-candidates.cjs');
// Exact publisher marks confirmed from the user's corpus. Words such as
// "scans", short dialogue, colored text, or page edges alone are insufficient.
function literalMark(text){
 const value=String(text||'').normalize('NFKC').replace(/\s+/gu,'');
 return Boolean(value&&!/[\p{L}\p{N}]/u.test(value)&&/^[\p{P}\p{S}]+$/u.test(value));
}
function numericOrSymbolMark(text){
 const value=String(text||'').normalize('NFKC').replace(/\s+/gu,'');
 return Boolean(value&&!/\p{L}/u.test(value)&&/^[\p{N}\p{P}\p{S}]+$/u.test(value));
}
function contentRole(region={}){
 if(region.partialReadingEvidence&&!region.reviewed&&!region.contentOverride)return {role:'uncertain',reason:'incomplete-japanese-reading-needs-review',excluded:true};
 if(region.placement?.cleanupReview)return {role:'uncertain',reason:region.placement.cleanupReview,excluded:true};
 if(!region.reviewed&&!region.contentOverride&&region.overlapReview?.signature===JSON.stringify([region.text,region.bbox]))return {role:'uncertain',reason:'overlapping-readings-need-review',excluded:true};
 if(!region.reviewed&&!region.contentOverride&&region.scriptConflictEvidence?.signature===JSON.stringify([region.text,region.bbox]))return {role:'uncertain',reason:'script-conflict-needs-review',excluded:true};
 if(!region.reviewed&&!region.contentOverride&&region.sparseReadingReview===JSON.stringify([region.text,region.bbox]))return {role:'uncertain',reason:'sparse-fragment-reading-needs-review',excluded:true};
 if(region.kind==='sfx')return {role:'sfx',reason:'marked-sound-effect',excluded:true};
 if(pendingEffect(region))return {role:'uncertain',reason:'possible-sound-effect-needs-review',excluded:true};
 if(region.layoutIssue)return {role:'uncertain',reason:region.layoutIssue,excluded:true};
 if(!region.contentOverride&&literalMark(region.text))return {role:'literal-mark',reason:'preserve-nonlexical-mark',excluded:true};
 if(!region.contentOverride&&!region.reviewed&&numericOrSymbolMark(region.text)){
  if(region.reviewRequired)return {role:'uncertain',reason:'nonlexical-reading-needs-review',excluded:true};
  return {role:'literal-mark',reason:'preserve-nonlexical-mark',excluded:true};
 }
 const alternatives=(region.alternatives||[]).filter(a=>a.engine===region.recognitionEngine&&!a.error);
 const canonical=s=>String(s||'').replace(/\s/g,'');
 if(region.reviewRequired&&!region.reviewed&&alternatives.length>=3&&alternatives.filter(a=>canonical(a.text)===canonical(region.text)).length===1&&alternatives.filter(a=>!canonical(a.text)).length>=2)return {role:'uncertain',reason:'unconfirmed-single-variant-reading',excluded:true};
 if(region.kind==='watermark')return {role:'watermark',reason:'manual-watermark',excluded:true};
 if(region.kind==='non-text')return {role:'non-text',reason:'manual-artwork',excluded:true};
 if(region.placement?.visualRole==='decorative-margin'&&!region.reviewed)return {role:'artwork',reason:'colored-margin-decoration',excluded:true};
 const chars=String(region.text||'').match(/[\p{L}\p{N}]/gu)||[];
 if(!region.reviewed&&region.reviewRequired&&chars.length<=2&&Number.isFinite(region.confidence)&&region.confidence<85)return {role:'uncertain',reason:'short-reading-needs-review',excluded:true};
 const bubble=region.kind==='bubble'||region.placement?.surfaceType==='bubble';
 const trustedBubble=Boolean(bubble&&region.placement?.surfaceType==='bubble'&&!region.placement?.reviewRequired&&Number(region.placement?.confidence)>=.8);
 const normalized=String(region.text||'').normalize('NFKC').replace(/[^A-Za-z]/g,'').toUpperCase();
 if(!region.contentOverride&&region.kind!=='bubble'&&/^RITHAR?SCANS?$/.test(normalized)&&region.contentRole?.reason?.startsWith('confirmed-publisher-mark:'))return {role:'watermark',reason:region.contentRole.reason,excluded:true};
 if(!region.contentOverride&&!bubble&&/^RITHAR?SCANS?$/.test(normalized))return {role:'watermark',reason:'confirmed-publisher-mark:RITHAR SCANS',excluded:true};
 if(!trustedBubble&&!region.reviewed&&region.reviewRequired&&Number.isFinite(region.confidence)&&region.confidence<75)return {role:'uncertain',reason:'low-confidence-needs-review',excluded:true};
 return {role:'content',reason:'',excluded:false};
}
function annotateContent(regions=[]){return regions.map(r=>({...r,contentRole:contentRole(r)}));}
function translationEligible(region,{includeUncertain=false}={}){
 const role=contentRole(region);return !role.excluded||(includeUncertain&&role.role==='uncertain');
}
module.exports={contentRole,annotateContent,translationEligible};
