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
    id: item.id, fingerprint: item.contentHash || idFor(item.url), url: item.url.startsWith('data:') ? '[embedded image]' : item.url,
    source: item.source, width: item.width, height: item.height, filterHints: item.filterHints,
    previewReady: item.previewReady !== false, ext: item.ext || '',
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
const NEXT_CHAPTER_RE = /(?:next\s*(?:chapter|chap(?:ter)?|episode|ep\.?|installment)|(?:chapter|episode)\s*next|ตอน(?:ถัด|ต่อ)ไป|ตอนหน้า|次の(?:話|章|回)|次話|下一(?:章|话|話|回)|다음\s*(?:화|회))/i;
const GENERIC_NEXT_RE = /(?:^|\b)(?:next|forward)(?:\b|$)|ถัดไป|ต่อไป|次へ|다음/i;
const PREVIOUS_RE = /(?:prev(?:ious)?|ก่อนหน้า|ย้อนกลับ|上一(?:章|话|話|回)|前の(?:話|章|回)|이전)/i;
const NEXT_PAGE_RE = /(?:next\s*page|page\s*next|หน้าถัดไป|หน้าต่อไป|次のページ|下一页|下一頁)/i;
const CHAPTER_WORD_RE = /(?:chapter|chap(?:ter)?|episode|ep\.?|ตอน(?:ที่)?|ตอน|第\s*\d+\s*(?:話|章|回)|(?:話|章|回)|화|회)/i;
function compactText(value = '') { return String(value).replace(/\s+/g, ' ').trim(); }
function chapterParts(value = '') {
  let text = compactText(value);
  try { text = decodeURIComponent(text); } catch {}
  const match = text.match(/(?:chapter|chap(?:ter)?|ch\.?|episode|ep\.?|ตอน(?:ที่)?|第)\s*#?\s*[-_/:]?\s*(\d+(?:(?:\.|-|_)\d+)*)/i);
  if (!match) return null;
  const parts = match[1].split(/[._-]/).map(Number);
  return parts.every(Number.isFinite) ? parts : null;
}
function compareChapterParts(a, b) {
  if (!a || !b) return 0;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const av = a[i] ?? 0, bv = b[i] ?? 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
}
function looseChapterParts(value = '') {
  let text = compactText(value);
  try { text = decodeURIComponent(text); } catch {}
  const match = text.match(/^\s*(?:ch(?:apter)?\s*[-_ ]*)?(\d+(?:(?:\.|-|_)\d+)*)\s*$/i);
  if (!match) return null;
  const parts = match[1].split(/[._-]/).map(Number);
  return parts.every(Number.isFinite) ? parts : null;
}
function numericGroups(value = '') {
  let text = String(value || '');
  try { text = decodeURIComponent(text); } catch {}
  return [...text.matchAll(/\d+(?:(?:\.|-|_)\d+)*/g)].map(m => m[0].split(/[._-]/).map(Number));
}
function siblingChapterParts(currentUrl, targetUrl, currentParts) {
  if (!currentParts) return null;
  try {
    const a = new URL(currentUrl), b = new URL(targetUrl);
    if (a.hostname !== b.hostname) return null;
    const ap = decodeURIComponent(a.pathname).split('/').filter(Boolean);
    const bp = decodeURIComponent(b.pathname).split('/').filter(Boolean);
    if (ap.length !== bp.length) return null;
    const changed = [];
    for (let i = 0; i < ap.length; i++) if (ap[i] !== bp[i]) changed.push(i);
    if (changed.length !== 1) return null;
    const ag = numericGroups(ap[changed[0]]), bg = numericGroups(bp[changed[0]]);
    if (ag.length !== bg.length) return null;
    let found = null, differences = 0;
    for (let i = 0; i < ag.length; i++) {
      if (compareChapterParts(ag[i], bg[i]) === 0) continue;
      differences++;
      if (compareChapterParts(ag[i], currentParts) === 0) found = bg[i];
    }
    return differences === 1 ? found : null;
  } catch { return null; }
}
function urlTailCarriesChapter(value, currentParts) {
  try {
    const url = new URL(value), segments = decodeURIComponent(url.pathname).split('/').filter(Boolean);
    if (!segments.length) return false;
    if (segments.length >= 3 && /^(?:chapter|chap|reader)$/i.test(segments[segments.length - 3]) &&
        !chapterParts(segments[segments.length - 2]) && !looseChapterParts(segments[segments.length - 2])) return false;
    return numericGroups(segments[segments.length - 1]).some(parts => compareChapterParts(parts, currentParts) === 0);
  } catch { return false; }
}
function replaceCurrentChapterInURL(value, currentParts, targetParts, hint = '') {
  try {
    const url = new URL(value), segments = url.pathname.split('/');
    for (let i = segments.length - 1; i >= 0; i--) {
      if (!segments[i]) continue;
      let decoded = decodeURIComponent(segments[i]);
      const matches = [...decoded.matchAll(/\d+(?:(?:\.|-|_)\d+)*/g)];
      for (let j = matches.length - 1; j >= 0; j--) {
        const match = matches[j], parts = match[0].split(/[._-]/).map(Number);
        if (compareChapterParts(parts, currentParts) !== 0) continue;
        const sep = match[0].match(/[._-]/)?.[0] || String(hint).match(/\d([._-])\d/)?.[1] || '.';
        const replacement = targetParts.join(sep);
        decoded = decoded.slice(0, match.index) + replacement + decoded.slice(match.index + match[0].length);
        segments[i] = encodeURIComponent(decoded);
        url.pathname = segments.join('/');
        return url.href;
      }
    }
  } catch {}
  return '';
}
function chapterNumber(value = '') {
  const parts = chapterParts(value);
  return parts ? Number(parts.join('.')) : null;
}
function canonicalDocumentURL(value) {
  const url = new URL(value);
  url.hash = '';
  return url.href.replace(/%[0-9a-f]{2}/gi, token => token.toUpperCase());
}
function sameDocument(a, b) {
  try { return canonicalDocumentURL(a) === canonicalDocumentURL(b); }
  catch { return String(a || '') === String(b || ''); }
}
function safeWebTarget(value, base) {
  try {
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    return url.href;
  } catch { return ''; }
}
function chapterResourceChanged(currentUrl, targetUrl) {
  try {
    const current = new URL(currentUrl), target = new URL(targetUrl);
    const a = decodeURIComponent(current.pathname).match(/\/chapter\/([^/]+)(?:\/\d+)?\/?$/i);
    const b = decodeURIComponent(target.pathname).match(/\/chapter\/([^/]+)(?:\/\d+)?\/?$/i);
    return Boolean(a && b && a[1] !== b[1]);
  } catch { return false; }
}
function scoreNextLink(currentUrl, page, candidate) {
  const target = safeWebTarget(candidate.href, currentUrl);
  if (!target || sameDocument(target, currentUrl)) return null;
  const current = new URL(currentUrl), next = new URL(target);
  if (current.hostname !== next.hostname) return null;
  const attrs = compactText([candidate.text, candidate.aria, candidate.title, candidate.id, candidate.className, candidate.desc].join(' '));
  const contextAttrs = compactText([attrs, candidate.parentText].join(' '));
  const pageContext = compactText([page.title, ...(page.headings || []), current.pathname].join(' '));
  const rel = compactText(candidate.rel).toLowerCase();
  const iconRight = /(?:chevron|arrow)[-_ ]?right/i.test(attrs);
  const iconLeft = /(?:chevron|arrow)[-_ ]?left/i.test(attrs);
  const resourceChanged = chapterResourceChanged(currentUrl, target);
  let score = 5; const reasons = ['same-host'];
  if (/(^|\s)next(\s|$)/.test(rel)) { score += 28; reasons.push('rel-next'); }
  if (candidate.sibling && /(^|\s)next(\s|$)/.test(rel)) { score += 45; reasons.push('rel-next-sibling-url'); }
  if (NEXT_CHAPTER_RE.test(attrs)) { score += 72; reasons.push('next-chapter-label'); }
  else if (GENERIC_NEXT_RE.test(attrs)) { score += 16; reasons.push('next-label'); }
  if (/(?:next[-_ ]?(?:chapter|chap|episode)|(?:chapter|chap|episode)[-_ ]?next)/i.test(attrs)) { score += 55; reasons.push('next-chapter-attr'); }
  if (iconRight && resourceChanged) { score += 86; reasons.push('chapter-resource-right'); }
  if (iconLeft && resourceChanged) { score -= 120; reasons.push('chapter-resource-left'); }
  if (CHAPTER_WORD_RE.test(contextAttrs)) { score += 14; reasons.push('chapter-context'); }
  if (CHAPTER_WORD_RE.test(pageContext)) { score += 10; reasons.push('page-chapter-context'); }
  if (/(?:chapter|chap(?:ter)?|episode|ep)[-_\/ ]?\d/i.test(next.pathname)) { score += 18; reasons.push('chapter-url'); }
  if (NEXT_PAGE_RE.test(attrs)) { score -= 95; reasons.push('page-next-penalty'); }
  if (PREVIOUS_RE.test(attrs)) { score -= 120; reasons.push('previous-penalty'); }
  const currentParts = chapterParts(pageContext);
  const siblingParts = siblingChapterParts(currentUrl, target, currentParts);
  const targetParts = chapterParts(attrs + ' ' + next.pathname) || siblingParts;
  if (siblingParts) { score += 45; reasons.push('same-series-sibling-url'); }
  if (currentParts && targetParts) {
    if (compareChapterParts(targetParts, currentParts) > 0) { score += 24; reasons.push('higher-chapter-number'); }
    else { score -= 45; reasons.push('not-higher-chapter-number'); }
  }
  return { url: target, score, reason: reasons.join(', '), text: compactText(candidate.text || candidate.aria || candidate.title || target), source: 'link' };
}
function nextFromSelect(currentUrl, page, select) {
  const selected = (select.options || []).find(x => x.selected) || (select.options || [])[select.selectedIndex];
  const pageContext = compactText([selected?.text, page.title, ...(page.headings || [])].join(' '));
  const currentParts = chapterParts(pageContext);
  if (!currentParts) return [];
  const selectedLoose = looseChapterParts(selected?.text) || looseChapterParts(selected?.value);
  const strongContext = CHAPTER_WORD_RE.test(select.label || '') || (select.options || []).some(x => CHAPTER_WORD_RE.test(x.text || ''));
  const urlContext = urlTailCarriesChapter(currentUrl, currentParts) && selectedLoose && compareChapterParts(selectedLoose, currentParts) === 0;
  if (!strongContext && !urlContext) return [];
  const rows = [];
  for (const option of select.options || []) {
    if (option === selected) continue;
    const rawValue = String(option.value || '').trim();
    const parts = chapterParts(option.text || '') || looseChapterParts(option.text) || chapterParts(rawValue) || looseChapterParts(rawValue);
    if (!parts || compareChapterParts(parts, currentParts) <= 0) continue;
    const rawParts = chapterParts(rawValue) || looseChapterParts(rawValue);
    let target = '';
    if (rawValue && (!rawParts || compareChapterParts(rawParts, parts) === 0)) target = safeWebTarget(rawValue, currentUrl);
    const inferred = replaceCurrentChapterInURL(currentUrl, currentParts, parts, option.text || rawValue);
    if (inferred) target = inferred;
    if (!target || sameDocument(target, currentUrl)) continue;
    const current = new URL(currentUrl), next = new URL(target);
    if (current.hostname !== next.hostname) continue;
    rows.push({ url: target, score: 90,
      reason: inferred ? 'chapter-select, inferred-sibling-url' : 'chapter-select, nearest-higher-chapter',
      text: compactText(option.text), source: 'select', parts });
  }
  return rows.sort((a, b) => compareChapterParts(a.parts, b.parts) || b.score - a.score);
}
function chapterIndexLink(currentUrl, page = {}) {
  const pageTitle = compactText(page.title || '').toLowerCase();
  const contextual = [];
  for (const link of page.links || []) {
    const target = safeWebTarget(link.href, currentUrl);
    if (!target || sameDocument(target, currentUrl)) continue;
    let targetUrl;
    try {
      targetUrl = new URL(target);
      if (targetUrl.hostname !== new URL(currentUrl).hostname) continue;
    } catch { continue; }
    const text = compactText(link.text);
    const context = compactText([text, link.parentText, link.aria, link.title].join(' '));
    if (/(?:all\s+chapters?|chapter\s+list|all\s+episodes?|ทุกตอน|ตอนทั้งหมด|รายการตอน|รวมตอน)/i.test(context))
      return { url:target, text, reason:'chapter-index-link' };
    const normalizedText = text.toLowerCase();
    if (/\/manga\//i.test(targetUrl.pathname) && normalizedText.length >= 8 &&
        pageTitle.includes(normalizedText))
      contextual.push({ url:target, text, reason:'series-breadcrumb-index', length:normalizedText.length });
  }
  contextual.sort((a,b) => b.length - a.length);
  return contextual[0] || null;
}
function nextFromChapterListing(currentUrl, currentPage = {}, listingPage = {}) {
  const currentContext = compactText([currentPage.title, ...(currentPage.headings || []), currentUrl].join(' '));
  const rows = [];
  for (const link of listingPage.links || []) {
    const direct = compactText(link.text || '');
    if (!/^(?:ตอน(?:ที่)?|chapter|chap(?:ter)?|ch\.?)\s*#?\s*\d/i.test(direct)) continue;
    const parts = chapterParts(direct) || looseChapterParts(direct.replace(/^(?:ตอน(?:ที่)?|chapter|chap(?:ter)?|ch\.?)\s*#?\s*/i,''));
    if (!parts) continue;
    const target = safeWebTarget(link.href, listingPage.url || currentUrl);
    if (!target) continue;
    try { if (new URL(target).hostname !== new URL(currentUrl).hostname) continue; } catch { continue; }
    rows.push({ url:target, parts, text:direct, reason:'chapter-index, nearest-higher-chapter', source:'index' });
  }
  const currentRow = rows.find(row => sameDocument(row.url, currentUrl));
  const currentParts = chapterParts(currentContext) || currentRow?.parts || null;
  if (!currentParts) return null;
  const higher = rows.filter(row => !sameDocument(row.url, currentUrl) && compareChapterParts(row.parts, currentParts) > 0);
  higher.sort((a,b) => compareChapterParts(a.parts,b.parts));
  return higher[0] || null;
}
function chooseNextAction(page = {}) {
  const rows = [];
  for (const candidate of [...(page.controls || []), ...(page.links || [])]) {
    if (candidate.disabled) continue;
    const direct = compactText([candidate.text, candidate.aria, candidate.title, candidate.id, candidate.className, candidate.desc].join(' '));
    const href = compactText(candidate.href || ''), rel = compactText(candidate.rel || '').toLowerCase();
    if (NEXT_PAGE_RE.test(direct) || PREVIOUS_RE.test(direct) || /(?:^|[-_ ])prev(?:$|[-_ ])/i.test(direct)) continue;
    let score = 0, reason = [];
    if (NEXT_CHAPTER_RE.test(direct)) { score += 90; reason.push('next-chapter-control'); }
    if (/(?:^|[-_ ])(?:ch|chap|chapter)[-_ ]*next(?:$|[-_ ])|next[-_ ]*(?:ch|chap|chapter)/i.test(direct)) { score += 85; reason.push('chapter-next-class'); }
    if (/(^|\s)next(\s|$)/.test(rel) && /#\/?next\/?$/i.test(href) && /(?:ch|chap|chapter)/i.test(direct)) {
      score += 85; reason.push('chapter-next-hash');
    }
    if (GENERIC_NEXT_RE.test(direct)) { score += 10; reason.push('next-control'); }
    if (score >= 75) rows.push({ action:'click', confidence:Math.min(100,score), text:compactText(candidate.text || candidate.aria || candidate.title || 'ตอนถัดไป'), reason:reason.join(', ') });
  }
  rows.sort((a,b) => b.confidence - a.confidence);
  return rows[0] || null;
}
function chooseNextChapter(currentUrl, page = {}) {
  const candidates = [];
  for (const link of page.links || []) {
    const scored = scoreNextLink(currentUrl, page, link);
    if (scored) candidates.push(scored);
  }
  for (const select of page.selects || []) candidates.push(...nextFromSelect(currentUrl, page, select));
  candidates.sort((a, b) => {
    const score = b.score - a.score;
    if (score) return score;
    if (a.source === 'select' && b.source === 'select') return compareChapterParts(a.parts, b.parts);
    if (a.source === 'select') return -1;
    if (b.source === 'select') return 1;
    return 0;
  });
  const best = candidates[0] || null;
  const action = chooseNextAction(page);
  const inferredOnly = best?.source === 'select' && /inferred-sibling-url/.test(best.reason || '');
  if (inferredOnly && action && action.confidence >= Math.min(100, best.score))
    return { url:'', ...action, inferredUrl:best.url, inferredText:best.text, bestRejected:best };
  if (best && best.score >= 65) return { ...best, confidence: Math.min(100, best.score) };
  if (action) return { url:'', ...action, bestRejected:best };
  return { url: '', confidence: 0, reason: 'ไม่พบลิงก์หรือตัวควบคุมตอนถัดไปที่มั่นใจพอ', bestRejected: best };
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
module.exports = { pageURL, imageURL, safeName, imageType, publicItem, orderItems, uniqueItems, isImageFilename, renamePlan, chooseNextChapter, chooseNextAction, chapterIndexLink, nextFromChapterListing, chapterNumber, chapterParts, compareChapterParts, idFor, delay, ByteCache };
