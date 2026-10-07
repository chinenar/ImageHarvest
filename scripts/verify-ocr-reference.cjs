'use strict';
// Transcriptions checked visually against the prepared crop contact sheets.
// These are a small, fixed recognition benchmark, not 99% page-completeness evidence.
const fs=require('node:fs/promises'),path=require('node:path'),sharp=require('sharp'),crypto=require('node:crypto');
const text={
 's2-p2-r0':'Name: Marion Bonait\nAge: 18\nJob: Knight apprentice\nSkills: Dual wielding\nSword rush',
 's2-p2-r2':'Current love\nlevel','s2-p2-r6':'HEY,','s2-p2-r8':'CAN YOU\nSTOP\nLOOKING\nOVER\nHERE?',
 's2-p2-r9':"YOU'RE\nJUST BEING\nPARANOID.",'s2-p2-r10':'DIE, YOU\nTRASH...',
 's2-p3-r2':"WHAT ARE YOU\nGOING TO DO!?\nTHIS ISN'T JUST\nBEING DISLIKED!",'s2-p3-r3':"THAT'S\nPRACTICALLY\nMURDEROUS\nINTENT!",
 's3-p3-r0':'COASTAL FISHERMEN\nDISCOVER GIGANTIC ABALONE\nREQUIRING TEN PEOPLE TO EMBRACE\nIT, SUSPECTED TO BE A NUCLEAR\nWASTEWATER MUTATION.',
 's3-p3-r1':'ANCIENT TREES IN 5A SCENIC\nAREA SHOW EXCESSIVE GROWTH, ROOTS\nSPREADING TEN MILES, ATTRACTING\nTOURIST CROWDS.',
 's4-p2-r0':"...IS IT REALLY\nOKAY FOR\nME TO PUT\nMY HANDS ON\nMY SISTER'S\nFRIEND?",'s4-p2-r1':'NO, OF\nCOURSE\nNOT.',
 's4-p2-r4':'WHAT\nIS HE\nWAITING\nFOR?!!',
 's4-p3-r9':'WH-...!\nWHAT IS\nTHIS...!',
 's4-p3-r16':'IT FEELS\nTHIS GOOD\nTO HAVE\nSOMEONE\nTOUCH\nTHEM...!?',
 's5-p3-r0':'I CAN\nBLOCK IT!','s5-p3-r1':'HAAAH!!',
 's6-p3-r1':'お前のお姉ちゃんには随分世話になったよ',
 's6-p3-r2':'な…何ですの!?あなた達…',
 's6-p3-r3':'そうだよお姉さまのお友達さ',
 's6-p3-r4':'お姉さまのお知り合いですの？',
 's6-p3-r5':'まあそう硬くなんなよ',
 's6-p3-r6':'今度は俺達が世話してやるよ',
 's7-p2-r0':'I-I WAS\nWONDERING IF\nI COULD ALSO\nSTART...',
 's7-p2-r3':'COULD YOU\nHELP ME OUT\nA BIT?','s7-p2-r6':'S-SERAPHIA...?',
 's7-p2-r9':'PLEASE\nTEACH ME HOW\nTO TRAIN...',
 's7-p2-r14':"AH...!! W-WELL...\nI'VE BEEN WORKING\nSO MUCH THAT I'VE BEEN\nFEELING MY STAMINA\nWORSENING..."
};
async function main(){
 const out=path.resolve('test-results/engine-comparison'),data=JSON.parse(await fs.readFile(path.join(out,'reference-draft.json'),'utf8'));
 const excluded=['s2-p3-r1','s5-p2-r0','s5-p2-r2','s4-p2-r9'];
 data.cases=data.cases.filter(c=>!excluded.includes(c.id)).map(c=>({...c,text:text[c.id],verified:true,reviewMethod:'visual transcription from crop; no model output used as reference'}));
 if(data.cases.some(c=>typeof c.text!=='string'))throw Error('Unverified reference');
 const add=async({id,source,roi,language,split,text,negative=false})=>{
  const buffer=await fs.readFile(source),meta=await sharp(buffer).metadata();
  roi||={x0:0,y0:0,x1:meta.width,y1:meta.height};
  await sharp(buffer).extract({left:roi.x0,top:roi.y0,width:roi.x1-roi.x0,height:roi.y1-roi.y0}).png().toFile(path.join(out,id+'.png'));
  data.cases.push({id,source,digest:crypto.createHash('sha256').update(buffer).digest('hex'),roi,file:id+'.png',language,split,text,negative,verified:true,reviewMethod:'visual transcription'});
 };
 await add({id:'thai-real',source:'C:/Users/jinna/AppData/Local/Temp/codex-clipboard-8880a6d9-c47d-4c10-b698-4c111add7889.png',roi:{x0:204,y0:183,x1:513,y1:320},language:'th',split:'holdout',text:'พวกแกทุกคนน่าจะ\nรู้เรื่องกองกำลังอิสรภาพ\nของจักรวรรดิกัน'});
 await add({id:'thai-fixture',source:path.resolve('test/fixtures/ocr-thai-bubble.png'),language:'th',split:'development',text:'พวกแกทุกคนน่าจะ\nรู้เรื่องกองกำลังอิสรภาพ\nของจักรวรรดิกัน'});
 await add({id:'japanese-fixture',source:path.resolve('test/fixtures/ocr-layout.png'),roi:{x0:707,y0:52,x1:816,y1:219},language:'ja',split:'development',text:'こんにちは世界です'});
 const first=JSON.parse(await fs.readFile('test-results/first-set/first-set-review.json','utf8')).pages[0];
 for(const [i,r]of first.truth.entries()){
  if(i===5)continue;
  const b=r.bbox;await add({id:'french-'+i,source:first.source.filePath,roi:{x0:Math.max(0,b.x0-8),y0:Math.max(0,b.y0-8),x1:b.x1+8,y1:b.y1+8},language:'fr',split:'development',text:r.text});
 }
 const files=JSON.parse(await fs.readFile('test-results/new-sets/set-3/files.json','utf8'));
 for(const [i,roi]of [{x0:0,y0:0,x1:200,y1:200},{x0:200,y0:400,x1:400,y1:600}].entries())await add({id:'no-text-'+i,source:files[1],roi,language:'en',split:'holdout',text:'',negative:true});
 await fs.writeFile(path.join(out,'reference.json'),JSON.stringify(data,null,2));
 console.log(data.cases.length+' manually transcribed crops');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
