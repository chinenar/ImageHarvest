'use strict';
const fs=require('node:fs');
const results=require('../test-results/ocr-accuracy/cleanup-summary-1.6.89.json');
const before=results.find(r=>r.phase==='before').regions,after=results.find(r=>r.phase==='after').regions;
if(after.length!==2||after.some(r=>r.paintMode!=='none'||!(r.ownership.protectedPixels>0)))throw Error('Expected guarded shared-ink examples');
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');
fs.writeFileSync('test-results/ocr-accuracy/revision-1.6.89.html',`<!doctype html><html lang="th"><meta charset="utf-8"><title>OCR 1.6.89 — ป้องกันลบข้อความข้างเคียง</title><style>body{font:18px system-ui;max-width:1150px;margin:24px auto;padding:24px;background:#f4f6f9;color:#182139}p{line-height:1.65}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}article,aside{background:white;padding:18px;border-radius:12px}img{width:100%}h2{font-size:21px}table{border-collapse:collapse;width:100%;background:white;margin:24px 0}td,th{text-align:left;padding:14px;border-bottom:1px solid #ddd}aside{border-left:5px solid #c68431}@media(max-width:750px){.cards{grid-template-columns:1fr}}</style>
<h1>1.6.89 — ป้องกันพื้นที่ลบกินคำข้างเคียง</h1><p><b>ภาพสีแดงคือพื้นที่ลบที่เสนอสำหรับตรวจ ไม่ใช่ภาพคลีนสำเร็จ</b> มาสก์เดิมกินถึงรูปขวดและคำข้างเคียง ระบบใหม่กันส่วนที่เชื่อมกับคำข้างเคียงไว้ และปิดการลงมาสก์อัตโนมัติเมื่อยังแยกเจ้าของหมึกไม่ได้</p>
<div class="cards">${[['source','ภาพต้นฉบับ'],['before','พื้นที่ลบเดิม'],['after','พื้นที่ลบหลังป้องกันคำข้างเคียง']].map(([id,title])=>`<article><h2>${title}</h2><img src="cleanup-${id}-1.6.89.png" alt="${title}"></article>`).join('')}</div>
<table><tr><th>กรอบ</th><th>พิกเซลในมาสก์เดิม</th><th>หลังป้องกัน</th><th>กันออกจากมาสก์</th></tr>${after.map((r,i)=>`<tr><td>${i?'POISON':'ประโยค Water Edge!'}</td><td>${before[i].pixels}</td><td>${r.pixels}</td><td>${r.ownership.protectedPixels}</td></tr>`).join('')}</table>
<aside><h2>ยังไม่แยกคู่นี้อัตโนมัติ</h2><p>ทั้งสองกรอบถูกพักการลบไว้ การยืนยันว่าคำอ่านถูกไม่ได้ปลดข้อจำกัดนี้ เพราะขอบเขตหมึกยังไม่ยืนยัน มาสก์ทดลองยังครอบบางส่วนของรูปขวด จึงยังไม่ใช้กับภาพจริง</p><p>ตัวเลขในตารางคือจำนวนพิกเซลที่กันออกจากมาสก์เสนอ ไม่ใช่คะแนนความแม่นหรือจำนวนพิกเซลผิดที่มีผู้ตรวจครบแล้ว</p></aside>
<p>ผ่าน 206 tests รวมการป้องกันคำข้างเคียงใน padding หมึกที่เชื่อมกัน บอลลูนปกติ พื้นหลังมืด และการกันมาสก์ที่ยังไม่ยืนยันออกจาก overlay ตรวจเพิ่มกับภาพ ALRIGHT/BARRIER ญี่ปุ่นแนวตั้ง DIE และหน้า Water Edge โดยไม่เรียก OCR ใหม่หรือเปลี่ยนคำอ่าน</p></html>`);
console.log('PASS: guarded cleanup report');
