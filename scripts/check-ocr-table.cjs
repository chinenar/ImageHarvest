'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {EnhancedMangaOcrPool}=require('../src/enhanced-manga-ocr.cjs');
const {LocalOcrBackend}=require('../src/ocr-backend.cjs');
async function main(){
 const root='test-results/ocr-accuracy',baseline=JSON.parse(await fs.readFile(`${root}/holdout-1.6.74/angled-dialogue-page.json`,'utf8'));
 // Fixed model proposals isolate recognition/routing from detector changes.
 // These are the existing detector's boxes, not the transcription reference.
 const detection={...baseline.result.detection,boxes:baseline.result.detection.boxes.filter(b=>b.bbox.x0>700&&b.bbox.x0<820&&b.bbox.y0>1400&&b.bbox.y0<1500||b.bbox.x0>480&&b.bbox.x1<950&&b.bbox.y0>1540&&b.bbox.y1<1630)};
 if(detection.boxes.length!==2)throw Error('Expected the two frozen table proposals');
 const backend=new LocalOcrBackend(),pool=new EnhancedMangaOcrPool({backend,langPath:path.resolve('assets/tessdata'),languages:['eng'],recognitionLanguage:'en',concurrency:1});
 pool.detectPage=async()=>structuredClone(detection);
 try{
  const [result]=await pool.recognizePages([{filePath:baseline.source}],{onRegion:r=>console.log(r.engine,r.index+'/'+r.total)});
  if(result.error)throw Error(result.error);
  const report={id:'table-recognition-only',source:baseline.source,scope:'Recognition and language routing on two frozen 1.6.74 detector proposals, not full-page detection.',ms:result.ms,result};
  await fs.writeFile(`${root}/table-targeted.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify(result.regions.map(r=>({text:r.text,language:r.regionLanguageEvidence}))));
 }finally{await pool.close();backend.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
