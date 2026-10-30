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
    const ac=a.coreBbox||a.bbox,bc=b.coreBbox||b.bbox;
    const thickness=c=>vertical?c.x1-c.x0:c.y1-c.y0;
    if(Math.max(thickness(ac),thickness(bc))/Math.max(1,Math.min(thickness(ac),thickness(bc)))>2.2)return false;
    const angle=l=>l.polygon?.length>=2?Math.atan2(l.polygon[1][1]-l.polygon[0][1],l.polygon[1][0]-l.polygon[0][0]):0;
    if(!vertical&&Math.abs(angle(a)-angle(b))>Math.PI/8)return false;
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
    const children=lines.filter(line=>{
      const a=block.bbox,b=line.coreBbox;
      if(intersection(a,b)/Math.max(1,area(b))>.65)return true;
      // A detail tile's block may end halfway down a complete vertical
      // column. Attach the canonical column, not a second cropped paragraph.
      if(line.orientation!=='vertical'||b.y1-b.y0<(b.x1-b.x0)*3)return false;
      const across=Math.max(0,Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0))/Math.max(1,b.x1-b.x0);
      const along=Math.max(0,Math.min(a.y1,b.y1)-Math.max(a.y0,b.y0))/Math.max(1,Math.min(a.y1-a.y0,b.y1-b.y0));
      return across>.8&&along>.8&&a.y1-a.y0>(b.x1-b.x0)*3;
    });
    children.forEach(l=>used.add(l));
    if(!children.length){result.push({...block,containerId:`block-${index}`});continue;}
    const verticalCount=children.filter(l=>l.orientation==='vertical').length;
    const vertical=verticalCount>children.length/2||verticalCount>0&&block.orientation==='vertical'&&children.every(l=>{const b=l.coreBbox||l.bbox;return b.x1-b.x0<(b.y1-b.y0)*2;});
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
  // Unclaimed headings still have a detected writing direction. Passing them
  // through the horizontal default turns short vertical headings into rows.
  for(const vertical of [false,true])for(const group of groupLines(lines.filter(l=>!used.has(l)&&(l.orientation==='vertical')===vertical),vertical))result.push({...group,detectedLanguage:'unknown',kind:'unboxed',lineOnly:true});
  const unique=[];
  for(const row of result){
    const duplicate=unique.find(other=>row.lines?.length&&row.orientation===other.orientation&&row.lines.length===other.lines?.length&&row.lines.every(line=>other.lines.includes(line)));
    if(!duplicate){unique.push(row);continue;}
    const observations=[...(duplicate.containerObservations||[{containerId:duplicate.containerId,bbox:duplicate.containerBBox,detectionConfidence:duplicate.detectionConfidence}]),
      {containerId:row.containerId,bbox:row.containerBBox,detectionConfidence:row.detectionConfidence}];
    if(row.detectionConfidence>duplicate.detectionConfidence)Object.assign(duplicate,row);
    duplicate.containerObservations=observations;duplicate.groupingReason='identical-line-observations';
  }
  // A full-page block and a detail block may own the same canonical lines,
  // with one missing a heading. Keep the complete observation once.
  return unique.filter(row=>{
    if(!row.lines?.length){
      if(row.orientation==='horizontal'&&row.detectionConfidence<.7){
        const columns=lines.filter(l=>{const b=l.coreBbox||l.bbox;return l.orientation==='vertical'&&b.y1-b.y0>(b.x1-b.x0)*6&&intersection(b,row.bbox)/Math.max(1,area(row.bbox))>.2;});
        if(columns.length>=2)return false;
      }
      return true;
    }
    const owner=unique.find(other=>other!==row&&other.orientation===row.orientation&&other.lines?.length>row.lines.length&&row.lines.every(l=>other.lines.includes(l)));
    if(!owner)return true;
    owner.containerObservations=[...(owner.containerObservations||[]),{containerId:row.containerId,bbox:row.containerBBox,detectionConfidence:row.detectionConfidence}];
    return false;
  });
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
function mergeLineObservations(rows){
  const horizontal=rows.filter(r=>r.orientation!=='vertical'),vertical=[];
  for(const row of rows.filter(r=>r.orientation==='vertical')){
    const a=row.coreBbox||row.bbox;
    const matches=vertical.filter(other=>{
      const b=other.coreBbox||other.bbox,aw=a.x1-a.x0,bw=b.x1-b.x0;
      const across=Math.max(0,Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0))/Math.max(1,Math.min(aw,bw));
      const along=Math.max(0,Math.min(a.y1,b.y1)-Math.max(a.y0,b.y0))/Math.max(1,Math.min(a.y1-a.y0,b.y1-b.y0));
      const gap=Math.max(0,a.y0-b.y1,b.y0-a.y1);
      const contiguous=gap<=Math.min(aw,bw)*.8&&Math.min(a.y1-a.y0,b.y1-b.y0)>Math.max(aw,bw)*3;
      return across>.75&&Math.max(aw,bw)/Math.max(1,Math.min(aw,bw))<1.8&&(along>.25||contiguous);
    });
    if(!matches.length){vertical.push(row);continue;}
    const members=[row,...matches],bounds=key=>({x0:Math.min(...members.map(r=>(r[key]||r.bbox).x0)),y0:Math.min(...members.map(r=>(r[key]||r.bbox).y0)),x1:Math.max(...members.map(r=>(r[key]||r.bbox).x1)),y1:Math.max(...members.map(r=>(r[key]||r.bbox).y1))});
    const complete=members.find(r=>!r.tileClipped)||row;
    for(const other of matches)vertical.splice(vertical.indexOf(other),1);
    vertical.push({...complete,bbox:bounds('bbox'),coreBbox:bounds('coreBbox'),tileClipped:members.every(r=>r.tileClipped),lineObservations:members.flatMap(r=>r.lineObservations||[{bbox:r.bbox,tileIndex:r.tileIndex}])});
  }
  // A final glyph can be classified as a horizontal component. Attach only
  // a short, closely aligned end fragment with one unambiguous column owner;
  // retain its observation so downstream grouping sees one canonical column.
  const tails=new Set();
  for(const row of horizontal){
    const a=row.coreBbox||row.bbox,aw=a.x1-a.x0,ah=a.y1-a.y0;
    const owners=vertical.filter(column=>{
      const b=column.coreBbox||column.bbox,bw=b.x1-b.x0;
      const gap=Math.max(a.y0-b.y1,b.y0-a.y1);
      return b.y1-b.y0>bw*6&&ah<=bw*2&&aw>=bw*.45&&aw<=bw*1.4&&
        Math.abs((a.x0+a.x1-b.x0-b.x1)/2)<=bw*.25&&gap>=0&&gap<=bw*.8;
    });
    if(owners.length!==1)continue;
    const column=owners[0];
    const bounds=key=>{const b=column[key]||column.bbox,c=row[key]||row.bbox;return {x0:Math.min(b.x0,c.x0),y0:Math.min(b.y0,c.y0),x1:Math.max(b.x1,c.x1),y1:Math.max(b.y1,c.y1)};};
    const bbox=bounds('bbox'),coreBbox=bounds('coreBbox');
    const observations=[...(column.lineObservations||[{bbox:column.bbox,tileIndex:column.tileIndex}]),{bbox:row.bbox,tileIndex:row.tileIndex}];
    vertical[vertical.indexOf(column)]={...column,bbox,coreBbox,lineObservations:observations};
    tails.add(row);
  }
  const independent=horizontal.filter(row=>!tails.has(row)&&!vertical.some(column=>{
    const a=row.coreBbox||row.bbox,b=column.coreBbox||column.bbox;
    return intersection(a,b)/Math.max(1,area(a))>.8&&a.x1-a.x0<(b.x1-b.x0)*1.8&&a.y1-a.y0<(b.y1-b.y0)*.85;
  }));
  const merged=[...mergeTileObservations(independent),...vertical];
  const suppressed=new Map();
  // Detail tiles can read several glyph columns as a wide horizontal row or
  // one broad vertical component. Complete thin columns outrank those partial
  // rectangles. This is positional evidence only; no OCR text is discarded.
  const retained=merged.filter(row=>{
    const a=row.coreBbox||row.bbox,aw=a.x1-a.x0,ah=a.y1-a.y0;
    const columns=vertical.filter(other=>{
      if(other===row)return false;
      const b=other.coreBbox||other.bbox,bw=b.x1-b.x0,bh=b.y1-b.y0;
      const along=Math.max(0,Math.min(a.y1,b.y1)-Math.max(a.y0,b.y0));
      return bw<aw*.55&&bh>bw*6&&bh>aw*2&&along/Math.max(1,ah)>.65&&
        b.x0>=Math.min(a.x0-bw*.5,row.bbox.x0)&&b.x1<=Math.max(a.x1+bw*.5,row.bbox.x1);
    }).sort((p,q)=>(p.coreBbox||p.bbox).x0-(q.coreBbox||q.bbox).x0);
    if(columns.length<2)return true;
    if(!columns.some(l=>{const b=l.coreBbox||l.bbox;return Math.max(0,Math.min(a.y1,b.y1)-Math.max(a.y0,b.y0))/Math.max(1,ah)>.95;}))return true;
    const first=columns[0].coreBbox||columns[0].bbox,last=columns.at(-1).coreBbox||columns.at(-1).bbox;
    if(last.x0-first.x1<=0||last.x1-first.x0<aw*.55)return true;
    // Retain a trace on the chosen owner rather than deleting the evidence.
    const owner=columns[0];suppressed.set(owner,[...(suppressed.get(owner)||[]),{bbox:row.bbox,coreBbox:row.coreBbox,reason:'covered-by-complete-vertical-columns'}]);
    return false;
  });
  return retained.map(row=>suppressed.has(row)?{...row,suppressedLineObservations:[...(row.suppressedLineObservations||[]),...suppressed.get(row)]}:row).sort((a,b)=>a.bbox.y0-b.bbox.y0||b.bbox.x0-a.bbox.x0);
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
  let segmentation;
  if(options.includeSegmentation){
    const pixels=Buffer.alloc(SIZE*SIZE);
    for(let i=0;i<pixels.length;i++)pixels[i]=Math.round(Math.max(0,Math.min(1,result.seg.data[i]))*255);
    segmentation=await sharp(pixels,{raw:{width:SIZE,height:SIZE,channels:1}}).extract({left:0,top:0,width:w,height:h}).resize(width,height,{kernel:'linear'}).png().toBuffer();
  }
  return {width,height,rawBlocks:boxes,lines,...(segmentation?{segmentation}:{}),ms:Date.now()-started};
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
  const rawBlocks=mergeTileObservations(blocks),lines=mergeLineObservations(observations),boxes=refineBlocks(rawBlocks,lines);
  return {engine:'comic-text-detector',width,height,boxes:boxes.sort((a,b)=>a.bbox.y0-b.bbox.y0||b.bbox.x0-a.bbox.x0),rawBlocks,lines,tiles,ms:Date.now()-started};
}
module.exports={detectText,detectTile,decodeBlocks,decodeLines,groupLines,refineBlocks,consolidateBlocks,planTiles,mergeTileObservations,mergeLineObservations};
