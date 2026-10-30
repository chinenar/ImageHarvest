'use strict';
const fs=require('node:fs/promises');
const {LocalOcrBackend}=require('../src/ocr-backend.cjs');
const {planReadingPage}=require('../src/reader-quality.cjs');
async function main(){
 const backend=new LocalOcrBackend(),reports=[];
 try{for(const id of ['alright','connected','status-and-effect']){
  const source=JSON.parse(await fs.readFile(`test-results/ocr-accuracy/after-1.6.76/${id}.json`,'utf8'));
  const rows=[...source.result.regions,...source.result.rejectedRegions.filter(r=>r.recognitionLines?.length)].map((r,i)=>({...r,id:'review-'+i}));
  const result=await planReadingPage(backend,await fs.readFile(source.source),rows);
  reports.push({id,source:source.source,candidates:result.regions.filter(r=>r.effectCandidate).map(r=>({text:r.text,bbox:r.bbox,evidence:r.effectCandidate,previouslyRejected:Boolean(r.rejectionReason)})),bubbleCount:result.regions.filter(r=>r.placement.surfaceValidated).length});
 }
 await fs.writeFile('test-results/ocr-accuracy/effect-candidates.json',JSON.stringify(reports,null,2));console.log(JSON.stringify(reports));
 }finally{backend.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
