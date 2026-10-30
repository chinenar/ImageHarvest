'use strict';
const fs=require('node:fs'),{pathToFileURL}=require('node:url');
const {metrics}=require('./benchmark-ocr-accuracy.cjs');
const previous=require('../test-results/ocr-accuracy/romance-1.6.83.json');
const before=previous.result,after=require('../test-results/ocr-accuracy/new-romance-after.json');
const reference={...previous.reference,units:[...previous.reference.units,
 {text:"IT DOESN'T SEEM LIKE IT CAN GO ANY LOWER...",box:[967,209,1075,420]},
 {text:'...OPPORTUNITY?',box:[73,1171,239,1220]}]};
const bm=metrics(before.result.regions,reference),am=metrics(after.result.regions,reference);
const count=m=>m.units.filter(u=>u.exactTranscription&&u.matches===1).length;
if(count(am)!==6)throw Error('Punctuation reference failed');
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');
const view=(r,box)=>`<svg viewBox="${box}"><image href="${pathToFileURL(after.source).href}" width="1132" height="1607"/>${(r.punctuationEvidence||[]).flatMap(e=>e.boxes).map(b=>`<rect x="${b.x0-1}" y="${b.y0-1}" width="${b.x1-b.x0+2}" height="${b.y1-b.y0+2}"/>`).join('')}</svg>`;
const lower=after.result.regions.find(r=>/LOWER/.test(r.text)),opportunity=after.result.regions.find(r=>/OPPORTUNITY\?/.test(r.text));
fs.writeFileSync('test-results/ocr-accuracy/romance-1.6.84.json',JSON.stringify({reference,before:bm,after:am,result:after},null,2));
fs.writeFileSync('test-results/ocr-accuracy/revision-1.6.84.html',`<!doctype html><meta charset="utf-8"><title>OCR 1.6.84</title><style>body{font:18px system-ui;max-width:1100px;margin:32px auto;padding:24px;background:#f5f6f9}.pair{display:grid;grid-template-columns:1fr 1fr;gap:24px}section{background:white;padding:24px}svg{width:100%}rect{fill:none;stroke:#059b59;stroke-width:.6}td,th{padding:14px;border:1px solid #ccc;white-space:pre-wrap}table{border-collapse:collapse;background:white;width:100%}</style><h1>1.6.84 — ยืนยันวรรคตอนจากภาพ</h1><p>หกหน่วยในหน้านี้ ตัวอักษรและวรรคตอนครบจาก ${count(bm)}/6 → ${count(am)}/6 (ไม่นับช่องว่าง) ไม่ใช่คะแนนทั้งหน้า</p><div class="pair"><section><h2>LOWER...</h2>${view(lower,'956 383 128 46')}</section><section><h2>...OPPORTUNITY?</h2>${view(opportunity,'68 1165 181 66')}</section></div><p>กรอบเขียวคือจุดสามจุดที่พบในพิกเซลต้นฉบับ ต้องพบตรงกันในสองเกณฑ์แยกสี และมีคำอ่านดังกล่าวในผล OCR อยู่แล้ว ไม่สร้างประโยคใหม่จากการคาดเดา</p><table><tr><th>ก่อน</th><th>หลัง</th></tr>${[4,5].map(i=>`<tr><td>${esc(bm.units[i].actual)}</td><td>${esc(am.units[i].actual)}</td></tr>`).join('')}</table><p>ตัด / หน้า OPPORTUNITY เฉพาะเมื่อเส้นนั้นเป็นขอบภาพที่ลากผ่านความสูงของภาพตัด และมีสามจุดถัดมา ทั้งคำอ่านเดิมและหลักฐานตำแหน่งยังถูกเก็บไว้</p><p>ช่องว่าง CAN GO ยังติดเป็น CANGO ส่วนเอฟเฟกต์และตัวเขียนเล็กยังต้องแก้ต่อ ไม่ได้ยืนยันความถูกต้องทั้งหน้า</p>`);
console.log({before:count(bm),after:count(am)});
