'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
async function main(){
 const before=process.argv.includes('--before');
 const {EnhancedMangaOcrPool}=require(before?'../test-results/ocr-accuracy/baseline-before-neighbor/src/enhanced-manga-ocr.cjs':'../src/enhanced-manga-ocr.cjs');
 const manifest=JSON.parse(await fs.readFile('test-results/manga-corpus/manifest.json','utf8'));
 const source=path.join(path.dirname(manifest.cases.find(c=>c.id==='case-04').file),'0003.webp');
 const pool=new EnhancedMangaOcrPool({langPath:path.resolve('assets/tessdata'),languages:['eng'],recognitionLanguage:'en',concurrency:1});
 try{const [result]=await pool.recognizePages([{filePath:source}]);if(result.error)throw Error(result.error);
  await fs.writeFile(`test-results/ocr-accuracy/new-romance-${before?'before':'after'}.json`,JSON.stringify({source,result},null,2));
  console.log(JSON.stringify(result.regions.map(r=>({t:r.text,b:r.bbox}))));
 }finally{await pool.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
