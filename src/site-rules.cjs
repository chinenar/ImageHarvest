'use strict';
const { createHash } = require('node:crypto');
const RULE_VERSION = '2026-09-18.1';
const PENGI_HASH = '0f2664ca4e355babe279bae104d53c93ead7b5bc4dded70666e539090c805dd6';
const PENGI_PATH = '/_nuxt/C5dBfbRQ.js';
const MAX_SCRIPT = 2 * 1024 * 1024;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function siteForURL(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return '';
    return u.hostname === 'ntrnaja.com' ? 'ntrnaja' : u.hostname === 'pengi.co' ? 'pengi' : '';
  } catch { return ''; }
}
function ntrBlockedScript(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
    return (u.hostname === 'cdn.jsdelivr.net' && u.pathname === '/npm/disable-devtool@0.3.9') ||
      (u.hostname === 'ntrnaja.com' && u.pathname === '/wp-content/plugins/wccp-pro/index.js');
  } catch { return false; }
}
function patchPengi(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_SCRIPT || sha256(bytes) !== PENGI_HASH)
    throw new Error('Pengi เปลี่ยนไฟล์ตัวอ่าน: หยุดโหมดนี้ไว้ก่อน ต้องตรวจและอัปเดตกฎใหม่');
  let text = bytes.toString('utf8');
  const startMark = 'Pe(()=>{if(document.visibilityState==="visible"&&ne.value&&document.visibilityState==="visible"){';
  const endMark = 'startBoom()}},1e3)';
  const start = text.indexOf(startMark), end = text.indexOf(endMark, start);
  if (start < 0 || end < start || text.indexOf(startMark, start + 1) !== -1 || text.split('ut.launch()').length !== 2)
    throw new Error('Pengi: จุดปรับโค้ดไม่ตรงกับรุ่นที่ตรวจแล้ว');
  // Only the reviewed harmful callback and detector launch are removed.
  // Reader, entitlement, API, watermark, timers and observers remain unchanged.
  text = text.slice(0, start) + 'void 0' + text.slice(end + endMark.length);
  text = text.replace('ut.launch()', 'void 0');
  if (text.includes('new Array(5e6)') || text.includes('window.startBoom'))
    throw new Error('Pengi: การแยกส่วนที่ทำให้แท็บค้างไม่สมบูรณ์');
  return Buffer.from(text, 'utf8');
}
function classifyPengi(pathname, bytes) {
  if (sha256(bytes) === PENGI_HASH) return 'reviewed';
  if (pathname === PENGI_PATH || /DevtoolsDetector|window\.startBoom|new Array\(5e6\)/.test(bytes.toString('utf8')))
    return 'unknown-guard';
  return 'unrelated';
}
function modifiedHeaders(headers, size) {
  const removed = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'etag', 'content-md5', 'digest']);
  return [...headers.filter(h => !removed.has(h.name.toLowerCase())), { name: 'Content-Length', value: String(size) }];
}
module.exports = { RULE_VERSION, PENGI_HASH, PENGI_PATH, MAX_SCRIPT, sha256, siteForURL, ntrBlockedScript, patchPengi, classifyPengi, modifiedHeaders };
