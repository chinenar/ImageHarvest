'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {EnhancedMangaOcrPool}=require('../src/enhanced-manga-ocr.cjs');
const {LocalOcrBackend}=require('../src/ocr-backend.cjs');
const {evaluateRegions}=require('../src/ocr-review.cjs');
(async()=>{
 const phase=process.argv.includes('--gpu')?'gpu':process.argv.includes('--before')?'before':'after',out=path.resolve('test-results/ocr-speed');await fs.mkdir(out,{recursive:true});
 const reference=JSON.parse(await fs.readFile('test-results/ocr-advanced/reference.json','utf8'));
 const only=process.argv.indexOf('--only'),pages=reference.pages.filter(p=>only<0||p.id===process.argv[only+1]);
 const backend=new LocalOcrBackend(),request=backend.request.bind(backend),calls=[];
 backend.request=async(data,opts)=>{const at=performance.now();try{return await request(data,opts);}finally{calls.push({op:data.op||data.engine,engine:data.engine,language:data.language,variant:data.variant,batchSize:data.items?.length,ms:Math.round(performance.now()-at)});}};
 const sourceHashes=Object.fromEntries(await Promise.all(['enhanced-manga-ocr.cjs','ocr-backend.cjs','ocr-backend.py','ocr-discovery.cjs'].map(async f=>[f,crypto.createHash('sha256').update(await fs.readFile(path.join('src',f))).digest('hex')])));
 const reports=[];try{
  const workerStarted=performance.now(),status=await backend.status(),startupMs=Math.round(performance.now()-workerStarted);await fs.writeFile(path.join(out,phase+'-started.json'),JSON.stringify({sourceHashes,status,startupMs}));
  const repetitions=process.argv.includes('--warm')?2:1;
  for(const [index,p] of Array.from({length:repetitions},()=>pages).flat().entries()){
   const round=Math.floor(index/pages.length)+1;
   calls.length=0;const start=performance.now(),pool=new EnhancedMangaOcrPool({backend,langPath:path.resolve('assets/tessdata'),languages:[{ja:'jpn',en:'eng',th:'tha'}[p.language]],concurrency:1});
   let result;try{[result]=await pool.recognizePages([{filePath:p.source}],{onRegion:r=>{if(r.index===1||r.index===r.total)console.log(p.id,r.phase||r.engine,r.index+'/'+r.total);}});}finally{await pool.close();}
   if(result.error)throw Error(result.error);
   const old=JSON.parse(await fs.readFile(path.join('test-results/ocr-advanced/final',p.id+'-result.json'),'utf8'));
   const report={id:p.id,round,wallMs:Math.round(performance.now()-start),ms:result.ms,metrics:evaluateRegions(result.regions,p.truth,{complete:p.complete}),calls,performance:result.performance,
     oldResults:old.regions.map(r=>({text:r.text,bbox:r.bbox})),newResults:result.regions.map(r=>({text:r.text,bbox:r.bbox}))};
   reports.push(structuredClone(report));await fs.writeFile(path.join(out,phase+'-'+(round>1?'warm-':'')+p.id+'.json'),JSON.stringify(result,null,2));await fs.writeFile(path.join(out,phase+'.json'),JSON.stringify({phase,sourceHashes,appVersion:require('../package.json').version,reports},null,2));
   console.log('RESULT',p.id,report.wallMs,'ms',report.metrics.matched+'/'+report.metrics.expected,'matched');
  }
 }finally{backend.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
