'use strict';
const fs=require('node:fs'),path=require('node:path');
const {EnhancedMangaOcrPool}=require('../src/enhanced-manga-ocr.cjs');
async function main(){
 const manifest=require('../test-results/manga-corpus/manifest.json');
 const source=path.join(path.dirname(manifest.cases.find(c=>c.id==='case-23').file),'0001.webp');
 const pool=new EnhancedMangaOcrPool({langPath:path.resolve('assets/tessdata'),languages:['eng'],recognitionLanguage:'en',concurrency:1});
 try{
  const [result]=await pool.recognizePages([{filePath:source}]);if(result.error)throw Error(result.error);
  fs.writeFileSync('test-results/ocr-accuracy/display-page-'+require('../package.json').version+'.json',JSON.stringify({source,result},null,2));
  const scream=result.regions.filter(r=>r.bbox.y0<850),die=result.regions.filter(r=>r.bbox.y0>3900&&r.bbox.y0<4300);
  if(scream.length!==1||scream[0].text!=='MEEEEEEEEEH!!!')throw Error('Repeated display line mismatch');
  if(die.length!==1||die[0].text!=='DIE!!'||die[0].bbox.y1>4200)throw Error('Short dialogue duplicates or effect contamination');
  console.log('PASS: full-page repeated lettering, punctuation, single DIE region and bounded dialogue');
 }finally{await pool.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
