'use strict';
let all = [],
  sequence = [],
  selected = new Set(),
  busy = false,
  currentURL = '',
  scannedURL = '',
  states = new Map();

let dragged = null,
  renderTimer = null;

let mainScope = 'unknown',
  removedSnapshot = null;

let captureActive = false,
  networkRestartRequired = false;

let downloadPending = false;

let continuousActive = false,
  continuousCancelled = false;

let activeScanId = null,
  liveRenderTimer = null,
  analysisTimer = null,
  analysisEpoch = 0;

const blankChecks = new Map();

let activeTabId = 'tab-1',
  tabCounter = 1;

const tabs = new Map();

function renderBrowserProfile(info = {}) {
  const ready = Boolean(info.ready),
    connected = Boolean(info.hasAccount || info.email);
  $('profileEmail').textContent =
    info.email ||
    (connected ? 'ล็อกอินแล้ว • Chrome ไม่ได้ส่งชื่ออีเมลให้แอป' : 'ยังไม่ได้ล็อกอิน');
  $('profileSummary').textContent = connected
    ? 'บัญชีและคุกกี้ของโปรไฟล์นี้จะถูกใช้ทุกครั้งที่เลือก Google Chrome'
    : ready
      ? 'สร้างโปรไฟล์แล้ว • เปิด Chrome แล้วล็อกอินบัญชีที่ต้องการได้เลย'
      : 'ยังไม่มีโปรไฟล์ • เปิด Chrome เพื่อเริ่มตั้งค่าบัญชี';
  $('profileBadge').textContent = connected ? 'พร้อมใช้' : ready ? 'มีโปรไฟล์' : 'ยังไม่ตั้งค่า';
  $('profileBadge').classList.toggle('ready', connected);
  $('profileNavState').textContent = connected ? 'พร้อม' : ready ? 'มีโปรไฟล์' : 'ตั้งค่า';
  $('profileNavState').classList.toggle('ready', connected);
  $('useBrowserProfile').disabled = !ready;
}

async function refreshBrowserProfile() {
  const info = await call('browserProfile');
  renderBrowserProfile(info);
  return info;
}

async function profileAction(fn) {
  try {
    $('profileActionNote').className = 'account-note';
    await fn();
  } catch (error) {
    $('profileActionNote').className = 'account-note error';
    $('profileActionNote').textContent = error.message;
  }
}

function imageSource(item, retry = 0) {
  return `eiw://app/image/${item.id}${retry ? `?retry=${retry}` : ''}`;
}

function queueLiveRender() {
  if (liveRenderTimer !== null) return;
  liveRenderTimer = setTimeout(() => {
    liveRenderTimer = null;
    render();
  }, 90);
}

function resetLiveWork() {
  activeScanId = null;
  analysisEpoch++;
  clearTimeout(liveRenderTimer);
  liveRenderTimer = null;
  clearTimeout(analysisTimer);
  analysisTimer = null;
  clearTimeout(renderTimer);
  renderTimer = null;
  for (const task of blankChecks.values()) task.cancel();
  blankChecks.clear();
}

function mergeScanItems(items, final = false) {
  const byId = new Map(all.map((item) => [item.id, item]));
  for (const update of items || []) {
    const item = byId.get(update.id);
    if (item)
      Object.assign(item, update); // Keep card callbacks bound to the same object.
    else {
      all.push(update);
      byId.set(update.id, update);
      sequence.push(update.id);
      selected.add(update.id);
    }
  }
  if (final) {
    const wanted = new Set(items.map((x) => x.id));
    all = all.filter((x) => wanted.has(x.id));
    sequence = sequence.filter((id) => wanted.has(id));
  }
  mainScope = ImageHarvestFilters.mainScope(all);
  applySort();
}

function inspectLocalImage(item, image) {
  if (item.pixelHints?.checked) return;
  const extension = item.ext || item.url.match(/\.([a-z0-9]+)(?:[?#]|$)/i)?.[1] || '';
  // Do not classify an animated/unknown format by its first frame.
  if (!/^(?:png|jpe?g)$/i.test(extension) && item.source !== 'canvas') {
    item.pixelHints = { checked: true, blank: false, unknown: true };
    return;
  }
  try {
    if (!image.naturalWidth || !image.naturalHeight) return;
    const scale = Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    item.pixelHints = ImageHarvestFilters.inspectPixels(
      ctx.getImageData(0, 0, canvas.width, canvas.height).data,
    );
    canvas.width = canvas.height = 1;
  } catch {
    item.pixelHints = { checked: true, blank: false, unknown: true };
  }
}

function blankCandidates() {
  if (!$('hideBlank').checked) return [];
  const options = { ...filterOptions(), hideBlank: false };
  return all.filter((x) => !x.pixelHints?.checked && ImageHarvestFilters.matches(x, options));
}

function queueBlankChecks() {
  if (
    analysisTimer !== null ||
    (busy && !continuousActive) ||
    captureActive ||
    !$('hideBlank').checked
  )
    return;
  analysisTimer = setTimeout(() => {
    analysisTimer = null;
    for (const item of blankCandidates()) {
      if (blankChecks.size >= 2) break;
      if (blankChecks.has(item.id) || item.previewReady === false) continue;
      const image = new Image(),
        epoch = analysisEpoch;
      let done = false,
        timer;
      const finish = (loaded, cancelled = false) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        image.onload = image.onerror = null;
        if (blankChecks.get(item.id)?.image === image) blankChecks.delete(item.id);
        if (!cancelled && epoch === analysisEpoch && all.includes(item)) {
          if (loaded) inspectLocalImage(item, image);
          else item.pixelHints = { checked: true, blank: false, unknown: true };
          queueLiveRender();
        }
        image.removeAttribute('src');
      };
      blankChecks.set(item.id, { image, cancel: () => finish(false, true) });
      image.onload = () => finish(true);
      image.onerror = () => finish(false);
      timer = setTimeout(() => finish(false), 35000);
      image.src = imageSource(item);
    }
  }, 0);
}

function cardHint(item) {
  if (item.pixelHints?.blank) return 'หน้าว่าง / สีล้วน (คาดว่า)';
  const h = item.filterHints || {};
  if (h.category === 'ad') return 'โฆษณา / แบนเนอร์ (คาดว่า)';
  if (h.category === 'promo') return 'โปรโมต / สนับสนุนเว็บ (คาดว่า)';
  if (h.category === 'placeholder') return 'ภาพรอโหลด / ตัวคั่น';
  if (h.chrome) return 'โลโก้ / ส่วนประกอบเว็บ (คาดว่า)';
  return h.mainKind === 'reader'
    ? 'บริเวณตัวอ่าน'
    : h.mainKind === 'main'
      ? 'เนื้อหาหลัก'
      : 'ไม่ระบุบริเวณ';
}

function defaultTabForm() {
  return {
    url: '',
    autoScroll: true,
    backgrounds: false,
    canvases: true,
    selector: '',
    waitMs: '800',
    maxSteps: '150',
    captureInterval: '900',
    search: '',
    minWidth: '0',
    minHeight: '0',
    sort: 'visual',
    dedupe: true,
    hideChrome: false,
    mainOnly: false,
    hideBlank: false,
    sourceFilter: 'all',
    setName: '',
    contentMode: 'web',
    continuousMode: false,
    continuousStart: '1',
  };
}

function makeTabState(number) {
  return {
    id: `tab-${number}`,
    number,
    title: '',
    url: '',
    all: [],
    sequence: [],
    selected: new Set(),
    states: new Map(),
    mainScope: 'unknown',
    removedSnapshot: null,
    pageTitle: 'คอลเลกชันใหม่ของพี่จะอยู่ตรงนี้',
    notice: '',
    form: defaultTabForm(),
  };
}

function readTabForm() {
  return {
    url: $('url').value,
    autoScroll: $('autoScroll').checked,
    backgrounds: $('backgrounds').checked,
    canvases: $('canvases').checked,
    selector: $('selector').value,
    waitMs: $('waitMs').value,
    maxSteps: $('maxSteps').value,
    captureInterval: $('captureInterval').value,
    search: $('search').value,
    minWidth: $('minWidth').value,
    minHeight: $('minHeight').value,
    sort: $('sort').value,
    dedupe: $('dedupe').checked,
    hideChrome: $('hideChrome').checked,
    mainOnly: $('mainOnly').checked,
    hideBlank: $('hideBlank').checked,
    sourceFilter: $('sourceFilter').value,
    setName: $('setName').value,
    contentMode: $('mangaMode').classList.contains('active') ? 'manga' : 'web',
    continuousMode: $('continuousMode').checked,
    continuousStart: $('continuousStart').value,
  };
}

function applyTabForm(form = defaultTabForm()) {
  $('url').value = form.url || '';
  $('autoScroll').checked = form.autoScroll !== false;
  $('backgrounds').checked = Boolean(form.backgrounds);
  $('canvases').checked = form.canvases !== false;
  $('selector').value = form.selector || '';
  $('waitMs').value = form.waitMs || '800';
  $('maxSteps').value = form.maxSteps || '150';
  $('captureInterval').value = form.captureInterval || '900';
  $('search').value = form.search || '';
  $('minWidth').value = form.minWidth || '0';
  $('minHeight').value = form.minHeight || '0';
  $('sort').value = form.sort || 'visual';
  $('dedupe').checked = form.dedupe !== false;
  $('hideChrome').checked = Boolean(form.hideChrome);
  $('hideBlank').checked = Boolean(form.hideBlank);
  $('mainOnly').checked = Boolean(form.mainOnly);
  $('sourceFilter').value = form.sourceFilter || 'all';
  $('setName').value = form.setName || '';
  setContentMode(form.contentMode === 'manga' ? 'manga' : 'web', false);
  $('continuousMode').checked = form.contentMode === 'manga' && Boolean(form.continuousMode);
  $('continuousStart').value = form.continuousStart || '1';
  syncContinuousUI();
}

function saveActiveTabState() {
  const tab = tabs.get(activeTabId);
  if (!tab) return;
  tab.all = all.slice();
  tab.sequence = sequence.slice();
  tab.selected = new Set(selected);
  tab.states = new Map(states);
  tab.mainScope = mainScope;
  tab.removedSnapshot = removedSnapshot;
  tab.pageTitle = $('pageTitle').textContent;
  tab.notice = $('notice').hidden ? '' : $('notice').textContent;
  tab.form = readTabForm();
  tab.url = tab.form.url;
}

function restoreTabState(tab) {
  resetLiveWork();
  all = tab.all.slice();
  sequence = tab.sequence.slice();
  selected = new Set(tab.selected);
  states = new Map(tab.states);
  mainScope = tab.mainScope;
  removedSnapshot = tab.removedSnapshot;
  currentURL = '';
  scannedURL = '';
  applyTabForm(tab.form);
  $('pageTitle').textContent = tab.pageTitle;
  $('notice').textContent = tab.notice || '';
  $('notice').hidden = !tab.notice;
  if ($('preview').open) $('preview').close();
  if ($('readerDialog').open) $('readerDialog').close();
  render();
}

function tabLabel(tab) {
  if (tab.title) return tab.title.length > 28 ? tab.title.slice(0, 27) + '…' : tab.title;
  const raw = tab.form?.url || tab.url;
  try {
    return new URL(raw).hostname || `แท็บ ${tab.number}`;
  } catch {
    return `แท็บ ${tab.number}`;
  }
}

function renderTabs() {
  const host = $('workspaceTabs');
  if (!host) return;
  const fragment = document.createDocumentFragment();
  for (const tab of tabs.values()) {
    const wrap = el('div', `workspace-tab${tab.id === activeTabId ? ' active' : ''}`);
    const mainButton = el('button', 'workspace-tab-main');
    mainButton.dataset.workspaceId = tab.id;
    mainButton.append(
      el('span', 'workspace-tab-label', tabLabel(tab)),
      el(
        'span',
        'workspace-tab-count',
        String(tab.id === activeTabId ? all.length : tab.all.length),
      ),
    );
    mainButton.disabled = busy || captureActive;
    mainButton.addEventListener('click', () => action(() => switchWorkspaceTab(tab.id)));
    wrap.append(mainButton);
    if (tabs.size > 1) {
      const close = el('button', 'workspace-tab-close', '×');
      close.dataset.closeWorkspace = tab.id;
      close.title = 'ปิดแท็บ';
      close.disabled = busy || captureActive;
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        action(() => closeWorkspaceTab(tab.id));
      });
      wrap.append(close);
    }
    fragment.append(wrap);
  }
  host.replaceChildren(fragment);
  $('addTab').disabled = busy || captureActive || tabs.size >= 12;
}

function touchActiveTab(title = '', url = '') {
  const tab = tabs.get(activeTabId);
  if (!tab) return;
  if (title) tab.title = title;
  if (url) {
    tab.url = url;
    tab.form.url = url;
  }
  renderTabs();
}

async function switchWorkspaceTab(id) {
  if (id === activeTabId || busy || captureActive || !tabs.has(id)) return;
  saveActiveTabState();
  await call('workspaceSwitch', { id });
  activeTabId = id;
  restoreTabState(tabs.get(id));
  renderTabs();
  status(
    all.length
      ? `สลับแท็บแล้ว — เก็บผลเดิม ${all.length} ภาพไว้ครบ`
      : 'แท็บใหม่พร้อมใช้งาน — วางลิงก์แล้วเริ่มสแกนได้เลย',
  );
}

async function addWorkspaceTab() {
  if (busy || captureActive || tabs.size >= 12) return;
  saveActiveTabState();
  const number = ++tabCounter,
    tab = makeTabState(number);
  tabs.set(tab.id, tab);
  try {
    await call('workspaceSwitch', { id: tab.id });
    activeTabId = tab.id;
    restoreTabState(tab);
    renderTabs();
    status(`เพิ่มแท็บ ${number} แล้ว — งานแท็บก่อนหน้ายังคงอยู่`);
  } catch (error) {
    tabs.delete(tab.id);
    tabCounter--;
    renderTabs();
    throw error;
  }
}

async function closeWorkspaceTab(id) {
  if (busy || captureActive || tabs.size <= 1 || !tabs.has(id)) return;
  if (id === activeTabId) {
    saveActiveTabState();
    const ids = [...tabs.keys()],
      index = ids.indexOf(id),
      target = ids[index + 1] || ids[index - 1];
    await call('workspaceSwitch', { id: target });
    activeTabId = target;
    restoreTabState(tabs.get(target));
    await call('workspaceClose', { id });
    tabs.delete(id);
    renderTabs();
    status('ปิดแท็บแล้ว — งานแท็บอื่นยังอยู่');
    return;
  }
  await call('workspaceClose', { id });
  tabs.delete(id);
  renderTabs();
  status('ปิดแท็บแล้ว');
}

tabs.set('tab-1', makeTabState(1));

function networkDescription(mode) {
  if (mode === 'cloudflare')
    return 'ใช้ Cloudflare DNS-over-HTTPS; ดาวน์โหลดในโหมด Chrome ใช้ 1.1.1.1';
  if (mode === 'google') return 'ใช้ Google DNS-over-HTTPS; ดาวน์โหลดในโหมด Chrome ใช้ 8.8.8.8';
  if (mode === 'adguard')
    return 'ใช้ AdGuard DNS-over-HTTPS เพื่อบล็อกโฆษณาและตัวติดตาม; ถ้าเว็บโหลดไม่ครบให้กลับ Smart Auto';
  if (mode === 'compat')
    return 'Compatibility ใช้ Cloudflare DNS และปิด HTTP/2 + QUIC หลังรีสตาร์ต';
  return 'Smart Auto: ใช้ Secure DNS ของ Cloudflare/Google อัตโนมัติ และสลับสำรองเมื่อเกิด timeout หรือหาโดเมนไม่เจอ';
}

function contentMode() {
  return $('mangaMode').classList.contains('active') ? 'manga' : 'web';
}

function setContentMode(mode, announce = true) {
  const manga = mode === 'manga';
  $('mangaMode').classList.toggle('active', manga);
  $('mangaMode').setAttribute('aria-pressed', String(manga));
  $('webMode').classList.toggle('active', !manga);
  $('webMode').setAttribute('aria-pressed', String(!manga));
  $('continuousControl').hidden = !manga;
  if (!manga) $('continuousMode').checked = false;
  $('contentModeNote').textContent = manga
    ? 'โหมดมังงะ • เปิดใช้ตัวตรวจ Chapter/ตอนถัดไปได้ • ตัวสแกนภาพเดิมยังทำงานเหมือนเดิม'
    : 'เว็บทั่วไป • เก็บภาพจากหน้าเว็บเดียว • ไม่ใช้ระบบหา Chapter';
  syncContinuousUI();
  if (announce)
    status(
      manga
        ? 'โหมดมังงะพร้อม — จะเปิดระบบไล่ตอนเพิ่มได้'
        : 'โหมดเว็บทั่วไปพร้อม — ไม่ใช้ระบบหา Chapter',
    );
}

function syncContinuousUI() {
  const manga = contentMode() === 'manga',
    enabled = manga && $('continuousMode').checked;
  $('continuousControl').hidden = !manga;
  $('setNameWrap').hidden = enabled;
  $('continuousStartWrap').hidden = !enabled;
  $('downloadActionText').textContent = enabled
    ? continuousActive
      ? 'กำลังเก็บต่อเนื่อง'
      : 'เริ่มเก็บต่อเนื่อง'
    : 'บันทึกภาพที่เลือก';
  $('download').title = enabled
    ? 'บันทึกตอนปัจจุบันลงโฟลเดอร์เลข แล้วไล่ตอนถัดไปอัตโนมัติ'
    : 'บันทึกภาพที่เลือก';
}

function syncCaptureControls() {
  $('capturePages').textContent = captureActive ? '■ หยุดจับทีละหน้า' : '◎ จับทีละหน้า';
  $('capturePages').disabled = busy;
  for (const id of [
    'open',
    'scan',
    'protectionCompatibility',
    'browserMode',
    'networkMode',
    'applyNetwork',
    'renameTool',
    'continuousMode',
    'webMode',
    'mangaMode',
    'autoReader',
  ])
    $(id).disabled = busy || captureActive;
  $('url').disabled = busy || captureActive;
  $('restartNetwork').disabled = busy || captureActive;
  $('statusDot').classList.toggle('working', busy || captureActive);
  if (captureActive) $('progress').hidden = true;
  syncChromeControls();
  renderTabs();
}

function appendCaptured(items) {
  if (!Array.isArray(items) || !items.length) return;
  const known = new Set(all.map((item) => item.id));
  for (const item of items) {
    if (known.has(item.id)) continue;
    known.add(item.id);
    all.push(item);
    sequence.push(item.id);
    selected.add(item.id);
  }
  mainScope = ImageHarvestFilters.mainScope(all);
  render();
}

function setBusy(value) {
  busy = value;
  for (const id of [
    'open',
    'scan',
    'capturePages',
    'applyNetwork',
    'restartNetwork',
    'chooseFolder',
    'exportLinks',
    'sort',
    'dedupe',
    'contentPreset',
    'selectAll',
    'deselectAll',
    'reverseOrder',
    'renameTool',
    'hideChrome',
    'mainOnly',
    'hideBlank',
    'sourceFilter',
    'resetFilters',
    'search',
    'minWidth',
    'minHeight',
    'setName',
    'continuousMode',
    'continuousStart',
    'webMode',
    'mangaMode',
    'browserMode',
    'networkMode',
    'preRead',
    'autoReader',
  ])
    $(id).disabled = value;
  $('url').disabled = value;
  $('cancel').hidden = !value;
  $('statusDot').classList.toggle('working', value);
  $('progress').hidden = !value;
  if (!value) $('progress').value = 0;
  syncCaptureControls();
  counts();
}

function sortedItems() {
  const byId = new Map(all.map((item) => [item.id, item]));
  return sequence.map((id) => byId.get(id)).filter(Boolean);
}

function filterOptions() {
  return {
    search: $('search').value,
    minWidth: Math.max(0, Number($('minWidth').value) || 0),
    minHeight: Math.max(0, Number($('minHeight').value) || 0),
    source: $('sourceFilter').value,
    hideChrome: $('hideChrome').checked,
    mainOnly: $('mainOnly').checked,
    hideBlank: $('hideBlank').checked,
    mainScope,
  };
}

function visibleItems() {
  const options = filterOptions(),
    seen = new Set();
  // Filter before deduplication: a header occurrence must not hide a main-content occurrence.
  return sortedItems()
    .filter((item) => ImageHarvestFilters.matches(item, options))
    .filter((item) => {
      if (!$('dedupe').checked) return true;
      // Deduplicate the same acquired source only. Different URLs may legitimately
      // contain identical bytes (e.g. repeated/blank manga pages or test fixtures).
      const key = item.url;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function exportItems() {
  return visibleItems().filter((item) => selected.has(item.id));
}

function counts() {
  const count = exportItems().length,
    unchecked = blankCandidates().length;
  const continuousReady =
    contentMode() === 'manga' && $('continuousMode').checked && Boolean($('url').value.trim());
  $('selectionCount').textContent = `เลือก ${count} ภาพ`;
  $('downloadCount').textContent = count;
  $('totalCount').textContent = all.length ? `${visibleItems().length} / ${all.length}` : '0';
  $('download').disabled =
    busy || captureActive || (!count && !continuousReady) || (count > 0 && unchecked > 0);
  $('exportLinks').disabled = busy || captureActive || !count || unchecked > 0;
  $('preRead').disabled = busy || captureActive || !count || unchecked > 0;
  $('reverseOrder').disabled = busy || captureActive || sequence.length < 2;
  $('removeSelected').disabled = busy || captureActive || !count || unchecked > 0;
  $('removeCount').textContent = count;
  $('clearResults').disabled = busy || captureActive || (!all.length && !removedSnapshot);
  $('undoRemove').disabled = busy || captureActive || !removedSnapshot;
  const hidden = all.length - visibleItems().length;
  const scopeNote = $('mainOnly').checked
    ? mainScope === 'unknown'
      ? ' • ระบุเขตหลักไม่ชัด: คงภาพที่ไม่แน่ใจไว้'
      : mainScope === 'reader'
        ? ' • ใช้บริเวณตัวอ่าน'
        : ' • ใช้บริเวณ main/article'
    : '';
  const blankNote = $('hideBlank').checked
    ? ` • หน้าว่างที่คาดว่า ${all.filter((x) => x.pixelHints?.blank).length}${unchecked ? ' • รอตรวจอีก ' + unchecked : ''}`
    : '';
  $('filterSummary').textContent =
    `แสดง ${all.length - hidden} / ${all.length} ภาพ • ซ่อนด้วยตัวกรอง/ภาพซ้ำ ${hidden} ภาพ${scopeNote}${blankNote} • คัดจากชื่อ/บริเวณ/ลิงก์ อาจผิดได้ — ปิดตัวกรองเพื่อคืนภาพ`;
  renderTabs();
  queueBlankChecks();
}

function applySort() {
  const mode = $('sort').value;
  if (mode === 'manual') return;
  const items = [...all].sort((a, b) => {
    if (mode === 'dom') return a.order - b.order;
    if (mode === 'name')
      return a.label.localeCompare(b.label, undefined, { numeric: true }) || a.order - b.order;
    return (
      a.top - b.top || (mode === 'right' ? b.left - a.left : a.left - b.left) || a.order - b.order
    );
  });
  sequence = items.map((item) => item.id);
}

function moveItem(id, target) {
  if (busy || captureActive || id === target) return;
  const a = sequence.indexOf(id),
    b = sequence.indexOf(target);
  if (a < 0 || b < 0) return;
  sequence.splice(a, 1);
  sequence.splice(b, 0, id);
  $('sort').value = 'manual';
  render();
}

function updateState(id, text, failed = false, scope = '') {
  if (!all.some((item) => item.id === id)) return;
  states.set(id, { text, failed, scope });
  const element = document.querySelector(`[data-state="${id}"]`);
  if (element) {
    element.textContent = text;
    element.title = text;
    element.classList.toggle('failed', failed);
  }
}

function render() {
  const visible = visibleItems(),
    grid = $('grid');
  const oldCards = new Map([...grid.children].map((card) => [card.dataset.id, card]));
  const fragment = document.createDocumentFragment();
  visible.forEach((item, i) => {
    let card = oldCards.get(item.id);
    if (!card) {
      card = el('article', 'card');
      card.dataset.id = item.id;
      card.draggable = true;
      const thumb = el('div', 'thumb'),
        image = el('img');
      image.loading = 'lazy';
      image.decoding = 'async';
      image.alt = item.alt || item.label;
      // Attach the image URL only once Chrome has preserved the bytes.
      image.addEventListener('load', () => {
        if (!all.includes(item)) return;
        image.hidden = false;
        thumb.querySelector('.image-error')?.remove();
        thumb.querySelector('.image-wait')?.remove();
        const stale = states.get(item.id);
        if (stale?.failed && stale.scope === 'preview') {
          states.delete(item.id);
          const node = card.querySelector('.card-state');
          if (node) {
            node.textContent = '';
            node.title = '';
            node.classList.remove('failed');
          }
        }
        inspectLocalImage(item, image);
        // Measured intrinsic dimensions are more accurate than CSS background dimensions.
        if (image.naturalWidth && image.naturalHeight) {
          item.width = image.naturalWidth;
          item.height = image.naturalHeight;
          const dimensions = card.querySelector('.dimensions');
          if (dimensions) dimensions.textContent = `${item.width} × ${item.height}`;
          counts();
          queueLiveRender();
        }
      });
      image.addEventListener('error', () => {
        const retry = Number(image.dataset.retry || 0);
        if (retry < 2 && all.includes(item)) {
          image.dataset.retry = String(retry + 1);
          image.hidden = true;
          let wait = thumb.querySelector('.image-wait');
          if (!wait) {
            wait = el('span', 'image-wait');
            thumb.append(wait);
          }
          wait.textContent = `โหลดไม่สำเร็จ • กำลังลองใหม่ ${retry + 1}/2…`;
          setTimeout(
            () => {
              if (!all.includes(item) || !image.isConnected) return;
              wait?.remove();
              image.hidden = false;
              image.src = imageSource(item, retry + 1);
            },
            retry === 0 ? 900 : 1800,
          );
          return;
        }
        image.hidden = true;
        thumb.querySelector('.image-wait')?.remove();
        if (!thumb.querySelector('.image-error'))
          thumb.append(el('span', 'image-error', 'แสดงภาพไม่ได้\nดูสถานะด้านล่าง'));
      });
      thumb.append(image);
      thumb.addEventListener('click', () => {
        $('previewTitle').textContent = item.label;
        $('previewUrl').textContent = item.url;
        $('previewImage').src = imageSource(item);
        $('preview').showModal();
      });
      const top = el('div', 'card-top'),
        badge = el('span', 'sequence'),
        checkbox = el('input');
      checkbox.type = 'checkbox';
      checkbox.setAttribute('aria-label', `เลือก ${item.label}`);
      checkbox.addEventListener('change', () => {
        checkbox.checked ? selected.add(item.id) : selected.delete(item.id);
        card.classList.toggle('selected', checkbox.checked);
        counts();
      });
      top.append(badge, checkbox);
      const meta = el('div', 'card-meta'),
        name = el('div', 'card-name', item.label);
      name.title = item.url;
      const info = el('div', 'card-info');
      info.append(
        el('span', 'dimensions', `${item.width} × ${item.height}`),
        el('span', 'source-tag', item.source),
      );
      meta.append(name, info);
      const hint = el('div', 'card-hint', cardHint(item));
      hint.title = item.filterHints?.reason || '';
      meta.append(hint);
      const tools = el('div', 'card-tools'),
        state = el('span', 'card-state'),
        buttons = el('span');
      state.dataset.state = item.id;
      const up = el('button', '', '←'),
        down = el('button', '', '→');
      up.title = 'เลื่อนก่อนหน้า';
      down.title = 'เลื่อนถัดไป';
      up.addEventListener('click', () => {
        const v = visibleItems(),
          index = v.findIndex((x) => x.id === item.id);
        if (index > 0) moveItem(item.id, v[index - 1].id);
      });
      down.addEventListener('click', () => {
        const v = visibleItems(),
          index = v.findIndex((x) => x.id === item.id);
        if (index + 1 < v.length) moveItem(item.id, v[index + 1].id);
      });
      buttons.append(up, down);
      tools.append(state, buttons);
      card.append(thumb, top, meta, tools);
      card.addEventListener('dragstart', (event) => {
        if (busy || captureActive) {
          event.preventDefault();
          return;
        }
        dragged = item.id;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', item.id);
      });
      card.addEventListener('dragover', (event) => {
        if (dragged) {
          event.preventDefault();
          card.classList.add('drag-over');
        }
      });
      card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
      card.addEventListener('drop', (event) => {
        event.preventDefault();
        card.classList.remove('drag-over');
        if (dragged) moveItem(dragged, item.id);
        dragged = null;
      });
      card.addEventListener('dragend', () => {
        dragged = null;
        document.querySelectorAll('.drag-over').forEach((x) => x.classList.remove('drag-over'));
      });
    }
    const thumbImage = card.querySelector('.thumb img'),
      thumbBox = card.querySelector('.thumb');
    if (item.previewReady === false) {
      if (!thumbBox.querySelector('.image-wait'))
        thumbBox.append(el('span', 'image-wait', 'พบภาพแล้ว • รอเว็บโหลด…'));
    } else if (!thumbImage.getAttribute('src')) {
      thumbBox.querySelector('.image-wait')?.remove();
      thumbImage.src = imageSource(item);
    }
    const hint = card.querySelector('.card-hint');
    hint.textContent = cardHint(item);
    hint.title = item.pixelHints?.blank ? item.pixelHints.reason : item.filterHints?.reason || '';
    hint.classList.toggle('chrome', Boolean(item.filterHints?.chrome || item.pixelHints?.blank));
    card.querySelector('.dimensions').textContent = `${item.width} × ${item.height}`;
    card.querySelector('.sequence').textContent = String(i + 1).padStart(4, '0');
    card.querySelector('input').checked = selected.has(item.id);
    card.querySelector('input').disabled = busy;
    card.classList.toggle('selected', selected.has(item.id));
    const state = states.get(item.id);
    if (state) {
      const node = card.querySelector('.card-state');
      node.textContent = state.text;
      node.title = state.text;
      node.classList.toggle('failed', state.failed);
    }
    fragment.append(card);
  });
  grid.replaceChildren(fragment);
  $('empty').hidden = all.length > 0;
  $('noMatches').hidden = !all.length || visible.length > 0;
  counts();
}

function applyReaderLayout() {
  $('readerStrip').dataset.mode = $('readerMode').value;
  $('readerStrip').dataset.width = $('readerWidth').value;
}

function openPreReader() {
  const items = exportItems();
  if (!items.length) {
    status('เลือกภาพที่จะ Pre-read ก่อนค่ะ', true);
    return;
  }
  const fragment = document.createDocumentFragment();
  items.forEach((item, index) => {
    const image = el('img');
    image.loading = index < 3 ? 'eager' : 'lazy';
    image.decoding = 'async';
    image.alt = item.alt || item.label || `หน้า ${index + 1}`;
    image.src = imageSource(item);
    image.dataset.page = String(index + 1);
    fragment.append(image);
  });
  $('readerStrip').replaceChildren(fragment);
  $('readerCount').textContent = `${items.length} ภาพ`;
  applyReaderLayout();
  $('readerDialog').showModal();
}

let renameChosen = false;

function renameOptions() {
  return {
    reverse: $('renameDirection').value === 'reverse',
    start: Number($('renameStart').value),
    padding: Number($('renamePadding').value),
  };
}

async function refreshRenamePreview() {
  if (!renameChosen) return;
  const result = await call('previewRename', renameOptions());
  $('renameSummary').textContent =
    `พบ ${result.count} ภาพ • ${renameOptions().reverse ? 'เรียงย้อนกลับ (ไฟล์ชื่อมากเป็นหน้าแรก)' : 'เรียงปกติ'}`;
  $('renamePreview').replaceChildren(
    ...result.plan.slice(0, 80).map((row) => el('div', 'rename-row', `${row.from}  →  ${row.to}`)),
  );
  if (result.plan.length > 80)
    $('renamePreview').append(el('div', 'rename-more', `… และอีก ${result.plan.length - 80} ภาพ`));
  $('applyRename').disabled = !result.count;
}

function scanRequest() {
  return {
    autoScroll: $('autoScroll').checked,
    backgrounds: $('backgrounds').checked,
    canvases: $('canvases').checked,
    selector: $('selector').value,
    waitMs: Number($('waitMs').value),
    maxSteps: Number($('maxSteps').value),
  };
}

async function ensurePageOpen(show = false) {
  const input = $('url').value.trim();
  if (!input) throw new Error('กรุณาใส่ลิงก์เว็บไซต์ก่อนค่ะ');
  if (!currentURL || (input !== currentURL && `https://${input}` !== currentURL)) {
    const opened = await call('open', {
      url: input,
      show,
      backend: $('browserMode').value,
      chromeControl: $('chromeControl').value,
      protectionCompatibility: $('protectionCompatibility').checked,
    });
    currentURL = opened.url;
    $('url').value = opened.url;
    touchActiveTab(opened.title, opened.url);
  }
  return currentURL;
}

function applyScanResult(result) {
  mergeScanItems(result.items, true);
  removedSnapshot = null;
  scannedURL = result.url || currentURL;
  render();
  $('pageTitle').textContent = result.title || result.url;
  touchActiveTab(result.title, result.url);
  const notices = [result.reason, result.notice].filter(Boolean);
  $('notice').textContent = notices.join(' • ');
  $('notice').hidden = !notices.length;
}

async function scanCurrentPage() {
  await ensurePageOpen(false);
  const result = await call('scan', scanRequest());
  applyScanResult(result);
  return result;
}

$('open').addEventListener('click', () =>
  action(async () => {
    setBusy(true);
    try {
      const result = await call('open', {
        url: $('url').value,
        show: true,
        backend: $('browserMode').value,
        chromeControl: $('chromeControl').value,
        protectionCompatibility: $('protectionCompatibility').checked,
      });
      currentURL = result.url;
      $('url').value = result.url;
      touchActiveTab(result.title, result.url);
    } finally {
      setBusy(false);
    }
  }),
);

$('scan').addEventListener('click', () =>
  action(async () => {
    setBusy(true);
    $('notice').hidden = true;
    try {
      await ensurePageOpen(false);
      if (/^https:\/\/viewer\.bookwalker\.jp\//i.test(currentURL)) {
        await call('startCapture', {
          backgrounds: false,
          canvases: true,
          selector: '',
          intervalMs: Number($('captureInterval').value),
          autoAdvanceReader: true,
        });
        captureActive = true;
        syncCaptureControls();
        counts();
        status('BookWalker • กำลังเก็บหน้าหนังสือทั้งหมดอัตโนมัติ…');
        return;
      }
      const result = await call('scan', scanRequest());
      applyScanResult(result);
      status(
        `${result.cancelled ? 'หยุดสแกนแล้ว เก็บผลที่พบไว้' : result.truncated ? 'สแกนได้บางส่วน' : 'สแกนเสร็จ'} — พบ ${all.length} ภาพ (${result.steps} รอบ)`,
      );
    } finally {
      activeScanId = null;
      clearTimeout(liveRenderTimer);
      liveRenderTimer = null;
      setBusy(false);
      render();
    }
  }),
);

$('capturePages').addEventListener('click', () =>
  action(async () => {
    if (captureActive) {
      await call('stopCapture');
      status('กำลังหยุดจับทีละหน้า…');
      return;
    }
    setBusy(true);
    $('notice').hidden = true;
    try {
      const input = $('url').value.trim();
      if (!input) throw new Error('กรุณาใส่ลิงก์เว็บไซต์ก่อนค่ะ');
      if (!currentURL || (input !== currentURL && `https://${input}` !== currentURL)) {
        const opened = await call('open', {
          url: input,
          show: true,
          backend: $('browserMode').value,
          chromeControl: $('chromeControl').value,
          protectionCompatibility: $('protectionCompatibility').checked,
        });
        currentURL = opened.url;
        $('url').value = opened.url;
      } else await call('showBrowser');
      await call('startCapture', {
        backgrounds: $('backgrounds').checked,
        canvases: $('canvases').checked,
        selector: $('selector').value,
        intervalMs: Number($('captureInterval').value),
        autoAdvanceReader: $('autoReader').checked,
      });
      captureActive = true;
      syncCaptureControls();
      counts();
      status(
        $('autoReader').checked
          ? 'กำลังจับทีละหน้า — ถ้าตัวอ่านรองรับ ระบบจะเปลี่ยนหน้าให้อัตโนมัติ'
          : 'กำลังจับทีละหน้า — ไปที่หน้าต่างเว็บแล้วกดเปลี่ยนหน้าได้เลย',
      );
    } finally {
      setBusy(false);
    }
  }),
);

$('protectionCompatibility').addEventListener('change', () => {
  currentURL = '';
  if ($('protectionCompatibility').checked) {
    $('browserMode').value = 'chrome';
    $('browserMode').dispatchEvent(new Event('change'));
  }
  $('protectionCompatibilityNote').textContent = $('protectionCompatibility').checked
    ? 'เปิดอัตโนมัติ — ตรวจเนื้อหาสคริปต์ ไม่ผูกโดเมน • เปิดหน้าใหม่เพื่อใช้'
    : 'ปิด — ไม่ปรับสคริปต์ แต่ยังเก็บภาพที่ Chrome โหลดแล้ว';
  status('กดเปิดเว็บหรือสแกนเพื่อใช้การตั้งค่าใหม่');
});

$('browserMode').addEventListener('change', () => {
  currentURL = '';
  $('browserModeNote').textContent =
    $('browserMode').value === 'chrome'
      ? 'ต้องติดตั้ง Chrome • ใช้โปรไฟล์ล็อกอินของ ImageHarvest • ไม่เปิดแผง DevTools'
      : 'เบราว์เซอร์ในแอป • ไม่ใช้เครื่องมือตรวจสคริปต์อัตโนมัติ';
  syncChromeControls();
  status('เลือกเบราว์เซอร์แล้ว — กดเปิดเว็บหรือสแกนเพื่อใช้โหมดนี้');
});

function syncChromeControls() {
  const chrome = $('browserMode').value === 'chrome',
    minimal = chrome && $('chromeControl').value === 'minimal';
  $('chromeControl').disabled = busy || captureActive || !chrome;
  $('protectionCompatibility').disabled = busy || captureActive || !chrome || minimal;
  if (minimal) {
    $('browserModeNote').textContent =
      'Chrome Minimal • ใช้โปรไฟล์ล็อกอินเดียวกัน • ไม่เปิดแผง DevTools • ยังใช้ CDP';
    $('protectionCompatibilityNote').textContent =
      'Minimal ไม่แก้สคริปต์เว็บ แม้ช่องวิธีเดิมจะติ๊กไว้';
  }
}

$('chromeControl').addEventListener('change', () => {
  currentURL = '';
  $('browserMode').dispatchEvent(new Event('change'));
  $('protectionCompatibilityNote').textContent =
    $('chromeControl').value === 'minimal'
      ? 'Minimal ไม่แก้สคริปต์เว็บ'
      : 'Standard ใช้กฎที่รู้จักเมื่อเปิดตัวเลือกนี้';
  status('เปลี่ยนวิธีควบคุมแล้ว — เปิดเว็บใหม่เพื่อใช้โหมดนี้กับโปรไฟล์เดิม');
});

$('applyNetwork').addEventListener('click', () =>
  action(async () => {
    const result = await call('networkMode', { mode: $('networkMode').value });
    networkRestartRequired = result.restartRequired;
    $('restartNetwork').hidden = !result.restartRequired;
    $('networkModeNote').textContent =
      networkDescription(result.mode) +
      (result.restartRequired ? ' • ต้องรีสตาร์ตแอป' : ' • ใช้งานแล้ว');
    currentURL = '';
    status(
      result.restartRequired
        ? 'บันทึกโหมดเครือข่ายแล้ว — รีสตาร์ตเพื่อให้ Compatibility มีผลครบ'
        : 'เปลี่ยนโหมดเครือข่ายแล้ว — เปิดเว็บใหม่เพื่อใช้การเชื่อมต่อใหม่',
    );
  }),
);

$('restartNetwork').addEventListener('click', () => action(() => call('restartForNetwork')));

$('webMode').addEventListener('click', () => {
  if (!busy && !captureActive) {
    setContentMode('web');
    counts();
  }
});

$('mangaMode').addEventListener('click', () => {
  if (!busy && !captureActive) {
    setContentMode('manga');
    counts();
  }
});

$('continuousMode').addEventListener('change', () => {
  if ($('continuousMode').checked && !$('hideChrome').checked) $('hideChrome').checked = true;
  syncContinuousUI();
  render();
  status(
    $('continuousMode').checked
      ? 'เปิดโหมดไล่ตอนแล้ว — เปิดตัวกรองโลโก้/โฆษณาให้อัตโนมัติ • ตั้งเลขโฟลเดอร์แล้วเริ่มเก็บได้เลย'
      : 'กลับเป็นโหมดบันทึกตอนเดียวแล้ว',
  );
});

$('continuousStart').addEventListener('input', counts);

$('url').addEventListener('input', counts);

$('url').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !busy && !captureActive) $('scan').click();
});

$('collectorNav').addEventListener('click', () => showWorkspaceView('collector'));

$('browserAccountNav').addEventListener('click', () =>
  profileAction(async () => {
    showWorkspaceView('account');
    await refreshBrowserProfile();
    $('profileActionNote').textContent =
      'รหัสผ่านกรอกใน Chrome โดยตรง แอปไม่รับหรือเก็บรหัสผ่านของบัญชี';
  }),
);

$('openBrowserLogin').addEventListener('click', () =>
  profileAction(async () => {
    $('openBrowserLogin').disabled = true;
    $('useBrowserProfile').disabled = true;
    $('profileActionNote').textContent = 'กำลังเปิด Chrome…';
    try {
      const info = await call('openBrowserLogin');
      renderBrowserProfile(info);
      $('profileActionNote').className = 'account-note success';
      $('profileActionNote').textContent =
        'Chrome ปกติเปิดแล้ว — ล็อกอินหรือเปลี่ยนบัญชีได้ตามปกติ แล้วกลับมากด “ใช้บัญชีนี้เลย”';
    } finally {
      $('openBrowserLogin').disabled = false;
      refreshBrowserProfile().catch(() => {});
    }
  }),
);

$('useBrowserProfile').addEventListener('click', () =>
  profileAction(async () => {
    $('useBrowserProfile').disabled = true;
    $('profileActionNote').textContent = 'กำลังบันทึกโปรไฟล์ Chrome…';
    const info = await call('useBrowserProfile');
    renderBrowserProfile(info);
    $('browserMode').value = 'chrome';
    $('browserMode').dispatchEvent(new Event('change'));
    showWorkspaceView('collector');
    status(
      info.email
        ? `ใช้บัญชี Chrome ${info.email} แล้ว — วางลิงก์แล้วเปิดเว็บได้เลย`
        : 'ใช้โปรไฟล์ Chrome นี้แล้ว — วางลิงก์แล้วเปิดเว็บได้เลย',
    );
  }),
);

$('addTab').addEventListener('click', () => action(addWorkspaceTab));

$('collectorAdblock').addEventListener('change', () =>
  action(async () => {
    const state = await call('harvestTsAdblockSet', {
      enabled: $('collectorAdblock').checked,
    });
    $('collectorAdblock').checked = Boolean(state.enabled);
    status(
      state.enabled
        ? 'Harvest Adblock เปิดอยู่ • ใช้ร่วมกับ HarvestTS'
        : 'ปิด Harvest Adblock แล้ว',
    );
  }),
);

$('collectorBlockElement').addEventListener('click', () =>
  action(async () => {
    const input = $('url').value.trim();
    if (!input) throw new Error('กรุณาเปิดเว็บไซต์ก่อนใช้ Block element');
    if (!currentURL || (input !== currentURL && `https://${input}` !== currentURL)) {
      const opened = await call('open', {
        url: input,
        show: true,
        backend: $('browserMode').value,
        chromeControl: $('chromeControl').value,
        protectionCompatibility: $('protectionCompatibility').checked,
      });
      currentURL = opened.url;
      $('url').value = opened.url;
      touchActiveTab(opened.title, opened.url);
    } else await call('showBrowser');
    await call('collectorBlockElement', {});
    status('Block element • ใช้กฎร่วมกับ HarvestTS • หน้าต่างลอยเปิดแล้ว');
  }),
);

$('showBrowser').addEventListener('click', () =>
  action(async () => {
    const input = $('url').value.trim();
    if (!input) throw new Error('กรุณาใส่ลิงก์เว็บไซต์ก่อนค่ะ');
    if (!currentURL || (input !== currentURL && `https://${input}` !== currentURL)) {
      const opened = await call('open', {
        url: input,
        show: true,
        backend: $('browserMode').value,
        chromeControl: $('chromeControl').value,
        protectionCompatibility: $('protectionCompatibility').checked,
      });
      currentURL = opened.url;
      $('url').value = opened.url;
      touchActiveTab(opened.title, opened.url);
    } else await call('showBrowser');
  }),
);

$('cancel').addEventListener('click', () =>
  action(async () => {
    if (continuousActive) continuousCancelled = true;
    await call('cancel');
    status(
      continuousActive
        ? 'กำลังหยุดโหมดต่อเนื่อง — เก็บตอนที่บันทึกเสร็จแล้วไว้…'
        : 'กำลังหยุดงาน เก็บไฟล์ที่บันทึกแล้วไว้…',
    );
  }),
);

$('advancedToggle').addEventListener('click', () => {
  $('advanced').hidden = !$('advanced').hidden;
});

$('sort').addEventListener('change', () => {
  applySort();
  render();
});

$('reverseOrder').addEventListener('click', () => {
  if (busy || captureActive || sequence.length < 2) return;
  sequence.reverse();
  $('sort').value = 'manual';
  render();
  status('กลับลำดับภาพแล้ว — ภาพท้ายสุดถูกย้ายมาเป็นหน้าแรก');
});

for (const id of ['minWidth', 'minHeight', 'search'])
  $(id).addEventListener('input', () => {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 180);
  });

$('dedupe').addEventListener('change', render);

for (const id of ['hideChrome', 'mainOnly', 'hideBlank', 'sourceFilter'])
  $(id).addEventListener('change', render);

$('resetFilters').addEventListener('click', () => {
  if (busy) return;
  $('hideChrome').checked = false;
  $('mainOnly').checked = false;
  $('hideBlank').checked = false;
  $('sourceFilter').value = 'all';
  $('search').value = '';
  $('minWidth').value = '0';
  $('minHeight').value = '0';
  $('dedupe').checked = true;
  render();
  status('รีเซ็ตตัวกรองแล้ว — รายการที่นำออกยังไม่ถูกคืน');
});

let collectionConfirmation = null;

function finishCollectionConfirmation(accepted) {
  const resolve = collectionConfirmation;
  if (!resolve) return;
  collectionConfirmation = null;
  $('collectionConfirm').close();
  resolve(accepted);
}

$('collectionCancel').addEventListener('click', (event) => {
  event.preventDefault();
  finishCollectionConfirmation(false);
});

$('collectionAccept').addEventListener('click', (event) => {
  event.preventDefault();
  finishCollectionConfirmation(true);
});

$('collectionConfirm').addEventListener('cancel', (event) => {
  event.preventDefault();
  finishCollectionConfirmation(false);
});

$('collectionConfirm')
  .querySelector('form')
  .addEventListener('submit', (event) => event.preventDefault());

function confirmCollection(title, message) {
  const modal = $('collectionConfirm');
  if (modal.open || collectionConfirmation) return Promise.resolve(false);
  $('collectionConfirmTitle').textContent = title;
  $('collectionConfirmText').textContent = message;
  return new Promise((resolve) => {
    collectionConfirmation = resolve;
    modal.showModal();
    $('collectionCancel').focus();
  });
}

$('removeSelected').addEventListener('click', () =>
  action(async () => {
    if (busy) return;
    const items = exportItems();
    if (!items.length) return;
    if (
      !(await confirmCollection(
        'นำรูปที่เลือกออกจากรายการ',
        `นำ ${items.length} ภาพที่เลือกและกำลังแสดงออก? ภาพที่ซ่อนอยู่ไม่ถูกนำออก และคืนรายการล่าสุดได้ก่อนสแกนใหม่`,
      ))
    )
      return;
    if (busy) return;
    const snapshot = {
      all: all.slice(),
      sequence: sequence.slice(),
      selected: new Set(selected),
      sort: $('sort').value,
      states: new Map(states),
    };
    setBusy(true);
    try {
      await call('removeItems', { ids: items.map((x) => x.id) });
      const ids = new Set(items.map((x) => x.id));
      all = all.filter((x) => !ids.has(x.id));
      sequence = sequence.filter((id) => !ids.has(id));
      ids.forEach((id) => {
        selected.delete(id);
        states.delete(id);
      });
      removedSnapshot = snapshot;
      status(`นำออกจากรายการ ${items.length} ภาพแล้ว — ไม่ลบไฟล์ในเครื่อง`);
    } finally {
      setBusy(false);
      render();
    }
  }),
);

$('undoRemove').addEventListener('click', () =>
  action(async () => {
    if (busy || !removedSnapshot) return;
    setBusy(true);
    try {
      const result = await call('undoRemove');
      if (!result.ids.length) throw new Error('คืนรายการไม่ได้ กรุณาสแกนใหม่');
      all = removedSnapshot.all;
      sequence = removedSnapshot.sequence;
      selected = removedSnapshot.selected;
      states = removedSnapshot.states;
      $('sort').value = removedSnapshot.sort;
      removedSnapshot = null;
      status(`คืนรายการ ${result.ids.length} ภาพแล้ว — ตัวกรองปัจจุบันยังทำงานอยู่`);
    } finally {
      setBusy(false);
      render();
    }
  }),
);

$('clearResults').addEventListener('click', () =>
  action(async () => {
    if (busy || (!all.length && !removedSnapshot)) return;
    if (
      !(await confirmCollection(
        'ล้างผลสแกนทั้งหมด',
        'ล้างทุกรายการ รวมภาพที่ซ่อนและประวัติคืนรายการ? ต้องสแกนใหม่เพื่อเรียกภาพกลับ โดยลิงก์และโฟลเดอร์ปลายทางยังอยู่',
      ))
    )
      return;
    if (busy) return;
    setBusy(true);
    try {
      await call('clearResults');
      resetLiveWork();
      all = [];
      sequence = [];
      selected.clear();
      states.clear();
      removedSnapshot = null;
      mainScope = 'unknown';
      scannedURL = '';
      $('pageTitle').textContent = 'ล้างผลสแกนแล้ว — กดสแกนภาพเพื่อเริ่มใหม่';
      $('notice').textContent = '';
      $('notice').hidden = true;
      if ($('preview').open) $('preview').close();
      status('ล้างทั้งหมดแล้ว — ไฟล์ที่บันทึกไว้ยังอยู่ครบ');
    } finally {
      setBusy(false);
      render();
    }
  }),
);

$('contentPreset').addEventListener('click', () => {
  $('minWidth').value = '300';
  $('minHeight').value = '300';
  render();
});

$('selectAll').addEventListener('click', () => {
  visibleItems().forEach((item) => selected.add(item.id));
  render();
});

$('deselectAll').addEventListener('click', () => {
  selected.clear();
  render();
});

function visitKey(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href.replace(/\/$/, '');
  } catch {
    return String(value || '');
  }
}

const continuousDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let continuousSessionId = '';

function traceContinuous(message, extra = {}) {
  if (!continuousSessionId) return;
  window.eiw.continuousLog({ sessionId: continuousSessionId, message, ...extra }).catch(() => {});
}

async function retryContinuous(label, operation, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (continuousCancelled) throw new Error('ยกเลิกโหมดต่อเนื่อง');
    try {
      const result = await operation(attempt);
      if (attempt > 1) traceContinuous(label + ' recovered', { attempt });
      return result;
    } catch (error) {
      lastError = error;
      traceContinuous(label + ' failed', {
        attempt,
        error: error.message || String(error),
      });
      if (attempt >= attempts) break;
      status(`${label} สะดุด • ลองใหม่ ${attempt + 1}/${attempts}…`);
      await continuousDelay(700 * attempt);
    }
  }
  throw lastError;
}

async function nextChapterWithRetry() {
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (continuousCancelled) return { url: '', reason: 'ยกเลิกแล้ว' };
    try {
      last = await call('nextChapter');
    } catch (error) {
      traceContinuous('next detection failed', {
        attempt,
        error: error.message || String(error),
      });
      if (attempt === 3) throw error;
    }
    if (last?.url || last?.action === 'click') return last;
    traceContinuous('next not found yet', {
      attempt,
      reason: last?.reason || '',
    });
    if (attempt < 3) {
      status(`ยังไม่พบตอนถัดไป • รอหน้าเว็บนิ่งแล้วตรวจใหม่ ${attempt + 1}/3…`);
      await continuousDelay(900 * attempt);
    }
  }
  return last || { url: '', reason: 'ไม่พบตอนถัดไป' };
}

async function scanContinuous(label) {
  return retryContinuous(label, async (attempt) => {
    const result = await call('scan', scanRequest());
    if (!result.cancelled && !(result.items || []).length && attempt < 3)
      throw new Error('ยังไม่พบภาพหลังสแกน');
    return result;
  });
}

async function waitForContinuousFilters() {
  if (!$('hideBlank').checked) return { timedOut: false, pending: 0 };
  const deadline = Date.now() + 30000;
  queueBlankChecks();
  while (!continuousCancelled && blankCandidates().length && Date.now() < deadline) {
    await continuousDelay(150);
    queueBlankChecks();
  }
  const pending = blankCandidates().length;
  if (!continuousCancelled && pending) {
    traceContinuous('blank analysis timeout; keeping uncertain images', {
      pending,
    });
    status(`ตรวจหน้าว่างไม่ทัน ${pending} ภาพ • เก็บภาพที่ยังไม่แน่ใจไว้เพื่อไม่ให้หน้าจริงหาย`);
    return { timedOut: true, pending };
  }
  return { timedOut: false, pending: 0 };
}

async function runContinuousHarvest() {
  if (contentMode() !== 'manga') throw new Error('โหมดไล่ตอนใช้ได้เฉพาะ “มังงะ / มังฮวา”');
  const start = Number($('continuousStart').value);
  if (!Number.isInteger(start) || start < 0 || start > 99999999)
    throw new Error('เลขโฟลเดอร์เริ่มต้นไม่ถูกต้อง');
  if (continuousActive) return;
  continuousActive = true;
  continuousCancelled = false;
  continuousSessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  syncContinuousUI();
  setBusy(true);
  $('notice').hidden = true;
  let folderNumber = start,
    chapters = 0,
    totalSaved = 0,
    totalFailed = 0;
  const visited = new Set();
  traceContinuous('session start', {
    url: $('url').value.trim(),
    folderNumber: start,
  });
  try {
    await ensurePageOpen(false);
    if (!all.length || visitKey(scannedURL) !== visitKey(currentURL)) {
      status('โหมดต่อเนื่อง • กำลังสแกนตอนเริ่มต้น…');
      const first = await scanContinuous('สแกนตอนเริ่มต้น');
      applyScanResult(first);
      if (first.cancelled) continuousCancelled = true;
    }
    visited.add(visitKey(currentURL));
    while (!continuousCancelled && chapters < 500) {
      await waitForContinuousFilters();
      const items = exportItems();
      if (!items.length)
        throw new Error('ตอนนี้ไม่มีภาพที่ผ่านตัวกรองและถูกเลือก จึงยังไม่สร้างโฟลเดอร์');
      downloadPending = true;
      status(`โหมดต่อเนื่อง • กำลังบันทึกโฟลเดอร์ ${folderNumber} • ${items.length} ภาพ`);
      const saved = await call('download', {
        ids: items.map((item) => item.id),
        numbered: true,
        folderNumber,
      });
      downloadPending = false;
      if (!saved.folder) throw new Error('ยังไม่ได้เลือกโฟลเดอร์ปลายทาง');
      if (!saved.saved)
        throw new Error(`โฟลเดอร์ ${folderNumber} บันทึกภาพไม่สำเร็จเลย จึงหยุดก่อนข้ามไปตอนถัดไป`);
      chapters++;
      totalSaved += saved.saved || 0;
      totalFailed += saved.failed || 0;
      $('continuousStart').value = String(folderNumber + 1);
      if (saved.cancelled || continuousCancelled) {
        continuousCancelled = true;
        break;
      }
      traceContinuous('chapter saved', {
        folderNumber,
        url: currentURL,
        saved: saved.saved || 0,
        failed: saved.failed || 0,
      });
      const next = await nextChapterWithRetry();
      if (!next.url && next.action !== 'click') {
        status(
          `เก็บต่อเนื่องเสร็จ — ${chapters} ตอน • สำเร็จ ${totalSaved} ภาพ • ไม่สำเร็จ ${totalFailed} ภาพ • ${next.reason || 'ไม่พบตอนถัดไป'}`,
        );
        return;
      }
      status(
        `โฟลเดอร์ ${folderNumber} เสร็จ • พบตอนถัดไป ${next.text ? '“' + next.text + '”' : ''} • กำลังเปิด…`,
      );
      let opened, actualKey;
      if (next.action === 'click') {
        opened = await call('advanceNextChapter');
        currentURL = opened.url || $('url').value;
        actualKey = visitKey(currentURL) + '|' + (opened.title || opened.heading || '');
      } else {
        const targetKey = visitKey(next.url);
        if (visited.has(targetKey))
          throw new Error('ตรวจพบว่าตอนถัดไปวนกลับ URL ที่เคยเก็บแล้ว จึงหยุดเพื่อกันลูป');
        opened = await retryContinuous('เปิดตอนถัดไป', () =>
          call('open', {
            url: next.url,
            show: false,
            backend: $('browserMode').value,
            chromeControl: $('chromeControl').value,
            protectionCompatibility: $('protectionCompatibility').checked,
          }),
        );
        if (opened.gated)
          throw new Error('ตอนถัดไปเปิดได้แต่ติดหน้าแจ้ง/ตรวจสอบการเข้าถึง กรุณาตรวจหน้าต่างเว็บ');
        currentURL = opened.url;
        actualKey = visitKey(currentURL);
      }
      if (visited.has(actualKey)) throw new Error('เว็บพากลับไปตอนที่เก็บแล้ว จึงหยุดเพื่อกันลูป');
      visited.add(actualKey);
      $('url').value = currentURL;
      touchActiveTab(opened.title, currentURL);
      folderNumber++;
      await continuousDelay(700);
      status(`โหมดต่อเนื่อง • กำลังสแกนตอนสำหรับโฟลเดอร์ ${folderNumber}…`);
      const scanResult = await scanContinuous(`สแกนโฟลเดอร์ ${folderNumber}`);
      applyScanResult(scanResult);
      if (scanResult.cancelled) continuousCancelled = true;
    }
    if (chapters >= 500)
      status(`หยุดที่เพดานความปลอดภัย 500 ตอน • บันทึกแล้ว ${totalSaved} ภาพ`, true);
    else if (continuousCancelled)
      status(
        `หยุดโหมดต่อเนื่องแล้ว — เก็บเสร็จ ${chapters} ตอน • สำเร็จ ${totalSaved} ภาพ • ไม่สำเร็จ ${totalFailed} ภาพ`,
      );
  } catch (error) {
    traceContinuous('session error', {
      folderNumber,
      chapters,
      totalSaved,
      totalFailed,
      error: error.message || String(error),
    });
    if (continuousCancelled || error.message === 'ยกเลิกโหมดต่อเนื่อง') {
      status(
        `หยุดโหมดต่อเนื่องแล้ว — เก็บเสร็จ ${chapters} ตอน • สำเร็จ ${totalSaved} ภาพ • ไม่สำเร็จ ${totalFailed} ภาพ`,
      );
    } else throw error;
  } finally {
    traceContinuous('session end', {
      folderNumber,
      chapters,
      totalSaved,
      totalFailed,
      cancelled: continuousCancelled,
    });
    downloadPending = false;
    activeScanId = null;
    clearTimeout(liveRenderTimer);
    liveRenderTimer = null;
    continuousActive = false;
    continuousSessionId = '';
    syncContinuousUI();
    setBusy(false);
    render();
  }
}

$('chooseFolder').addEventListener('click', () =>
  action(async () => {
    const folder = await call('chooseFolder');
    if (folder) {
      $('folderLabel').textContent = folder;
      $('chooseFolder').title = folder;
    }
  }),
);

$('openFolder').addEventListener('click', () => action(() => call('openFolder')));

$('download').addEventListener('click', () =>
  action(async () => {
    if (contentMode() === 'manga' && $('continuousMode').checked) {
      await runContinuousHarvest();
      return;
    }
    const items = exportItems();
    if (!items.length) return;
    downloadPending = true;
    setBusy(true);
    render();
    try {
      const result = await call('download', {
        ids: items.map((item) => item.id),
        name: $('setName').value,
      });
      downloadPending = false; // Ignore progress queued before the completed IPC result.
      if (!result.folder) {
        status('ยังไม่ได้เลือกโฟลเดอร์');
        return;
      }
      status(
        `${result.cancelled ? 'หยุดแล้ว' : 'บันทึกเสร็จ'} — สำเร็จ ${result.saved} ภาพ / ไม่สำเร็จ ${result.failed} ภาพ${result.notAttempted ? ` / ยังไม่บันทึก ${result.notAttempted} ภาพ` : ''} — ${result.folder}`,
        result.failed > 0,
      );
      const settings = await call('settings');
      $('folderLabel').textContent = settings.outputRoot;
    } finally {
      downloadPending = false;
      setBusy(false);
      render();
    }
  }),
);

$('exportLinks').addEventListener('click', () =>
  action(async () => {
    if (await call('exportLinks', { ids: exportItems().map((item) => item.id) }))
      status('บันทึกลิงก์ตามลำดับแล้ว');
  }),
);

$('renameTool').addEventListener('click', () => {
  if (!busy && !captureActive) $('renameDialog').showModal();
});

$('closeRename').addEventListener('click', () => $('renameDialog').close());

$('chooseRenameSource').addEventListener('click', () =>
  action(async () => {
    const result = await call('chooseRenameFolder');
    if (!result) return;
    renameChosen = true;
    $('renameFolderLabel').textContent = result.folder;
    await refreshRenamePreview();
  }),
);

for (const id of ['renameDirection', 'renameStart', 'renamePadding'])
  $(id).addEventListener('change', () => action(refreshRenamePreview));

$('applyRename').addEventListener('click', () =>
  action(async () => {
    $('applyRename').disabled = true;
    try {
      const result = await call('renameImages', renameOptions());
      if (result.cancelled) {
        status('ยกเลิกการเปลี่ยนชื่อรูป');
        return;
      }
      status(
        result.renamed
          ? `เปลี่ยนชื่อรูปเป็นเลขหน้าแล้ว ${result.renamed} ภาพ — ${result.folder}`
          : 'ชื่อไฟล์เป็นเลขหน้าถูกต้องอยู่แล้ว',
      );
    } finally {
      await refreshRenamePreview();
    }
  }),
);

$('preRead').addEventListener('click', openPreReader);

$('readerMode').addEventListener('change', applyReaderLayout);

$('readerWidth').addEventListener('change', applyReaderLayout);

$('closeReader').addEventListener('click', () => $('readerDialog').close());

$('readerDialog').addEventListener('close', () => $('readerStrip').replaceChildren());

$('closePreview').addEventListener('click', () => $('preview').close());

$('preview').addEventListener('close', () => $('previewImage').removeAttribute('src'));

window.eiw.on((event) => {
  if (event.type === 'collector-block-finished') {
    if (event.cancelled) status(event.message || 'ยกเลิก Block element แล้ว');
    else
      status(
        event.saved
          ? `บันทึก Block element แล้ว • ใช้ร่วมกับ HarvestTS • เพิ่ม ${event.added || 0} กฎ • รวม ${event.count || 0} กฎ`
          : 'ยังไม่ได้เลือก Element สำหรับบล็อก',
      );
    return;
  }

  if (event.type === 'scan-items') {
    if (!activeScanId || event.scanId !== activeScanId || event.workspaceId !== activeTabId) return;
    mergeScanItems(event.items);
    queueLiveRender();
    if (event.title) $('pageTitle').textContent = event.title;
    return;
  }
  if (event.type === 'scan-progress' && event.scanId && event.scanId !== activeScanId) return;
  if (event.type === 'protection-compatibility' && event.controlMode === 'minimal') {
    $('chromeControl').value = 'minimal';
    $('protectionCompatibilityNote').textContent =
      'Minimal • ไม่แก้สคริปต์เว็บ • ไม่เปิด Runtime/Console/Debugger events';
    $('compatibilityLog').textContent =
      'Chrome Minimal (ยังใช้ CDP)\nแก้สคริปต์: 0\nไม่สลับไปใช้กฎ Standard อัตโนมัติ';
  }
  if (event.type === 'protection-compatibility' && event.controlMode !== 'minimal') {
    $('protectionCompatibilityNote').textContent =
      event.error ||
      `อัตโนมัติ: ใช้กฎ ${event.applied || 0} • ไม่รู้จัก ${event.unknown || 0} • ข้ามการตรวจ ${event.skipped || 0}`;
    $('compatibilityLog').textContent =
      (event.events || [])
        .map((x) => `${x.kind} • ${x.family || ''} • ${x.rule || ''}\n${x.url || ''}`)
        .join('\n\n') || 'ยังไม่พบสคริปต์ตรงกับกฎ';
    if (event.error) status(event.error, true);
  }
  if (event.type === 'status' || event.type === 'rate-limit' || event.type === 'error')
    status(event.message, event.type !== 'status');
  if (event.type === 'navigation') {
    currentURL = event.url;
    if (/^https?:\/\//i.test(event.url)) {
      $('url').value = event.url;
      touchActiveTab('', event.url);
    } else status('หน้าเว็บนำทางออกไป ' + event.url + ' — กรุณาตรวจหน้าต่างเว็บ', true);
  }
  if (event.type === 'scan-start') {
    if (event.workspaceId && event.workspaceId !== activeTabId) return;
    resetLiveWork();
    activeScanId = event.scanId;
    scannedURL = '';
    all = [];
    sequence = [];
    selected.clear();
    states.clear();
    removedSnapshot = null;
    mainScope = 'unknown';
    render();
    status('กำลังรวบรวมภาพและเลื่อนหน้า…');
  }
  if (event.type === 'capture-start') {
    resetLiveWork();
    captureActive = true;
    all = [];
    sequence = [];
    selected.clear();
    states.clear();
    removedSnapshot = null;
    mainScope = 'unknown';
    $('pageTitle').textContent = event.title || event.url || 'กำลังจับทีละหน้า';
    syncCaptureControls();
    render();
    status('กำลังจับทีละหน้า — เปลี่ยนหน้าในหน้าต่างเว็บได้เลย');
  }
  if (event.type === 'capture-progress') {
    appendCaptured(event.items);
    if (event.title || event.url) {
      $('pageTitle').textContent = event.title || event.url;
      touchActiveTab(event.title, event.url);
    }
    const extra = event.lastError ? ` • ล่าสุดลองไม่สำเร็จ: ${event.lastError}` : '';
    status(
      `จับทีละหน้า • เก็บแล้ว ${event.count} ภาพ • รอบล่าสุดเพิ่ม ${event.items?.length || 0} • ซ้ำ ${event.duplicates || 0}${extra}`,
    );
  }
  if (event.type === 'capture-stop') {
    captureActive = false;
    syncCaptureControls();
    counts();
    status(
      `${event.reason ? event.reason + ' • ' : ''}${event.cancelled ? 'หยุดจับทีละหน้าแล้ว' : 'จบการจับทีละหน้า'} — เก็บ ${event.count} ภาพ`,
    );
  }
  if (event.type === 'scan-progress') {
    status(`กำลังสแกน • พบ ${event.count} ภาพ • รอบ ${event.step}/${event.maxSteps}`);
    $('progress').value = Math.round(event.progress * 100);
  }
  if (event.type === 'download-progress' && downloadPending) {
    status(
      `กำลังบันทึกภาพ ${event.index}/${event.total} • สำเร็จ ${event.saved} • ไม่สำเร็จ ${event.failed}`,
    );
    $('progress').value = ((event.index - 1) / event.total) * 100;
  }
  if (event.type === 'image-saved') updateState(event.id, `✓ ${event.filename}`, false, 'download');
  if (event.type === 'image-failed')
    updateState(event.id, event.message, true, event.scope || 'download');
});

renderTabs();

call('settings')
  .then((settings) => {
    $('appVersion').textContent = settings.version || '—';
    if (settings.outputRoot) $('folderLabel').textContent = settings.outputRoot;
    $('protectionCompatibility').checked = settings.protectionCompatibility === true;
    $('chromeControl').value = settings.chromeControl || 'standard';
    $('browserMode').value = settings.browserMode || 'chrome';
    $('browserMode').dispatchEvent(new Event('change'));
    $('protectionCompatibilityNote').textContent = settings.protectionCompatibility
      ? 'เปิดอัตโนมัติ — ตรวจจากลายเซ็น ไม่จำกัดชื่อเว็บ'
      : 'ปิด — ไม่แก้สคริปต์ของเว็บ';
    $('networkMode').value = settings.networkMode || 'auto';
    $('networkModeNote').textContent =
      networkDescription(settings.networkMode || 'auto') +
      (settings.compatibilityActive ? ' • Compatibility ทำงานอยู่' : '');
    $('restartNetwork').hidden = true;
    syncCaptureControls();
    counts();
    refreshBrowserProfile().catch(() => {});
    call('harvestTsAdblockStatus')
      .then((state) => {
        $('collectorAdblock').checked = state.enabled !== false;
      })
      .catch(() => {});
  })
  .catch((error) => status(error.message, true));
async function sendHarvestToCollector(target) {
  showWorkspaceView('collector');
  $('url').value = target;
  status('รับ URL จาก HarvestTS แล้ว • กำลังเปิดใน ImageHarvest…');
  const opened = await call('open', {
    url: target,
    show: true,
    backend: $('browserMode').value,
    chromeControl: $('chromeControl').value,
    protectionCompatibility: $('protectionCompatibility').checked,
  });
  currentURL = opened.url;
  $('url').value = opened.url;
  touchActiveTab(opened.title, opened.url);
  status('ส่งจาก HarvestTS มา ImageHarvest แล้ว • พร้อมสแกนหรือ Block element');
}
