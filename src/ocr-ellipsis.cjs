'use strict';
const sharp=require('sharp');
const {intersection,area}=require('./ocr-review.cjs');
function components(data,w,h,threshold){
 const seen=new Uint8Array(w*h),out=[];
 for(let p=0;p<w*h;p++){
  if(seen[p]||data[p]>threshold)continue;
  const q=[p];seen[p]=1;let x0=w,y0=h,x1=0,y1=0;
  for(let i=0;i<q.length;i++){
   const at=q[i],x=at%w,y=Math.floor(at/w);x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);
   for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){const a=x+dx,b=y+dy,n=b*w+a;if(a<0||a>=w||b<0||b>=h||seen[n]||data[n]>threshold)continue;seen[n]=1;q.push(n);}
  }
  if(q.length>=2)out.push({x0,y0,x1:x1+1,y1:y1+1,size:q.length});
 }return out;
}
async function inspectDots(input,bbox){
 const meta=await sharp(input).metadata(),height=bbox.y1-bbox.y0,pad=Math.ceil(height);
 const left=Math.max(0,Math.floor(bbox.x0)-pad),top=Math.max(0,Math.floor(bbox.y0)-3),width=Math.min(meta.width,Math.ceil(bbox.x1)+pad)-left,h=Math.min(meta.height,Math.ceil(bbox.y1)+3)-top;
 if(width<=0||h<=0||width*h>200000)return null;
 const {data,info}=await sharp(input).extract({left,top,width,height:h}).flatten({background:'#fff'}).greyscale().raw().toBuffer({resolveWithObject:true});
 return {left,top,height,passes:[100,160].map(t=>components(data,info.width,info.height,t)),width:info.width,h:info.height};
}
function dotTriple(scan,side){
 const found=scan.passes.map(parts=>{
  const letters=parts.filter(c=>c.y0>0&&c.y1<scan.h&&c.y1-c.y0>scan.height*.25&&c.y1-c.y0<scan.height*.95);
  if(letters.length<3)return null;
  const heights=letters.map(c=>c.y1-c.y0).sort((a,b)=>a-b),height=heights[Math.floor(heights.length/2)];
  const bottoms=letters.map(c=>c.y1).sort((a,b)=>a-b),bottom=bottoms[Math.floor(bottoms.length/2)];
  const edge=side==='end'?Math.max(...letters.map(c=>c.x1)):Math.min(...letters.map(c=>c.x0));
  const dots=parts.filter(c=>c.x1-c.x0<=height*.4&&c.y1-c.y0<=height*.4&&Math.abs(c.y1-bottom)<=height*.25&&
   (side==='end'?c.x0>=edge-height*.2:c.x1<=edge)&&c.x1-c.x0>=.3*(c.y1-c.y0)).sort((a,b)=>a.x0-b.x0);
  if(dots.length!==3)return null;
  const gaps=[dots[1].x0-dots[0].x0,dots[2].x0-dots[1].x0];
  if(Math.min(...gaps)<2||Math.max(...gaps)>height||Math.max(...gaps)/Math.min(...gaps)>2)return null;
  const border=parts.some(c=>c.y0===0&&c.y1===scan.h&&c.x0<dots[0].x0&&c.x1<=dots[0].x1+height*.2);
  return {dots,border};
 });
 if(found.some(x=>!x)||found[0].dots.some((d,i)=>Math.abs(d.x0-found[1].dots[i].x0)>2))return null;
 return {side,boxes:found[1].dots.map(d=>({x0:d.x0+scan.left,y0:d.y0+scan.top,x1:d.x1+scan.left,y1:d.y1+scan.top})),border:found.every(x=>x.border)};
}
async function repairEllipsis(input,chosen,readings){
 if(!chosen.textLines?.length||chosen.orientation==='vertical'&&!chosen.textLines.every(l=>l.bbox.x1-l.bbox.x0>l.bbox.y1-l.bbox.y0))return chosen;
 const compact=s=>String(s).normalize('NFKC').replace(/\s/g,'');
 const lines=[];const evidence=[];
 for(const line of chosen.textLines){
  const value=compact(line.text),side=/^[\/|]?\.{0,3}[A-Za-z]/.test(value)&&readings.some(r=>r.textLines?.some(l=>compact(l.text)==='...'+value.replace(/^[\/|]?\.{0,3}/,'')))?'start':'end';
  const target=side==='end'?value.replace(/\.*$/,'')+'...':value.replace(/^[\/|]?\.{0,3}/,'...');
  if(value===target||!/[A-Za-z]/.test(value)){lines.push(line);continue;}
  const candidates=readings.flatMap(r=>r.textLines||[]).filter(l=>l.confidence>=85&&compact(l.text)===target&&intersection(l.bbox,line.bbox)/Math.max(1,Math.min(area(l.bbox),area(line.bbox)))>.6&&Math.abs(l.bbox.y0-line.bbox.y0)<(line.bbox.y1-line.bbox.y0)*.5);
  const partial=side==='end'&&/[A-Za-z]\.{2}$/.test(value)&&line.confidence>=95;
  if(!candidates.length&&!partial){lines.push(line);continue;}
  const scan=await inspectDots(input,line.bbox),proof=scan&&dotTriple(scan,side);
  if(!proof||side==='start'&&/^[\/|]/.test(value)&&!proof.border){lines.push(line);continue;}
  const candidate=candidates[0]||{...line,text:line.text+'.'},all=[candidate.bbox,...proof.boxes];
  lines.push({...candidate,bbox:{x0:Math.min(...all.map(b=>b.x0)),y0:Math.min(...all.map(b=>b.y0)),x1:Math.max(...all.map(b=>b.x1)),y1:Math.max(...all.map(b=>b.y1))}});
  evidence.push({from:line.text,to:candidate.text,...proof});
 }
 return evidence.length?{...chosen,text:lines.map(l=>l.text).join('\n'),textLines:lines,selectionReason:'source-verified-ellipsis',punctuationEvidence:evidence}:chosen;
}
module.exports={inspectDots,dotTriple,repairEllipsis};
