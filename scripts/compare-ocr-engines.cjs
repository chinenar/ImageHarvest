'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),sharp=require('sharp');
const {MangaOcrPool}=require('../src/manga-ocr.cjs'),{LocalOcrBackend}=require('../src/ocr-backend.cjs');
const {editDistance}=require('../src/ocr-review.cjs');
const {postprocessReading,chooseReadings}=require('../src/enhanced-manga-ocr.cjs');
const crypto=require('node:crypto');
const clean=text=>String(text||'').normalize('NFC').replace(/\u0e4d\u0e32/g,'\u0e33').replace(/\s+/gu,'');
async function main(){
 const root=path.resolve('test-results/engine-comparison'),reference=JSON.parse(await fs.readFile(path.join(root,'reference.json'),'utf8'));
 const backend=new LocalOcrBackend(),pools=new Map(),results=[];
 const cached=process.argv.includes('--reuse-reads')?JSON.parse(await fs.readFile(path.join(root,'results.json'),'utf8')).cases:[];
 const language={en:'eng',fr:'fra',ja:'jpn',th:'tha'};
 try{
  const versions=await backend.status();
  for(const c of reference.cases){
   if(!c.verified)continue;
   const file=path.join(root,c.file),buffer=await fs.readFile(file),meta=await sharp(buffer).metadata();
   if(crypto.createHash('sha256').update(buffer).digest('hex')!==c.cropDigest)throw Error('Reference crop changed: '+c.id);
   if(!pools.has(c.language))pools.set(c.language,new MangaOcrPool({langPath:path.resolve('assets/tessdata'),languages:[language[c.language]],concurrency:1}));
   const [base]=await pools.get(c.language).recognizePages([{filePath:file}],{mode:c.language==='ja'&&meta.height>meta.width?'vertical':'horizontal',rectangle:{left:0,top:0,width:meta.width,height:meta.height}});
   const crop=await sharp(buffer).resize({width:Math.round(Math.min(1000,meta.width*(c.language==='th'?1.5:2)))}).extend({top:12,bottom:12,left:12,right:12,background:'#fff'}).png().toBuffer();
   const alternatives=[];
   const old=c.language==='th'?null:cached.find(row=>row.id===c.id&&row.cropDigest===c.cropDigest);
   for(const variant of c.language==='ja'?['original']:['original','contrast','invert']){
    if(old){alternatives.push(old.alternatives.find(r=>r.variant===variant));continue;}
    try{alternatives.push(await backend.read(crop,{engine:c.language==='ja'?'manga':'paddle',language:c.language==='ja'?'japan':c.language,variant}));}
    catch(e){alternatives.push({variant,error:e.message,text:''});}
   }
   const score=text=>({edits:editDistance(text,c.text),chars:Array.from(clean(c.text)).length,exact:clean(text)===clean(c.text)});
   const baseline={text:base.text,confidence:base.regions[0]?.confidence||0,engine:'tesseract.js',error:base.error,...score(base.text)};
   const processed=alternatives.map(postprocessReading);
   const selected=chooseReadings(processed,baseline,{allowBaseline:c.language!=='th'});
   const row={...c,baseline,alternatives:alternatives.map(r=>({...r,...score(r.text)})),processedAlternatives:processed.map(r=>({...r,...score(r.text)})),selected:{...selected,...score(selected.text)}};
   results.push(row);await fs.writeFile(path.join(root,'results.json'),JSON.stringify({versions,scope:reference.scope,cases:results},null,2));
   console.log(`${results.length}/${reference.cases.length} ${c.id}: baseline edits ${row.baseline.edits}, new ${row.alternatives.map(r=>r.error?'ERROR':r.edits).join('/')}`);
  }
 }finally{backend.close();await Promise.allSettled([...pools.values()].map(p=>p.close()));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
