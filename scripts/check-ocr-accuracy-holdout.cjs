'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const baseline=process.argv.includes('--baseline');
const sourceRoot=baseline?'../test-results/ocr-accuracy/baseline-app/src/':'../src/';
const {EnhancedMangaOcrPool}=require(sourceRoot+'enhanced-manga-ocr.cjs');
const {LocalOcrBackend}=require(sourceRoot+'ocr-backend.cjs');
const {evaluateRegions}=require('../src/ocr-review.cjs');
async function main(){
 const ref=JSON.parse(await fs.readFile('test-results/ocr-advanced/reference.json','utf8'));
 const chinese=JSON.parse(await fs.readFile('test-results/manga-corpus/case-16.json','utf8'));
 const plant=JSON.parse(await fs.readFile('test-results/manga-corpus/case-22.json','utf8'));
 const pages=[...ref.pages,{id:'zh-vertical-page',language:'zh',source:chinese.file,truth:[],complete:false},{id:'angled-dialogue-page',language:'en',source:plant.file,truth:[],complete:false}];
 const only=process.argv.find(a=>a.startsWith('--case='))?.slice(7).split(',');
 const root='test-results/ocr-accuracy/holdout'+(baseline?'-before':'');await fs.mkdir(root,{recursive:true});
 const backend=new LocalOcrBackend(),reports=[];
 try{for(const p of pages){
  if(only&&!only.includes(p.id))continue;
  const pool=new EnhancedMangaOcrPool({backend,langPath:path.resolve('assets/tessdata'),languages:[{en:'eng',ja:'jpn',th:'tha',zh:'jpn'}[p.language]],recognitionLanguage:p.language,concurrency:1});
  console.log(p.id,'start');let result;
  try{[result]=await pool.recognizePages([{filePath:p.source}]);}finally{await pool.close();backend.close();}
  if(result.error)throw Error(result.error);
  const metrics=p.truth.length?evaluateRegions(result.regions,p.truth,{complete:p.complete}):null;
  const report={id:p.id,source:p.source,ms:result.ms,metrics,result};
  await fs.writeFile(path.join(root,p.id+'.json'),JSON.stringify(report,null,2));reports.push({id:p.id,ms:result.ms,metrics,regions:result.regions.length});
  console.log(p.id,JSON.stringify(reports.at(-1)));
 }}finally{backend.close();}
 await fs.writeFile(path.join(root,'summary.json'),JSON.stringify(reports,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
