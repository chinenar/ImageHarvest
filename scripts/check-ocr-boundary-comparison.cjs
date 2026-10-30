'use strict';
// Cached full-page OCR observations, followed by real crop refinement/layout.
// This is a reading-boundary regression, not fresh full-page OCR or a CER claim.
const fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const output=path.join(root,'test-results/ocr-detection/boundary-comparison');
const digest=b=>createHash('sha256').update(b).digest('hex');
const readJson=async file=>JSON.parse(await fs.readFile(file,'utf8'));
async function runPhase(phase){
 const cachedPath=path.join(root,'test-results/reader-pipeline/live/0004-ocr.json');
 const live=await readJson(path.join(root,'test-results/reader-pipeline/live/0004-result.json'));
 const source=path.resolve(live.source),image=await fs.readFile(source),sourceHash=digest(image);
 const reference=(await readJson(path.join(root,'test/fixtures/ocr-detection-reference.json'))).cases.find(c=>c.id==='en-connected-page');
 if(!reference)throw Error('Missing en-connected-page reference');
 if(path.resolve(reference.source)!==source)throw Error('Reference source path differs from cached page source');
 if(sourceHash!==live.page.imageDigest || (reference.sourceHash&&sourceHash!==reference.sourceHash))throw Error('Source SHA differs from saved source/reference');
 const cachedBytes=await fs.readFile(cachedPath),ocr=JSON.parse(cachedBytes.toString('utf8'));
 if(ocr.error||!Array.isArray(ocr.regions))throw Error('Cached OCR is invalid');
 const readingPath=path.join(root,'src/reading-units.cjs');
 const selectedPath=phase==='before'?path.join(root,'test-results/ocr-detection/reading-units-before.cjs'):readingPath;
 if(phase==='before'){
  // Install baseline exports before reader-quality or its dependencies load.
  const baseline=require(selectedPath);
  require.cache[require.resolve(readingPath)]={id:readingPath,filename:readingPath,loaded:true,exports:baseline};
 }
 const {planReadingPage}=require('../src/reader-quality.cjs');
 const {LocalOcrBackend}=require('../src/ocr-backend.cjs');
 const {translationEligible}=require('../src/ocr-content-role.cjs');
 const {evaluateDetection}=require('./ocr-detection-metrics.cjs');
 const backend=new LocalOcrBackend(),refinements=[];
 try{
  console.log(phase+': cached OCR '+ocr.regions.length+' regions; planning with crop refinement');
  const planned=await planReadingPage(backend,image,ocr.regions,{refineText:true,sourceLanguage:'en',onRefine:event=>refinements.push(event)});
  if(planned.error)throw Error(planned.error);
  const eligible=planned.regions.filter(r=>translationEligible(r));
  const files=['src/reader-quality.cjs','src/reader-slanted-text.cjs','src/ocr-content-role.cjs','src/ocr-backend.cjs','src/ocr-backend.py','src/reader_surface.py','scripts/ocr-detection-metrics.cjs'];
  const moduleHashes={readingUnits:digest(await fs.readFile(selectedPath))};
  for(const file of files)moduleHashes[file]=digest(await fs.readFile(path.join(root,file)));
  const report={phase,provenance:'Same cached full-page OCR, real LocalOcrBackend crop refinement and layout. Development boundary comparison; not fresh full-page inference or a transcription-quality estimate.',source,sourceHash,cachedOcrPath:cachedPath,cachedOcrHash:digest(cachedBytes),reference,moduleHashes,refinements,backendStats:backend.stats(),metrics:{raw:evaluateDetection(ocr.regions,reference),planned:evaluateDetection(planned.regions,reference),eligible:evaluateDetection(eligible,reference)},planned};
  await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,phase+'.json'),JSON.stringify(report,null,2));
  console.log(phase+': saved '+path.join(output,phase+'.json'));
 }finally{backend.close();}
}
function child(phase){return new Promise((resolve,reject)=>{
 const p=spawn(process.execPath,[__filename,'--phase='+phase],{cwd:root,stdio:'inherit',windowsHide:true});
 p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(Error(phase+' failed: '+code)));
});}
const summary=m=>({outputs:m.evaluatedOutputs,matched:m.matches.length,missing:m.missing,falsePositives:m.falsePositives,unscored:m.unscoredOutputs,merges:m.merges,splits:m.splits,duplicates:m.duplicatePairs,incompleteCrops:m.unitCoverage.filter(u=>u.incompleteCrop).map(u=>u.unitId)});
async function main(){
 const phase=process.argv.find(a=>a.startsWith('--phase='))?.slice(8);
 if(phase){if(!['before','after'].includes(phase))throw Error('Invalid phase');return runPhase(phase);}
 if(!process.argv.includes('--rescore')){await child('before');await child('after');}
 const before=await readJson(path.join(output,'before.json')),after=await readJson(path.join(output,'after.json'));
 if(before.sourceHash!==after.sourceHash||before.cachedOcrHash!==after.cachedOcrHash)throw Error('Before/after inputs differ');
 for(const [file,hash] of Object.entries(before.moduleHashes))if(file!=='readingUnits'&&after.moduleHashes[file]!==hash)throw Error('Uncontrolled module change: '+file);
 // Score both saved plans against one final reference snapshot. Manual reference
 // review may finish while crop refinement is running; it must not alter just
 // one side of the comparison.
 const reference=(await readJson(path.join(root,'test/fixtures/ocr-detection-reference.json'))).cases.find(c=>c.id==='en-connected-page');
 if(!reference||path.resolve(reference.source)!==before.source||reference.sourceHash!==before.sourceHash)throw Error('Final reference source differs');
 const referenceHash=digest(Buffer.from(JSON.stringify(reference)));
 const raw=(await readJson(before.cachedOcrPath)).regions;
 const {evaluateDetection}=require('./ocr-detection-metrics.cjs');
 const {translationEligible}=require('../src/ocr-content-role.cjs');
 for(const report of [before,after]){
  report.reference=reference;report.referenceHash=referenceHash;
  report.metrics={raw:evaluateDetection(raw,reference),planned:evaluateDetection(report.planned.regions,reference),eligible:evaluateDetection(report.planned.regions.filter(r=>translationEligible(r)),reference)};
  await fs.writeFile(path.join(output,report.phase+'.json'),JSON.stringify(report,null,2));
 }
 const result={scope:before.provenance,source:before.source,sourceHash:before.sourceHash,cachedOcrHash:before.cachedOcrHash,referenceHash,stages:Object.fromEntries(['raw','planned','eligible'].map(stage=>[stage,{before:summary(before.metrics[stage]),after:summary(after.metrics[stage])}]))};
 await fs.writeFile(path.join(output,'summary.json'),JSON.stringify(result,null,2));
 console.log(result.scope);
 for(const [stage,pair] of Object.entries(result.stages))console.log(stage+': matched '+pair.before.matched+' -> '+pair.after.matched+'; merges '+pair.before.merges.length+' -> '+pair.after.merges.length+'; missing '+JSON.stringify(pair.before.missing)+' -> '+JSON.stringify(pair.after.missing)+'; false positives '+pair.before.falsePositives.length+' -> '+pair.after.falsePositives.length);
 console.log('Saved '+path.join(output,'summary.json'));
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
