'use strict';
const sharp=require('sharp');
const {detectText,groupLines,mergeTileObservations}=require('./comic-text-detector.cjs');
const {intersection,area}=require('./ocr-review.cjs');

function reconcileDiscovery(ctd,observations){
  const uncovered=[],covered=[],conflicts=[];
  for(const line of mergeTileObservations(observations)){
    const a=line.coreBbox||line.bbox;
    const hits=ctd.boxes.map(box=>{
      const sameLine=(box.lines||[]).some(l=>{
        const b=l.coreBbox||l.bbox,axis=l.orientation==='vertical'?'y':'x',length=a[axis+'1']-a[axis+'0'],other=b[axis+'1']-b[axis+'0'];
        // Paddle polygons include more padding than CTD's glyph map. Match
        // the actual line, not just the fraction of the larger rectangle.
        return intersection(a,b)/Math.max(1,area(b))>.8&&Math.max(length,other)/Math.max(1,Math.min(length,other))<2.2;
      });
      return {box,sameLine,coverage:intersection(a,box.bbox)/Math.max(1,area(a))};
    }).filter(h=>h.coverage>.18||h.sameLine);
    if(hits.filter(h=>h.coverage>.2||h.sameLine).length>1){conflicts.push({...line,discoveryStatus:'spans-existing-units'});continue;}
    if(hits.some(h=>h.coverage>=.6||h.sameLine)){covered.push({...line,discoveryStatus:'supports-ctd'});continue;}
    uncovered.push(line);
  }
  const groups=[...groupLines(uncovered.filter(l=>l.orientation!=='vertical')),...groupLines(uncovered.filter(l=>l.orientation==='vertical'),true)];
  const supplemental=groups.map((g,i)=>({...g,detectedLanguage:'unknown',kind:'unboxed',lineOnly:true,discoveryOnly:true,
    containerId:'paddle-'+i,observedBy:['paddle-text-detector'],reviewRequired:true,discoveryStatus:'new-proposal'}));
  return {...ctd,boxes:[...ctd.boxes,...supplemental].sort((a,b)=>a.bbox.y0-b.bbox.y0||b.bbox.x0-a.bbox.x0),
    supplemental,discovery:{engine:'PP-OCRv5_server_det',observations,covered,conflicts,proposals:supplemental}};
}
async function discoverText(input,backend,{signal,sourceScale=1,onScan,detail=true}={}){
  const ctd=await detectText(input,{signal,sourceScale,detail,onScan}),observations=[];
  // A full-page pass supplies context. Detail crops preserve small glyphs.
  // Process the same plan for both models so neither depends on CTD boxes.
  for(const [index,tile]of ctd.tiles.entries()){
    const {left,top,width,height}=tile;
    let image=await sharp(input).rotate().extract({left,top,width,height}).png().toBuffer();
    // Undo user-requested OCR enlargement for discovery; positions are mapped
    // back to the prepared image and then by the Lab to source pixels.
    if(sourceScale!==1)image=await sharp(image).resize(Math.round(width/sourceScale),Math.round(height/sourceScale)).png().toBuffer();
    for(const variant of ['original','clahe']){
      if(signal?.aborted)throw Error('ยกเลิก OCR');
      onScan?.({index:index*2+(variant==='original'?1:2),total:ctd.tiles.length*2,engine:'Paddle',variant});
      const read=await backend.detect(image,{variant,signal});
      for(const l of read.lines){
        const a=l.bbox,bbox={x0:Math.max(0,left+a.x0*sourceScale),y0:Math.max(0,top+a.y0*sourceScale),x1:Math.min(ctd.width,left+a.x1*sourceScale),y1:Math.min(ctd.height,top+a.y1*sourceScale)};
        if(bbox.x1-bbox.x0<3*sourceScale||bbox.y1-bbox.y0<3*sourceScale)continue;
        const clipped=(top>0&&a.y0<8)||(top+height<ctd.height&&a.y1>height/sourceScale-8)||(left>0&&a.x0<8)||(left+width<ctd.width&&a.x1>width/sourceScale-8);
        observations.push({...l,bbox,coreBbox:{...bbox},polygon:l.polygon?.map(([x,y])=>[left+x*sourceScale,top+y*sourceScale]),
          orientation:bbox.y1-bbox.y0>(bbox.x1-bbox.x0)*1.8?'vertical':'horizontal',variant,tileIndex:index,scanType:tile.scanType,tileClipped:clipped});
      }
    }
  }
  return reconcileDiscovery(ctd,observations);
}
module.exports={discoverText,reconcileDiscovery};
