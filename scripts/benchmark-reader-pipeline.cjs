'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const sharp=require('sharp');
const {detectTile}=require('../src/comic-text-detector.cjs');
const {LocalOcrBackend,runtimeRoot}=require('../src/ocr-backend.cjs');
const reference=require('../test/fixtures/reader-pipeline-reference.json');
const root=path.resolve('test-results/reader-pipeline');
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
async function main(){
 fs.mkdirSync(root,{recursive:true});const inputs=[],backend=new LocalOcrBackend();
 try{for(const fixture of reference.cases){
  const saved=JSON.parse(fs.readFileSync(fixture.ocr)),source=fs.readFileSync(saved.source),[left,top,width,height]=fixture.crop;
  if(sha(source)!==saved.sourceHash)throw Error('Reference source changed: '+fixture.id);
  if(saved.parameterFreeze&&sha(fs.readFileSync('scripts/reader_mask_candidates.py'))!==saved.parameterFreeze.candidateHash)throw Error('Frozen validation parameters changed: '+fixture.id);
  const folder=path.join(root,fixture.id);fs.mkdirSync(folder,{recursive:true});
  const crop=await sharp(source).extract({left,top,width,height}).png().toBuffer();fs.writeFileSync(path.join(folder,'source.png'),crop);
  const started=performance.now(),layout=await backend.layoutSafe(source,saved.observations,{includeSplitHints:false});
  const layoutMs=performance.now()-started;
  const selected=fixture.regionIds.map(id=>{const original=saved.observations.find(r=>r.id===id),p=layout.regions.find(r=>r.id===id)?.placement;if(!original||!p)throw Error('Missing fixture region '+id);return {...original,placement:p};});
  const raw=Buffer.alloc(width*height),applied=Buffer.alloc(width*height),allow=Buffer.alloc(width*height);
  for(const r of selected){
   const b=r.bbox;
   for(let y=Math.max(0,Math.floor(b.y0-top)-2);y<Math.min(height,Math.ceil(b.y1-top)+2);y++)for(let x=Math.max(0,Math.floor(b.x0-left)-2);x<Math.min(width,Math.ceil(b.x1-left)+2);x++)allow[y*width+x]=255;
   const patch=r.placement.erasePatch;if(!patch)continue;
   const v=await sharp(Buffer.from(patch.png,'base64')).ensureAlpha().raw().toBuffer({resolveWithObject:true});
   for(let y=0;y<v.info.height;y++)for(let x=0;x<v.info.width;x++){
    const xx=x+patch.bbox.x0-left,yy=y+patch.bbox.y0-top;if(xx<0||yy<0||xx>=width||yy>=height)continue;
    const alpha=v.data[(y*v.info.width+x)*4+3];raw[yy*width+xx]=Math.max(raw[yy*width+xx],alpha);
    if(r.placement.paintMode!=='none')applied[yy*width+xx]=Math.max(applied[yy*width+xx],alpha);
   }
  }
  // Fixed threshold for every case. Annotations are not read by the detector.
  const learned=await detectTile(crop,{includeSegmentation:true,upscale:true});
  fs.writeFileSync(path.join(folder,'probability.png'),learned.segmentation);
  await sharp(allow,{raw:{width,height,channels:1}}).png().toFile(path.join(folder,'allowed.png'));
  const probability=await sharp(learned.segmentation).greyscale().raw().toBuffer(),mask=Buffer.alloc(width*height);
  for(let i=0;i<mask.length;i++)if(allow[i]&&probability[i]>=128)mask[i]=255;
  for(const [name,data]of [['current-proposal',raw],['current-applied',applied],['segmentation',mask]])await sharp(data,{raw:{width,height,channels:1}}).png().toFile(path.join(folder,name+'-mask.png'));
  const regions=selected.map((r,i)=>({id:r.id,text:r.text,translation:fixture.translations[i],bbox:r.bbox,placement:r.placement}));
  fs.writeFileSync(path.join(folder,'regions.json'),JSON.stringify(regions));
  const shift=b=>({x0:b.x0-left,y0:b.y0-top,x1:b.x1-left,y1:b.y1-top});
  fs.writeFileSync(path.join(folder,'reading-lines.json'),JSON.stringify(selected.flatMap(r=>(r.recognitionLines?.length?r.recognitionLines:[{bbox:r.bbox,text:r.text,supportGranularity:'region'}]).map(l=>({...l,bbox:shift(l.bbox),...(l.polygon?{polygon:l.polygon.map(([x,y])=>[x-left,y-top])}:{})})))));
  const normalize=s=>s.replace(/\s+/g,' ').trim();
  const cachedOcrExactMatches=selected.filter((r,i)=>normalize(r.text)===normalize(fixture.expectedTexts[i])).length;
  inputs.push({...fixture,width,height,sourceHash:sha(source),cropHash:sha(crop),layoutMs,segmentationMs:learned.ms,cachedOcrExactMatches,blockedRegions:selected.filter(r=>r.placement.paintMode==='none').length,totalRegions:selected.length});
  console.log(fixture.id,{layoutMs:Math.round(layoutMs),segmentationMs:learned.ms,blocked:inputs.at(-1).blockedRegions});
 }}finally{backend.close();}
 fs.writeFileSync(path.join(root,'inputs.json'),JSON.stringify(inputs,null,2));
 execFileSync(path.join(runtimeRoot(),'Scripts/python.exe'),['scripts/reader-pipeline-metrics.py',root],{stdio:'inherit'});
 fs.writeFileSync(path.join(root,'provenance.json'),JSON.stringify({at:new Date().toISOString(),version:require('../package.json').version,scope:reference.scope,threshold:128,
  hashes:Object.fromEntries(['src/comic-text-detector.cjs','src/reader_surface.py','src/translation-overlay.cjs','scripts/reader-pipeline-metrics.py','scripts/reader_mask_candidates.py','scripts/reader_cleanup_candidates.py','test/fixtures/reader-pipeline-reference.json','assets/models/comic-text-detector.onnx',...reference.cases.map(c=>c.ocr)].map(p=>[p,sha(fs.readFileSync(p))]))},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
