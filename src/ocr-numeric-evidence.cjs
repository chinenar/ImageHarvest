'use strict';
const {intersection,area}=require('./ocr-review.cjs');
const {distinctReadings}=require('./ocr-evidence.cjs');
const compact=s=>String(s||'').normalize('NFKC').replace(/\s/g,'');
const numeric=s=>/^[+−-]?\d+(?:[.,]\d+)?$/.test(compact(s));
const shape=s=>compact(s).toLowerCase().replace(/q/g,'9').replace(/o/g,'0').replace(/[il]/g,'1').replace(/s/g,'5').replace(/b/g,'8');
function needsNumericProbe(chosen,readings){
 const value=compact(chosen.text);
 return !numeric(value)&&/^[+−-][\dqoilsb]{1,5}$/i.test(value)&&readings.some(r=>!r.error&&r.confidence>=80&&numeric(r.text)&&shape(r.text)===shape(value));
}
function verifiedNumeric(chosen,probes){
 if(probes.length!==2||distinctReadings(probes).length!==2||probes.some(r=>r.error||r.confidence<95||!numeric(r.text)||shape(r.text)!==shape(chosen.text)||r.textLines?.length!==1))return null;
 if(compact(probes[0].text)!==compact(probes[1].text))return null;
 const a=probes[0].textLines[0].bbox,b=probes[1].textLines[0].bbox;
 if(!a||!b||intersection(a,b)/Math.max(1,Math.max(area(a),area(b)))<.7)return null;
 return {...probes[0],selectionReason:'cross-model-numeric-agreement',numericEvidence:{model:probes[0].model,text:probes[0].text,confirmed:true}};
}
function sameNumericHypothesis(a,b){return numeric(a)&&shape(a)===shape(b);}
module.exports={needsNumericProbe,verifiedNumeric,sameNumericHypothesis};
