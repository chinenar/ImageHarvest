'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const sharp=require('sharp');
const {metrics}=require('./benchmark-ocr-accuracy.cjs');
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function main(){
 const root=path.resolve('test-results/ocr-accuracy');
 const load=async name=>JSON.parse(await fs.readFile(path.join(root,name+'.json'),'utf8'));
 const [before,after,holdBefore,holdAfter]=await Promise.all(['new-plant-before','new-plant-after','new-romance-before','new-romance-after'].map(load));
 const reference=JSON.parse(await fs.readFile('test/fixtures/ocr-new-plant-reference.json','utf8'));
 const bm=metrics(before.result.regions,reference),am=metrics(after.result.regions,reference);
 const exact=m=>m.units.filter(u=>u.matches===1&&u.exactTranscription).length;
 const comparable=data=>data.result.regions.map(r=>({text:r.text,bbox:r.bbox}));
 const unchanged=JSON.stringify(comparable(holdBefore))===JSON.stringify(comparable(holdAfter));
 const meta=await sharp(after.source).metadata();
 const overlay=(data,title)=>`<section><h3>${title}</h3><svg viewBox="0 0 ${meta.width} ${meta.height}"><image href="${escape(pathToFileURL(data.source).href)}" width="${meta.width}" height="${meta.height}"/>${data.result.regions.map(r=>`<rect x="${r.bbox.x0}" y="${r.bbox.y0}" width="${r.bbox.x1-r.bbox.x0}" height="${r.bbox.y1-r.bbox.y0}" fill="none" stroke="#f06b00" stroke-width="2"><title>${escape(r.text)}</title></rect>`).join('')}</svg></section>`;
 const summary={before:{lexical:bm.exact,punctuation:exact(bm)},after:{lexical:am.exact,punctuation:exact(am)},expected:12,holdoutUnchanged:unchanged,scope:reference.scope};
 await fs.writeFile(path.join(root,'revision-1.6.79.json'),JSON.stringify({summary,before:bm,after:am},null,2));
 const html=`<!doctype html><html lang="th"><meta charset="utf-8"><title>OCR 1.6.79 — new page validation</title><style>body{font:17px system-ui;background:#f4f5f7;color:#192233;margin:32px auto;max-width:1300px;padding:0 24px}h1{font-size:30px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:20px}section{background:white;padding:16px;border-radius:12px}svg{width:100%}table{border-collapse:collapse;width:100%;background:white}td,th{padding:12px;border:1px solid #ccd1da;text-align:left;white-space:pre-wrap;vertical-align:top}.ok{color:#087549}.bad{color:#a53221}@media(max-width:800px){.pair{grid-template-columns:1fr}}</style><h1>OCR 1.6.79: แก้ข้อความปนจากกล่องข้างเคียง และประโยคแตกเป็นหลายกล่อง</h1><p>ภาพใหม่ 12 หน่วยคำพูด: ตัวอักษรถูกครบ ${bm.exact}/12 → ${am.exact}/12; รวมเครื่องหมายวรรคตอน ${exact(bm)}/12 → ${exact(am)}/12 โดยแต่ละหน่วยต้องมีเพียงหนึ่งผลลัพธ์</p><p>ภาพนี้ใช้พัฒนาแล้ว จึงไม่ใช่ชุดทดสอบที่โมเดล/โค้ดไม่เคยเห็น และคะแนนนี้ไม่รวมเอฟเฟกต์ ป้ายกราฟิก หรือข้อความเล็กริมภาพ</p><div class="pair">${overlay(before,'ก่อนแก้')}${overlay(after,'หลังแก้')}</div><h2>ข้อความจริงก่อน–หลัง</h2><table><tr><th>อ้างอิงจากภาพ</th><th>ก่อน</th><th>หลัง</th></tr>${am.units.map((u,i)=>`<tr><td>${escape(u.expected)}</td><td>${escape(bm.units[i].actual)}<br>จำนวนผลลัพธ์ ${bm.units[i].matches}</td><td class="${u.exactTranscription&&u.matches===1?'ok':'bad'}">${escape(u.actual)}<br>จำนวนผลลัพธ์ ${u.matches}</td></tr>`).join('')}</table><h2>ภาพตรวจแยกอีกหน้า</h2><p>เทียบกับซอร์สจากแอปที่ติดตั้ง 1.6.78: ${unchanged?'ข้อความและตำแหน่งทั้ง 14 ผลลัพธ์เหมือนเดิม':'พบความแตกต่าง — ตรวจไฟล์ผลลัพธ์'} ยังมี MASTER! ปนกับ IS -99 THE LIMIT? และ THAT’S PRACTICALLY MURDEROUS INTENT! อ่านขาด ภาพนี้ยืนยันเพียงว่ารอบนี้ไม่เปลี่ยนผลเดิม ไม่ใช่ยืนยันความแม่นยำ</p><h2>ยังต้องแก้</h2><p>Water Edge! ยังอ่านเป็น ONater Edge!, จุดท้ายประโยคสองแห่งยังผิด/ตกหล่น และการแยกคำพูด–เอฟเฟกต์/ข้อความเล็กยังต้องทดสอบเพิ่มเติม การแก้รอบนี้ไม่ได้ยืนยันความแม่นยำทั้งคลังหรือความเร็วเทียบแอปอื่น</p></html>`;
 await fs.writeFile(path.join(root,'revision-1.6.79.html'),html);console.log(summary);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
