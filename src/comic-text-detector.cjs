'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const sharp=require('sharp');
const ort=require('onnxruntime-node');
const {iou,intersection,area}=require('./ocr-review.cjs');
const SIZE=1024;
let loading;
async function model(){
  if(!loading)loading=(async()=>{
    const bytes=await fs.readFile(path.join(__dirname,'..','assets','models','comic-text-detector.onnx'));
    const options={executionProviders:process.platform==='win32'?['dml']:['cpu'],intraOpNumThreads:4,interOpNumThreads:1,enableMemPattern:false,executionMode:'sequential'};
    try{return await ort.InferenceSession.create(new Uint8Array(bytes),options);}
    catch(error){if(process.platform!=='win32')throw error;return ort.InferenceSession.create(new Uint8Array(bytes),{...options,executionProviders:['cpu']});}
  })().catch(error=>{loading=null;throw error;});
  return loading;
}
function decodeBlocks(data,width,height,resizedWidth,resizedHeight,{threshold=.3,nms=.5}={}){
  const candidates=[];
  for(let i=0;i<data.length;i+=7){
    const cls=data[i+5]>=data[i+6]?0:1,confidence=data[i+4]*data[i+5+cls];
    if(confidence<threshold)continue;
    const cx=data[i],cy=data[i+1],w=data[i+2],h=data[i+3];
    const bbox={x0:Math.max(0,Math.floor((cx-w/2)*width/resizedWidth)),y0:Math.max(0,Math.floor((cy-h/2)*height/resizedHeight)),
      x1:Math.min(width,Math.ceil((cx+w/2)*width/resizedWidth)),y1:Math.min(height,Math.ceil((cy+h/2)*height/resizedHeight))};
    if(bbox.x1-bbox.x0<3||bbox.y1-bbox.y0<3)continue;
    candidates.push({bbox,detectionConfidence:confidence,detectedLanguage:cls===0?'latin':'ja',orientation:cls===1?'vertical':'horizontal'});
  }
  candidates.sort((a,b)=>b.detectionConfidence-a.detectionConfidence);
  const kept=[];
  for(const row of candidates)if(!kept.some(r=>iou(r.bbox,row.bbox)>nms))kept.push(row);
  return kept.sort((a,b)=>a.bbox.y0-b.bbox.y0||b.bbox.x0-a.bbox.x0);
}
function decodeLines(map,width,height,w,h,blocks){
  const visited=new Uint8Array(SIZE*SIZE),queue=new Int32Array(SIZE*SIZE),lines=[];
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const start=y*SIZE+x;if(visited[start]||map[start]<.3)continue;
    let head=0,tail=1,sum=0,x0=x,x1=x,y0=y,y1=y;queue[0]=start;visited[start]=1;
    while(head<tail){const i=queue[head++],px=i%SIZE,py=Math.floor(i/SIZE);sum+=map[i];x0=Math.min(x0,px);x1=Math.max(x1,px);y0=Math.min(y0,py);y1=Math.max(y1,py);
      for(const n of [i-1,i+1,i-SIZE,i+SIZE]){if(n<0||n>=SIZE*h)continue;const nx=n%SIZE;if(nx>=w||Math.abs(nx-px)>1||visited[n]||map[n]<.3)continue;visited[n]=1;queue[tail++]=n;}
    }
    if(tail<12||x1-x0<3||y1-y0<3||sum/tail<.6)continue;
    const pad=Math.max(2,Math.min(x1-x0,y1-y0)*.5);
    const bbox={x0:Math.max(0,Math.floor((x0-pad)*width/w)),y0:Math.max(0,Math.floor((y0-pad)*height/h)),x1:Math.min(width,Math.ceil((x1+pad)*width/w)),y1:Math.min(height,Math.ceil((y1+pad)*height/h))};
    lines.push({bbox,coreBbox:{x0:x0*width/w,y0:y0*height/h,x1:(x1+1)*width/w,y1:(y1+1)*height/h},detectionConfidence:sum/tail,detectedLanguage:'unknown',orientation:bbox.y1-bbox.y0>(bbox.x1-bbox.x0)*1.8?'vertical':'horizontal',kind:'unboxed',lineOnly:true});
  }
  return lines;
}
function groupLines(lines,vertical=false){
  const groups=[];
  const adjacent=(a,b)=>{
    a=a.bbox;b=b.bbox;
    if(vertical){const overlap=Math.max(0,Math.min(a.y1,b.y1)-Math.max(a.y0,b.y0))/Math.max(1,Math.min(a.y1-a.y0,b.y1-b.y0));const gap=Math.max(0,a.x0-b.x1,b.x0-a.x1);return overlap>=.45&&gap<=Math.min(a.x1-a.x0,b.x1-b.x0)*1.8;}
    const overlap=Math.max(0,Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0))/Math.max(1,Math.min(a.x1-a.x0,b.x1-b.x0));
    const gap=Math.max(0,a.y0-b.y1,b.y0-a.y1);
    return overlap>=.45&&gap<=Math.min(a.y1-a.y0,b.y1-b.y0)*1.5;
  };
  for(const line of [...lines].sort((a,b)=>a.bbox.y0-b.bbox.y0||b.bbox.x0-a.bbox.x0)){
    const near=groups.filter(g=>g.some(other=>adjacent(other,line)));
    if(!near.length)groups.push([line]);else{near[0].push(line);for(const g of near.slice(1)){near[0].push(...g);groups.splice(groups.indexOf(g),1);}}
  }
  return groups.map(group=>({bbox:{x0:Math.min(...group.map(l=>l.bbox.x0)),y0:Math.min(...group.map(l=>l.bbox.y0)),x1:Math.max(...group.map(l=>l.bbox.x1)),y1:Math.max(...group.map(l=>l.bbox.y1))},lines:group,
    detectionConfidence:group.reduce((n,l)=>n+l.detectionConfidence,0)/group.length,orientation:vertical?'vertical':'horizontal'}));
}
function consolidateBlocks(blocks,lines){
  const groups=[];
  const owns=(block,line)=>intersection(block.bbox,line.coreBbox||line.bbox)/Math.max(1,area(line.coreBbox||line.bbox))>.65;
  const duplicate=(a,b)=>{
    if(a.orientation!==b.orientation||iou(a.bbox,b.bbox)<.25)return false;
    const axis=a.orientation==='vertical'?'y':'x',p=a.bbox,q=b.bbox;
    const length=Math.min(p[axis+'1']-p[axis+'0'],q[axis+'1']-q[axis+'0']);
    const overlap=Math.min(p[axis+'1'],q[axis+'1'])-Math.max(p[axis+'0'],q[axis+'0']);
    if(overlap<length*.85||Math.abs(p[axis+'0']+p[axis+'1']-q[axis+'0']-q[axis+'1'])>length*.4)return false;
    // A common observed line is required: overlapping balloon rectangles
    // alone do not establish that they contain the same paragraph.
    return lines.some(line=>owns(a,line)&&owns(b,line));
  };
  for(const block of blocks){
    const near=groups.filter(g=>g.some(other=>duplicate(other,block)));
    if(!near.length)groups.push([block]);else{near[0].push(block);for(const g of near.slice(1)){near[0].push(...g);groups.splice(groups.indexOf(g),1);}}
  }
  return groups.map(group=>{
    const best=[...group].sort((a,b)=>b.detectionConfidence-a.detectionConfidence)[0];
    if(group.length===1)return best;
    return {...best,bbox:{x0:Math.min(...group.map(b=>b.bbox.x0)),y0:Math.min(...group.map(b=>b.bbox.y0)),x1:Math.max(...group.map(b=>b.bbox.x1)),y1:Math.max(...group.map(b=>b.bbox.y1))},
      blockObservations:group.map(b=>({bbox:b.bbox,detectionConfidence:b.detectionConfidence,tileIndex:b.tileIndex})),groupingReason:'shared-line-observations'};
  });
}
function refineBlocks(blocks,lines){
  blocks=consolidateBlocks(blocks,lines);
  const used=new Set(),result=[];
  for(const [index,block] of blocks.entries()){
    const children=lines.filter(line=>intersection(block.bbox,line.coreBbox)/Math.max(1,area(line.coreBbox))>.65);
    children.forEach(l=>used.add(l));
    if(!children.length){result.push({...block,containerId:`block-${index}`});continue;}
    const vertical=children.filter(l=>l.orientation==='vertical').length>children.length/2;
    const groups=groupLines(children,vertical);
    const heights=children.map(l=>l.coreBbox.y1-l.coreBbox.y0).sort((a,b)=>a-b);
    const lineHeight=heights[Math.floor(heights.length/2)];
    const firstY=Math.min(...children.map(l=>l.bbox.y0));
    // A small heading can disappear from the downsampled line map. Retain
    // the uncovered head of the learned block as an independent OCR proposal.
    const uncoveredHead=!vertical&&firstY-block.bbox.y0>lineHeight*2.5;
    if(uncoveredHead)result.push({...block,bbox:{...block.bbox,y1:Math.floor(firstY-lineHeight*.5)},lineOnly:true,uncovered:true,
      containerId:`block-${index}`,containerBBox:block.bbox});
    for(const group of groups)result.push({...block,...group,bbox:group.bbox,
      kind:'text',lineOnly:false,containerId:`block-${index}`,containerBBox:block.bbox,detectionConfidence:block.detectionConfidence});
  }
  for(const group of groupLines(lines.filter(l=>!used.has(l))))result.push({...group,detectedLanguage:'unknown',kind:'unboxed',lineOnly:true});
  const unique=[];
  for(const row of result){
    const duplicate=unique.find(other=>row.lines?.length&&row.orientation===other.orientation&&row.lines.length===other.lines?.length&&row.lines.every(line=>other.lines.includes(line)));
    if(!duplicate){unique.push(row);continue;}
    const observations=[...(duplicate.containerObservations||[{containerId:duplicate.containerId,bbox:duplicate.containerBBox,detectionConfidence:duplicate.detectionConfidence}]),
      {containerId:row.containerId,bbox:row.containerBBox,detectionConfidence:row.detectionConfidence}];
    if(row.detectionConfidence>duplicate.detectionConfidence)Object.assign(duplicate,row);
    duplicate.containerObservations=observations;duplicate.groupingReason='identical-line-observations';
  }
  return unique;
}
function planTiles(width,height,{detail=false,sourceScale=1}={}){
  const nativeWidth=Math.round(width/sourceScale),nativeHeight=Math.round(height/sourceScale);
  if(sourceScale!==1)return planTiles(nativeWidth,nativeHeight,{detail}).map(t=>({...t,left:t.left*sourceScale,top:t.top*sourceScale,width:t.width*sourceScale,height:t.height*sourceScale}));
  const full={left:0,top:0,width,height,scanType:'full'};
  if(Math.max(width,height)/Math.min(width,height)<=2.8){
    if(!detail||Math.max(width,height)<=1536)return [full];
    const starts=(length,span)=>{const n=Math.ceil((length-span)/Math.floor(span*.8));return Array.from({length:Math.max(1,n+1)},(_,i)=>n>0?Math.round((length-span)*i/n):0);};
    const w=Math.min(width,1024),h=Math.min(height,1024),tiles=[];
    for(const top of starts(height,h))for(const left of starts(width,w))tiles.push({left,top,width:w,height:h,scanType:'detail'});
    return [full,...tiles];
  }
  const vertical=height>width,short=vertical?width:height,long=vertical?height:width;
  const span=Math.min(long,Math.max(512,Math.min(1600,Math.round(short*1.5)))),step=Math.max(1,Math.floor(span*.75));
  const starts=[];for(let start=0;;start=Math.min(long-span,start+step)){starts.push(start);if(start+span>=long)break;}
  const tiles=starts.map(start=>vertical?{left:0,top:start,width,height:span,scanType:'detail'}:{left:start,top:0,width:span,height,scanType:'detail'});
  return detail?[full,...tiles]:tiles;
}
function mergeTileObservations(rows){
  // Prefer a complete observation to one clipped at a crop edge. Containment
  // catches partial repeats; neighboring text units remain separate.
  const quality=r=>(r.tileClipped?0:10)+(r.scanType==='detail'?2:0)+(r.detectionConfidence||0);
  const kept=[];
  for(const row of [...rows].sort((a,b)=>quality(b)-quality(a))){
    if(!kept.some(other=>iou(row.bbox,other.bbox)>.45||intersection(row.bbox,other.bbox)/Math.max(1,Math.min(area(row.bbox),area(other.bbox)))>.85))kept.push(row);
  }
  return kept.sort((a,b)=>a.bbox.y0-b.bbox.y0||b.bbox.x0-a.bbox.x0);
}
async function detectTile(input,options={}){
  const started=Date.now(),source=sharp(input).rotate().flatten({background:'#fff'});
  const {width,height}=await source.metadata();
  // Keep native glyph sizes on small screenshots. Enlarging a tightly
  // cropped paragraph to 1024 can turn a single line into several detections.
  // Recognition crops are enlarged separately, after region detection.
  const sourceScale=Math.max(1,Number(options.sourceScale)||1),requestedRatio=Math.min(SIZE/width,SIZE/height);
  const limit=options.upscale===false||(options.upscale!==true&&requestedRatio*sourceScale>2)?1/sourceScale:Infinity;
  const ratio=Math.min(requestedRatio,limit),w=Math.max(1,Math.round(width*ratio)),h=Math.max(1,Math.round(height*ratio));
  const {data,info}=await source.resize(w,h,{fit:'fill',kernel:'cubic'}).removeAlpha().raw().toBuffer({resolveWithObject:true});
  const planar=new Float32Array(3*SIZE*SIZE);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)for(let c=0;c<3;c++)planar[c*SIZE*SIZE+y*SIZE+x]=data[(y*w+x)*info.channels+c]/255;
  const session=await model();
  const result=await session.run({images:new ort.Tensor('float32',planar,[1,3,SIZE,SIZE])});
  const boxes=decodeBlocks(result.blk.data,width,height,w,h,options);
  const lines=decodeLines(result.det.data,width,height,w,h,boxes);
  return {width,height,rawBlocks:boxes,lines,ms:Date.now()-started};
}
async function detectText(input,options={}){
  const started=Date.now(),meta=await sharp(input).metadata(),{width,height}=meta.autoOrient||meta;
  const tiles=options.tiling===false?[{left:0,top:0,width,height,scanType:'full'}]:planTiles(width,height,{detail:options.detail,sourceScale:options.sourceScale||1}),blocks=[],observations=[];
  for(const [index,tile]of tiles.entries()){
    if(options.signal?.aborted)throw Error('ยกเลิก OCR');
    options.onScan?.({index:index+1,total:tiles.length,engine:'CTD'});
    const {left,top,width:tileWidth,height:tileHeight}=tile;
    const image=tiles.length===1?input:await sharp(input).rotate().extract({left,top,width:tileWidth,height:tileHeight}).png().toBuffer();
    const result=await detectTile(image,options);
    const map=row=>{
      const shift=b=>({x0:b.x0+tile.left,y0:b.y0+tile.top,x1:b.x1+tile.left,y1:b.y1+tile.top});
      const b=row.bbox,clipped=(tile.top>0&&b.y0<8)||(tile.top+tile.height<height&&b.y1>tile.height-8)||(tile.left>0&&b.x0<8)||(tile.left+tile.width<width&&b.x1>tile.width-8);
      return {...row,bbox:shift(b),...(row.coreBbox?{coreBbox:shift(row.coreBbox)}:{}),scanType:tile.scanType,tileIndex:index,tileClipped:clipped};
    };
    blocks.push(...result.rawBlocks.map(map));observations.push(...result.lines.map(map));
  }
  const rawBlocks=mergeTileObservations(blocks),lines=mergeTileObservations(observations),boxes=refineBlocks(rawBlocks,lines);
  return {engine:'comic-text-detector',width,height,boxes:boxes.sort((a,b)=>a.bbox.y0-b.bbox.y0||b.bbox.x0-a.bbox.x0),rawBlocks,lines,tiles,ms:Date.now()-started};
}
module.exports={detectText,decodeBlocks,decodeLines,groupLines,refineBlocks,consolidateBlocks,planTiles,mergeTileObservations};
