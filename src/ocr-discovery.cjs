'use strict';
const sharp=require('sharp');
const {detectText,groupLines,mergeLineObservations}=require('./comic-text-detector.cjs');
const {intersection,area}=require('./ocr-review.cjs');
const {refineVerticalGeometry}=require('./ocr-vertical-geometry.cjs');

function reconcileDiscovery(ctd,observations){
  ctd=refineVerticalGeometry(ctd,observations);
  const uncovered=[],covered=[],conflicts=[];
  let boxes=ctd.boxes;
  for(let line of mergeLineObservations(observations)){
    // A short glyph above/below a long vertical dash may look horizontal in
    // isolation. Only an enclosing learned vertical block and a neighboring
    // complete column establish its direction, not aspect ratio alone.
    if(line.orientation!=='vertical'){
      const a=line.coreBbox||line.bbox;
      const owner=boxes.find(box=>box.orientation==='vertical'&&box.containerBBox&&
        intersection(a,box.containerBBox)/Math.max(1,area(a))>.8&&
        a.x1-a.x0<=(a.y1-a.y0)*1.4&&(box.lines||[]).some(l=>{
          const b=l.coreBbox||l.bbox,w=b.x1-b.x0;
          return l.orientation==='vertical'&&b.y1-b.y0>w*4&&a.x1-a.x0<=w*2.2&&
            Math.abs((a.x0+a.x1-b.x0-b.x1)/2)>w*.75;
        }));
      if(owner)line={...line,orientation:'vertical',directionEvidence:'enclosing-vertical-block'};
    }
    const a=line.coreBbox||line.bbox;
    const hits=boxes.map(box=>{
      const sameLine=(box.lines||[]).some(l=>{
        const b=l.coreBbox||l.bbox,axis=l.orientation==='vertical'?'y':'x',length=a[axis+'1']-a[axis+'0'],other=b[axis+'1']-b[axis+'0'];
        if(l.orientation==='vertical'){
          const across=Math.max(0,Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0))/Math.max(1,Math.min(a.x1-a.x0,b.x1-b.x0));
          const along=Math.max(0,Math.min(a.y1,b.y1)-Math.max(a.y0,b.y0))/Math.max(1,Math.min(a.y1-a.y0,b.y1-b.y0));
          if(across>.7&&along>.8&&Math.max(a.x1-a.x0,b.x1-b.x0)/Math.max(1,Math.min(a.x1-a.x0,b.x1-b.x0))<2)return true;
        }
        // Paddle polygons include more padding than CTD's glyph map. Match
        // the actual line, not just the fraction of the larger rectangle.
        return intersection(a,b)/Math.max(1,area(b))>.8&&Math.max(length,other)/Math.max(1,Math.min(length,other))<3;
      });
      const container=box.containerBBox;
      const missingLine=container&&intersection(a,container)/Math.max(1,Math.min(area(a),area(container)))>.8&&(box.lines||[]).some(l=>{
        if(l.orientation!==line.orientation)return false;
        const b=l.coreBbox||l.bbox,vertical=line.orientation==='vertical',axis=vertical?'y':'x',cross=vertical?'x':'y';
        const overlap=Math.max(0,Math.min(a[axis+'1'],b[axis+'1'])-Math.max(a[axis+'0'],b[axis+'0']))/Math.max(1,Math.min(a[axis+'1']-a[axis+'0'],b[axis+'1']-b[axis+'0']));
        const gap=Math.max(0,a[cross+'0']-b[cross+'1'],b[cross+'0']-a[cross+'1']);
        return overlap>.3&&gap<=Math.min(a[cross+'1']-a[cross+'0'],b[cross+'1']-b[cross+'0'])*.9;
      });
      return {box,sameLine,missingLine,coverage:intersection(a,box.bbox)/Math.max(1,area(a))};
    }).filter(h=>h.coverage>.18||h.sameLine||h.missingLine);
    const strong=hits.filter(h=>h.coverage>.2||h.sameLine||h.missingLine);
    // One independently detected line can span CTD fragments of the SAME
    // container (e.g. "...A" + "LRIGHT."). It cannot join different bubbles.
    if(strong.length>1){
      const parent=strong[0].box.containerId;
      const sameParent=parent&&strong.every(h=>h.box.containerId===parent&&h.box.orientation===line.orientation);
      const coversFragments=strong.every(h=>h.box.lines?.length===1&&h.box.lines.every(l=>intersection(a,l.coreBbox||l.bbox)/Math.max(1,area(l.coreBbox||l.bbox))>.7));
      if(!sameParent||!coversFragments){conflicts.push({...line,discoveryStatus:'spans-existing-units'});continue;}
      const members=strong.map(h=>h.box),first=members[0];
      const joined={...first,lines:[...new Set(members.flatMap(b=>b.lines||[]))],
        bbox:bounds([...members.map(b=>b.bbox),a]),discoveryLines:[...members.flatMap(b=>b.discoveryLines||[]),line],
        groupingReason:'independent-line-spans-same-container'};
      boxes=boxes.filter(b=>!members.includes(b));boxes.push(joined);
      covered.push({...line,discoveryStatus:'repairs-fragmented-line'});continue;
    }
    const supported=hits.find(h=>h.coverage>=.6||h.sameLine||h.missingLine);
    if(supported){
      const target=supported.box;
      // Restore slanted strokes omitted by the CTD core map. Do not use
      // paragraph-container padding that can swallow a neighboring speaker.
      const collision=boxes.some(b=>b!==target&&(b.lines||[]).some(l=>intersection(a,l.coreBbox||l.bbox)/Math.max(1,area(l.coreBbox||l.bbox))>.25));
      if(!collision){
        const ext=bounds([target.bbox,a]),old=target.bbox;
        const thickness=(target.lines||[]).map(l=>{const c=l.coreBbox||l.bbox;return l.orientation==='vertical'?c.x1-c.x0:c.y1-c.y0;}).sort((x,y)=>x-y);
        const overflow=Math.max(old.x0-ext.x0,old.y0-ext.y0,ext.x1-old.x1,ext.y1-old.y1);
        // Detector polygons have generous padding. Expanding every valid crop
        // changes Manga OCR context and can introduce punctuation from a rim.
        // Repair missing strokes/lines when expansion exceeds a glyph core.
        const repair=overflow>(thickness[Math.floor(thickness.length/2)]||0)||supported.missingLine&&!supported.sameLine;
        const updated={...target,bbox:repair?ext:old,discoveryLines:[...(target.discoveryLines||[]),line],...(repair?{localizationRefinement:'independent-line-coverage'}:{})};
        boxes=boxes.map(b=>b===target?updated:b);
      }
      covered.push({...line,discoveryStatus:collision?'supports-ctd-with-conflict':'supports-ctd'});continue;
    }
    uncovered.push(line);
  }
  // Repeated tall-glyph proposals are one display line, not a paragraph
  // neighbor of the overlapping action lettering below the balloon.
  const groups=[...groupLines(uncovered.filter(l=>!l.displayFont&&l.orientation!=='vertical')),...groupLines(uncovered.filter(l=>!l.displayFont&&l.orientation==='vertical'),true),...groupLines(uncovered.filter(l=>l.displayFont&&l.orientation!=='vertical')),...groupLines(uncovered.filter(l=>l.displayFont&&l.orientation==='vertical'),true)];
  const supplemental=groups.map((g,i)=>({...g,detectedLanguage:'unknown',kind:'unboxed',lineOnly:true,discoveryOnly:true,
    containerId:'paddle-'+i,displayFont:g.lines.some(l=>l.displayFont),observedBy:g.lines.some(l=>l.displayFont)?['glyph-components']:['paddle-text-detector'],reviewRequired:true,discoveryStatus:'new-proposal'}));
  return {...ctd,boxes:[...boxes,...supplemental].sort((a,b)=>a.bbox.y0-b.bbox.y0||b.bbox.x0-a.bbox.x0),
    supplemental,discovery:{engine:'PP-OCRv5_server_det',observations,covered,conflicts,proposals:supplemental}};
}
function bounds(boxes){return {x0:Math.min(...boxes.map(b=>b.x0)),y0:Math.min(...boxes.map(b=>b.y0)),x1:Math.max(...boxes.map(b=>b.x1)),y1:Math.max(...boxes.map(b=>b.y1))};}
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
