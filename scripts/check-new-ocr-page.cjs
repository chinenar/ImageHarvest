'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {EnhancedMangaOcrPool}=require('../src/enhanced-manga-ocr.cjs');
async function main(){
 const before=JSON.parse(await fs.readFile('test-results/ocr-accuracy/new-plant-before.json','utf8'));
 const pool=new EnhancedMangaOcrPool({langPath:path.resolve('assets/tessdata'),languages:['eng'],recognitionLanguage:'en',concurrency:1});
 try{const [result]=await pool.recognizePages([{filePath:before.source}]);if(result.error)throw Error(result.error);
  await fs.writeFile('test-results/ocr-accuracy/new-plant-after.json',JSON.stringify({source:before.source,result},null,2));
  console.log(JSON.stringify(result.regions.map(r=>({t:r.text,b:r.bbox}))));
 }finally{await pool.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
