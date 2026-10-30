'use strict';
const $ = id => document.getElementById(id);
let catalog = null, selected = null, record = null, mode = 'raw', regionIndex = -1, zoom = 0, requestId = 0, refreshing = false;
let marks = {}; try { marks = JSON.parse(localStorage.getItem('ocr-audit-marks-v1') || '{}'); } catch {}
const statusNames = { done: 'ตรวจระบบเสร็จ', pending: 'รอประมวลผล', error: 'ข้อผิดพลาด' };
const markNames = { ok: 'ดูแล้ว ✓', issue: 'พบปัญหา !', later: 'ดูอีกครั้ง' };
const node = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; };
const reviewCount = c => (c.metrics?.review || 0) + (c.metrics?.placementReview || 0) + (c.metrics?.cleanupModelErrors || 0) + (c.metrics?.refinementErrors || 0);
const markKey = c => c.sourceHash || c.id;
const duration = ms => ms == null ? '—' : ms >= 60000 ? (ms / 60000).toFixed(1) + ' นาที' : (ms / 1000).toFixed(1) + ' วินาที';
const confidence = value => value == null ? '—' : (Number(value) <= 1 ? Number(value) * 100 : Number(value)).toFixed(1) + '%';
const referencesDetails = node('details'); referencesDetails.id = 'referenceDetails'; referencesDetails.append(node('summary', '', 'หน้าอ้างอิงที่มีกรอบเฉลย'), node('div', 'references')); document.querySelector('.overview').append(referencesDetails);
function filtered() {
  const term = $('search').value.trim().toLocaleLowerCase(), group = $('group').value, filter = $('filter').value;
  return (catalog?.cases || []).filter(c => {
    if (group && c.group !== group) return false;
    if (term && ![c.relative, c.group, c.text].join(' ').toLocaleLowerCase().includes(term)) return false;
    if (['done', 'pending', 'error'].includes(filter)) return c.state === filter;
    if (filter === 'review') return c.state !== 'pending' && reviewCount(c) > 0;
    if (filter === 'slow') return c.timings?.totalMs >= 60000;
    if (filter === 'unseen') return !marks[markKey(c)]?.status;
    if (filter === 'marked') return Boolean(marks[markKey(c)]?.status);
    return true;
  });
}
function renderStats() {
  const cases = catalog.cases, completed = cases.filter(c => c.state !== 'pending').length;
  const stats = [ [completed + ' / ' + catalog.totalImages, 'ประมวลผลแล้ว', ''], [cases.filter(c => c.state === 'pending').length, 'รอประมวลผล', ''], [cases.filter(c => reviewCount(c) > 0).length, 'ภาพที่ระบบให้ตรวจเพิ่ม', 'review'], [cases.filter(c => c.state === 'error').length, 'ภาพที่เกิดข้อผิดพลาด', 'error'], [cases.filter(c => marks[markKey(c)]?.status).length, 'ภาพที่คุณตรวจแล้ว', ''], [catalog.totalGroups || new Set(cases.map(c => c.group)).size, 'กลุ่มภาพ', ''] ];
  $('stats').replaceChildren(...stats.map(([value, label, cls]) => { const el = node('div', 'stat ' + cls); el.append(node('strong', '', value), node('span', '', label)); return el; }));
  $('progressBar').style.width = (100 * completed / (catalog.totalImages || 1)) + '%';
  $('version').textContent = catalog.version ? 'v' + catalog.version : '';
  const at = catalog.summary?.updatedAt;
  $('liveStatus').textContent = catalog.state === 'waiting' ? 'รอเริ่มชุดข้อมูล' : (catalog.summary?.state === 'complete' ? 'ประมวลผลครบแล้ว' : 'อัปเดตอัตโนมัติทุก 10 วินาที') + (at ? ' · ' + new Date(at).toLocaleTimeString('th-TH') : '');
  const executions = catalog.suites?.suites || [], finalSuites = new Map();
  executions.forEach(s => finalSuites.set(s.name.replace(/-(retry|repaired)$/, ''), s));
  const suites = [...finalSuites.values()];
  $('suiteDetails').hidden = !suites.length;
  $('suiteCount').textContent = suites.length ? '· ผ่าน ' + suites.filter(s => s.exitCode === 0).length + ' / ' + suites.length : '';
  $('suites').replaceChildren(...suites.map(s => { const a = node('a', s.exitCode === 0 ? '' : 'failed', (s.exitCode === 0 ? '✓ ' : '✕ ') + s.name); a.href = '/suite/' + encodeURIComponent(s.name); a.target = '_blank'; a.rel = 'noopener'; return a; }));
  const unresolved = suites.filter(s => s.exitCode !== 0); if (unresolved.length) { const note = node('p', '', 'ยังไม่ผ่าน: ' + unresolved.map(s => s.name.replace(/-repaired$/, '')).join(' · ') + ' — คลิกชื่อชุดเพื่ออ่าน log (นับสถานะล่าสุดแยกชุด ไม่บวกรอบทดสอบซ้ำ)'); $('suites').append(note); }
  referencesDetails.hidden = !catalog.references?.length;
  const referenceBody = referencesDetails.querySelector('.references'); referenceBody.replaceChildren();
  if (catalog.references?.length) referenceBody.append(node('p', '', 'กรอบเฉลยครอบคลุมเฉพาะหน้าที่ระบุ ชุดอ้างอิงอาจซ้อนกัน จึงไม่รวมตัวหารเป็นคะแนนทั้งหมด • การจับคู่กรอบยังไม่ยืนยันว่าถอดข้อความครบ'));
  for (const group of catalog.references || []) {
    const block = node('div', 'reference-group'); block.append(node('strong', '', group.id));
    const table = node('table'); const head = node('tr'); ['หน้า', 'ขอบเขต', 'สถานะ', 'OCR จับคู่ / เฉลย', 'แผน จับคู่ / เฉลย'].forEach(t => head.append(node('th', '', t))); table.append(head);
    for (const p of group.pages) { const tr = node('tr'), label = node('td'); if (p.id) { const a = node('a', '', p.label); a.href = '/?page=' + p.id; a.onclick = e => { e.preventDefault(); selectPage(p.id); }; label.append(a); } else label.textContent = p.label; tr.append(label, node('td', '', p.coverage === 'complete-page' ? 'เฉลยทั้งหน้า' : 'เฉลยบางส่วน'), node('td', '', ({ scored: 'เทียบแล้ว', pending: 'รอผล', stale: 'ผลเก่า', failed: 'ผิดพลาด', 'outside-corpus': 'นอกชุด 589 ภาพ' })[p.status] || p.status), node('td', '', p.status === 'scored' && p.raw ? p.raw.matched + ' / ' + p.annotatedUnits : '—'), node('td', '', p.status === 'scored' && p.planned ? p.planned.matched + ' / ' + p.annotatedUnits : '—')); table.append(tr); } block.append(table); referenceBody.append(block);
  }
}
function makeCard(c) {
  const card = node('button', 'card'); card.dataset.id = c.id;
  const thumb = node('img', 'thumb'); thumb.loading = 'lazy'; thumb.decoding = 'async'; thumb.src = '/thumb/' + c.id; thumb.alt = c.relative;
  const body = node('div', 'card-body'); body.append(node('div', 'card-name', c.relative.split('/').at(-1)), node('span', 'tag status'), node('span', 'tag review review-tag'));
  card.append(thumb, body, node('span', 'tag marked')); card.onclick = () => selectPage(c.id); card.title = c.relative;
  updateCard(card, c); return card;
}
function updateCard(card, c) {
  card.classList.toggle('selected', selected?.id === c.id);
  const status = card.querySelector('.status'); status.className = 'tag status ' + c.state; status.textContent = statusNames[c.state];
  const review = card.querySelector('.review-tag'); review.textContent = 'ตรวจเพิ่ม'; review.hidden = reviewCount(c) === 0;
  const marked = card.querySelector('.marked'); marked.textContent = markNames[marks[markKey(c)]?.status] || ''; marked.hidden = !marked.textContent;
}
function renderGallery() {
  const list = filtered(), el = $('gallery'), old = new Map([...el.children].map(card => [card.dataset.id, card]));
  const sameOrder = el.children.length === list.length && list.every((c, i) => el.children[i].dataset.id === c.id);
  if (sameOrder) list.forEach(c => updateCard(old.get(c.id), c));
  else { const top = el.scrollTop; el.replaceChildren(...list.map(c => { const card = old.get(c.id) || makeCard(c); updateCard(card, c); return card; })); el.scrollTop = top; }
  $('galleryCount').textContent = list.length + ' ภาพที่แสดง / ' + (catalog?.totalImages || 589) + ' ภาพทั้งหมด';
  updateNavigation();
}
function updateNavigation() {
  const list = filtered(), index = list.findIndex(c => c.id === selected?.id);
  $('position').textContent = selected ? (index >= 0 ? (index + 1) + ' / ' + list.length : 'อยู่นอกตัวกรอง') : '';
  $('prev').disabled = index <= 0; $('next').disabled = index < 0 || index >= list.length - 1;
}
async function refresh() {
  if (refreshing) return; refreshing = true;
  try {
    const next = await fetch('/api/catalog', { cache: 'no-store' }).then(r => { if (!r.ok) throw Error(r.status); return r.json(); });
    const before = selected;
    catalog = next;
    const groups = [...new Set(next.cases.map(c => c.group))].sort();
    if ($('group').options.length !== groups.length + 1) { const value = $('group').value; $('group').replaceChildren(new Option('ทุกกลุ่ม', ''), ...groups.map(g => new Option(g, g))); $('group').value = value; }
    if (selected) selected = next.cases.find(c => c.id === selected.id) || selected;
    renderStats(); renderGallery();
    if (before && (before.at !== selected.at || before.cleaned !== selected.cleaned)) await loadRecord(false);
    if (!selected && next.cases.length) { const initial = next.cases.find(c => c.id === (new URLSearchParams(location.search).get('page') || location.hash.slice(1))); await selectPage(initial?.id || next.cases[0].id); }
  } catch (error) { $('liveStatus').textContent = 'เชื่อมต่อไม่ได้ · กดอัปเดตเพื่อลองใหม่'; console.error(error); }
  finally { refreshing = false; }
}
async function selectPage(id) {
  selected = catalog.cases.find(c => c.id === id); if (!selected) return;
  history.replaceState(null, '', '/?page=' + id); record = null; regionIndex = -1; zoom = 0;
  $('empty').hidden = true; $('pageView').hidden = false;
  $('viewport').scrollTop = $('viewport').scrollLeft = 0;
  renderGallery(); renderPage(); await loadRecord(true);
}
async function loadRecord(newPage) {
  const seq = ++requestId, id = selected.id;
  const r = await fetch('/api/result/' + id).then(res => res.json());
  if (seq !== requestId || id !== selected?.id) return;
  const left = $('viewport').scrollLeft, top = $('viewport').scrollTop, inspectorTop = document.querySelector('.inspector').scrollTop;
  record = r.pending ? null : r; renderPage();
  if (!newPage) { $('viewport').scrollLeft = left; $('viewport').scrollTop = top; document.querySelector('.inspector').scrollTop = inspectorTop; }
}
function rows() { return mode === 'raw' ? record?.ocrRegions || [] : record?.planRegions || record?.ocrRegions || []; }
function renderPage() {
  if (!selected) return;
  $('pageTitle').textContent = selected.relative.split('/').at(-1);
  $('pageTitle').title = selected.relative;
  $('pageMeta').textContent = selected.group + ' · ' + selected.width + ' × ' + selected.height + ' px · ' + statusNames[selected.state] + ' · ' + duration(selected.timings?.totalMs);
  $('resultLink').href = '/api/result/' + selected.id;
  const mark = marks[markKey(selected)] || {}; $('mark').value = mark.status || ''; $('note').value = mark.note || '';
  const diag = node('div', 'diagnostics'); const m = selected.metrics;
  for (const [value, label] of [[m?.regions, 'กรอบ'], [m?.eligible, 'เข้าเกณฑ์แปล'], [m?.excluded, 'ไม่เข้าเกณฑ์'], [m?.review, 'กรอบ OCR ต้องตรวจ'], [m?.placementReview, 'แผนต้องตรวจ'], [record?.appliedPatchCount, 'แพตช์ลบจริง']]) if (value != null) diag.append(node('span', 'diag', value + ' ' + label));
  $('pageDiagnostics').replaceChildren(diag);
  if (record?.error) $('pageDiagnostics').append(node('div', 'error-message', record.error));
  if (record?.cleanupPreviewError) $('pageDiagnostics').append(node('div', 'error-message', record.cleanupPreviewError));
  document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  const clean = mode === 'clean', available = Boolean(record?.cleanedPath);
  const src = (clean && available ? '/clean/' : '/image/') + selected.id;
  if ($('fullImage').getAttribute('src') !== src) { $('fullImage').src = src; $('fullImage').onerror = () => { $('imageNotice').textContent = 'โหลดภาพไม่ได้ · ลองอัปเดตอีกครั้ง'; }; }
  $('imageNotice').textContent = !record ? 'หน้านี้ยังรอประมวลผล — แสดงต้นฉบับก่อน' : clean && !available ? (record.appliedPatchCount === 0 ? 'ไม่มีแพตช์ลบที่เข้าเกณฑ์ในหน้านี้ — แสดงต้นฉบับ' : 'ภาพลบข้อความยังไม่พร้อม — แสดงต้นฉบับ') : mode === 'plan' ? 'เส้นทึบ = กรอบข้อความ • เส้นประสีฟ้า = พื้นที่วางข้อความตามแผน • สีเหลือง = ต้องตรวจเพิ่ม • สีม่วง = ไม่เข้าเกณฑ์แปล' : mode === 'raw' ? 'กรอบ OCR ก่อนการปรับแผน • คลิกแต่ละกรอบเพื่ออ่านข้อความ' : clean ? 'ภาพตัวอย่างลบข้อความ — ต้องตรวจด้วยตนเอง ยังไม่รับรองผล • แพตช์ที่เข้าเกณฑ์อาจยังมีธงตรวจเพิ่ม • ยังไม่มีข้อความแปลหรือฟอนต์ใหม่' : '';
  renderRegions(); renderOverlay(); applyZoom(); updateNavigation();
}
function regionReasons(row) { return [...new Set([row.contentRole?.reason, row.layoutIssue, row.refinementError, row.reviewRequired ? 'ocr-review-required' : '', row.placement?.cleanupReview, row.placement?.layoutReview, row.placement?.cleanupModelError, row.placement?.reviewRequired ? 'placement-review-required' : ''].filter(Boolean))]; }
function renderRegions() {
  const list = rows(); $('regionCount').textContent = '(' + list.length + ')';
  $('regions').replaceChildren(...list.map((row, i) => {
    const el = node('button', 'region' + (i === regionIndex ? ' active' : '')); el.dataset.index = i;
    el.append(node('div', 'muted', '#' + (i + 1) + ' · ' + (row.orientation === 'vertical' ? 'แนวตั้ง' : 'แนวนอน') + ' · ความมั่นใจ ' + confidence(row.confidence)), node('div', 'region-text', row.text || '(ไม่มีข้อความ)'));
    el.append(node('div', 'region-detail', (row.eligible ? 'เข้าเกณฑ์แปล' : 'ไม่เข้าเกณฑ์แปล') + ' · บทบาท ' + (row.contentRole?.role || 'unknown')));
    el.append(node('div', 'region-detail', 'เอนจิน: ' + (row.recognitionEngine || '—') + (row.placement ? ' · paint: ' + row.placement.paintMode : '')));
    const reasons = regionReasons(row); if (reasons.length) el.append(node('div', 'region-detail region-review', 'เหตุผล: ' + reasons.join(' · ')));
    el.onclick = () => selectRegion(i, true); return el;
  }));
}
function boxOf(b) { if (!b) return null; const x = Number(b.x0 ?? b.x ?? b[0]), y = Number(b.y0 ?? b.y ?? b[1]), w = Number(b.x1 != null ? b.x1 - x : b.width ?? b[2]), h = Number(b.y1 != null ? b.y1 - y : b.height ?? b[3]); return [x, y, w, h].every(Number.isFinite) && w > 0 && h > 0 ? [x, y, w, h] : null; }
function renderOverlay() {
  const svg = $('overlay'); svg.replaceChildren(); svg.setAttribute('viewBox', '0 0 ' + selected.width + ' ' + selected.height);
  if (mode !== 'raw' && mode !== 'plan') return;
  const rect = (box, cls, i) => { const b = boxOf(box); if (!b) return; const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect'); ['x', 'y', 'width', 'height'].forEach((key, n) => r.setAttribute(key, b[n])); r.setAttribute('class', cls); if (i != null) { r.dataset.index = i; r.onclick = e => { e.stopPropagation(); selectRegion(i, false); }; } svg.append(r); };
  rows().forEach((row, i) => { const cls = i === regionIndex ? 'selected-box' : !row.eligible ? 'excluded-box' : row.reviewRequired || row.placement?.reviewRequired ? 'review-box' : ''; rect(row.bbox, cls, i); if (mode === 'plan') rect(row.placement?.safeBox, 'safe-box'); });
}
function selectRegion(i, center) {
  regionIndex = i; renderOverlay();
  document.querySelectorAll('.region').forEach(el => el.classList.toggle('active', Number(el.dataset.index) === i));
  const el = $('regions').children[i]; if (!center) el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (center) { const b = boxOf(rows()[i]?.bbox); if (b) { const scale = $('imageStage').clientWidth / selected.width, vp = $('viewport'); vp.scrollTo({ left: (b[0] + b[2] / 2) * scale - vp.clientWidth / 2, top: (b[1] + b[3] / 2) * scale - vp.clientHeight / 2, behavior: 'smooth' }); } }
}
function fitScale() { return Math.min(1, Math.max(100, $('viewport').clientWidth - 20) / selected.width); }
function applyZoom() { if (!selected) return; const scale = zoom || fitScale(); $('imageStage').style.width = Math.round(selected.width * scale) + 'px'; $('imageStage').style.height = Math.round(selected.height * scale) + 'px'; $('zoomLabel').textContent = zoom ? Math.round(scale * 100) + '%' : 'พอดี'; }
function changeZoom(factor) { if (!selected) return; const vp = $('viewport'), old = zoom || fitScale(); zoom = Math.max(.05, Math.min(4, old * factor)); const x = (vp.scrollLeft + vp.clientWidth / 2) / old, y = (vp.scrollTop + vp.clientHeight / 2) / old; applyZoom(); vp.scrollLeft = x * zoom - vp.clientWidth / 2; vp.scrollTop = y * zoom - vp.clientHeight / 2; }
function navigate(delta) { const list = filtered(), i = list.findIndex(c => c.id === selected?.id); if (list[i + delta]) selectPage(list[i + delta].id); }
function saveMark() { if (!selected) return; marks[markKey(selected)] = { id: selected.id, status: $('mark').value, note: $('note').value, relative: selected.relative, sourceHash: selected.sourceHash, at: new Date().toISOString() }; try { localStorage.setItem('ocr-audit-marks-v1', JSON.stringify(marks)); } catch { $('liveStatus').textContent = 'เก็บโน้ตไม่ได้ — พื้นที่เบราว์เซอร์เต็ม'; } renderStats(); renderGallery(); }
$('search').oninput = renderGallery; $('group').onchange = $('filter').onchange = renderGallery;
$('refresh').onclick = refresh; $('prev').onclick = () => navigate(-1); $('next').onclick = () => navigate(1);
document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { mode = b.dataset.mode; regionIndex = -1; renderPage(); });
$('zoomIn').onclick = () => changeZoom(1.25); $('zoomOut').onclick = () => changeZoom(.8); $('fit').onclick = () => { zoom = 0; applyZoom(); }; $('actual').onclick = () => { zoom = 1; applyZoom(); };
$('mark').onchange = saveMark; $('note').oninput = saveMark;
$('export').onclick = () => { const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), sourceFingerprint: catalog.sourceFingerprint, marks }, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob), a = node('a'); a.href = url; a.download = 'ocr-audit-review-notes.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
document.addEventListener('keydown', e => { if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return; if (e.key === 'ArrowLeft') { e.preventDefault(); navigate(-1); } if (e.key === 'ArrowRight') { e.preventDefault(); navigate(1); } if (e.key === '+' || e.key === '=') changeZoom(1.25); if (e.key === '-') changeZoom(.8); });
let drag = null;
$('viewport').addEventListener('pointerdown', e => { if (e.button !== 0 || e.target.closest('rect')) return; drag = { x: e.clientX, y: e.clientY, left: $('viewport').scrollLeft, top: $('viewport').scrollTop }; $('viewport').setPointerCapture(e.pointerId); });
$('viewport').addEventListener('pointermove', e => { if (!drag) return; $('viewport').scrollLeft = drag.left - (e.clientX - drag.x); $('viewport').scrollTop = drag.top - (e.clientY - drag.y); });
['pointerup', 'pointercancel'].forEach(name => $('viewport').addEventListener(name, () => { drag = null; }));
window.addEventListener('resize', applyZoom);
refresh(); setInterval(refresh, 10000);
