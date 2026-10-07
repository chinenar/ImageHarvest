'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {EnhancedMangaOcrPool}=require('../src/enhanced-manga-ocr.cjs');
const {LocalOcrBackend}=require('../src/ocr-backend.cjs');
const {evaluateRegions}=require('../src/ocr-review.cjs');
async function main(){
 const root=path.resolve('test-results/ocr-advanced'),only=process.argv.indexOf('--only'),out=process.argv.includes('--final')?path.join(root,'final'):root,ref=JSON.parse(await fs.readFile(path.join(root,'reference.json'),'utf8')),backend=new LocalOcrBackend(),pages=[],reports=[];
 await fs.mkdir(out,{recursive:true});
 const metadata={createdAt:new Date().toISOString(),appVersion:require('../package.json').version,sourceHashes:Object.fromEntries(await Promise.all(['comic-text-detector.cjs','ocr-discovery.cjs','enhanced-manga-ocr.cjs','ocr-crop.cjs','ocr-backend.py'].map(async name=>[name,crypto.createHash('sha256').update(await fs.readFile(path.resolve('src',name))).digest('hex')])))};
 if(only>=0){
  const previous=await fs.readFile(path.join(out,'report.json'),'utf8').then(JSON.parse,()=>null),review=await fs.readFile(path.join(out,'review.json'),'utf8').then(JSON.parse,()=>null);
  if(previous)reports.push(...previous.reports.filter(r=>r.id!==process.argv[only+1]).map(r=>({...r,runMetadata:r.runMetadata||{createdAt:previous.createdAt,appVersion:previous.appVersion,sourceHashes:previous.sourceHashes}})));
  if(review)pages.push(...review.pages.filter(p=>p.id!==process.argv[only+1]));
 }
 try{
  for(const p of ref.pages){
   if(only>=0&&p.id!==process.argv[only+1])continue;
   const buffer=await fs.readFile(p.source);if(crypto.createHash('sha256').update(buffer).digest('hex')!==p.digest)throw Error('Source changed: '+p.id);
   const pool=new EnhancedMangaOcrPool({backend,langPath:path.resolve('assets/tessdata'),languages:[{en:'eng',ja:'jpn',th:'tha'}[p.language]],concurrency:1});
   let result;try{[result]=await pool.recognizePages([{filePath:p.source}],{onRegion:({engine,index,total})=>{if(index===1||index===total)console.log(`${p.id}: ${engine} ${index}/${total}`);}});}finally{await pool.close();}
   Object.assign(result,{appVersion:metadata.appVersion,imageDigest:p.digest});
   await fs.writeFile(path.join(out,p.id+'-result.json'),JSON.stringify(result,null,2));if(result.error)throw Error(result.error);
   const metrics=evaluateRegions(result.regions,p.truth,{complete:p.complete});
   const chars=metrics.pairs.reduce((n,pair)=>n+Array.from(p.truth.find(t=>t.id===pair.truthId).text.replace(/\s/gu,'')).length,0),matchedReadingAccuracy=chars?1-metrics.pairs.reduce((n,p)=>n+p.edits,0)/chars:null;
   const report={id:p.id,scope:p.scope,runMetadata:metadata,metrics,matchedReadingAccuracy,regions:result.regions.length,supplementalAccepted:result.regions.filter(r=>r.discoveryOnly).length,supplementalRejected:result.rejectedRegions.filter(r=>r.discoveryOnly).length,tiles:result.detection.tiles.length,ms:result.ms};reports.push(report);
   pages.push({id:p.id,name:p.id+'.png',width:p.width,height:p.height,digest:p.digest,source:{type:'file',filePath:p.source},imageBase64:buffer.toString('base64'),regions:result.regions,rawRegions:structuredClone(result.regions),truth:p.truth,complete:p.complete,referenceScope:p.scope,runs:[result],activeRun:0,history:[],metrics});
   await fs.writeFile(path.join(out,'report.json'),JSON.stringify({...metadata,versions:await backend.status(),reports},null,2));console.log(JSON.stringify(report));
  }
  await fs.writeFile(path.join(out,'review.json'),JSON.stringify({schema:'imageharvest.ocr-review',version:1,pages},null,2));
 }finally{backend.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
