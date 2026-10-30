'use strict';
const fs=require('node:fs'),{pathToFileURL}=require('node:url');
const {metrics}=require('./benchmark-ocr-accuracy.cjs');
const {translationEligible}=require('../src/ocr-content-role.cjs');
const before=require('../test-results/ocr-accuracy/plant-1.6.86.json').result;
const after=require('../test-results/ocr-accuracy/plant-1.6.87.json');
const heading=require('../test-results/ocr-accuracy/after-1.6.87/short-heading.json');
const oldHeading=require('../test-results/ocr-accuracy/after-1.6.86/short-heading.json');
const normalized=s=>s.replace(/\s+/g,' ').trim();
const specs=[
 {name:'ป้ายสั้น',old:r=>r.text==='POISOM',next:r=>r.text==='POISON',expected:'POISON',crop:[895,950,155,95]},
 {name:'ข้อความเล็กชิดขอบภาพ',old:r=>r.text.startsWith('omfg'),next:r=>r.text.startsWith('omfg'),expected:'omfg stop...STOP',crop:[1155,1285,129,85]},
 {name:'ข้อความหมุน 90°',old:r=>r.text.startsWith(', p'),next:r=>Boolean(r.textRotation),expected:'did he not hear me when i said "cringe"?',crop:[48,745,44,510]},
 {name:'จุดที่ถูกอ่านเป็นจุลภาค',old:r=>r.text.startsWith('Just,'),next:r=>r.text.startsWith('Just,'),expected:"Just, Even if I can make poison, I can't get it out of my body.",crop:[840,410,190,65]},
 {name:'จุดท้ายประโยคที่ตกหล่น',old:r=>r.text.startsWith('This is'),next:r=>r.text.startsWith('This is'),expected:'This is quite difficult.',crop:[510,1350,160,145]},
];
const targets=specs.map(s=>{const a=before.result.regions.find(s.old),b=after.result.regions.find(s.next);if(!a||!b||normalized(b.text)!==s.expected)throw Error('Target failed: '+s.name);return {...s,before:a,after:b,source:after.source,width:1284,height:1826};});
const a=oldHeading.result.regions.find(r=>r.text.includes('ADRIAN')),b=heading.result.regions.find(r=>r.text.includes('ADRIAN'));
if(normalized(b.text)!=='THE G-GOOD-FOR-N... NO, ADRIAN!!')throw Error('Heading punctuation failed');
targets.push({name:'จุดไข่ปลาครบสามจุด',before:a,after:b,source:heading.source,width:heading.result.detection.width,height:heading.result.detection.height,crop:[120,12350,440,160]});
const glyph=after.result.regions.find(r=>r.scriptConflictEvidence),overlaps=after.result.regions.filter(r=>r.overlapReview);
if(glyph?.scriptConflictEvidence.text!=='ち'||translationEligible(glyph)||overlaps.length!==2||overlaps.some(r=>translationEligible(r)))throw Error('Review guards failed');
const plant=metrics(after.result.regions,require('../test/fixtures/ocr-new-plant-reference.json'));
const regression=fs.readdirSync('test-results/ocr-accuracy/after-1.6.87').filter(f=>f!=='runtime.json'&&f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync('test-results/ocr-accuracy/after-1.6.87/'+f)));
const units=regression.flatMap(r=>r.metrics.units),exact=units.filter(u=>u.exact&&u.matches===1).length,punct=units.filter(u=>u.exactTranscription&&u.matches===1).length;
if(exact!==11||punct!==11||regression.length!==8)throw Error('Regression failed');
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');
let imageIndex=0;
const svg=t=>{const [x,y,w,h]=t.crop,id='source-'+imageIndex++,rotated=t.after.textRotation===90;return '<svg viewBox="'+(rotated?'0 0 '+h+' '+w:t.crop.join(' '))+'"><defs><clipPath id="'+id+'"><rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'"/></clipPath></defs><g transform="'+(rotated?'translate('+h+' 0) rotate(90) translate('+(-x)+' '+(-y)+')':'')+'"><image clip-path="url(#'+id+')" href="'+pathToFileURL(t.source).href+'" width="'+t.width+'" height="'+t.height+'"/></g></svg>';};
fs.writeFileSync('test-results/ocr-accuracy/revision-1.6.87.html',`<!doctype html><html lang="th"><meta charset="utf-8"><title>OCR 1.6.87 — แก้หลายรูปแบบ</title>
<style>body{font:18px system-ui;max-width:1100px;margin:24px auto;padding:24px;background:#f3f5f9;color:#19233a}p{line-height:1.65}.cards{display:grid;grid-template-columns:1fr 1fr;gap:20px}article,aside{background:white;border-radius:12px;padding:22px;margin-bottom:20px}svg{width:100%;height:150px;background:#eee}pre{white-space:pre-wrap;font:17px system-ui;margin:8px 0}.before{color:#925323}.after{color:#126341}h2{font-size:22px}.warning{border-left:5px solid #dd9135}small{color:#56627a}@media(max-width:750px){.cards{grid-template-columns:1fr}}</style>
<h1>1.6.87 — แก้หลายรูปแบบในรอบเดียว</h1>
<p>ชุดภาพเดิม 8 เคส / 6 ภาพ: ตัวอักษรและวรรคตอนตรง 11/11 หน่วยอ้างอิง (ไม่นับช่องว่าง) ส่วนหน้า Water Edge! คำอ่านที่ตรงที่สุดครบ 12/12 รวมวรรคตอน แต่คะแนนที่ต้องมีกล่องตรงเพียงกล่องเดียวยัง ${plant.exact}/12 เพราะกรอบป้ายกับคำพูดทับกัน</p>
<div class="cards">${targets.map(t=>`<article><h2>${t.name}</h2>${svg(t)}<small>ก่อน</small><pre class="before">${esc(normalized(t.before.text))}</pre><small>หลัง</small><pre class="after">${esc(normalized(t.after.text))}</pre></article>`).join('')}</div>
<aside class="warning"><h2>ยังต้องตรวจ: ลายมือและขอบเขตที่ทับกัน</h2><p>ลายมือ ${esc(glyph.text)} มีคำอ่านอีกโมเดลเป็น <b>${esc(glyph.scriptConflictEvidence.text)}</b> เก็บไว้ให้เลือกใน OCR Lab และยังไม่ส่งแปลอัตโนมัติ เพราะการเห็นตรงกันของโมเดลเดียวไม่พอยืนยันภาษา</p><p>POISON กับ Water Edge! อ่านได้แล้ว แต่กรอบยังทับกัน จึงแสดงคำเตือนให้ตรวจขอบเขตและกันไว้จากการแปลอัตโนมัติ ไม่ตัดกรอบทิ้งจนตัวอักษรหาย</p></aside>
<p>ตรวจโค้ด 199 tests และทดลองเลือกคำอ่าน / ยืนยันผลใน OCR Lab จริงผ่านแล้ว การอ่านซ้ำเพิ่มเฉพาะกรณีเข้าเงื่อนไข ยังไม่สรุปว่าเร็วขึ้นหรือแม่นครบทั้งคลังภาพ เอฟเฟกต์ลายมือยาวที่พาดผ่านภาพยังไม่ถือว่าแก้สำเร็จ</p></html>`);
fs.writeFileSync('test-results/ocr-accuracy/summary-1.6.87.json',JSON.stringify({targets:targets.map(t=>({name:t.name,before:t.before.text,after:t.after.text})),plant,regression:{cases:8,exact,punct},scriptConflict:glyph.scriptConflictEvidence.text,overlapReview:overlaps.map(r=>r.text)},null,2));
console.log('PASS: six corrections, script alternatives, overlap guards and 11/11 regression');
