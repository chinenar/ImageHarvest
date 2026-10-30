'use strict';
const fs = require('node:fs');
const {pathToFileURL} = require('node:url');
const {metrics} = require('./benchmark-ocr-accuracy.cjs');
const before = require('../test-results/ocr-accuracy/new-plant-1.6.80.json');
const after = require('../test-results/ocr-accuracy/new-plant-after.json');
const reference = require('../test/fixtures/ocr-new-plant-reference.json');
const a = before.result.regions.find(r => /ONater Edge/.test(r.text));
const b = after.result.regions.find(r => r.lineRecoveryEvidence?.some(e => e.to === 'Water Edge!'));
const expected = "That's right! I can just combine the poison with Water Edge!";
if (!a || !b || b.text.replace(/\s+/g, ' ').trim() !== expected) throw Error('Target sentence failed');
const score = metrics(after.result.regions, reference);
const escape = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
fs.writeFileSync('test-results/ocr-accuracy/plant-1.6.86.json', JSON.stringify({expected, before:a, after:b, metrics:score, result:after}, null, 2));
fs.writeFileSync('test-results/ocr-accuracy/revision-1.6.86.html', `<!doctype html><meta charset="utf-8"><title>OCR 1.6.86</title>
<style>body{font:18px system-ui;max-width:1000px;margin:24px auto;padding:24px;background:#f5f6f9}.pair{display:grid;grid-template-columns:1fr 1fr;gap:24px}section{background:white;padding:20px}svg{width:100%;height:300px}rect{fill:none;stroke:#087c50;stroke-width:1}pre{font:20px system-ui;white-space:pre-wrap}p{line-height:1.6}</style>
<h1>1.6.86 — อ่านซ้ำเฉพาะบรรทัดที่ผิด</h1>
<svg viewBox="890 780 335 255"><image href="${pathToFileURL(after.source).href}" width="1284" height="1826"/>${b.lineRecoveryEvidence.map(e=>`<rect x="${e.box.x0}" y="${e.box.y0}" width="${e.box.x1-e.box.x0}" height="${e.box.y1-e.box.y0}"/>`).join('')}</svg>
<div class="pair"><section><h2>ก่อนแก้</h2><pre>${escape(a.text)}</pre></section><section><h2>หลังแก้</h2><pre>${escape(b.text)}</pre></section></div>
<p>ใช้ขอบเขตบรรทัดจากตัวตรวจจับ อ่านภาพต้นฉบับและภาพปรับคอนทราสต์ ทั้งสองรอบต้องเห็นตรงกัน และมีคำอ่านจาก Tesseract สนับสนุน จึงแทนเฉพาะบรรทัดนั้น เก็บคำอ่านก่อนแก้และหลักฐานไว้ตรวจย้อนหลัง</p>
<p>เพิ่มการอ่าน 2 ครั้งต่อบรรทัดที่เข้าเงื่อนไข จำกัดไม่เกิน 2 บรรทัดต่อกล่อง ไม่ได้เพิ่มความเร็วและยังไม่ได้ยืนยันความแม่นกับภาพใหม่ที่ไม่เคยใช้พัฒนา</p>
<p>หน้านี้มีข้อความอ้างอิง 12 หน่วย: ตัวอักษรของคำอ่านที่ตรงที่สุดถูกครบ 12 หน่วย แต่คะแนนที่กำหนดให้มีกล่องตรงเพียงกล่องเดียวยังเป็น 11/12 เพราะกรอบป้ายข้างเคียงทับพื้นที่อ้างอิง ส่วนวรรคตอนถูก 10/12 เมื่อไม่นับช่องว่าง ยังมีป้าย POISON ข้อความขอบภาพ และลายมือที่อ่านผิด</p>`);
console.log('PASS: Water Edge target including spaces and punctuation; plant strict score '+score.exact+'/'+score.expected);
