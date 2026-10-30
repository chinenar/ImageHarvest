'use strict';
const {iou,editDistance}=require('./ocr-review.cjs');
const normalize=s=>String(s||'').normalize('NFKC').replace(/\s/gu,'');
const letters=s=>Array.from(normalize(s).replace(/[^\p{L}\p{N}]/gu,''));
function repeatedTerminalColumn(chosen,positioned){
 const columns=positioned.textLines||[];
 if(columns.length<2||columns.length>6)return null;
 const ordered=[...columns].sort((a,b)=>b.bbox.x0-a.bbox.x0),last=ordered.at(-1),glyphs=letters(last.text);
 if(last.confidence<85||glyphs.length<4||new Set(glyphs).size!==1)return null;
 const target=Array.from(normalize(last.text)),source=Array.from(normalize(chosen.text));
 if(source.length<=target.length||source.length!==Array.from(chosen.text).length)return null;
 const suffix=source.slice(-target.length).join('');
 if(editDistance(suffix,target.join(''))!==1||letters(suffix).length!==glyphs.length)return null;
 return last;
}
function repairRepeatedVerticalColumn(chosen,first,second,third){
 const last=repeatedTerminalColumn(chosen,first);
 if(!last||!first.inferenceFingerprint||!second.inferenceFingerprint||first.inferenceFingerprint===second.inferenceFingerprint)return chosen;
 const support=(second.textLines||[]).find(l=>l.confidence>=85&&normalize(l.text)===normalize(last.text)&&iou(l.bbox,last.bbox)>=.65);
 if(!support)return chosen;
 const independentThird=third?.inferenceFingerprint&&![first.inferenceFingerprint,second.inferenceFingerprint].includes(third.inferenceFingerprint);
 const extra=independentThird&&(third.textLines||[]).find(l=>l.confidence>=80&&normalize(l.text)===normalize(last.text)&&iou(l.bbox,last.bbox)>=.65);
 if(Math.max(last.confidence,support.confidence)<90&&!extra)return chosen;
 const source=Array.from(chosen.text),length=Array.from(normalize(last.text)).length;
 return {...chosen,text:source.slice(0,-length).join('')+last.text,selectionReason:'confirmed-repeated-vertical-column',
  terminalColumnEvidence:[{read:first,line:last},{read:second,line:support},...(extra?[{read:third,line:extra}]:[])].map(({read:r,line})=>({engine:r.engine,inferenceFingerprint:r.inferenceFingerprint,variant:r.variant,line}))};
}
module.exports={repeatedTerminalColumn,repairRepeatedVerticalColumn};
