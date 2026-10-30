'use strict';
const fs=require('node:fs'),path=require('node:path'),sharp=require('sharp');
const assert=require('node:assert/strict');
const {LocalOcrBackend}=require('../src/ocr-backend.cjs');
const root=path.resolve(__dirname,'../test-results/ocr-accuracy');
async function main(){
 const input=JSON.parse(fs.readFileSync(path.join(root,'cleanup-input.json'))),image=fs.readFileSync(input.source);
 const backend=new LocalOcrBackend();let result;
 try{result=await backend.layoutSafe(image,input.regions,{includeSplitHints:false});}finally{backend.close();}
 fs.writeFileSync(path.join(root,'cleanup-after-1.6.90.json'),JSON.stringify(result));
 const ids=['p1-07661f7bc945','p1-f815442aeab6'];
 const summary=result.regions.map(r=>({id:r.id,text:input.regions.find(x=>x.id===r.id)?.text,mode:r.placement.paintMode,review:r.placement.cleanupReview,pixels:r.placement.erasePatch?.pixels,ownership:r.placement.erasePatch?.ownership}));
 const before=JSON.parse(fs.readFileSync(path.join(root,'cleanup-after-1.6.89.json')));
 for(const old of before.regions){const now=result.regions.find(r=>r.id===old.id);assert.equal(now.placement.paintMode,old.placement.paintMode,'existing paint eligibility changed: '+old.id);}
 fs.writeFileSync(path.join(root,'cleanup-summary-1.6.90.json'),JSON.stringify(summary,null,2));
 const {data,info}=await sharp(image).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 for(const r of result.regions.filter(r=>ids.includes(r.id))){
  const p=r.placement.erasePatch,b=p.bbox,v=await sharp(Buffer.from(p.png,'base64')).raw().toBuffer({resolveWithObject:true});
  for(let y=0;y<v.info.height;y++)for(let x=0;x<v.info.width;x++)if(v.data[(y*v.info.width+x)*4+3]){
   const k=((y+b.y0)*info.width+x+b.x0)*4;data[k]=255;data[k+1]=Math.round(data[k+1]*.35);data[k+2]=Math.round(data[k+2]*.35);
  }
 }
 await sharp(data,{raw:info}).extract({left:880,top:780,width:350,height:275}).png().toFile(path.join(root,'cleanup-after-1.6.90.png'));
 const targets=summary.filter(r=>ids.includes(r.id));
 assert.ok(targets.every(r=>r.mode==='none'&&r.ownership.unreadShapePixels>0));
 fs.writeFileSync(path.join(root,'revision-1.6.90.html'),`<!doctype html><html lang="th"><meta charset="utf-8"><title>OCR 1.6.90 — เก็บเส้นภาพนอกแนวข้อความ</title><style>body{font:18px system-ui;max-width:1200px;margin:32px auto;padding:20px;background:#f4f6f9;color:#182139}p{line-height:1.7}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}article,aside{background:white;padding:18px;border-radius:12px}img{width:100%}h2{font-size:21px}aside{margin-top:20px;border-left:5px solid #bd8030}@media(max-width:800px){.grid{grid-template-columns:1fr}}</style>
 <h1>1.6.90 — ลดพื้นที่ลบที่กินเส้นภาพ</h1><p>ตรวจกลุ่มหมึกเทียบกับแนวบรรทัดที่ OCR อ่านได้ แทนการถือว่าทุกอย่างในกรอบย่อหน้าเป็นข้อความ เส้นภาพที่อยู่นอกแนวบรรทัดจะถูกเก็บไว้ทั้งกลุ่ม</p><p><b>สีแดงคือมาสก์สำหรับตรวจ ไม่ใช่ภาพคลีนสำเร็จ</b></p>
 <div class="grid">${[['source-1.6.89','ต้นฉบับ'],['after-1.6.89','มาสก์ 1.6.89'],['after-1.6.90','มาสก์ 1.6.90']].map(([file,title])=>`<article><h2>${title}</h2><img src="cleanup-${file}.png" alt="${title}"></article>`).join('')}</div>
 <aside><h2>ยังไม่ปลดการลบอัตโนมัติของคู่นี้</h2><p>เส้นขอบขวดและเส้นภาพรอบข้างถูกกันออกมากขึ้น แต่หมึก N/W ยังเชื่อมกัน และมาสก์ยังมีรายละเอียดภายในขวดติดอยู่ การแยกข้อความจากภาพที่อยู่ในแนวบรรทัดยังต้องพัฒนาต่อ</p><p>กรณีที่พักไว้แล้วใช้เกณฑ์ทดลองที่เข้มขึ้นเพื่อดูมาสก์ ส่วนกรณีที่ใช้งานได้จะตัดเฉพาะกลุ่มหมึกที่ไม่มีส่วนอยู่ในแนวบรรทัดเลย จึงไม่ทิ้งตัวอักษรเพียงเพราะกรอบ OCR ครอบมาไม่ครบ</p></aside>
 <p>จากมาสก์ 1.6.89 กันออกเพิ่ม: ย่อหน้า ${targets[0].ownership.unreadShapePixels} พิกเซล, POISON ${targets[1].ownership.unreadShapePixels} พิกเซล ตัวเลขนี้ไม่ใช่คะแนนความแม่นยำหรือจำนวนข้อผิดพลาดที่มีผู้ตรวจครบแล้ว</p><p>ตรวจทั้ง ${summary.length} กรอบของหน้านี้แล้ว สถานะอนุญาตให้วาดยังเหมือนรุ่นก่อน ไม่เรียก OCR ใหม่และไม่เปลี่ยนข้อความ ทดสอบกับ Python/OpenCV จริงครอบคลุมภาพระหว่างบรรทัด ตัวอักษรที่ถูกตัดกรอบ หมึกติดกัน และข้อความข้างเคียง</p></html>`);
 console.log(JSON.stringify(summary.filter(r=>ids.includes(r.id)),null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
