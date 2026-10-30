'use strict';
const {area,intersection}=require('./ocr-review.cjs');
const text=s=>String(s||'').normalize('NFKC').replace(/\s/g,'').toLowerCase();
function fragmentOwner(row,rows){
 if(!row.discoveryOnly||row.reviewed||row.contentOverride||!row.recognitionLines?.length)return null;
 return rows.find(parent=>parent!==row&&!parent.discoveryOnly&&(parent.recognitionLines||[]).some(line=>line.confidence>=95&&row.recognitionLines.every(part=>{
  const a=text(part.text),b=text(line.text);
  return a.length>=2&&b.length>=a.length+3&&b.includes(a)&&intersection(part.bbox,line.bbox)/Math.max(1,area(part.bbox))>.65;
 })))||null;
}
module.exports={fragmentOwner};
