'use strict';
const sharp=require('sharp');
const {rawLines}=require('./reading-units.cjs');
const compact=s=>String(s).toLowerCase().replace(/[^a-z0-9]/g,'');
async function recoverSlantedText(backend,image,rows,{signal,sourceLanguage='auto'}={}){
 if(!['en','fr','auto'].includes(sourceLanguage))return rows;
 const meta=await sharp(image).metadata(),result=[];
 for(const row of rows){
  const lines=rawLines(row),p=lines[0]?.polygon;
  if(row.slantedRecovery||lines.length!==1||p?.length!==4||!/[a-z]{3}/i.test(row.text)){result.push(row);continue;}
  const angle=Math.atan2(p[1][1]-p[0][1],p[1][0]-p[0][0])*180/Math.PI;
  if(Math.abs(angle)<25||Math.abs(angle)>80){result.push(row);continue;}
  const left=Math.max(0,Math.floor(row.bbox.x0)-24),top=Math.max(0,Math.floor(row.bbox.y0)-24),width=Math.min(meta.width-left,Math.ceil(row.bbox.x1)-left+24),height=Math.min(meta.height-top,Math.ceil(row.bbox.y1)-top+24);
  try{
   const crop=await sharp(image).extract({left,top,width,height}).rotate(-angle,{background:'#fff'}).png().toBuffer(),rotated=await sharp(crop).metadata();
   const read=await backend.read(crop,{engine:'paddle',language:sourceLanguage==='fr'?'fr':'en',signal});
   const original=compact(row.text),candidate=(read.lines||[]).filter(l=>l.confidence>=95&&compact(l.text).startsWith(original)&&compact(l.text).length>original.length&&compact(l.text).length<=original.length+6).sort((a,b)=>b.confidence-a.confidence)[0];
   if(!candidate?.polygon){result.push(row);continue;}
   const radians=angle*Math.PI/180,c=Math.cos(radians),s=Math.sin(radians);
   const polygon=candidate.polygon.map(([x,y])=>{x-=rotated.width/2;y-=rotated.height/2;return [x*c-y*s+width/2+left,x*s+y*c+height/2+top];});
   const bbox={x0:Math.max(0,Math.floor(Math.min(...polygon.map(p=>p[0])))),y0:Math.max(0,Math.floor(Math.min(...polygon.map(p=>p[1])))),x1:Math.min(meta.width,Math.ceil(Math.max(...polygon.map(p=>p[0])))),y1:Math.min(meta.height,Math.ceil(Math.max(...polygon.map(p=>p[1]))))};
   const line={...candidate,polygon,bbox},updated={...row,text:candidate.text,bbox,recognitionLines:[line],unitSourceLines:[line],confidence:candidate.confidence,slantedRecovery:{previousText:row.text,previousBox:row.bbox,angle},localizationRefinement:'deskewed-line-extension'};
   for(const key of ['translation','translationRecord','placement','overlapReview','layoutIssue'])delete updated[key];
   result.push(updated);
  }catch(error){if(signal?.aborted)throw error;result.push({...row,slantedRecoveryError:error.message});}
 }
 return result;
}
module.exports={recoverSlantedText};
