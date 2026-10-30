'use strict';
const fs=require('node:fs/promises'),assert=require('node:assert/strict');
const {LocalOcrBackend}=require('../src/ocr-backend.cjs');
const {planReadingPage,observation}=require('../src/reader-quality.cjs');
async function main(){
 const saved=JSON.parse(await fs.readFile('test-results/ocr-accuracy/cache-page-enabled.json','utf8'));
 const image=await fs.readFile(saved.source),backend=new LocalOcrBackend(),rounds=[];
 try{
  // Warm imports and source processing before alternating the two paths.
  await planReadingPage(backend,image,saved.result.regions);
  for(let i=0;i<4;i++){
   const results={};
   for(const mode of i%2?['current','previous']:['previous','current']){
    const at=performance.now();
    if(mode==='previous')await backend.layoutSafe(image,saved.result.regions.map(observation));
    const result=await planReadingPage(backend,image,saved.result.regions);
    results[mode]={ms:Math.round(performance.now()-at),result};
   }
   assert.deepEqual(results.previous.result.regions,results.current.result.regions);
   rounds.push({previousMs:results.previous.ms,currentMs:results.current.ms,identical:true});
  }
  const report={scope:'Placement only, refinement disabled, 18 existing OCR regions on one real manga page. No OCR or translation-provider time. Previous path reconstructed by its unused preliminary surface pass.',source:saved.source,rounds};
  await fs.writeFile('test-results/ocr-accuracy/layout-speed.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }finally{backend.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
