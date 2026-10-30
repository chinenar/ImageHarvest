'use strict';
const fs=require('node:fs/promises'),sharp=require('sharp'),assert=require('node:assert/strict');
const {editDistance}=require('../src/ocr-review.cjs');
const root='test-results/ocr-accuracy';
const canon=s=>String(s||'').normalize('NFKC').replace(/\s/gu,'');
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
async function main(){
 const load=async file=>JSON.parse(await fs.readFile(file,'utf8'));
 const before=await load(`${root}/cache-page-enabled.json`),after=await load(`${root}/holdout/angled-dialogue-page.json`);
 assert.equal(before.source,after.source);
 const left=await load('test/fixtures/ocr-table-left-reference.json'),table=await load('test/fixtures/ocr-table-reference.json');
 const select=(page,box)=>page.result.regions.filter(r=>{const b=r.bbox;return b.x0>=box[0]&&b.x0<=box[2]&&b.y0>=box[1]&&b.y0<=box[3];}).map(r=>r.text).join('\n');
 const units=[{id:'left-status-labels',...left},...table.units].map(unit=>{
  const previous=select(before,unit.box),current=select(after,unit.box);
  return {id:unit.id,expected:unit.text,before:previous,after:current,beforeEdits:editDistance(canon(previous),canon(unit.text)),afterEdits:editDistance(canon(current),canon(unit.text))};
 });
 const dialogue=["I feel like I've grown a bit.","I've also moved from growing on the stone to in the ground.","Is it the work of the goddess?"];
 const exactDialogue=dialogue.filter(text=>after.result.regions.filter(r=>canon(r.text)===canon(text)).length===1).length;
 assert.equal(units[0].afterEdits,0,'All five left labels must match');
 assert.equal(units[1].afterEdits,0,'Right labels must not regress');
 assert.equal(units[2].afterEdits,2,'Skill list must retain the previous two-edit result');
 assert.equal(exactDialogue,3,'Adjacent angled dialogue must not regress');
 const speed=await load(`${root}/layout-speed.json`);
 const report={scope:'Full-page OCR execution; transcription scoring is limited to these three table regions and three angled dialogue units. Development examples, not overall accuracy.',wholePageMs:after.ms,units,exactDialogue,placementBenchmark:speed,inferenceReuse:after.result.performance.inferenceReuse,limitations:['Two skill-list character omissions remain.','The separate upper label and other page regions remain imperfect.','Automatic SFX classification is unresolved.','Cache A/B did not demonstrate faster full-page OCR; one unscored noisy region varied.']};
 const source=await sharp(after.source).extract({left:540,top:1360,width:130,height:165}).resize({width:390}).png().toBuffer();
 await fs.writeFile(`${root}/revision-1.6.76.json`,JSON.stringify(report,null,2));
 await fs.writeFile(`${root}/revision-1.6.76.html`,`<!doctype html><meta charset="utf-8"><title>OCR 1.6.76</title><style>body{font:17px system-ui;max-width:1100px;margin:32px auto;padding:0 20px;color:#182238}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccd4df;padding:14px;text-align:left;vertical-align:top}pre{white-space:pre-wrap}img{max-width:100%}.note{background:#f0f4fa;padding:18px}</style><h1>OCR 1.6.76 — ตารางเล็กและข้อความข้างเคียง</h1><p>รันภาพต้นฉบับทั้งหน้า แต่ตรวจคำตอบเฉพาะตาราง 3 ส่วนและบทพูดเอียง 3 ส่วน ไม่ใช่คะแนนความแม่นทั้งหน้า</p><img alt="ข้อความต้นฉบับ ฝั่งซ้ายของตาราง" src="data:image/png;base64,${source.toString('base64')}"><table><tr><th>ส่วน</th><th>ก่อนแก้รอบนี้</th><th>หลังแก้</th><th>จำนวนอักขระที่ต้องแก้</th></tr>${units.map(u=>`<tr><td>${esc(u.id)}</td><td><pre>${esc(u.before)}</pre></td><td><pre>${esc(u.after)}</pre></td><td>${u.beforeEdits} → ${u.afterEdits}</td></tr>`).join('')}</table><p>บทพูดเอียงตรงต้นฉบับพร้อมเครื่องหมาย ${exactDialogue}/3 ส่วน</p><h2>เวลาเฉพาะขั้นเตรียมพื้นที่วางคำแปล</h2><p>ภาพเดียว 18 กล่อง ปิดการแก้ย่อหน้าเพิ่มเติม สลับก่อน–หลัง 4 รอบ ผลตำแหน่งตรงกันทั้งหมด</p><pre>${esc(JSON.stringify(speed.rounds,null,2))}</pre><div class="note">OCR ทั้งหน้ายังไม่มีหลักฐานว่าเร็วขึ้นจากแคช และการแยกเอฟเฟกต์อัตโนมัติยังไม่เสร็จ ตารางรายการสกิลยังตกหล่น 2 ตัวอักษร รวมถึงส่วนอื่นของหน้ายังมีข้อผิดพลาด</div>`);
 console.log(JSON.stringify({units:units.map(u=>({id:u.id,before:u.beforeEdits,after:u.afterEdits})),exactDialogue,wholePageMs:after.ms}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
