'use strict';
// Run only after the all-image inference job releases the local GPU.
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const {implementationFingerprint}=require('./ocr-corpus-inventory.cjs');
const root=path.resolve(__dirname,'..'),out=path.join(root,'test-results/full-audit-1.6.95/regressions');
const jobs=[
 ['annotated-detection',['scripts/benchmark-ocr-detection.cjs','--phase','full-audit-1-6-95']],
 ['development-excerpts',['scripts/benchmark-ocr-accuracy.cjs','--phase=full-audit-1-6-95']],
 ['advanced-pages',['scripts/benchmark-ocr-advanced.cjs','--final']],
 ['recognition-crops',['scripts/compare-ocr-engines.cjs']],
 ['cleanup-masks',['scripts/benchmark-reader-pipeline.cjs']],
 ['cleanup-render',['scripts/render-reader-pipeline.cjs']],
 ['cleanup-report',['scripts/report-reader-pipeline.cjs']],
 ['live-translation-render',['scripts/check-reader-live.cjs']],
 ['cold-warm-speed',['scripts/benchmark-ocr-speed.cjs','--warm']],
];
async function main(){
 fs.mkdirSync(out,{recursive:true});
 const summary={version:require('../package.json').version,startedAt:new Date().toISOString(),scope:'Fresh regression runs; crop and partial-page references do not establish full-corpus accuracy.',fingerprint:await implementationFingerprint(path.join(root,'src')),jobs:[]};
 const save=()=>fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(summary,null,2));save();
 for(const [id,args] of jobs){
  if((id==='cleanup-render'&&summary.jobs.find(j=>j.id==='cleanup-masks')?.exitCode!==0)||
     (id==='cleanup-report'&&summary.jobs.find(j=>j.id==='cleanup-render')?.exitCode!==0)){
   summary.jobs.push({id,args,exitCode:null,skipped:true,error:'Upstream cleanup stage failed; do not render stale artifacts'});save();continue;
  }
  const log=path.join(out,id+'.log'),stream=fs.createWriteStream(log),started=Date.now();
  console.log('START',id);
  const env={...process.env};delete env.READER_REUSE_OCR;
  const result=await new Promise(resolve=>{
   const child=spawn(process.execPath,args,{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
   child.stdout.pipe(stream,{end:false});child.stderr.pipe(stream,{end:false});
   child.on('error',error=>resolve({exitCode:null,error:error.message}));
   child.on('close',(exitCode,signal)=>resolve({exitCode,signal}));
  });
  await new Promise(resolve=>stream.end(resolve));
  summary.jobs.push({id,args,log,ms:Date.now()-started,...result});save();console.log('DONE',id,result.exitCode);
 }
 summary.finishedAt=new Date().toISOString();summary.finalFingerprint=await implementationFingerprint(path.join(root,'src'));
 summary.sourceChanged=summary.fingerprint.implementationDigest!==summary.finalFingerprint.implementationDigest;save();
 process.exitCode=summary.jobs.some(j=>j.exitCode!==0)||summary.sourceChanged?1:0;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
