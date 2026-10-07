'use strict';

const fs = require('node:fs/promises');
const sharp = require('sharp');
const { LocalOcrBackend } = require('./ocr-backend.cjs');

function compactRegion(region = {}) {
  const bbox = region.bbox || {};
  const out = {
    id:String(region.id || ''),
    bbox:{
      x0:Number(bbox.x0) || 0,
      y0:Number(bbox.y0) || 0,
      x1:Number(bbox.x1) || 0,
      y1:Number(bbox.y1) || 0
    },
    orientation:region.orientation === 'vertical' ? 'vertical' : 'horizontal'
  };
  if (region.containerBBox) out.containerBBox = { ...region.containerBBox };
  if (region.detectorBBox) out.detectorBBox = { ...region.detectorBBox };
  return out;
}

function placementStats(regions = []) {
  const stats = {
    total:regions.length,
    bubble:0,
    scene:0,
    reviewRequired:0,
    flatFillSafe:0,
    requiresInpaint:0
  };
  for (const region of regions) {
    const placement = region?.placement;
    if (!placement) continue;
    if (placement.surfaceType === 'bubble') stats.bubble++;
    else stats.scene++;
    if (placement.reviewRequired) stats.reviewRequired++;
    if (placement.flatFillSafe) stats.flatFillSafe++;
    if (placement.requiresInpaint) stats.requiresInpaint++;
  }
  return stats;
}

function svgEscape(value) {
  return String(value || '').replace(/[&<>"']/g, ch => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'
  }[ch]));
}

function polygonPoints(points = []) {
  return points.map(([x,y]) => `${Number(x).toFixed(1)},${Number(y).toFixed(1)}`).join(' ');
}

function boxArea(b={}) {
  return Math.max(0,(Number(b.x1)||0)-(Number(b.x0)||0))*Math.max(0,(Number(b.y1)||0)-(Number(b.y0)||0));
}
function boxIntersection(a={},b={}) {
  return Math.max(0,Math.min(Number(a.x1)||0,Number(b.x1)||0)-Math.max(Number(a.x0)||0,Number(b.x0)||0))*
    Math.max(0,Math.min(Number(a.y1)||0,Number(b.y1)||0)-Math.max(Number(a.y0)||0,Number(b.y0)||0));
}
function boxIou(a={},b={}) {
  const n=boxIntersection(a,b);
  return n/Math.max(1,boxArea(a)+boxArea(b)-n);
}
function polygonBox(points=[]) {
  if(!Array.isArray(points)||!points.length)return null;
  return {x0:Math.min(...points.map(p=>Number(p?.[0])||0)),y0:Math.min(...points.map(p=>Number(p?.[1])||0)),
    x1:Math.max(...points.map(p=>Number(p?.[0])||0)),y1:Math.max(...points.map(p=>Number(p?.[1])||0))};
}
function pointInPolygon(point,points=[]) {
  if(!Array.isArray(points)||points.length<3)return false;
  const [x,y]=point;let inside=false;
  for(let i=0,j=points.length-1;i<points.length;j=i++){
    const xi=Number(points[i][0]),yi=Number(points[i][1]),xj=Number(points[j][0]),yj=Number(points[j][1]);
    const crosses=(yi>y)!==(yj>y)&&x<(xj-xi)*(y-yi)/((yj-yi)||1e-9)+xi;
    if(crosses)inside=!inside;
  }
  return inside;
}
function reconcilePlacements(regions=[]) {
  let rows=regions.map(row=>({...row,placement:row.placement?{...row.placement}:row.placement}));
  const bubbleRows=()=>rows.filter(row=>row.placement?.surfaceType==='bubble'&&Array.isArray(row.placement.polygon));

  // A detector can split one balloon into several OCR regions. If a scene
  // rectangle actually sits inside an already-detected balloon, attach it to
  // that balloon instead of painting a second rectangle over the artwork.
  for(const row of rows){
    if(row.placement?.surfaceType!=='scene')continue;
    const b=row.bbox||{},center=[((Number(b.x0)||0)+(Number(b.x1)||0))/2,((Number(b.y0)||0)+(Number(b.y1)||0))/2];
    const candidates=bubbleRows().map(other=>{
      const pb=polygonBox(other.placement.polygon);if(!pb)return null;
      const coverage=boxIntersection(b,pb)/Math.max(1,boxArea(b));
      return pointInPolygon(center,other.placement.polygon)&&coverage>=.68?{other,coverage}:null;
    }).filter(Boolean).sort((a,b)=>b.coverage-a.coverage||(b.other.placement.confidence||0)-(a.other.placement.confidence||0));
    if(candidates.length){
      const canonical=candidates[0].other.placement;
      row.placement={...canonical,promotedFromScene:true,detectionMode:'shared-bubble-surface',reviewRequired:Boolean(canonical.reviewRequired)};
    }
  }

  const bubbles=bubbleRows();
  const parent=bubbles.map((_,i)=>i);
  const find=i=>parent[i]===i?i:(parent[i]=find(parent[i]));
  const union=(a,b)=>{a=find(a);b=find(b);if(a!==b)parent[b]=a;};
  for(let i=0;i<bubbles.length;i++)for(let j=i+1;j<bubbles.length;j++){
    const a=polygonBox(bubbles[i].placement.polygon),b=polygonBox(bubbles[j].placement.polygon);
    if(!a||!b)continue;
    const minOverlap=boxIntersection(a,b)/Math.max(1,Math.min(boxArea(a),boxArea(b)));
    if(boxIou(a,b)>=.58||minOverlap>=.80)union(i,j);
  }
  const groups=new Map();
  bubbles.forEach((row,i)=>{const root=find(i);if(!groups.has(root))groups.set(root,[]);groups.get(root).push(row);});
  let surfaceIndex=0;
  for(const group of groups.values()){
    surfaceIndex++;
    const canonical=[...group].sort((a,b)=>{
      const pa=polygonBox(a.placement.polygon),pb=polygonBox(b.placement.polygon);
      return (b.placement.confidence||0)-(a.placement.confidence||0)||boxArea(pb)-boxArea(pa);
    })[0];
    const members=group.map(row=>String(row.id||'')).sort();
    const surfaceId=`bubble-${String(surfaceIndex).padStart(3,'0')}`;
    for(const row of group){
      const keep={...canonical.placement,surfaceId,surfaceMembers:members,sharedSurface:group.length>1};
      if(row.placement.promotedFromScene)keep.promotedFromScene=true;
      row.placement=keep;
    }
  }
  let rectIndex=0;
  for(const row of rows)if(row.placement?.surfaceType!=='bubble'){
    row.placement={...row.placement,surfaceId:`scene-${String(++rectIndex).padStart(3,'0')}`,surfaceMembers:[String(row.id||'')],sharedSurface:false};
  }
  return rows;
}

function unionBox(items=[]){
  const boxes=items.map(item=>item?.bbox||item).filter(Boolean);
  if(!boxes.length)return null;
  return {x0:Math.min(...boxes.map(b=>Number(b.x0)||0)),y0:Math.min(...boxes.map(b=>Number(b.y0)||0)),
    x1:Math.max(...boxes.map(b=>Number(b.x1)||0)),y1:Math.max(...boxes.map(b=>Number(b.y1)||0))};
}
function yOverlapRatio(a={},b={}){
  const overlap=Math.max(0,Math.min(Number(a.y1)||0,Number(b.y1)||0)-Math.max(Number(a.y0)||0,Number(b.y0)||0));
  return overlap/Math.max(1,Math.min((Number(a.y1)||0)-(Number(a.y0)||0),(Number(b.y1)||0)-(Number(b.y0)||0)));
}
function clipPolygonX(points=[],cut,keepLeft=true){
  if(!Array.isArray(points)||points.length<3)return [];
  const inside=p=>keepLeft?Number(p[0])<=cut:Number(p[0])>=cut;
  const intersect=(a,b)=>{
    const ax=Number(a[0]),ay=Number(a[1]),bx=Number(b[0]),by=Number(b[1]);
    const dx=bx-ax;if(Math.abs(dx)<1e-9)return [cut,ay];
    const t=(cut-ax)/dx;return [cut,ay+(by-ay)*t];
  };
  const out=[];let prev=points.at(-1),prevIn=inside(prev);
  for(const cur of points){
    const curIn=inside(cur);
    if(curIn!==prevIn)out.push(intersect(prev,cur));
    if(curIn)out.push([Number(cur[0]),Number(cur[1])]);
    prev=cur;prevIn=curIn;
  }
  return out;
}
function paddedBox(box={},padX=8,padY=8,limit=null){
  const out={x0:(Number(box.x0)||0)-padX,y0:(Number(box.y0)||0)-padY,x1:(Number(box.x1)||0)+padX,y1:(Number(box.y1)||0)+padY};
  if(limit){
    out.x0=Math.max(Number(limit.x0)||0,out.x0);out.y0=Math.max(Number(limit.y0)||0,out.y0);
    out.x1=Math.min(Number(limit.x1)||out.x1,out.x1);out.y1=Math.min(Number(limit.y1)||out.y1,out.y1);
  }
  return out;
}
function clusterWordsIntoColumns(words=[],surfaceBox=null){
  const points=words.map((w,sourceIndex)=>({w,sourceIndex})).filter(item=>item.w?.bbox&&String(item.w.text||'').trim()).map(({w,sourceIndex})=>{
    const b=w.bbox;return {w,index:sourceIndex,x:((Number(b.x0)||0)+(Number(b.x1)||0))/2,b};
  });
  if(points.length<6||!surfaceBox)return null;
  let c0=Math.min(...points.map(p=>p.x)),c1=Math.max(...points.map(p=>p.x));
  if(c1-c0<24)return null;
  let groups;
  for(let iter=0;iter<12;iter++){
    groups=[[],[]];
    for(const p of points)groups[Math.abs(p.x-c0)<=Math.abs(p.x-c1)?0:1].push(p);
    if(!groups[0].length||!groups[1].length)return null;
    const n0=groups[0].reduce((n,p)=>n+p.x,0)/groups[0].length;
    const n1=groups[1].reduce((n,p)=>n+p.x,0)/groups[1].length;
    if(Math.abs(n0-c0)+Math.abs(n1-c1)<.05){c0=n0;c1=n1;break;}
    c0=n0;c1=n1;
  }
  if(c0>c1){[c0,c1]=[c1,c0];groups.reverse();}
  const leftBox=unionBox(groups[0].map(p=>p.b)),rightBox=unionBox(groups[1].map(p=>p.b));
  const width=Math.max(1,(Number(surfaceBox.x1)||0)-(Number(surfaceBox.x0)||0));
  const separation=c1-c0;
  const overlap=yOverlapRatio(leftBox,rightBox);
  if(groups[0].length<2||groups[1].length<2||separation<Math.max(28,width*.28)||overlap<.30)return null;
  const cut=(c0+c1)/2;
  const textOf=group=>{
    const heights=group.map(p=>Math.max(1,(Number(p.b.y1)||0)-(Number(p.b.y0)||0))).sort((a,b)=>a-b);
    const tolerance=Math.max(4,(heights[Math.floor(heights.length/2)]||12)*.55);
    const lines=[];
    for(const p of group.slice().sort((a,b)=>((a.b.y0||0)-(b.b.y0||0))||a.x-b.x)){
      const cy=((Number(p.b.y0)||0)+(Number(p.b.y1)||0))/2;
      let line=lines.find(row=>Math.abs(row.cy-cy)<=tolerance);
      if(!line){line={cy,items:[]};lines.push(line);}
      line.items.push(p);line.cy=line.items.reduce((n,item)=>n+((Number(item.b.y0)||0)+(Number(item.b.y1)||0))/2,0)/line.items.length;
    }
    return lines.sort((a,b)=>a.cy-b.cy).map(line=>line.items.sort((a,b)=>a.x-b.x).map(p=>String(p.w.text||'')).join(' ').replace(/\s+/g,' ').trim()).filter(Boolean).join('\n');
  };
  return {cut,kind:'ocr-word-columns',confidence:Math.max(.5,Math.min(.98,.58+(separation/width)*.55+(overlap*.12))),
    groups:[{box:leftBox,wordIndices:groups[0].map(p=>p.index),text:textOf(groups[0])},{box:rightBox,wordIndices:groups[1].map(p=>p.index),text:textOf(groups[1])}]};
}
function polygonVerticalSpan(points=[],x){
  if(!Array.isArray(points)||points.length<3)return 0;
  const ys=[];
  for(let i=0,j=points.length-1;i<points.length;j=i++){
    const a=points[j],b=points[i],ax=Number(a[0]),bx=Number(b[0]),ay=Number(a[1]),by=Number(b[1]);
    if((ax<=x&&x<bx)||(bx<=x&&x<ax)){
      const t=(x-ax)/((bx-ax)||1e-9);ys.push(ay+(by-ay)*t);
    }else if(Math.abs(ax-x)<1e-6&&Math.abs(bx-x)<1e-6){ys.push(ay,by);}
  }
  if(ys.length<2)return 0;
  return Math.max(...ys)-Math.min(...ys);
}
function connectedShapeEvidence(placement,cut){
  const points=placement?.polygon||[],pb=polygonBox(points);
  if(!pb)return {ok:false,pinchRatio:1,solidity:1};
  const width=Math.max(1,pb.x1-pb.x0);
  const cutSpan=polygonVerticalSpan(points,cut);
  let leftMax=0,rightMax=0;
  for(let i=1;i<=8;i++){
    leftMax=Math.max(leftMax,polygonVerticalSpan(points,pb.x0+(cut-pb.x0)*i/9));
    rightMax=Math.max(rightMax,polygonVerticalSpan(points,cut+(pb.x1-cut)*i/9));
  }
  const pinchRatio=cutSpan/Math.max(1,Math.min(leftMax||cutSpan,rightMax||cutSpan));
  const solidity=Number(placement?.metrics?.solidity);
  const solidityValue=Number.isFinite(solidity)?solidity:1;
  return {ok:solidityValue<=.90&&pinchRatio<=.96,pinchRatio,solidity:solidityValue};
}

function splitBubbleSurface(rows=[]){
  if(!rows.length)return null;
  const p=rows[0].placement;
  if(p?.surfaceType!=='bubble'||!Array.isArray(p.polygon)||p.polygon.length<3)return null;
  const surfaceBox=polygonBox(p.polygon);if(!surfaceBox)return null;

  let evidence=null;
  if(rows.length>=2){
    const candidates=rows.filter(r=>r?.bbox).slice().sort((a,b)=>(((a.bbox.x0+a.bbox.x1)-(b.bbox.x0+b.bbox.x1))));
    const left=candidates[0],right=candidates.at(-1);
    const lc=((left.bbox.x0+left.bbox.x1)/2),rc=((right.bbox.x0+right.bbox.x1)/2);
    const width=Math.max(1,surfaceBox.x1-surfaceBox.x0);
    if(left!==right&&rc-lc>=Math.max(28,width*.28)&&yOverlapRatio(left.bbox,right.bbox)>=.30){
      evidence={cut:(lc+rc)/2,kind:'ocr-regions',confidence:.96,groups:[
        {box:left.bbox,regionIds:[String(left.id||'')],text:String(left.text||'')},
        {box:right.bbox,regionIds:[String(right.id||'')],text:String(right.text||'')}
      ]};
    }
  }
  if(!evidence&&rows.length===1)evidence=clusterWordsIntoColumns(rows[0].words||[],surfaceBox);
  if(!evidence)return null;
  const shapeEvidence=connectedShapeEvidence(p,evidence.cut);
  if(!shapeEvidence.ok)return null;

  const leftPoly=clipPolygonX(p.polygon,evidence.cut,true),rightPoly=clipPolygonX(p.polygon,evidence.cut,false);
  if(leftPoly.length<3||rightPoly.length<3)return null;
  const polys=[leftPoly,rightPoly];
  const subSurfaces=evidence.groups.map((group,index)=>{
    const poly=polys[index],pb=polygonBox(poly);
    const bw=Math.max(1,(group.box.x1||0)-(group.box.x0||0)),bh=Math.max(1,(group.box.y1||0)-(group.box.y0||0));
    const safe=paddedBox(group.box,Math.max(6,bw*.10),Math.max(6,bh*.12),pb);
    return {
      id:`${p.surfaceId || 'bubble'}-part-${index+1}`,
      index,
      shape:'polygon',
      polygon:poly,
      eraseBox:pb,
      safeBox:safe,
      sourceRegionIds:group.regionIds||[String(rows[0].id||'')],
      regionIds:group.regionIds||[String(rows[0].id||'')],
      sourceBBox:{...group.box},
      ocrWordIndices:group.wordIndices||[],
      ocrTextHint:group.text||'',
      splitEvidence:evidence.kind,
      confidence:Number(evidence.confidence.toFixed(4))
    };
  });
  return {subSurfaces,splitMode:'connected-bubble-columns',splitEvidence:{
    kind:evidence.kind,
    confidence:Number(evidence.confidence.toFixed(4)),
    cutX:Number(evidence.cut.toFixed(2)),
    pinchRatio:Number(shapeEvidence.pinchRatio.toFixed(4)),
    solidity:Number(shapeEvidence.solidity.toFixed(4))
  }};
}
function splitConnectedBubbleSurfaces(rows=[]){
  const groups=new Map();
  for(const row of rows){
    const p=row.placement;if(p?.surfaceType!=='bubble')continue;
    const key=String(p.surfaceId||row.id||'');
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(row);
  }
  for(const group of groups.values()){
    const split=splitBubbleSurface(group);if(!split)continue;
    for(const row of group)row.placement={...row.placement,...split,subSurfaceCount:split.subSurfaces.length};
  }
  return rows;
}

function speechSurfaceSnapshot(p={}){
  return {
    surfaceId:p.surfaceId,
    surfaceType:p.surfaceType,
    shape:p.shape,
    polygon:Array.isArray(p.polygon)?p.polygon.map(point=>[Number(point[0]),Number(point[1])]):[],
    eraseBox:p.eraseBox?{...p.eraseBox}:undefined,
    safeBox:p.safeBox?{...p.safeBox}:undefined,
    fillColor:p.fillColor,
    paintMode:p.paintMode,
    confidence:p.confidence
  };
}
function rowEraseBoxes(row={},words=row.words||[]){
  const boxes=(Array.isArray(words)?words:[]).filter(word=>word?.bbox&&String(word.text||'').trim()).map(word=>({...word.bbox}));
  return boxes.length?boxes:(row.bbox?[{...row.bbox}]:[]);
}
function directZonePlacement(base={},part=null,{memberIds=[],sourceEraseBoxes=[]}={}){
  const speechSurface=base.speechSurface||speechSurfaceSnapshot(base);
  const zone=part||{};
  return {
    ...base,
    speechSurface,
    activeSubSurfaceId:zone.id||base.activeSubSurfaceId,
    eraseBox:zone.eraseBox?{...zone.eraseBox}:{...(base.eraseBox||{})},
    safeBox:zone.safeBox?{...zone.safeBox}:{...(base.safeBox||{})},
    polygon:Array.isArray(zone.polygon)?zone.polygon.map(point=>[Number(point[0]),Number(point[1])]):(Array.isArray(base.polygon)?base.polygon.map(point=>[Number(point[0]),Number(point[1])]):[]),
    sourceEraseBoxes:sourceEraseBoxes.map(box=>({...box})),
    surfaceMembers:memberIds.length?memberIds:[...(base.surfaceMembers||[])],
    sharedSurface:memberIds.length>1||Boolean(base.sharedSurface),
    placementZone:true
  };
}
function materializePlacementZones(regions=[]){
  const rows=(Array.isArray(regions)?regions:[]).map(row=>({...row,placement:row.placement?{...row.placement}:row.placement}));
  const grouped=new Map();
  for(const [index,row] of rows.entries()){
    const p=row.placement;
    const key=p?.surfaceType==='bubble'&&p.surfaceId?String(p.surfaceId):`row-${index}`;
    if(!grouped.has(key))grouped.set(key,[]);
    grouped.get(key).push(row);
  }
  const output=[];
  for(const group of grouped.values()){
    const base=group[0]?.placement;
    if(!base){output.push(...group);continue;}

    const parts=Array.isArray(base.subSurfaces)?base.subSurfaces:[];
    if(base.surfaceType==='bubble'&&base.splitEvidence?.kind==='ocr-word-columns'&&group.length===1&&parts.length>=2&&parts.every(part=>String(part.ocrTextHint||'').trim())){
      const original=group[0];
      const ids=parts.map((part,index)=>`${original.id}::zone-${index+1}`);
      for(const [index,part] of parts.entries()){
        const selectedWords=(part.ocrWordIndices||[]).map(i=>original.words?.[i]).filter(Boolean);
        const bbox=part.sourceBBox?{...part.sourceBBox}:unionBox(selectedWords.map(word=>word.bbox))||{...original.bbox};
        output.push({
          ...original,
          id:ids[index],
          parentRegionId:String(original.id||''),
          splitFromRegion:true,
          splitEvidence:base.splitEvidence,
          text:String(part.ocrTextHint||'').trim(),
          bbox,
          words:selectedWords,
          reviewRequired:Boolean(original.reviewRequired||Number(part.confidence)<.8),
          placement:directZonePlacement(base,part,{memberIds:ids,sourceEraseBoxes:rowEraseBoxes(original,selectedWords)})
        });
      }
      continue;
    }

    const memberIds=group.map(row=>String(row.id||''));
    for(const row of group){
      if(base.surfaceType!=='bubble'){
        row.placement={...row.placement,sourceEraseBoxes:rowEraseBoxes(row),placementZone:true};
        output.push(row);continue;
      }
      let part=parts.find(candidate=>(candidate.sourceRegionIds||candidate.regionIds||[]).map(String).includes(String(row.id||'')));
      if(!part&&parts.length&&group.length>1){
        const center=((Number(row.bbox?.x0)||0)+(Number(row.bbox?.x1)||0))/2;
        part=[...parts].sort((a,b)=>{
          const ac=((Number(a.sourceBBox?.x0??a.safeBox?.x0)||0)+(Number(a.sourceBBox?.x1??a.safeBox?.x1)||0))/2;
          const bc=((Number(b.sourceBBox?.x0??b.safeBox?.x0)||0)+(Number(b.sourceBBox?.x1??b.safeBox?.x1)||0))/2;
          return Math.abs(ac-center)-Math.abs(bc-center);
        })[0];
      }
      if(!part&&group.length>1){
        const limit=polygonBox(base.polygon)||base.eraseBox;
        const b=row.bbox||{};
        const bw=Math.max(1,(Number(b.x1)||0)-(Number(b.x0)||0)),bh=Math.max(1,(Number(b.y1)||0)-(Number(b.y0)||0));
        const local=paddedBox(b,Math.max(4,bw*.08),Math.max(4,bh*.10),limit);
        part={id:`${base.surfaceId}-region-${String(row.id||'')}`,eraseBox:local,safeBox:local,polygon:base.polygon};
      }
      row.placement=directZonePlacement(base,part,{memberIds,sourceEraseBoxes:rowEraseBoxes(row)});
      output.push(row);
    }
  }
  return output;
}

function normalizedBox(box={},width=1,height=1) {
  const w=Math.max(1,Number(width)||1),h=Math.max(1,Number(height)||1);
  const clamp=value=>Math.max(0,Math.min(1,value));
  return {
    x0:Number(clamp((Number(box.x0)||0)/w).toFixed(6)),
    y0:Number(clamp((Number(box.y0)||0)/h).toFixed(6)),
    x1:Number(clamp((Number(box.x1)||0)/w).toFixed(6)),
    y1:Number(clamp((Number(box.y1)||0)/h).toFixed(6))
  };
}
function attachNormalizedPlacement(regions=[],width=1,height=1) {
  return regions.map(row=>{
    const p=row.placement;
    if(!p)return row;
    const normalized={
      eraseBox:normalizedBox(p.eraseBox||row.bbox||{},width,height),
      safeBox:normalizedBox(p.safeBox||row.bbox||{},width,height)
    };
    if(Array.isArray(p.polygon)) normalized.polygon=p.polygon.map(([x,y])=>[
      Number(Math.max(0,Math.min(1,(Number(x)||0)/Math.max(1,width))).toFixed(6)),
      Number(Math.max(0,Math.min(1,(Number(y)||0)/Math.max(1,height))).toFixed(6))
    ]);
    const subSurfaces=Array.isArray(p.subSurfaces)?p.subSurfaces.map(part=>({
      ...part,
      normalized:{
        eraseBox:normalizedBox(part.eraseBox||{},width,height),
        safeBox:normalizedBox(part.safeBox||{},width,height),
        polygon:Array.isArray(part.polygon)?part.polygon.map(([x,y])=>[
          Number(Math.max(0,Math.min(1,(Number(x)||0)/Math.max(1,width))).toFixed(6)),
          Number(Math.max(0,Math.min(1,(Number(y)||0)/Math.max(1,height))).toFixed(6))
        ]):[]
      }
    })):p.subSurfaces;
    return {...row,placement:{...p,subSurfaces,normalized}};
  });
}

async function readImageInput(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  return fs.readFile(input);
}

class TextPlacementPlanner {
  constructor({ backend } = {}) {
    this.backend = backend || new LocalOcrBackend();
    this.ownsBackend = !backend;
  }

  async planPage(imageInput, regions = [], { signal, quality = true, refineText = false, sourceLanguage = 'auto', onRefine } = {}) {
    const source = Array.isArray(regions) ? regions : [];
    if (!source.length) return { regions:source, stats:placementStats(source), width:0, height:0, ms:0 };
    const startedAt = Date.now();
    const image = await readImageInput(imageInput);
    if(quality && typeof this.backend.layoutSafe === 'function'){
      const {planReadingPage}=require('./reader-quality.cjs');
      const result=await planReadingPage(this.backend,image,source,{signal,refineText,sourceLanguage,onRefine});
      return {...result,stats:placementStats(result.regions)};
    }
    let result, backendError = '';
    try {
      result = await this.backend.layout(image, source.map(compactRegion), { signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      backendError = error?.message || String(error);
      const meta = await sharp(image).metadata();
      result = { width:meta.width || 0, height:meta.height || 0, regions:[] };
    }
    const byId = new Map((result.regions || []).map(row => [String(row.id), row.placement]));
    const mapped = source.map(region => {
      const b=region.bbox || {};
      const width=Math.max(1,(Number(b.x1)||0)-(Number(b.x0)||0));
      const height=Math.max(1,(Number(b.y1)||0)-(Number(b.y0)||0));
      const padX=Math.max(6,Math.round(width*.10)),padY=Math.max(5,Math.round(height*.14));
      const fallback={
        surfaceType:'scene',
        shape:'rect',
        eraseBox:{x0:Math.max(0,(Number(b.x0)||0)-padX),y0:Math.max(0,(Number(b.y0)||0)-padY),x1:Math.min(result.width||Infinity,(Number(b.x1)||0)+padX),y1:Math.min(result.height||Infinity,(Number(b.y1)||0)+padY)},
        safeBox:{x0:Math.max(0,(Number(b.x0)||0)-padX),y0:Math.max(0,(Number(b.y0)||0)-padY),x1:Math.min(result.width||Infinity,(Number(b.x1)||0)+padX),y1:Math.min(result.height||Infinity,(Number(b.y1)||0)+padY)},
        fillColor:'#ffffff',
        flatFillSafe:false,
        requiresInpaint:true,
        paintMode:'inpaint-rect',
        confidence:0,
        reviewRequired:true,
        detectionMode:backendError?'backend-unavailable':'fallback'
      };
      return {...region,placement:byId.get(String(region.id)) || fallback};
    });
    const resultWidth=Number(result.width) || 0;
    const resultHeight=Number(result.height) || 0;
    const reconciled=attachNormalizedPlacement(materializePlacementZones(splitConnectedBubbleSurfaces(reconcilePlacements(mapped))),resultWidth,resultHeight);
    return {
      width:resultWidth,
      height:resultHeight,
      regions:reconciled,
      stats:placementStats(reconciled),
      error:backendError,
      ms:Date.now() - startedAt
    };
  }

  async renderDebug(imageInput, regions = [], outputPath, { opacity = 0.20 } = {}) {
    const image = await readImageInput(imageInput);
    const meta = await sharp(image).metadata();
    const width = meta.width || 1, height = meta.height || 1;
    const elements = [];
    for (const region of regions) {
      const p = region.placement;
      if (!p) continue;
      const stroke = p.surfaceType === 'bubble' ? '#00d4ff' : '#ffb000';
      const fill = p.surfaceType === 'bubble' ? '#00d4ff' : '#ffb000';
      if (p.shape === 'polygon' && Array.isArray(p.polygon) && p.polygon.length >= 3) {
        elements.push(`<polygon points="${polygonPoints(p.polygon)}" fill="${fill}" fill-opacity="${opacity}" stroke="${stroke}" stroke-width="3"/>`);
      } else if (p.eraseBox) {
        const b=p.eraseBox;
        elements.push(`<rect x="${b.x0}" y="${b.y0}" width="${Math.max(1,b.x1-b.x0)}" height="${Math.max(1,b.y1-b.y0)}" fill="${fill}" fill-opacity="${opacity}" stroke="${stroke}" stroke-width="3"/>`);
      }
      if (p.safeBox) {
        const b=p.safeBox;
        elements.push(`<rect x="${b.x0}" y="${b.y0}" width="${Math.max(1,b.x1-b.x0)}" height="${Math.max(1,b.y1-b.y0)}" fill="none" stroke="#30e070" stroke-width="2" stroke-dasharray="8 5"/>`);
      }
      const b=region.bbox;
      elements.push(`<rect x="${b.x0}" y="${b.y0}" width="${Math.max(1,b.x1-b.x0)}" height="${Math.max(1,b.y1-b.y0)}" fill="none" stroke="#ff3d71" stroke-width="2"/>`);
      const label = svgEscape(`${p.surfaceType} ${Math.round((p.confidence||0)*100)}%`);
      elements.push(`<text x="${b.x0}" y="${Math.max(14,b.y0-5)}" font-size="14" font-family="Arial" fill="#ff3d71" stroke="white" stroke-width="3" paint-order="stroke">${label}</text>`);
    }
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${elements.join('')}</svg>`);
    await sharp(image).composite([{input:svg,top:0,left:0}]).toFile(outputPath);
    return outputPath;
  }

  close() {
    if (this.ownsBackend) this.backend.close();
  }
}

module.exports = {
  TextPlacementPlanner,
  compactRegion,
  placementStats,
  reconcilePlacements,
  splitConnectedBubbleSurfaces,
  materializePlacementZones,
  clusterWordsIntoColumns
};
