'use strict';
const crypto = require('node:crypto');

function pageURL(value) {
  let text = String(value ?? '').trim();
  if (!text || text.length > 8192) throw new Error('กรุณาใส่ URL เว็บไซต์ให้ถูกต้อง');
  if (!/^[a-z][a-z\d+.-]*:/i.test(text)) text = `https://${text}`;
  let u;
  try { u = new URL(text); } catch { throw new Error('URL ไม่ถูกต้อง'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password)
    throw new Error('รองรับเฉพาะ http / https และไม่รองรับรหัสผ่านที่ฝังใน URL');
  return u.href;
}
function imageURL(value, base) {
  try {
    const u = new URL(value, base);
    if (!['http:', 'https:', 'data:', 'blob:'].includes(u.protocol)) return null;
    if (u.username || u.password) return null;
    if (u.protocol === 'data:' && !/^data:image\//i.test(value)) return null;
    return u.href;
  } catch { return null; }
}
function safeName(value, fallback = 'images') {
  const out = String(value ?? '').normalize('NFKC')
    .replace(/[<>:"/\\|?*\x00-\x1F\x7F]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, 70);
  if (!out || /^\.+$/.test(out)) return fallback;
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(out) ? `_${out}` : out;
}
function imageType(buf, contentType = '') {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { ext: 'png', mime: 'image/png' };
  if (buf[0] === 255 && buf[1] === 216 && buf[2] === 255) return { ext: 'jpg', mime: 'image/jpeg' };
  const head = buf.subarray(0, 256).toString('latin1');
  if (/^GIF8[79]a/.test(head)) return { ext: 'gif', mime: 'image/gif' };
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  if (head.slice(4, 8) === 'ftyp' && /avif|avis/.test(head.slice(8, 64))) return { ext: 'avif', mime: 'image/avif' };
  if (head.startsWith('BM')) return { ext: 'bmp', mime: 'image/bmp' };
  if (buf.length >= 4 && buf.readUInt32LE(0) === 65536) return { ext: 'ico', mime: 'image/x-icon' };
  const xml = buf.subarray(0, 8192).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(xml)) return { ext: 'svg', mime: 'image/svg+xml' };
  throw new Error(`ข้อมูลที่ได้รับไม่ใช่ไฟล์ภาพที่รองรับ (${contentType || 'ไม่ทราบชนิด'})`);
}
function publicItem(item) {
  return {
    id: item.id, fingerprint: idFor(item.url), url: item.url.startsWith('data:') ? '[embedded image]' : item.url,
    source: item.source, width: item.width, height: item.height,
    top: item.top, left: item.left, order: item.order, alt: item.alt,
    label: item.label || (item.url.startsWith('data:') ? 'Embedded image' : decodeName(item.url))
  };
}
function decodeName(url) {
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || new URL(url).host).slice(0, 160); }
  catch { return 'image'; }
}
function orderItems(items, mode = 'visual') {
  return [...items].sort((a, b) => {
    if (mode === 'dom') return a.order - b.order;
    if (mode === 'name') return decodeName(a.url).localeCompare(decodeName(b.url), undefined, { numeric: true }) || a.order - b.order;
    if (mode === 'right') return a.top - b.top || b.left - a.left || a.order - b.order;
    return a.top - b.top || a.left - b.left || a.order - b.order;
  });
}
function uniqueItems(items) {
  const seen = new Set();
  return items.filter(item => { if (seen.has(item.url)) return false; seen.add(item.url); return true; });
}
const IMAGE_FILE_RE = /\.(?:jpe?g|png|webp|avif|gif|bmp|ico|svg)$/i;
function isImageFilename(name) { return IMAGE_FILE_RE.test(String(name || '')); }
function renamePlan(names, { reverse = false, start = 1, padding = 4 } = {}) {
  start = Math.max(0, Math.min(99999999, Math.trunc(Number(start) || 1)));
  padding = Math.max(1, Math.min(8, Math.trunc(Number(padding) || 4)));
  const ordered = names.filter(isImageFilename).sort((a,b) => a.localeCompare(b, undefined, { numeric:true, sensitivity:'base' }));
  if (reverse) ordered.reverse();
  return ordered.map((from, i) => {
    const dot = from.lastIndexOf('.'), ext = from.slice(dot).toLowerCase();
    return { from, to: `${String(start + i).padStart(padding, '0')}${ext}`, page: start + i };
  });
}
const idFor = key => crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
class ByteCache {
  constructor(limit = 128 * 1024 * 1024) { this.limit = limit; this.bytes = 0; this.map = new Map(); }
  get(id) {
    const value = this.map.get(id);
    if (value) { this.map.delete(id); this.map.set(id, value); }
    return value;
  }
  set(id, value) {
    if (this.map.has(id)) { this.bytes -= this.map.get(id).buffer.length; this.map.delete(id); }
    if (value.buffer.length > this.limit) return;
    while (this.bytes + value.buffer.length > this.limit && this.map.size) {
      const first = this.map.keys().next().value;
      this.bytes -= this.map.get(first).buffer.length; this.map.delete(first);
    }
    this.map.set(id, value); this.bytes += value.buffer.length;
  }
  clear() { this.map.clear(); this.bytes = 0; }
}
module.exports = { pageURL, imageURL, safeName, imageType, publicItem, orderItems, uniqueItems, isImageFilename, renamePlan, idFor, delay, ByteCache };
