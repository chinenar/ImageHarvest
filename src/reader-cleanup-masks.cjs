'use strict';
const sharp=require('sharp');
const {detectTile}=require('./comic-text-detector.cjs');
async function prepareCleanupMasks(image,regions,{signal,detect=detectTile}={}){
 const meta=await sharp(image).metadata(),out=[];
 for(const row of regions){
  if(signal?.aborted)throw Error('ยกเลิก OCR');
  if(row.excludeFromLayoutCompetition){out.push(row);continue;}
  const b=row.bbox,padX=Math.max(32,(384-(b.x1-b.x0))/2),padY=Math.max(32,(384-(b.y1-b.y0))/2);
  const left=Math.max(0,Math.floor(b.x0-padX)),top=Math.max(0,Math.floor(b.y0-padY)),right=Math.min(meta.width,Math.ceil(b.x1+padX)),bottom=Math.min(meta.height,Math.ceil(b.y1+padY));
  if(right<=left||bottom<=top){out.push(row);continue;}
  try{
   const crop=await sharp(image).extract({left,top,width:right-left,height:bottom-top}).png().toBuffer();
   const result=await detect(crop,{includeSegmentation:true,upscale:true,signal});
   if(signal?.aborted)throw Error('ยกเลิก OCR');
   if(!result.segmentation)throw Error('No segmentation output');
   out.push({...row,cleanupProbability:{bbox:{x0:left,y0:top,x1:right,y1:bottom},png:result.segmentation.toString('base64')}});
  }catch(error){if(signal?.aborted)throw error;out.push({...row,cleanupModelError:String(error.message).slice(0,200)});}
 }
 return out;
}
module.exports={prepareCleanupMasks};
