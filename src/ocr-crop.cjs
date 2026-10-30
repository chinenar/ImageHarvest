'use strict';
const sharp=require('sharp');
function validateCrop(crop,width,height){
  if(crop?.rotation!==undefined&&![0,90,270].includes(crop.rotation))throw Error('Unsupported OCR crop rotation');
  const r=crop?.rectangle,scale=crop?.inputScale||1;
  if(!r||![1,2,3].includes(scale)||crop.border!==12||![r.left,r.top,r.width,r.height,crop.width].every(Number.isFinite)||r.left<0||r.top<0||r.width<=0||r.height<=0||r.left+r.width>width+.01||r.top+r.height>height+.01||crop.width<1||crop.width>1200)throw Error('กรอบ preview ไม่ถูกต้อง');
  const resizedHeight=r.height*crop.width/r.width;
  if(resizedHeight>6000||resizedHeight*crop.width>3000000)throw Error('กรอบ preview ใหญ่เกินกำหนด');
  if(crop.maskLines&&(!Array.isArray(crop.maskLines)||crop.maskLines.length>500||!Number.isFinite(crop.maskPadding)||crop.maskPadding<0||crop.maskPadding>16||crop.maskLines.some(l=>!l.coreBbox||!['x0','y0','x1','y1'].every(k=>Number.isFinite(l.coreBbox[k]))||l.coreBbox.x0<0||l.coreBbox.y0<0||l.coreBbox.x1>width||l.coreBbox.y1>height||l.coreBbox.x1<=l.coreBbox.x0||l.coreBbox.y1<=l.coreBbox.y0||!['x0','x1','y0','y1',undefined].includes(l.cutEdge))))throw Error('พื้นที่ข้อความ preview ไม่ถูกต้อง');
  for(const polygons of [crop.ownedPolygons,crop.excludedPolygons])if(polygons&&(!Array.isArray(polygons)||polygons.length>500||polygons.some(p=>!Array.isArray(p)||p.length!==4||p.some(v=>!Array.isArray(v)||v.length!==2||!v.every(Number.isFinite)||v[0]<0||v[1]<0||v[0]>width||v[1]>height))))throw Error('ขอบเขตข้อความเอียงไม่ถูกต้อง');
}
async function prepareCrop(input,crop,{prepared=false}={}){
  const r=crop.rectangle,ss=prepared?1:(crop.inputScale||1);
  let source=sharp(input).rotate();
  if(ss!==1){const m=await source.metadata();source=source.resize((m.autoOrient||m).width*ss,(m.autoOrient||m).height*ss);}
  const left=Math.round(r.left*ss),top=Math.round(r.top*ss),width=Math.round(r.width*ss),height=Math.round(r.height*ss);
  let image=await source.extract({left,top,width,height}).ensureAlpha().png().toBuffer();
  if(crop.maskLines?.length){
    const pad=(crop.maskPadding??8)*(prepared?(crop.inputScale||1):ss);
    const mask=Buffer.from(`<svg width="${width}" height="${height}">${crop.maskLines.map(l=>{const a=l.coreBbox,x0=a.x0*ss-left-(l.cutEdge==='x0'?0:pad),y0=a.y0*ss-top-(l.cutEdge==='y0'?0:pad),x1=a.x1*ss-left+(l.cutEdge==='x1'?0:pad),y1=a.y1*ss-top+(l.cutEdge==='y1'?0:pad);return `<rect x="${x0}" y="${y0}" width="${x1-x0}" height="${y1-y0}" fill="white"/>`;}).join('')}</svg>`);
    image=await sharp(image).composite([{input:mask,blend:'dest-in'}]).png().toBuffer();
  }
  for(const [polygons,blend] of [[crop.ownedPolygons,'dest-in'],[crop.excludedPolygons,'dest-out']]){
    if(!polygons?.length)continue;
    const shapes=polygons.map(p=>`<polygon points="${p.map(([x,y])=>`${x*ss-left},${y*ss-top}`).join(' ')}" fill="white" stroke="white" stroke-width="${2*(prepared?(crop.inputScale||1):ss)}"/>`).join('');
    image=await sharp(image).composite([{input:Buffer.from(`<svg width="${width}" height="${height}">${shapes}</svg>`),blend}]).png().toBuffer();
  }
  const outputWidth=Math.round(crop.width),border=crop.border??12;
  const padded=await sharp(image).flatten({background:'#fff'}).resize({width:outputWidth}).extend({top:border,bottom:border,left:border,right:border,background:'#fff'}).png().toBuffer();
  return crop.rotation?sharp(padded).rotate(crop.rotation).png().toBuffer():padded;
}
module.exports={prepareCrop,validateCrop};
