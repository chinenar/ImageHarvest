'use strict';
const {area,intersection}=require('./ocr-review.cjs');
const {distinctReadings}=require('./ocr-evidence.cjs');
const canonical=s=>String(s||'').normalize('NFKC').replace(/\s/g,'');
function refineSparseGeometry(row,{width,height,scale=1}={}){
 if(row.reviewed||row.contentOverride||row.segmentation||row.orientation==='vertical'||row.recognitionEngine!=='paddleocr'||!(row.detectionConfidence<.6))return row;
 const text=canonical(row.text);
 if(!text||text.length>2||row.recognitionLines?.length!==1)return row;
 const line=row.recognitionLines[0];
 if(!(line.confidence>=90)||!line.bbox||area(line.bbox)/Math.max(1,area(row.bbox))>.2)return row;
 const samePosition=b=>b&&intersection(b,line.bbox)/Math.max(1,Math.max(area(b),area(line.bbox)))>.65;
 const observations=(row.discoveryLines||[]).filter(l=>l.detectionConfidence>=.7&&samePosition(l.bbox));
 const reads=distinctReadings(row.alternatives||[]).filter(r=>r.engine==='paddleocr'&&!r.error&&canonical(r.text)===text&&r.textLines?.length===1&&r.textLines[0].confidence>=90&&samePosition(r.textLines[0].bbox));
 if(!observations.length||reads.length<2)return row;
 const independent=(row.alternatives||[]).some(r=>r.engine==='tesseract.js'&&r.confidence>=85&&canonical(r.text)===text);
 const bounds=[line.bbox,...observations.map(l=>l.bbox),...reads.map(r=>r.textLines[0].bbox)],pad=3*scale;
 const bbox={x0:Math.max(0,Math.floor(Math.min(...bounds.map(b=>b.x0))-pad)),y0:Math.max(0,Math.floor(Math.min(...bounds.map(b=>b.y0))-pad)),x1:Math.min(width,Math.ceil(Math.max(...bounds.map(b=>b.x1))+pad)),y1:Math.min(height,Math.ceil(Math.max(...bounds.map(b=>b.y1))+pad))};
 return {...row,bbox,detectorBBox:row.detectorBBox||row.bbox,localizationRefinement:'supported-sparse-fragment',reviewRequired:true,
  ...(!independent?{sparseReadingReview:JSON.stringify([row.text,bbox])}:{})};
}
module.exports={refineSparseGeometry};
