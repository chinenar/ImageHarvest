'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawn,spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),out=path.join(root,'test-results/full-audit-1.6.95');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const state=s=>fs.writeFileSync(path.join(out,'run-status.json'),JSON.stringify({...s,updatedAt:new Date().toISOString()},null,2));
async function main(){
 for(;;){
  const summary=JSON.parse(fs.readFileSync(path.join(out,'corpus/summary.json'),'utf8'));
  state({phase:'corpus',completed:summary.completed,total:589});
  console.log('Corpus',summary.completed,'/',589,'failed',summary.failed);
  spawnSync(process.execPath,['scripts/score-full-ocr-audit.cjs'],{cwd:root,windowsHide:true,stdio:'ignore'});
  if(summary.state==='fatal-error')throw Error('Corpus stopped unexpectedly; inspect its log');
  if(summary.state==='complete')break;
  await pause(55000);
 }
 await pause(5000); // Let the finished corpus close its owned model workers.
 state({phase:'regressions'});
 const code=await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['scripts/run-ocr-regression-audit.cjs'],{cwd:root,windowsHide:true,stdio:'inherit'});
  child.on('error',reject);child.on('exit',resolve);
 });
 spawnSync(process.execPath,['scripts/score-full-ocr-audit.cjs'],{cwd:root,windowsHide:true,stdio:'inherit'});
 state({phase:'complete',regressionExitCode:code});process.exitCode=code||0;
}
main().catch(error=>{state({phase:'failed',error:error.message});console.error(error);process.exitCode=1;});
