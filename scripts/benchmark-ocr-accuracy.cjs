'use strict';
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const sharp = require('sharp');
const {EnhancedMangaOcrPool} = require('../src/enhanced-manga-ocr.cjs');
const {LocalOcrBackend} = require('../src/ocr-backend.cjs');
const {editDistance, intersection, area} = require('../src/ocr-review.cjs');
const box = a => ({x0:a[0],y0:a[1],x1:a[2],y1:a[3]});
const lexical = s => String(s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
function metrics(rows, c) {
  const active=rows.filter(r=>r.text?.trim()&&!['sfx','non-text'].includes(r.contentRole?.role));
  const hits=c.units.map(u=>active.filter(r=>intersection(r.bbox,box(u.box))/Math.max(1,Math.min(area(r.bbox),area(box(u.box))))>.35));
  const units=c.units.map((u,i)=>{
    const expected=lexical(u.text)||u.text, candidates=hits[i];
    const best=[...candidates].sort((a,b)=>editDistance(lexical(a.text)||a.text,expected)-editDistance(lexical(b.text)||b.text,expected))[0];
    const exactTranscription=Boolean(best&&best.text.normalize('NFKC').toLowerCase().replace(/\s/gu,'')===u.text.normalize('NFKC').toLowerCase().replace(/\s/gu,''));
    return {expected:u.text,actual:best?.text||'',matches:candidates.length,exact:Boolean(best&&(lexical(best.text)||best.text)===expected),exactTranscription,cer:editDistance(lexical(best?.text||'')||best?.text||'',expected)/Math.max(1,Array.from(expected).length)};
  });
  return {units,exact:units.filter(u=>u.exact&&u.matches===1).length,expected:units.length,missed:units.filter(u=>!u.matches).length,splitOrDuplicate:units.filter(u=>u.matches>1).length,
    crossUnit:active.filter(r=>c.units.filter(u=>intersection(r.bbox,box(u.box))/Math.max(1,area(box(u.box)))>.25).length>1).length,
    negativeDetections:active.filter(r=>(c.negative||[]).some(b=>intersection(r.bbox,box(b))/Math.max(1,area(r.bbox))>.6)).map(r=>({text:r.text,bbox:r.bbox})),
    meanCer:units.reduce((s,u)=>s+u.cer,0)/Math.max(1,units.length)};
}
async function main(){
  const phase=process.argv.find(a=>a.startsWith('--phase='))?.slice(8)||'before';
  const only=process.argv.find(a=>a.startsWith('--case='))?.slice(7).split(',');
  const full=process.argv.includes('--full'), cache=new Map();
  const ref=JSON.parse(await fs.readFile('test/fixtures/ocr-accuracy-reference.json','utf8'));
  const manifest=JSON.parse(await fs.readFile('test-results/manga-corpus/manifest.json','utf8'));
  const root=path.resolve('test-results/ocr-accuracy');await fs.mkdir(root,{recursive:true});
  const out=path.join(root,phase);await fs.mkdir(out,{recursive:true});
  const backend=new LocalOcrBackend();const pools=new Map();let previousLanguage;
  const sourceHashes={};
  for(const file of ['comic-text-detector.cjs','ocr-discovery.cjs','enhanced-manga-ocr.cjs','ocr-backend.py','reading-units.cjs','ocr-punctuation.cjs','ocr-reading-ownership.cjs'])sourceHashes[file]=crypto.createHash('sha256').update(await fs.readFile(path.join('src',file))).digest('hex');
  try{
    await fs.writeFile(path.join(out,'runtime.json'),JSON.stringify(await backend.status(),null,2));
    for(const c of ref.cases.filter(c=>!only||only.includes(c.id))){
      if(previousLanguage&&previousLanguage!==c.language){for(const pool of pools.values())await pool.close();pools.clear();backend.close();}
      previousLanguage=c.language;
      const source=c.fixture||manifest.cases.find(p=>p.id===c.sourceCase)?.file;
      let image=sharp(source);if(c.crop&&!full){const [left,top,width,height]=c.crop;image=image.extract({left,top,width,height});}
      const input=await image.png().toBuffer(), file=path.join(root,c.id+'.png');await fs.writeFile(file,input);
      const options={backend,langPath:path.resolve('assets/tessdata'),languages:[c.language==='ja'?'jpn':'eng'],recognitionLanguage:c.language,concurrency:1};
      if(!pools.has(c.language))pools.set(c.language,new EnhancedMangaOcrPool(options));
      console.log(phase,c.id,'start');const start=Date.now();
      const key=source+'|'+c.language;
      let result;
      if(full&&cache.has(key))result=cache.get(key);
      else { [result]=await pools.get(c.language).recognizePages([{filePath:file}]); if(full)cache.set(key,result); }
      if(result.error)throw Error(c.id+': '+result.error);
      const elapsed=Date.now()-start,oracle=[];
      const shift=a=>[a[0]+(c.crop?.[0]||0),a[1]+(c.crop?.[1]||0),a[2]+(c.crop?.[0]||0),a[3]+(c.crop?.[1]||0)];
      const reference=full?{...c,units:c.units.map(u=>({...u,box:shift(u.box)})),negative:c.negative.map(shift)}:c;
      // The reference crop is never fed into the page pipeline. It isolates recognition.
      if(phase==='before'||process.argv.includes('--oracle'))for(const u of reference.units){
        const [x0,y0,x1,y1]=u.box;
        const crop=await sharp(input).extract({left:x0,top:y0,width:x1-x0,height:y1-y0}).resize({width:Math.min(1000,(x1-x0)*2)}).extend({top:12,bottom:12,left:12,right:12,background:'#fff'}).png().toBuffer();
        oracle.push({expected:u.text,read:await backend.read(crop,{engine:c.language==='ja'?'manga':'paddle',language:c.language==='ja'?'japan':'en'})});
      }
      const data={id:c.id,source,crop:c.crop,full,reference,sourceHashes,digest:crypto.createHash('sha256').update(input).digest('hex'),ms:elapsed,metrics:metrics(result.regions,reference),oracle,result};
      await fs.writeFile(path.join(out,c.id+'.json'),JSON.stringify(data,null,2));
      console.log(c.id,elapsed+'ms',JSON.stringify(data.metrics));
    }
  }finally{for(const p of pools.values())await p.close();backend.close();}
}
module.exports={metrics};
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
