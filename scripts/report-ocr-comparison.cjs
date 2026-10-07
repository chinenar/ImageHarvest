'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),sharp=require('sharp');
const {evaluateRegions}=require('../src/ocr-review.cjs');
async function main(){
 const root=path.resolve('test-results/engine-comparison'),results=JSON.parse(await fs.readFile(path.join(root,'results.json'),'utf8'));
 const canonical=text=>String(text||'').normalize('NFKC').replace(/\.{3}/g,'…').replace(/\s+/gu,'');
 const {editDistance}=require('../src/ocr-review.cjs');
 const summarize=cases=>{
  const text=cases.filter(c=>!c.negative),chars=text.reduce((n,c)=>n+c.baseline.chars,0),baselineEdits=text.reduce((n,c)=>n+c.baseline.edits,0),selectedEdits=text.reduce((n,c)=>n+c.selected.edits,0);
  const normalizedChars=text.reduce((n,c)=>n+Array.from(canonical(c.text)).length,0),normalizedEdits=text.reduce((n,c)=>n+editDistance(canonical(c.selected.text),canonical(c.text)),0);
  return {crops:text.length,chars,baselineEdits,selectedEdits,baselineCharacterAccuracy:chars?Math.max(0,1-baselineEdits/chars):null,
    selectedCharacterAccuracy:chars?Math.max(0,1-selectedEdits/chars):null,exactCrops:text.filter(c=>c.selected.exact).length,
    typographicNormalizedCharacterAccuracy:normalizedChars?Math.max(0,1-normalizedEdits/normalizedChars):null,
    negativeCrops:cases.filter(c=>c.negative).length,negativeFalseReadings:cases.filter(c=>c.negative&&c.selected.text.trim()).length};
 };
 const report={createdAt:new Date().toISOString(),versions:results.versions,scope:'Fixed-crop recognition, not page detection, grouping recall, localization, or corpus-wide 99% accuracy.',
  normalization:'Primary: NFC, Thai sara-am normalization, whitespace ignored, case and punctuation preserved. Secondary: NFKC and three dots equivalent to ellipsis.',
  caveats:['Small hand-selected representative subset; not a random sample of all 515 pages.','Development examples informed preprocessing; page 4-6 EN/JA holdout outputs were read after the selection rules were frozen.','No independent Thai/French holdout. Two Thai development crops show the same source bubble.','Four ambiguous or incomplete holdout crops excluded before reading the new engine outputs; recorded in reference.json.','Recognition-crop reference rectangles describe input areas, not independently annotated pixel-accurate text boundaries.'],
  development:summarize(results.cases.filter(c=>c.split==='development')),holdout:summarize(results.cases.filter(c=>c.split==='holdout')),
  languages:Object.fromEntries(['en','ja','th','fr'].map(language=>[language,{development:summarize(results.cases.filter(c=>c.language===language&&c.split==='development')),holdout:summarize(results.cases.filter(c=>c.language===language&&c.split==='holdout'))}])),
  disagreements:results.cases.filter(c=>!c.selected.exact).map(c=>({id:c.id,language:c.language,split:c.split,reference:c.text,selected:c.selected.text,edits:c.selected.edits,reason:c.selected.selectionReason}))};
 const paired=JSON.parse(await fs.readFile(path.join(root,'paired-page-result.json'),'utf8'));
 const truth=[{id:'right',text:"WE'LL BE\nFOUND\nOUT IF\nYOU DON'T\nHURRY.",bbox:{x0:563,y0:2400,x1:668,y1:2550}},{id:'left',text:"LET'S\nENJOY OUR-\nSELVES IN\nSECRET?",bbox:{x0:464,y0:2518,x1:592,y1:2638}}];
 const regions=paired.regions.filter(r=>r.segmentation&&r.bbox.y0>2300&&r.bbox.y0<2650);
 report.connectedBalloonSubset={completePage:false,expected:2,metrics:evaluateRegions(regions,truth,{complete:false}),regions};
 await fs.writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2));
 const pct=v=>v===null?'—':(v*100).toFixed(2)+'%';
 const rows=['| Language | Split | Crops | Baseline characters | New characters | Exact crops |','|---|---|---:|---:|---:|---:|'];
 for(const [language,sets]of Object.entries(report.languages))for(const [split,r]of Object.entries(sets))if(r.crops)rows.push(`| ${language} | ${split} | ${r.crops} | ${pct(r.baselineCharacterAccuracy)} | ${pct(r.selectedCharacterAccuracy)} | ${r.exactCrops}/${r.crops} |`);
 const md=`# OCR engine comparison\n\n${results.cases.length} checked crops, including 2 no-text controls. The independent EN/JA holdout has ${report.holdout.crops} crops and ${report.holdout.chars} non-whitespace reference characters. Primary character accuracy improves from ${pct(report.holdout.baselineCharacterAccuracy)} to ${pct(report.holdout.selectedCharacterAccuracy)}; exact recognition is ${report.holdout.exactCrops}/${report.holdout.crops} crops.\n\n${rows.join('\n')}\n\n## Scope and limits\n\n${report.caveats.map(v=>'- '+v).join('\n')}\n- This does not establish detection completeness, precise positioning, or 99% over all manga pages. Punctuation and small kana still produce errors.\n- Models run locally. The optional Python runtime is installed separately under LocalAppData; public models download on first use.\n\n## Connected-balloon check\n\nThe staggered connected English balloon is now 2 distinct groups, including the shared-line portions. The two-group subset matches ${report.connectedBalloonSubset.metrics.matched}/2, with no merges or splits; character accuracy is ${pct(report.connectedBalloonSubset.metrics.characterAccuracy)}. Other text on the page is outside this reference.\n\n## Files\n\n- reference.json: verified text, source/crop SHA-256, source coordinates, split, exclusions.\n- results.json: raw engine outputs, preprocessing alternatives, chosen reading and per-crop errors.\n- comparison-review.json: portable images and text references for OCR Lab. Uses recognition-only scope; input rectangles are not localization ground truth.\n`;
 await fs.writeFile(path.join(root,'report.md'),md);
 const pages=[];
 for(const c of results.cases){
  const buffer=await fs.readFile(path.join(root,c.file)),meta=await sharp(buffer).metadata(),bbox={x0:0,y0:0,x1:meta.width,y1:meta.height};
  const region={id:c.id+'-selected',text:c.selected.text,bbox,confidence:c.selected.confidence,recognitionEngine:c.selected.engine,reviewRequired:!c.selected.exact||c.selected.confidence==null,
    alternatives:[{engine:'tesseract.js',...c.baseline},...c.processedAlternatives.map(r=>({text:r.text,engine:r.engine,variant:r.variant,confidence:r.confidence,rawText:r.rawText}))]};
  const pass=r=>[{id:c.id+'-'+r.engine,text:r.text,bbox,confidence:r.confidence}];
  pages.push({id:crypto.randomUUID(),name:c.split+' / '+c.id,width:meta.width,height:meta.height,imageBase64:buffer.toString('base64'),digest:c.cropDigest,
    source:{type:'recognition-crop',filePath:c.source,sourceDigest:c.digest,roi:c.roi},measurementScope:'recognition-only',referenceLanguage:c.language,
    regions:[region],rawRegions:[region],truth:c.negative?[]:[{id:c.id+'-truth',text:c.text,bbox,reviewed:true}],complete:false,history:[],
    runs:[{engine:'fixed-crop-comparison',regions:[region],passes:[{name:'tesseract-baseline',regions:pass(c.baseline)},...c.processedAlternatives.map(r=>({name:r.engine+'-'+r.variant,regions:pass(r)}))]}]});
 }
 await fs.writeFile(path.join(root,'comparison-review.json'),JSON.stringify({schema:'imageharvest.ocr-review',version:1,pages},null,2));
 console.log(JSON.stringify({holdout:report.holdout,connectedBalloon:report.connectedBalloonSubset.metrics},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
