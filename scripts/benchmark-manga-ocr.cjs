'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),sharp=require('sharp');
const {MangaOcrPool}=require('../src/manga-ocr.cjs');
const {evaluateRegions}=require('../src/ocr-review.cjs');
async function main(){
  const root=path.resolve(process.argv[2]||'C:/Users/jinna/Downloads/manga test ocr/1');
  const out=path.resolve(process.argv[3]||'test-results/first-set');await fs.mkdir(out,{recursive:true});
  const files=[];async function walk(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())await walk(f);else if(/\.(png|jpe?g|webp|bmp|avif)$/i.test(e.name))files.push(f);}}
  await walk(root);files.sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
  await fs.writeFile(path.join(out,'files.json'),JSON.stringify(files,null,2));
  const pool=new MangaOcrPool({langPath:path.resolve(__dirname,'../assets/tessdata'),concurrency:2});let results;
  try{results=await pool.recognizePages(files.map((filePath,pageIndex)=>({filePath,pageIndex})),{onDone:(_p,r,i)=>console.log(`${i+1}/${files.length}: ${r.regions.length} regions, ${(r.rejectedRegions||[]).length} rejected${r.error?' ERROR '+r.error:''}`)});}finally{await pool.close();}
  const pages=[];
  for(const [i,file]of files.entries()){
    const buffer=await fs.readFile(file),meta=await sharp(buffer).metadata(),r=results[i];
    await fs.writeFile(path.join(out,`ocr-${i+1}.json`),JSON.stringify(r,null,2));
    const digest=crypto.createHash('sha256').update(buffer).digest('hex');
    const truth=digest==='82123c79108bee963e6668519983d1589222b8989cbad6b9aa1f88c5493fb865'?[
      ["QUAND J’AI\nCOMMENCÉ LE\nLYCÉE, J’AI DÛ\nEMMÉNAGER\nCHEZ MA\nTANTE...",{x0:1010,y0:600,x1:1170,y1:798}],
      ['ET ELLE A\nUNE FILLE...\nMA COUSINE,\nSAYA-\nNEECHAN...',{x0:105,y0:630,x1:240,y1:785}],
      ['ELLE EST\nTOUJOURS\nAUSSI\nCOLLANTE...',{x0:1076,y0:1106,x1:1182,y1:1216}],
      ['ONEE-CHAN\nVA TE FAIRE\nUN MASSAGE\nDES\nÉPAULES...',{x0:440,y0:1126,x1:608,y1:1248}],
      ['EUH...\nEH BIEN...',{x0:743,y0:1140,x1:846,y1:1186}],
      ['…',{x0:694,y0:1306,x1:719,y1:1377}],
      ['HEIN ?',{x0:980,y0:1519,x1:1062,y1:1548}],
      ['POURQUOI\nTES\nÉPAULES\nSONT\nAUSSI\nTENDUES ?',{x0:894,y0:1588,x1:995,y1:1704}],
      ['?!',{x0:128,y0:1625,x1:236,y1:1705}]
    ].map(([text,bbox],j)=>({id:`truth-${j+1}`,text,bbox,orientation:'horizontal',kind:'text',reviewed:true})):[];
    pages.push({id:crypto.randomUUID(),name:path.relative(root,file),width:meta.width,height:meta.height,digest,imageBase64:buffer.toString('base64'),
      source:{type:'file',filePath:file},regions:r.regions,rawRegions:structuredClone(r.regions),truth,complete:false,runs:[r],history:[],metrics:evaluateRegions(r.regions,truth,{complete:false})});
  }
  const report={images:files.length,errors:results.filter(r=>r.error).length,regions:results.reduce((n,r)=>n+r.regions.length,0),rejected:results.reduce((n,r)=>n+(r.rejectedRegions||[]).length,0),
    referencePages:pages.filter(p=>p.truth.length).map(p=>({name:p.name,metrics:p.metrics})),
    tiledImages:results.filter(r=>r.detection?.tiles?.length>1).length,
    firstPageDialogueSubset:pages[0]?.truth.length?pages[0].metrics:null,note:'Only matching source-image digests receive a reference. The existing first-set reference is partial and excludes Japanese sound effects. Other images have no verified reference. Counts do not establish 99% accuracy.'};
  const project=JSON.stringify({schema:'imageharvest.ocr-review',version:1,savedAt:new Date().toISOString(),pages});
  await fs.writeFile(path.join(out,'review.json'),project);
  if(path.basename(root)==='1')await fs.writeFile(path.join(out,'first-set-review.json'),project);
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
