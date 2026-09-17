'use strict';
const $ = id => document.getElementById(id);
let all = [], sequence = [], selected = new Set(), busy = false, currentURL = '', states = new Map();
let dragged = null, renderTimer = null;
let mainScope = 'unknown', removedSnapshot = null;
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
function status(message, error = false) { $('status').textContent = message; $('statusDot').classList.toggle('error', error); }
async function call(method, args) {
  const result = await window.eiw[method](args);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
function setBusy(value) {
  busy = value;
  for (const id of ['open', 'scan', 'chooseFolder', 'exportLinks', 'sort', 'dedupe', 'contentPreset', 'selectAll', 'deselectAll', 'reverseOrder', 'renameTool', 'hideChrome', 'mainOnly', 'sourceFilter', 'resetFilters', 'search', 'minWidth', 'minHeight', 'setName', 'browserMode']) $(id).disabled = value;
  $('url').disabled = value; $('cancel').hidden = !value;
  $('statusDot').classList.toggle('working', value); $('progress').hidden = !value;
  if (!value) $('progress').value = 0;
  counts();
}
function sortedItems() {
  const byId = new Map(all.map(item => [item.id, item]));
  return sequence.map(id => byId.get(id)).filter(Boolean);
}
function filterOptions() {
  return { search: $('search').value, minWidth: Math.max(0, Number($('minWidth').value) || 0),
    minHeight: Math.max(0, Number($('minHeight').value) || 0), source: $('sourceFilter').value,
    hideChrome: $('hideChrome').checked, mainOnly: $('mainOnly').checked, mainScope };
}
function visibleItems() {
  const options = filterOptions(), seen = new Set();
  // Filter before deduplication: a header occurrence must not hide a main-content occurrence.
  return sortedItems().filter(item => ImageHarvestFilters.matches(item, options)).filter(item => {
    if (!$('dedupe').checked) return true;
    const key = item.fingerprint || item.url;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
function exportItems() { return visibleItems().filter(item => selected.has(item.id)); }
function counts() {
  const count = exportItems().length;
  $('selectionCount').textContent = `เลือก ${count} ภาพ`;
  $('downloadCount').textContent = count;
  $('totalCount').textContent = all.length ? `${visibleItems().length} / ${all.length}` : '0';
  $('download').disabled = busy || !count;
  $('exportLinks').disabled = busy || !count;
  $('reverseOrder').disabled = busy || sequence.length < 2;
  $('removeSelected').disabled = busy || !count;
  $('removeCount').textContent = count;
  $('clearResults').disabled = busy || (!all.length && !removedSnapshot);
  $('undoRemove').disabled = busy || !removedSnapshot;
  const hidden = all.length - visibleItems().length;
  const scopeNote = $('mainOnly').checked ? (mainScope === 'unknown' ? ' • ระบุเขตหลักไม่ชัด: คงภาพที่ไม่แน่ใจไว้' : mainScope === 'reader' ? ' • ใช้บริเวณตัวอ่าน' : ' • ใช้บริเวณ main/article') : '';
  $('filterSummary').textContent = `แสดง ${all.length - hidden} / ${all.length} ภาพ • ซ่อนด้วยตัวกรอง/ภาพซ้ำ ${hidden} ภาพ${scopeNote} • คัดจากชื่อและโครงสร้างเว็บ อาจผิดได้`;
}
function applySort() {
  const mode = $('sort').value;
  if (mode === 'manual') return;
  const items = [...all].sort((a, b) => {
    if (mode === 'dom') return a.order - b.order;
    if (mode === 'name') return a.label.localeCompare(b.label, undefined, { numeric: true }) || a.order - b.order;
    return a.top - b.top || (mode === 'right' ? b.left - a.left : a.left - b.left) || a.order - b.order;
  });
  sequence = items.map(item => item.id);
}
function moveItem(id, target) {
  if (busy || id === target) return;
  const a = sequence.indexOf(id), b = sequence.indexOf(target);
  if (a < 0 || b < 0) return;
  sequence.splice(a, 1); sequence.splice(b, 0, id);
  $('sort').value = 'manual'; render();
}
function updateState(id, text, failed = false) {
  if (!all.some(item => item.id === id)) return;
  states.set(id, { text, failed });
  const element = document.querySelector(`[data-state="${id}"]`);
  if (element) { element.textContent = text; element.title = text; element.classList.toggle('failed', failed); }
}
function render() {
  const visible = visibleItems(), grid = $('grid');
  const oldCards = new Map([...grid.children].map(card => [card.dataset.id, card]));
  const fragment = document.createDocumentFragment();
  visible.forEach((item, i) => {
    let card = oldCards.get(item.id);
    if (!card) {
      card = el('article', 'card'); card.dataset.id = item.id; card.draggable = true;
      const thumb = el('div', 'thumb'), image = el('img'); image.loading = 'lazy'; image.decoding = 'async'; image.alt = item.alt || item.label;
      image.src = `eiw-image://cache/${item.id}`;
      image.addEventListener('load', () => {
        // Measured intrinsic dimensions are more accurate than CSS background dimensions.
        if (image.naturalWidth && image.naturalHeight) {
          item.width = image.naturalWidth; item.height = image.naturalHeight;
          const dimensions = card.querySelector('.dimensions');
          if (dimensions) dimensions.textContent = `${item.width} × ${item.height}`;
          counts();
          if (!busy && !ImageHarvestFilters.matches(item, filterOptions())) { clearTimeout(renderTimer); renderTimer = setTimeout(render, 100); }
        }
      });
      image.addEventListener('error', () => { image.hidden = true; if (!thumb.querySelector('.image-error')) thumb.append(el('span', 'image-error', 'แสดงภาพไม่ได้\nดูสถานะด้านล่าง')); });
      thumb.append(image);
      thumb.addEventListener('click', () => {
        $('previewTitle').textContent = item.label; $('previewUrl').textContent = item.url;
        $('previewImage').src = `eiw-image://cache/${item.id}`; $('preview').showModal();
      });
      const top = el('div', 'card-top'), badge = el('span', 'sequence'), checkbox = el('input');
      checkbox.type = 'checkbox'; checkbox.setAttribute('aria-label', `เลือก ${item.label}`);
      checkbox.addEventListener('change', () => { checkbox.checked ? selected.add(item.id) : selected.delete(item.id); card.classList.toggle('selected', checkbox.checked); counts(); });
      top.append(badge, checkbox);
      const meta = el('div', 'card-meta'), name = el('div', 'card-name', item.label); name.title = item.url;
      const info = el('div', 'card-info'); info.append(el('span', 'dimensions', `${item.width} × ${item.height}`), el('span', 'source-tag', item.source)); meta.append(name, info);
      if (item.filterHints) {
        const hint = el('div', `card-hint${item.filterHints.chrome ? ' chrome' : ''}`, item.filterHints.chrome ? 'รูปประกอบเว็บ (คาดว่า)' : item.filterHints.mainKind === 'reader' ? 'บริเวณตัวอ่าน' : item.filterHints.mainKind === 'main' ? 'เนื้อหาหลัก' : 'ไม่ระบุบริเวณ');
        hint.title = item.filterHints.reason; meta.append(hint);
      }
      const tools = el('div', 'card-tools'), state = el('span', 'card-state'), buttons = el('span'); state.dataset.state = item.id;
      const up = el('button', '', '←'), down = el('button', '', '→'); up.title = 'เลื่อนก่อนหน้า'; down.title = 'เลื่อนถัดไป';
      up.addEventListener('click', () => { const v = visibleItems(), index = v.findIndex(x => x.id === item.id); if (index > 0) moveItem(item.id, v[index - 1].id); });
      down.addEventListener('click', () => { const v = visibleItems(), index = v.findIndex(x => x.id === item.id); if (index + 1 < v.length) moveItem(item.id, v[index + 1].id); });
      buttons.append(up, down); tools.append(state, buttons);
      card.append(thumb, top, meta, tools);
      card.addEventListener('dragstart', event => { if (busy) { event.preventDefault(); return; } dragged = item.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', item.id); });
      card.addEventListener('dragover', event => { if (dragged) { event.preventDefault(); card.classList.add('drag-over'); } });
      card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
      card.addEventListener('drop', event => { event.preventDefault(); card.classList.remove('drag-over'); if (dragged) moveItem(dragged, item.id); dragged = null; });
      card.addEventListener('dragend', () => { dragged = null; document.querySelectorAll('.drag-over').forEach(x => x.classList.remove('drag-over')); });
    }
    card.querySelector('.sequence').textContent = String(i + 1).padStart(4, '0');
    card.querySelector('input').checked = selected.has(item.id);
    card.querySelector('input').disabled = busy;
    card.classList.toggle('selected', selected.has(item.id));
    const state = states.get(item.id);
    if (state) { const node = card.querySelector('.card-state'); node.textContent = state.text; node.title = state.text; node.classList.toggle('failed', state.failed); }
    fragment.append(card);
  });
  grid.replaceChildren(fragment); $('empty').hidden = all.length > 0; $('noMatches').hidden = !all.length || visible.length > 0;
  counts();
}
let renameChosen = false;
function renameOptions() { return { reverse: $('renameDirection').value === 'reverse', start:Number($('renameStart').value), padding:Number($('renamePadding').value) }; }
async function refreshRenamePreview() {
  if (!renameChosen) return;
  const result = await call('previewRename', renameOptions());
  $('renameSummary').textContent = `พบ ${result.count} ภาพ • ${renameOptions().reverse ? 'เรียงย้อนกลับ (ไฟล์ชื่อมากเป็นหน้าแรก)' : 'เรียงปกติ'}`;
  $('renamePreview').replaceChildren(...result.plan.slice(0,80).map(row => el('div','rename-row',`${row.from}  →  ${row.to}`)));
  if (result.plan.length > 80) $('renamePreview').append(el('div','rename-more',`… และอีก ${result.plan.length - 80} ภาพ`));
  $('applyRename').disabled = !result.count;
}
async function action(fn) { try { await fn(); } catch (error) { status(error.message, true); } }
$('open').addEventListener('click', () => action(async () => {
  setBusy(true);
  try { const result = await call('open', { url: $('url').value, show: true, backend: $('browserMode').value }); currentURL = result.url; $('url').value = result.url; }
  finally { setBusy(false); }
}));
$('scan').addEventListener('click', () => action(async () => {
  setBusy(true); $('notice').hidden = true;
  try {
    const input = $('url').value.trim();
    if (!input) throw new Error('กรุณาใส่ลิงก์เว็บไซต์ก่อนค่ะ');
    if (!currentURL || (input !== currentURL && `https://${input}` !== currentURL)) {
      const opened = await call('open', { url: input, show: false, backend: $('browserMode').value }); currentURL = opened.url; $('url').value = opened.url;
    }
    const result = await call('scan', { autoScroll: $('autoScroll').checked, backgrounds: $('backgrounds').checked, canvases: $('canvases').checked,
      selector: $('selector').value, waitMs: Number($('waitMs').value), maxSteps: Number($('maxSteps').value) });
    all = result.items; mainScope = ImageHarvestFilters.mainScope(all); removedSnapshot = null; sequence = all.map(item => item.id); selected = new Set(sequence); states.clear(); applySort(); render();
    $('pageTitle').textContent = result.title || result.url;
    const notices = [result.reason, result.notice].filter(Boolean);
    $('notice').textContent = notices.join(' • '); $('notice').hidden = !notices.length;
    status(`${result.cancelled ? 'หยุดสแกนแล้ว เก็บผลที่พบไว้' : result.truncated ? 'สแกนได้บางส่วน' : 'สแกนเสร็จ'} — พบ ${all.length} ภาพ (${result.steps} รอบ)`);
  } finally { setBusy(false); render(); }
}));
$('browserMode').addEventListener('change', () => {
  currentURL = '';
  $('browserModeNote').textContent = $('browserMode').value === 'chrome'
    ? 'ต้องติดตั้ง Chrome • เปิดหน้าต่างจริง • โปรไฟล์แยกชั่วคราว • ไม่เปิดแผง DevTools'
    : 'ใช้เบราว์เซอร์ที่มากับแอป';
  status('เลือกเบราว์เซอร์แล้ว — กดเปิดเว็บหรือสแกนเพื่อใช้โหมดนี้');
});
$('url').addEventListener('keydown', event => { if (event.key === 'Enter' && !busy) $('scan').click(); });
$('showBrowser').addEventListener('click', () => action(() => call('showBrowser')));
$('cancel').addEventListener('click', () => action(async () => { await call('cancel'); status('กำลังหยุดงาน เก็บไฟล์ที่บันทึกแล้วไว้…'); }));
$('advancedToggle').addEventListener('click', () => { $('advanced').hidden = !$('advanced').hidden; });
$('sort').addEventListener('change', () => { applySort(); render(); });
$('reverseOrder').addEventListener('click', () => { if (busy || sequence.length < 2) return; sequence.reverse(); $('sort').value='manual'; render(); status('กลับลำดับภาพแล้ว — ภาพท้ายสุดถูกย้ายมาเป็นหน้าแรก'); });
for (const id of ['minWidth', 'minHeight', 'search']) $(id).addEventListener('input', () => { clearTimeout(renderTimer); renderTimer = setTimeout(render, 180); });
$('dedupe').addEventListener('change', render);
for (const id of ['hideChrome', 'mainOnly', 'sourceFilter']) $(id).addEventListener('change', render);
$('resetFilters').addEventListener('click', () => {
  if (busy) return;
  $('hideChrome').checked = false; $('mainOnly').checked = false; $('sourceFilter').value = 'all';
  $('search').value = ''; $('minWidth').value = '0'; $('minHeight').value = '0'; $('dedupe').checked = true;
  render(); status('รีเซ็ตตัวกรองแล้ว — รายการที่นำออกยังไม่ถูกคืน');
});
let collectionConfirmation = null;
function finishCollectionConfirmation(accepted) {
  const resolve = collectionConfirmation;
  if (!resolve) return;
  collectionConfirmation = null;
  $('collectionConfirm').close();
  resolve(accepted);
}
$('collectionCancel').addEventListener('click', event => { event.preventDefault(); finishCollectionConfirmation(false); });
$('collectionAccept').addEventListener('click', event => { event.preventDefault(); finishCollectionConfirmation(true); });
$('collectionConfirm').addEventListener('cancel', event => { event.preventDefault(); finishCollectionConfirmation(false); });
$('collectionConfirm').querySelector('form').addEventListener('submit', event => event.preventDefault());
function confirmCollection(title, message) {
  const modal = $('collectionConfirm');
  if (modal.open || collectionConfirmation) return Promise.resolve(false);
  $('collectionConfirmTitle').textContent = title; $('collectionConfirmText').textContent = message;
  return new Promise(resolve => {
    collectionConfirmation = resolve;
    modal.showModal(); $('collectionCancel').focus();
  });
}
$('removeSelected').addEventListener('click', () => action(async () => {
  if (busy) return;
  const items = exportItems(); if (!items.length) return;
  if (!await confirmCollection('นำรูปที่เลือกออกจากรายการ', `นำ ${items.length} ภาพที่เลือกและกำลังแสดงออก? ภาพที่ซ่อนอยู่ไม่ถูกนำออก และคืนรายการล่าสุดได้ก่อนสแกนใหม่`)) return;
  if (busy) return;
  const snapshot = { all: all.slice(), sequence: sequence.slice(), selected: new Set(selected), sort: $('sort').value, states: new Map(states) };
  setBusy(true);
  try {
    await call('removeItems', { ids: items.map(x => x.id) });
    const ids = new Set(items.map(x => x.id));
    all = all.filter(x => !ids.has(x.id)); sequence = sequence.filter(id => !ids.has(id));
    ids.forEach(id => { selected.delete(id); states.delete(id); }); removedSnapshot = snapshot;
    status(`นำออกจากรายการ ${items.length} ภาพแล้ว — ไม่ลบไฟล์ในเครื่อง`);
  } finally { setBusy(false); render(); }
}));
$('undoRemove').addEventListener('click', () => action(async () => {
  if (busy || !removedSnapshot) return;
  setBusy(true);
  try {
    const result = await call('undoRemove');
    if (!result.ids.length) throw new Error('คืนรายการไม่ได้ กรุณาสแกนใหม่');
    all = removedSnapshot.all; sequence = removedSnapshot.sequence; selected = removedSnapshot.selected;
    states = removedSnapshot.states; $('sort').value = removedSnapshot.sort; removedSnapshot = null;
    status(`คืนรายการ ${result.ids.length} ภาพแล้ว — ตัวกรองปัจจุบันยังทำงานอยู่`);
  } finally { setBusy(false); render(); }
}));
$('clearResults').addEventListener('click', () => action(async () => {
  if (busy || (!all.length && !removedSnapshot)) return;
  if (!await confirmCollection('ล้างผลสแกนทั้งหมด', 'ล้างทุกรายการ รวมภาพที่ซ่อนและประวัติคืนรายการ? ต้องสแกนใหม่เพื่อเรียกภาพกลับ โดยลิงก์และโฟลเดอร์ปลายทางยังอยู่')) return;
  if (busy) return;
  setBusy(true);
  try {
    await call('clearResults'); clearTimeout(renderTimer);
    all = []; sequence = []; selected.clear(); states.clear(); removedSnapshot = null; mainScope = 'unknown';
    $('pageTitle').textContent = 'ล้างผลสแกนแล้ว — กดสแกนภาพเพื่อเริ่มใหม่';
    $('notice').textContent = ''; $('notice').hidden = true;
    if ($('preview').open) $('preview').close();
    status('ล้างทั้งหมดแล้ว — ไฟล์ที่บันทึกไว้ยังอยู่ครบ');
  } finally { setBusy(false); render(); }
}));
$('contentPreset').addEventListener('click', () => { $('minWidth').value = '300'; $('minHeight').value = '300'; render(); });
$('selectAll').addEventListener('click', () => { visibleItems().forEach(item => selected.add(item.id)); render(); });
$('deselectAll').addEventListener('click', () => { selected.clear(); render(); });
$('chooseFolder').addEventListener('click', () => action(async () => { const folder = await call('chooseFolder'); if (folder) { $('folderLabel').textContent = folder; $('chooseFolder').title = folder; } }));
$('openFolder').addEventListener('click', () => action(() => call('openFolder')));
$('download').addEventListener('click', () => action(async () => {
  const items = exportItems(); if (!items.length) return;
  setBusy(true); render();
  try {
    const result = await call('download', { ids: items.map(item => item.id), name: $('setName').value });
    if (!result.folder) { status('ยังไม่ได้เลือกโฟลเดอร์'); return; }
    status(`${result.cancelled ? 'หยุดแล้ว' : 'บันทึกเสร็จ'} — สำเร็จ ${result.saved} ภาพ / ไม่สำเร็จ ${result.failed} ภาพ${result.notAttempted ? ` / ยังไม่บันทึก ${result.notAttempted} ภาพ` : ''} — ${result.folder}`, result.failed > 0);
    const settings = await call('settings'); $('folderLabel').textContent = settings.outputRoot;
  } finally { setBusy(false); render(); }
}));
$('exportLinks').addEventListener('click', () => action(async () => { if (await call('exportLinks', { ids: exportItems().map(item => item.id) })) status('บันทึกลิงก์ตามลำดับแล้ว'); }));
$('renameTool').addEventListener('click', () => { if (!busy) $('renameDialog').showModal(); });
$('closeRename').addEventListener('click', () => $('renameDialog').close());
$('chooseRenameSource').addEventListener('click', () => action(async () => {
  const result = await call('chooseRenameFolder'); if (!result) return;
  renameChosen = true; $('renameFolderLabel').textContent = result.folder; await refreshRenamePreview();
}));
for (const id of ['renameDirection','renameStart','renamePadding']) $(id).addEventListener('change', () => action(refreshRenamePreview));
$('applyRename').addEventListener('click', () => action(async () => {
  $('applyRename').disabled = true;
  try {
    const result = await call('renameImages', renameOptions());
    if (result.cancelled) { status('ยกเลิกการเปลี่ยนชื่อรูป'); return; }
    status(result.renamed ? `เปลี่ยนชื่อรูปเป็นเลขหน้าแล้ว ${result.renamed} ภาพ — ${result.folder}` : 'ชื่อไฟล์เป็นเลขหน้าถูกต้องอยู่แล้ว');
  } finally { await refreshRenamePreview(); }
}));

$('closePreview').addEventListener('click', () => $('preview').close());
$('preview').addEventListener('close', () => $('previewImage').removeAttribute('src'));
window.eiw.on(event => {
  if (event.type === 'status' || event.type === 'rate-limit' || event.type === 'error') status(event.message, event.type !== 'status');
  if (event.type === 'navigation') { currentURL = event.url; if (/^https?:\/\//i.test(event.url)) $('url').value = event.url; else status('หน้าเว็บนำทางออกไป ' + event.url + ' — กรุณาตรวจหน้าต่างเว็บ', true); }
  if (event.type === 'scan-start') { all = []; sequence = []; selected.clear(); states.clear(); removedSnapshot = null; mainScope = 'unknown'; render(); status('กำลังรวบรวมภาพและเลื่อนหน้า…'); }
  if (event.type === 'scan-progress') { status(`กำลังสแกน • พบ ${event.count} ภาพ • รอบ ${event.step}/${event.maxSteps}`); $('progress').value = Math.round(event.progress * 100); }
  if (event.type === 'download-progress') { status(`กำลังบันทึกภาพ ${event.index}/${event.total} • สำเร็จ ${event.saved} • ไม่สำเร็จ ${event.failed}`); $('progress').value = ((event.index - 1) / event.total) * 100; }
  if (event.type === 'image-saved') updateState(event.id, `✓ ${event.filename}`);
  if (event.type === 'image-failed') updateState(event.id, event.message, true);
});
call('settings').then(settings => { if (settings.outputRoot) $('folderLabel').textContent = settings.outputRoot; }).catch(error => status(error.message, true));
