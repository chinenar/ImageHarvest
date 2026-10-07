'use strict';
// Human transcriptions below were read from the source pages before this run.
// No OCR output is used to generate the reference or its geometry.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),sharp=require('sharp');
const out=path.resolve('test-results/ocr-advanced');
const box=(text,x0,y0,x1,y1,orientation='horizontal',kind='text')=>({text,bbox:{x0,y0,x1,y1},orientation,kind,reviewed:true});
async function main(){
 await fs.mkdir(out,{recursive:true});
 const referenceFile=path.join(out,'reference.json');
 if(await fs.stat(referenceFile).then(()=>true,()=>false))throw Error('Frozen reference already exists');
 const source=async(set,index)=>JSON.parse(await fs.readFile(`test-results/new-sets/set-${set}/files.json`,'utf8'))[index-1];
 const pages=[{id:'en-real-page',language:'en',source:await source(2,4),complete:false,scope:'Full-page scan; manually transcribed dialogue/captions and watermark. Stylized Japanese/Latin SFX excluded; not complete-page accuracy.',truth:[
  box('YOU...',322,172,376,193),box("I'VE SET\nIT UP.",929,239,1062,318),box("IT'S\nHIM...",525,616,575,659),box('RITHAR\nSCANS',897,690,1113,796),
  box('A DUEL\nCHALLENGE!!',285,959,430,1014),box('A DUEL\nCHALLENGE',512,929,621,984),box('WHAT IS THE\nMEANING OF\nTHIS!!!',694,998,804,1081),box('THIS IS!',858,1322,932,1345)
 ]},{id:'ja-real-page',language:'ja',source:await source(6,8),complete:false,scope:'Full-page scan; manually transcribed dialogue units. Small whispers, punctuation-only marks and stylized SFX excluded; not complete-page accuracy.',truth:[
  box('フン！なんなんだもう！',1010,26,1108,173,'vertical'),box('せっかく私が褒めてやったのに一緒に学園祭回ろうとか言えないのか！',748,23,908,343,'vertical'),
  box('そんでさチラチラこっち見てんのマジウケる',229,117,369,292,'vertical'),box('絶対一緒に回りたくないわ',151,465,218,665,'vertical'),box('もういいトイレ！',450,563,512,682,'vertical'),
  box('ただの学園祭なのにめっちゃ気合入ってんの',901,791,1030,932,'vertical'),box('見た？あのメイド服空気読めっての',792,809,886,991,'vertical'),
  box('私も絶対一緒に回りたくないな',268,778,362,958,'vertical'),box('親が金持ちだからって嫌味なヤツ',132,800,223,1007,'vertical'),
  box('今日もどうせ一人で回ってんだろうな',126,1065,222,1290,'vertical'),box('だから友達いないんだよアイツ',645,1095,752,1324,'vertical')
 ]}];
 const svg='<svg width="800" height="760"><defs><linearGradient id="g" x2="0" y2="1"><stop stop-color="#fcf2e5"/><stop offset="1" stop-color="#a2a9bf"/></linearGradient></defs><rect width="800" height="760" fill="#dfe6eb"/><ellipse cx="224" cy="170" rx="195" ry="140" fill="white" stroke="black" stroke-width="3"/><ellipse cx="604" cy="170" rx="161" ry="140" fill="url(#g)" stroke="black" stroke-width="3"/><g font-family="Tahoma" font-size="29" fill="black" text-anchor="middle"><text x="224" y="145">วันนี้ท้องฟ้าแจ่มใส</text><text x="224" y="192">เราออกเดินทางกันเถอะ</text><text x="604" y="145">เดี๋ยวก่อน!</text><text x="604" y="192">ฉันยังไม่พร้อม</text><text x="394" y="480">เสียงฝีเท้าใกล้เข้ามาแล้ว</text><text x="394" y="527">อย่าลืมหยิบกระเป๋าด้วย</text></g><g stroke="#556" fill="none" stroke-width="3"><path d="M80 620L200 585L290 680L150 700Z"/><circle cx="610" cy="650" r="65"/><path d="M560 680Q620 560 670 680"/></g></svg>';
 const synthetic=path.join(out,'thai-independent-synthetic.png');await sharp(Buffer.from(svg)).png().toFile(synthetic);
 pages.push({id:'th-synthetic-page',language:'th',source:synthetic,complete:true,scope:'Controlled synthetic full page with independent Thai text, close white/gradient balloons, floating text and no-text artwork; not a real-manga holdout.',truth:[
  box('วันนี้ท้องฟ้าแจ่มใส\nเราออกเดินทางกันเถอะ',65,115,385,200),box('เดี๋ยวก่อน!\nฉันยังไม่พร้อม',500,115,710,200),box('เสียงฝีเท้าใกล้เข้ามาแล้ว\nอย่าลืมหยิบกระเป๋าด้วย',218,450,570,538,'horizontal','unboxed')
 ]});
 for(const p of pages){const buffer=await fs.readFile(p.source),meta=await sharp(buffer).metadata();p.digest=crypto.createHash('sha256').update(buffer).digest('hex');p.width=meta.width;p.height=meta.height;p.truth=p.truth.map((t,i)=>({...t,id:p.id+'-'+i}));}
 await fs.writeFile(referenceFile,JSON.stringify({schema:'imageharvest.ocr-page-reference',version:1,createdAt:new Date().toISOString(),provenance:'Manual image inspection and authored synthetic text, frozen before enhanced full-page evaluation. Real references are partial.',pages},null,2));
 console.log('Frozen references: '+pages.map(p=>p.id+' '+p.truth.length+' units').join(', '));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
