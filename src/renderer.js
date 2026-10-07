'use strict';
const $ = id => document.getElementById(id);
let all = [], sequence = [], selected = new Set(), busy = false, currentURL = '', scannedURL = '', states = new Map();
let dragged = null, renderTimer = null;
let mainScope = 'unknown', removedSnapshot = null;
let captureActive = false, networkRestartRequired = false;
let downloadPending = false;
let continuousActive = false, continuousCancelled = false;
let activeScanId = null, liveRenderTimer = null, analysisTimer = null, analysisEpoch = 0;
const blankChecks = new Map();
let activeTabId = 'tab-1', tabCounter = 1;
const tabs = new Map();
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
function status(message, error = false) { $('status').textContent = message; $('statusDot').classList.toggle('error', error); }
async function call(method, args) {
  const result = await window.eiw[method](args);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
function showWorkspaceView(view) {
  const collector = view === 'collector', account = view === 'account', harvest = view === 'harvestts';
  $('collectorView').hidden = !collector;
  $('browserAccountView').hidden = !account;
  $('harvestTsView').hidden = !harvest;
  $('collectorNav').classList.toggle('active', collector);
  $('browserAccountNav').classList.toggle('active', account);
  $('harvestTsNav').classList.toggle('active', harvest);
  $('collectorSideGuide').hidden = !collector;
  if (harvest) {
    call('harvestTsDnsActivate').catch(() => {});
    ensureHarvestBrowser().catch(error => { $('harvestStatus').textContent = error.message; });
  } else {
    if (harvestBlockMode) cancelHarvestBlockMode(false).catch(() => {});
    window.eiw.harvestTsLayout({ visible:false }).catch(() => {});
    window.eiw.harvestTsDnsDeactivate().catch(() => {});
  }
}

const HARVEST_HOME = 'https://www.google.com/';
const harvestTabs = new Map();
let activeHarvestTabId = null;

function harvestTarget(value) {
  const raw = String(value || '').trim();
  if (!raw) return HARVEST_HOME;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(raw)) return 'http://' + raw;
  if (/^[^\s/]+\.[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(raw)) return 'https://' + raw;
  return 'https://www.google.com/search?q=' + encodeURIComponent(raw);
}
function activeHarvestTab() { return harvestTabs.get(activeHarvestTabId) || null; }
function harvestHost(url) { try { return new URL(url).hostname || url; } catch { return url || 'แท็บใหม่'; } }
function harvestBounds() {
  const rect = $('harvestWebviews').getBoundingClientRect();
  return { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) };
}
function updateHarvestSecurity(url) {
  const secure = /^https:\/\//i.test(url || '');
  $('harvestSecurity').classList.toggle('secure', secure);
  $('harvestSecurity').classList.toggle('insecure', Boolean(url) && !secure);
  $('harvestSecurity').title = secure ? 'เชื่อมต่อผ่าน HTTPS' : 'การเชื่อมต่อนี้ไม่ใช่ HTTPS';
}
function updateHarvestControls() {
  const tab = activeHarvestTab();
  $('harvestBack').disabled = !tab?.canGoBack;
  $('harvestForward').disabled = !tab?.canGoForward;
  if (!tab) return;
  const internal=tab.kind!=='web';
  const internalLabel=tab.kind==='downloads'?'Downloads':tab.kind==='offline'?'Offline Library':tab.kind==='offline-reader'?'Offline Reader':'History';
  if (document.activeElement !== $('harvestAddress')) $('harvestAddress').value = internal ? internalLabel : (tab.url || '');
  updateHarvestSecurity(internal ? '' : tab.url);
  const zoom=Math.round((Number(tab.zoomFactor)||1)*100),zoomEnabled=!internal;
  $('harvestZoomValue').textContent=zoom+'%';$('harvestZoomValue').disabled=!zoomEnabled||zoom===100;
  $('harvestZoomOut').disabled=!zoomEnabled||zoom<=50;$('harvestZoomIn').disabled=!zoomEnabled||zoom>=300;
  $('harvestReload').textContent = tab.loading ? '✕' : '↻';
  $('harvestReload').title = tab.loading ? 'หยุดโหลด' : 'โหลดใหม่ (Ctrl+R)';
  $('harvestStatus').textContent = tab.loading ? 'กำลังโหลด…' : (
    tab.kind==='downloads' ? 'Downloads • รายการดาวน์โหลดของ HarvestTS' :
    tab.kind==='history' ? 'History • ค้นหาประวัติการเข้าเว็บ' :
    (tab.title || harvestHost(tab.url))
  );
}
function applyHarvestSnapshot(snapshot = {}) {
  harvestTabs.clear();
  for (const tab of snapshot.tabs || []) harvestTabs.set(tab.id, tab);
  activeHarvestTabId = snapshot.activeId || null;
  renderHarvestTabs();
  updateHarvestControls();
  updateHarvestSendButton();
  updateHarvestBookmarkButton().catch(()=>{});
  updateHarvestPasswordButton().catch(()=>{});
}
function updateHarvestSendButton(){
  const tab=activeHarvestTab(),button=$('harvestSendToCollector');
  const enabled=Boolean(tab && tab.kind==='web' && /^https?:\/\//i.test(tab.url||''));
  button.disabled=!enabled;
  button.title=enabled?'ส่งหน้านี้ไป ImageHarvest':'หน้านี้ส่งไป ImageHarvest ไม่ได้';
}
function renderHarvestTabs() {
  const host = $('harvestTabs'), fragment = document.createDocumentFragment();
  for (const tab of harvestTabs.values()) {
    const item = el('div', 'harvest-browser-tab' + (tab.id === activeHarvestTabId ? ' active' : ''));
    item.setAttribute('role', 'tab'); item.setAttribute('aria-selected', String(tab.id === activeHarvestTabId));
    const open = el('button', 'harvest-tab-main');
    const dot = el('span', 'harvest-tab-dot', tab.loading ? '◌' : '●');
    const label = el('span', 'harvest-tab-label', tab.title || harvestHost(tab.url));
    const close = el('button', 'harvest-tab-close', '×');
    open.type = close.type = 'button'; open.title = tab.title || tab.url; close.title = 'ปิดแท็บ';
    open.addEventListener('click', () => switchHarvestTab(tab.id));
    close.addEventListener('click', event => { event.stopPropagation(); closeHarvestTab(tab.id); });
    open.append(dot, label); item.append(open, close); fragment.append(item);
  }
  host.replaceChildren(fragment);
}
async function syncHarvestLayout(visible = !$('harvestTsView').hidden) {
  const result = await call('harvestTsLayout', { visible, bounds: harvestBounds() });
  applyHarvestSnapshot(result);
  return result;
}
async function ensureHarvestBrowser() {
  await new Promise(resolve => requestAnimationFrame(resolve));
  const result = await syncHarvestLayout(true);
  if (!(result.tabs || []).length) applyHarvestSnapshot(await call('harvestTsCreate', { url: HARVEST_HOME }));
}
async function createHarvestTab(url = HARVEST_HOME) {
  applyHarvestSnapshot(await call('harvestTsCreate', { url: harvestTarget(url), activate: true }));
  await syncHarvestLayout(true);
}
async function switchHarvestTab(id) {
  if (harvestBlockMode && id !== harvestBlockTabId) await cancelHarvestBlockMode(false);
  applyHarvestSnapshot(await call('harvestTsSwitch', { id }));
  await syncHarvestLayout(true);
}
async function closeHarvestTab(id) {
  if (harvestBlockMode && id === harvestBlockTabId) await cancelHarvestBlockMode(false);
  applyHarvestSnapshot(await call('harvestTsClose', { id }));
  await syncHarvestLayout(true);
}
async function navigateHarvest(value) {
  if (harvestBlockMode) await cancelHarvestBlockMode(false);
  const tab = activeHarvestTab(); if (!tab) return;
  const target = harvestTarget(value);
  $('harvestStatus').textContent = 'กำลังเปิด ' + harvestHost(target) + '…';
  if(tab.kind!=='web') await createHarvestTab(target);
  else applyHarvestSnapshot(await call('harvestTsNavigate', { id: tab.id, url: target }));
}
async function harvestAction(action) {
  const tab = activeHarvestTab(); if (!tab) return;
  applyHarvestSnapshot(await call('harvestTsAction', { id: tab.id, action }));
}
function reloadHarvest() { action(() => harvestAction('reload')); }

function harvestManagerSurfaceVisible() {
  return !$('harvestHistoryDialog').open && !$('harvestBookmarkDialog').open && !$('harvestPasswordDialog').open &&
    !$('harvestExtensionDialog').open && !$('harvestDnsDialog').open;
}

function harvestHistoryTime(ms) {
  try { return new Date(Number(ms) || Date.now()).toLocaleString('th-TH', { dateStyle:'medium', timeStyle:'short' }); }
  catch { return ''; }
}
async function refreshHarvestHistory() {
  const data = await call('harvestTsHistoryList',{limit:1000}), host = $('harvestHistoryList');
  $('harvestHistoryState').textContent = data.enabled ? 'กำลังบันทึกประวัติการเข้าเว็บ' : 'ปิดการบันทึกประวัติอยู่';
  $('harvestClearHistory').disabled = !data.items.length;
  if (!data.items.length) { host.replaceChildren(harvestListEmpty('ยังไม่มีประวัติการเข้าเว็บ')); return; }
  const fragment=document.createDocumentFragment();
  for(const item of data.items){
    const row=el('div','harvest-manager-row'), main=el('div','harvest-manager-row-main');
    main.append(el('strong','',item.title || harvestHost(item.url)), el('small','',item.url+' • '+harvestHistoryTime(item.visitedAt)));
    const actions=el('div','harvest-manager-row-actions');
    const open=el('button','quiet','เปิด'), remove=el('button','delete','ลบ');
    open.type=remove.type='button';
    open.addEventListener('click',()=>action(async()=>{
      $('harvestHistoryDialog').close();
      await syncHarvestLayout(true);
      await navigateHarvest(item.url);
    }));
    remove.addEventListener('click',()=>action(async()=>{ await call('harvestTsHistoryRemove',{id:item.id,limit:1000}); await refreshHarvestHistory(); }));
    actions.append(open,remove);row.append(main,actions);fragment.append(row);
  }
  host.replaceChildren(fragment);
}
async function openHarvestHistory(){
  await call('harvestTsLayout',{visible:false,bounds:harvestBounds()});
  await refreshHarvestHistory();
  $('harvestHistoryDialog').showModal();
}

async function setHarvestMenuOpen(open) {
  $('harvestMenuPopup').hidden = !open;
  if (open) await call('harvestTsLayout', { visible:false, bounds:harvestBounds() });
  else if (!$('harvestTsView').hidden && harvestManagerSurfaceVisible()) await syncHarvestLayout(true);
}
function harvestListEmpty(text) {
  return el('div', 'harvest-manager-empty', text);
}
async function refreshHarvestBookmarks(preferredFolderId) {
  const model = await call('harvestTsBookmarkModel'), host = $('harvestBookmarkList');
  const tab = activeHarvestTab();
  $('harvestBookmarkCurrentTitle').textContent = tab?.title || 'หน้าปัจจุบัน';
  $('harvestBookmarkCurrentUrl').textContent = tab?.kind === 'web' ? (tab.url || '') : 'หน้านี้ไม่สามารถบันทึกเป็น Bookmark ได้';
  $('harvestBookmarkCount').textContent = `${model.items.length} รายการ`;

  const select=$('harvestBookmarkFolderSelect'), current=preferredFolderId !== undefined ? preferredFolderId : null;
  select.replaceChildren(new Option('ทั่วไป — ไม่อยู่ในโฟลเดอร์',''));
  for(const folder of model.folders) select.append(new Option(folder.name,folder.id));
  const savedCurrent = tab?.kind === 'web' ? model.items.find(x=>x.url===tab.url) : null;
  const targetFolder = current !== null && [...select.options].some(x=>x.value===current)
    ? current : (savedCurrent?.folderId || '');
  select.value = targetFolder || '';
  $('harvestAddBookmark').disabled = !tab || tab.kind !== 'web' || !/^https?:\/\//i.test(tab.url || '');
  $('harvestAddBookmark').textContent = savedCurrent ? '★ อัปเดต Bookmark นี้' : '☆ บันทึกหน้านี้';

  if (!model.items.length) { host.replaceChildren(harvestListEmpty('ยังไม่มี Bookmark ค่ะ')); return model; }
  const folders = new Map(model.folders.map(x=>[x.id,x.name]));
  const fragment = document.createDocumentFragment();
  for (const item of model.items) {
    const row = el('div','harvest-manager-row'), main = el('div','harvest-manager-row-main');
    const meta = item.folderId ? `${item.url} • 📁 ${folders.get(item.folderId) || 'โฟลเดอร์'}` : `${item.url} • ทั่วไป`;
    main.append(el('strong','',item.title || harvestHost(item.url)), el('small','',meta));
    const actions = el('div','harvest-manager-row-actions');
    const open = el('button','quiet','เปิด'), remove = el('button','delete','ลบ');
    open.type = remove.type = 'button';
    open.addEventListener('click', () => action(async () => {
      $('harvestBookmarkDialog').close();
      await syncHarvestLayout(true);
      await createHarvestTab(item.url);
    }));
    remove.addEventListener('click', () => action(async () => {
      await call('harvestTsBookmarkRemove',{id:item.id});
      await refreshHarvestBookmarks();
      updateHarvestBookmarkButton().catch(()=>{});
    }));
    actions.append(open,remove); row.append(main,actions); fragment.append(row);
  }
  host.replaceChildren(fragment);
  return model;
}
async function openHarvestBookmarks() {
  await call('harvestTsLayout', {visible:false,bounds:harvestBounds()});
  await refreshHarvestBookmarks();
  $('harvestBookmarkNewFolder').value='';
  $('harvestBookmarkDialog').showModal();
}
async function updateHarvestBookmarkButton() {
  const tab=activeHarvestTab(), button=$('harvestBookmarkQuick');
  const eligible=Boolean(tab && tab.kind==='web' && /^https?:\/\//i.test(tab.url || ''));
  button.disabled=!eligible;
  if(!eligible){button.textContent='☆';button.classList.remove('saved');button.title='บันทึก Bookmark';return}
  const state=await call('harvestTsBookmarkStatus',{url:tab.url});
  button.textContent=state.saved?'★':'☆';
  button.classList.toggle('saved',state.saved);
  button.title=state.saved?'แก้ไข Bookmark นี้':'บันทึก Bookmark';
}

const harvestPasswordHints = new Map();
let lastPasswordPromptToken = '';
async function updateHarvestPasswordButton() {
  const tab=activeHarvestTab(), button=$('harvestPasswordQuick');
  const eligible=Boolean(tab && tab.kind==='web' && /^https?:\/\//i.test(tab.url||''));
  button.disabled=!eligible;
  if(!eligible){button.classList.remove('available','pending');button.title='บัญชีและรหัสผ่าน';return}
  let state=harvestPasswordHints.get(tab.id);
  let origin='';try{origin=new URL(tab.url||'').origin}catch{}
  if(!state || state.origin!==origin) {
    state=await call('harvestTsPasswordStatus',{id:tab.id});
    harvestPasswordHints.set(tab.id,state);
  }
  const count=Array.isArray(state.accounts)?state.accounts.length:0;
  button.classList.toggle('available',count>0);
  button.classList.toggle('pending',Boolean(state.canSave));
  if(state.canSave) button.title=state.candidateUsername?('มีรหัสของ '+state.candidateUsername+' รอให้บันทึก'):'มีรหัสผ่านรอให้บันทึก';
  else if(count>1) button.title='เลือกจาก '+count+' บัญชีที่บันทึกไว้';
  else if(count===1) button.title='ใช้บัญชีที่บันทึกไว้';
  else button.title='บันทึกหรือจัดการรหัสผ่าน';
}

async function refreshHarvestPasswords() {
  const items = await call('harvestTsPasswordList'), host = $('harvestPasswordList');
  if (!items.length) { host.replaceChildren(harvestListEmpty('ยังไม่มีรหัสผ่านที่บันทึกไว้')); return; }
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const row = el('div','harvest-manager-row'), main = el('div','harvest-manager-row-main');
    main.append(el('strong','',item.origin), el('small','',item.username ? `บัญชี: ${item.username}` : 'ไม่ได้ระบุชื่อบัญชี'));
    const actions = el('div','harvest-manager-row-actions');
    const remove = el('button','delete','ลบ');
    remove.type='button';
    remove.addEventListener('click', () => action(async () => {
      await call('harvestTsPasswordRemove',{id:item.id});
      harvestPasswordHints.delete(activeHarvestTabId);
      await refreshHarvestPasswords();
      await updateHarvestPasswordButton();
    }));
    actions.append(remove); row.append(main,actions); fragment.append(row);
  }
  host.replaceChildren(fragment);
}
async function openHarvestPasswords() {
  await call('harvestTsLayout', {visible:false,bounds:harvestBounds()});
  await refreshHarvestPasswords();
  $('harvestPasswordDialog').showModal();
}
async function closeHarvestManager(dialog) {
  dialog.close();
  if (!$('harvestTsView').hidden) await syncHarvestLayout(true);
}

async function refreshHarvestExtensions() {
  const [adblock, items] = await Promise.all([call('harvestTsAdblockStatus'), call('harvestTsExtensionList')]);
  const host = $('harvestExtensionList'), fragment = document.createDocumentFragment();
  const built = el('div','harvest-manager-row harvest-adblock-row'), builtMain = el('div','harvest-manager-row-main');
  const builtTitle = el('strong','',adblock.name || 'Harvest Adblock');
  let details = adblock.loading ? 'กำลังโหลด EasyList / EasyPrivacy…'
    : adblock.ready
      ? `Ghostery Engine • HarvestTS + ImageHarvest • Network ${Number(adblock.networkFilters||0).toLocaleString()} • Cosmetic ${Number(adblock.cosmeticFilters||0).toLocaleString()} • บล็อกแล้ว ${Number(adblock.blockedSession||0).toLocaleString()} request รอบนี้`
      : `Fallback network blocker${adblock.error ? ' • '+adblock.error : ''}`;
  if (adblock.updatedAt) {
    try { details += ' • อัปเดต '+new Date(adblock.updatedAt).toLocaleString('th-TH',{dateStyle:'short',timeStyle:'short'}); } catch {}
  }
  const builtMeta = el('small',adblock.error && !adblock.ready ? 'harvest-extension-error' : '', details);
  builtMain.append(builtTitle,builtMeta);
  const builtActions = el('div','harvest-manager-row-actions'), builtLabel = el('label','harvest-extension-toggle');
  const builtToggle = document.createElement('input'); builtToggle.type='checkbox'; builtToggle.checked=Boolean(adblock.enabled);
  builtLabel.append(builtToggle, el('span','',adblock.enabled ? 'เปิด' : 'ปิด'));
  builtToggle.addEventListener('change', () => action(async () => { await call('harvestTsAdblockSet',{enabled:builtToggle.checked}); await refreshHarvestExtensions(); }));
  const update = el('button','quiet','อัปเดต'); update.type='button'; update.disabled=Boolean(adblock.loading);
  update.addEventListener('click',()=>action(async()=>{ update.disabled=true; update.textContent='กำลังอัปเดต…'; await call('harvestTsAdblockUpdate'); await refreshHarvestExtensions(); }));
  builtActions.append(el('span','harvest-plugin-badge',adblock.ready?'EASYLIST+':'BUILT-IN'),update,builtLabel); built.append(builtMain,builtActions); fragment.append(built);

  for (const item of items) {
    const row = el('div','harvest-manager-row'), main = el('div','harvest-manager-row-main');
    main.append(el('strong','',item.name || item.id), el('small',item.error ? 'harvest-extension-error' : '', item.error ? `โหลดไม่สำเร็จ: ${item.error}` : `v${item.version || '?'} • Chrome Extension`));
    const actions = el('div','harvest-manager-row-actions'), label = el('label','harvest-extension-toggle');
    const toggle=document.createElement('input'); toggle.type='checkbox'; toggle.checked=item.enabled !== false && item.loaded !== false;
    label.append(toggle,el('span','',toggle.checked?'เปิด':'ปิด'));
    toggle.addEventListener('change',()=>action(async()=>{ await call('harvestTsExtensionToggle',{id:item.id,enabled:toggle.checked}); await refreshHarvestExtensions(); }));
    const remove=el('button','delete','ลบ'); remove.type='button';
    remove.addEventListener('click',()=>action(async()=>{ await call('harvestTsExtensionRemove',{id:item.id}); await refreshHarvestExtensions(); }));
    actions.append(label,remove); row.append(main,actions); fragment.append(row);
  }
  host.replaceChildren(fragment);
}
async function openHarvestExtensions() {
  await call('harvestTsLayout',{visible:false,bounds:harvestBounds()});
  await refreshHarvestExtensions();
  $('harvestExtensionDialog').showModal();
}
async function openHarvestDns() {
  await call('harvestTsLayout',{visible:false,bounds:harvestBounds()});
  const settings = await call('harvestTsDnsSettings');
  $('harvestDnsMode').value = settings.dnsMode || 'inherit';
  $('harvestCustomDoh').value = settings.customDoh || '';
  $('harvestCustomDohRow').hidden = $('harvestDnsMode').value !== 'custom';
  $('harvestDnsStatus').textContent = '';
  $('harvestDnsDialog').showModal();
}

let harvestBlockMode = false, harvestBlockTabId = null, harvestBlockPollTimer = null, harvestBlockPollBusy = false;
function selectorLabel(selector) {
  const text=String(selector || '');
  return text.length > 72 ? text.slice(0,69)+'…' : text;
}
function renderHarvestBlockState(state = {}) {
  $('harvestBlockOrigin').textContent = state.origin || 'เลือกส่วนที่ต้องการซ่อน';
  const selected = Array.isArray(state.selectors) ? state.selectors : [];
  const saved = Array.isArray(state.saved) ? state.saved : [];
  $('harvestBlockDraftCount').textContent = `${selected.length} จุด`;
  $('harvestBlockCommit').disabled = selected.length === 0;
  const draft = document.createDocumentFragment();
  if (!selected.length) draft.append(harvestListEmpty('ยังไม่ได้เลือก Element'));
  else for (const selector of selected) {
    const row=el('div','harvest-block-selector'); const code=document.createElement('code'); code.textContent=selector; code.title=selector;
    row.append(code); draft.append(row);
  }
  $('harvestBlockDraftList').replaceChildren(draft);
  $('harvestBlockSavedCount').textContent = `${saved.length} กฎ`;
  $('harvestBlockClearSaved').disabled = saved.length === 0;
  const savedFrag=document.createDocumentFragment();
  if (!saved.length) savedFrag.append(harvestListEmpty('เว็บนี้ยังไม่มี Filter ที่บันทึกไว้'));
  else for (const selector of saved) {
    const row=el('div','harvest-block-selector'); const code=document.createElement('code'); code.textContent=selector; code.title=selector;
    const remove=el('button','delete','ลบ'); remove.type='button';
    remove.addEventListener('click',()=>action(async()=>{
      const tab=activeHarvestTab(); if(!tab) return;
      const result=await call('harvestTsBlockRemove',{id:tab.id,selector});
      const latest=await call('harvestTsBlockDraftState',{id:tab.id});
      latest.saved=result.selectors; renderHarvestBlockState(latest);
    }));
    row.append(code,remove); savedFrag.append(row);
  }
  $('harvestBlockSavedList').replaceChildren(savedFrag);
}
function stopHarvestBlockPolling() {
  clearTimeout(harvestBlockPollTimer); harvestBlockPollTimer=null; harvestBlockPollBusy=false;
}
async function pollHarvestBlockState() {
  if (!harvestBlockMode || !harvestBlockTabId || harvestBlockPollBusy) return;
  harvestBlockPollBusy=true;
  try {
    const state=await call('harvestTsBlockDraftState',{id:harvestBlockTabId});
    renderHarvestBlockState(state);
    if (state.cancelled) { await cancelHarvestBlockMode(true); return; }
    if (!state.active) { await cancelHarvestBlockMode(false); return; }
  } catch { await cancelHarvestBlockMode(false); return; }
  finally { harvestBlockPollBusy=false; }
  if (harvestBlockMode) harvestBlockPollTimer=setTimeout(pollHarvestBlockState,220);
}
async function closeHarvestBlockPanel() {
  stopHarvestBlockPolling(); harvestBlockMode=false; harvestBlockTabId=null;
  $('harvestBlockPanel').hidden=true; document.querySelector('.harvest-browser-shell').classList.remove('block-mode');
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  if (!$('harvestTsView').hidden && harvestManagerSurfaceVisible()) await syncHarvestLayout(true);
}
async function cancelHarvestBlockMode(showMessage=true) {
  const id=harvestBlockTabId;
  if (id) await call('harvestTsBlockDraftCancel',{id}).catch(()=>{});
  await closeHarvestBlockPanel();
  if (showMessage) $('harvestStatus').textContent='ยกเลิก Block element แล้ว';
}
async function startHarvestBlockElement() {
  const tab=activeHarvestTab(); if(!tab) return;
  await call('harvestTsBlockDraftBegin',{id:tab.id});
  $('harvestStatus').textContent='Block element • หน้าต่างลอยเปิดแล้ว • สีเทา = กำลังชี้ • สีฟ้าอ่อน = เลือกแล้ว';
}


const harvestResizeObserver = new ResizeObserver(() => {
  if (!$('harvestTsView').hidden && harvestManagerSurfaceVisible()) window.eiw.harvestTsLayout({ visible: true, bounds: harvestBounds() }).catch(() => {});
});
harvestResizeObserver.observe($('harvestWebviews'));
window.addEventListener('resize', () => {
  if (!$('harvestTsView').hidden && harvestManagerSurfaceVisible()) window.eiw.harvestTsLayout({ visible: true, bounds: harvestBounds() }).catch(() => {});
});

function renderBrowserProfile(info = {}) {
  const ready = Boolean(info.ready), connected = Boolean(info.hasAccount || info.email);
  $('profileEmail').textContent = info.email || (connected ? 'ล็อกอินแล้ว • Chrome ไม่ได้ส่งชื่ออีเมลให้แอป' : 'ยังไม่ได้ล็อกอิน');
  $('profileSummary').textContent = connected
    ? 'บัญชีและคุกกี้ของโปรไฟล์นี้จะถูกใช้ทุกครั้งที่เลือก Google Chrome'
    : ready ? 'สร้างโปรไฟล์แล้ว • เปิด Chrome แล้วล็อกอินบัญชีที่ต้องการได้เลย' : 'ยังไม่มีโปรไฟล์ • เปิด Chrome เพื่อเริ่มตั้งค่าบัญชี';
  $('profileBadge').textContent = connected ? 'พร้อมใช้' : ready ? 'มีโปรไฟล์' : 'ยังไม่ตั้งค่า';
  $('profileBadge').classList.toggle('ready', connected);
  $('profileNavState').textContent = connected ? 'พร้อม' : ready ? 'มีโปรไฟล์' : 'ตั้งค่า';
  $('profileNavState').classList.toggle('ready', connected);
  $('useBrowserProfile').disabled = !ready;
}
async function refreshBrowserProfile() { const info = await call('browserProfile'); renderBrowserProfile(info); return info; }
async function profileAction(fn) {
  try { $('profileActionNote').className = 'account-note'; await fn(); }
  catch (error) { $('profileActionNote').className = 'account-note error'; $('profileActionNote').textContent = error.message; }
}
function imageSource(item, retry = 0) { return `eiw://app/image/${item.id}${retry ? `?retry=${retry}` : ''}`; }
function queueLiveRender() {
  if (liveRenderTimer !== null) return;
  liveRenderTimer = setTimeout(() => { liveRenderTimer = null; render(); }, 90);
}
function resetLiveWork() {
  activeScanId = null; analysisEpoch++;
  clearTimeout(liveRenderTimer); liveRenderTimer = null;
  clearTimeout(analysisTimer); analysisTimer = null;
  clearTimeout(renderTimer); renderTimer = null;
  for (const task of blankChecks.values()) task.cancel();
  blankChecks.clear();
}
function mergeScanItems(items, final = false) {
  const byId = new Map(all.map(item => [item.id,item]));
  for (const update of items || []) {
    const item = byId.get(update.id);
    if (item) Object.assign(item, update); // Keep card callbacks bound to the same object.
    else { all.push(update); byId.set(update.id,update); sequence.push(update.id); selected.add(update.id); }
  }
  if (final) {
    const wanted = new Set(items.map(x => x.id));
    all = all.filter(x => wanted.has(x.id)); sequence = sequence.filter(id => wanted.has(id));
  }
  mainScope = ImageHarvestFilters.mainScope(all); applySort();
}
function inspectLocalImage(item, image) {
  if (item.pixelHints?.checked) return;
  const extension = item.ext || (item.url.match(/\.([a-z0-9]+)(?:[?#]|$)/i)?.[1] || '');
  // Do not classify an animated/unknown format by its first frame.
  if (!/^(?:png|jpe?g)$/i.test(extension) && item.source !== 'canvas') {
    item.pixelHints = {checked:true,blank:false,unknown:true}; return;
  }
  try {
    if (!image.naturalWidth || !image.naturalHeight) return;
    const scale = Math.min(1,512 / Math.max(image.naturalWidth,image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1,Math.round(image.naturalWidth*scale));
    canvas.height = Math.max(1,Math.round(image.naturalHeight*scale));
    const ctx = canvas.getContext('2d',{willReadFrequently:true});
    ctx.drawImage(image,0,0,canvas.width,canvas.height);
    item.pixelHints = ImageHarvestFilters.inspectPixels(ctx.getImageData(0,0,canvas.width,canvas.height).data);
    canvas.width = canvas.height = 1;
  } catch { item.pixelHints = {checked:true,blank:false,unknown:true}; }
}
function blankCandidates() {
  if (!$('hideBlank').checked) return [];
  const options = {...filterOptions(),hideBlank:false};
  return all.filter(x => !x.pixelHints?.checked && ImageHarvestFilters.matches(x,options));
}
function queueBlankChecks() {
  if (analysisTimer !== null || (busy && !continuousActive) || captureActive || !$('hideBlank').checked) return;
  analysisTimer = setTimeout(() => {
    analysisTimer = null;
    for (const item of blankCandidates()) {
      if (blankChecks.size >= 2) break;
      if (blankChecks.has(item.id) || item.previewReady === false) continue;
      const image = new Image(), epoch = analysisEpoch;
      let done = false, timer;
      const finish = (loaded, cancelled = false) => {
        if (done) return; done = true; clearTimeout(timer);
        image.onload = image.onerror = null;
        if (blankChecks.get(item.id)?.image === image) blankChecks.delete(item.id);
        if (!cancelled && epoch === analysisEpoch && all.includes(item)) {
          if (loaded) inspectLocalImage(item,image);
          else item.pixelHints = {checked:true,blank:false,unknown:true};
          queueLiveRender();
        }
        image.removeAttribute('src');
      };
      blankChecks.set(item.id,{image,cancel:()=>finish(false,true)});
      image.onload = () => finish(true); image.onerror = () => finish(false);
      timer = setTimeout(()=>finish(false),35000); image.src = imageSource(item);
    }
  },0);
}
function cardHint(item) {
  if (item.pixelHints?.blank) return 'หน้าว่าง / สีล้วน (คาดว่า)';
  const h = item.filterHints || {};
  if (h.category === 'ad') return 'โฆษณา / แบนเนอร์ (คาดว่า)';
  if (h.category === 'promo') return 'โปรโมต / สนับสนุนเว็บ (คาดว่า)';
  if (h.category === 'placeholder') return 'ภาพรอโหลด / ตัวคั่น';
  if (h.chrome) return 'โลโก้ / ส่วนประกอบเว็บ (คาดว่า)';
  return h.mainKind === 'reader' ? 'บริเวณตัวอ่าน' : h.mainKind === 'main' ? 'เนื้อหาหลัก' : 'ไม่ระบุบริเวณ';
}
function defaultTabForm() {
  return { url:'', autoScroll:true, backgrounds:false, canvases:true, selector:'', waitMs:'800', maxSteps:'150',
    captureInterval:'900', search:'', minWidth:'0', minHeight:'0', sort:'visual', dedupe:true,
    hideChrome:false, mainOnly:false, hideBlank:false, sourceFilter:'all', setName:'', contentMode:'web', continuousMode:false, continuousStart:'1' };
}
function makeTabState(number) {
  return { id:`tab-${number}`, number, title:'', url:'', all:[], sequence:[], selected:new Set(), states:new Map(),
    mainScope:'unknown', removedSnapshot:null, pageTitle:'คอลเลกชันใหม่ของพี่จะอยู่ตรงนี้',
    notice:'', form:defaultTabForm() };
}
function readTabForm() {
  return { url:$('url').value, autoScroll:$('autoScroll').checked, backgrounds:$('backgrounds').checked,
    canvases:$('canvases').checked, selector:$('selector').value, waitMs:$('waitMs').value, maxSteps:$('maxSteps').value,
    captureInterval:$('captureInterval').value, search:$('search').value, minWidth:$('minWidth').value,
    minHeight:$('minHeight').value, sort:$('sort').value, dedupe:$('dedupe').checked,
    hideChrome:$('hideChrome').checked, mainOnly:$('mainOnly').checked, hideBlank:$('hideBlank').checked, sourceFilter:$('sourceFilter').value,
    setName:$('setName').value, contentMode:$('mangaMode').classList.contains('active') ? 'manga' : 'web',
    continuousMode:$('continuousMode').checked, continuousStart:$('continuousStart').value };
}
function applyTabForm(form = defaultTabForm()) {
  $('url').value = form.url || ''; $('autoScroll').checked = form.autoScroll !== false;
  $('backgrounds').checked = Boolean(form.backgrounds); $('canvases').checked = form.canvases !== false;
  $('selector').value = form.selector || ''; $('waitMs').value = form.waitMs || '800'; $('maxSteps').value = form.maxSteps || '150';
  $('captureInterval').value = form.captureInterval || '900'; $('search').value = form.search || '';
  $('minWidth').value = form.minWidth || '0'; $('minHeight').value = form.minHeight || '0'; $('sort').value = form.sort || 'visual';
  $('dedupe').checked = form.dedupe !== false; $('hideChrome').checked = Boolean(form.hideChrome);
  $('hideBlank').checked = Boolean(form.hideBlank);
  $('mainOnly').checked = Boolean(form.mainOnly); $('sourceFilter').value = form.sourceFilter || 'all'; $('setName').value = form.setName || '';
  setContentMode(form.contentMode === 'manga' ? 'manga' : 'web', false);
  $('continuousMode').checked = form.contentMode === 'manga' && Boolean(form.continuousMode);
  $('continuousStart').value = form.continuousStart || '1'; syncContinuousUI();
}
function saveActiveTabState() {
  const tab = tabs.get(activeTabId); if (!tab) return;
  tab.all = all.slice(); tab.sequence = sequence.slice(); tab.selected = new Set(selected); tab.states = new Map(states);
  tab.mainScope = mainScope; tab.removedSnapshot = removedSnapshot; tab.pageTitle = $('pageTitle').textContent;
  tab.notice = $('notice').hidden ? '' : $('notice').textContent; tab.form = readTabForm(); tab.url = tab.form.url;
}
function restoreTabState(tab) {
  resetLiveWork();
  all = tab.all.slice(); sequence = tab.sequence.slice(); selected = new Set(tab.selected); states = new Map(tab.states);
  mainScope = tab.mainScope; removedSnapshot = tab.removedSnapshot; currentURL = ''; scannedURL = '';
  applyTabForm(tab.form); $('pageTitle').textContent = tab.pageTitle;
  $('notice').textContent = tab.notice || ''; $('notice').hidden = !tab.notice;
  if ($('preview').open) $('preview').close(); if ($('readerDialog').open) $('readerDialog').close();
  render();
}
function tabLabel(tab) {
  if (tab.title) return tab.title.length > 28 ? tab.title.slice(0, 27) + '…' : tab.title;
  const raw = tab.form?.url || tab.url;
  try { return new URL(raw).hostname || `แท็บ ${tab.number}`; } catch { return `แท็บ ${tab.number}`; }
}
function renderTabs() {
  const host = $('workspaceTabs'); if (!host) return;
  const fragment = document.createDocumentFragment();
  for (const tab of tabs.values()) {
    const wrap = el('div', `workspace-tab${tab.id === activeTabId ? ' active' : ''}`);
    const mainButton = el('button', 'workspace-tab-main'); mainButton.dataset.workspaceId = tab.id;
    mainButton.append(el('span', 'workspace-tab-label', tabLabel(tab)),
      el('span', 'workspace-tab-count', String(tab.id === activeTabId ? all.length : tab.all.length)));
    mainButton.disabled = busy || captureActive;
    mainButton.addEventListener('click', () => action(() => switchWorkspaceTab(tab.id)));
    wrap.append(mainButton);
    if (tabs.size > 1) {
      const close = el('button', 'workspace-tab-close', '×'); close.dataset.closeWorkspace = tab.id;
      close.title = 'ปิดแท็บ'; close.disabled = busy || captureActive;
      close.addEventListener('click', event => { event.stopPropagation(); action(() => closeWorkspaceTab(tab.id)); });
      wrap.append(close);
    }
    fragment.append(wrap);
  }
  host.replaceChildren(fragment);
  $('addTab').disabled = busy || captureActive || tabs.size >= 12;
}
function touchActiveTab(title = '', url = '') {
  const tab = tabs.get(activeTabId); if (!tab) return;
  if (title) tab.title = title; if (url) { tab.url = url; tab.form.url = url; }
  renderTabs();
}
async function switchWorkspaceTab(id) {
  if (id === activeTabId || busy || captureActive || !tabs.has(id)) return;
  saveActiveTabState();
  await call('workspaceSwitch', { id });
  activeTabId = id; restoreTabState(tabs.get(id)); renderTabs();
  status(all.length ? `สลับแท็บแล้ว — เก็บผลเดิม ${all.length} ภาพไว้ครบ` : 'แท็บใหม่พร้อมใช้งาน — วางลิงก์แล้วเริ่มสแกนได้เลย');
}
async function addWorkspaceTab() {
  if (busy || captureActive || tabs.size >= 12) return;
  saveActiveTabState(); const number = ++tabCounter, tab = makeTabState(number); tabs.set(tab.id, tab);
  try { await call('workspaceSwitch', { id: tab.id }); activeTabId = tab.id; restoreTabState(tab); renderTabs(); status(`เพิ่มแท็บ ${number} แล้ว — งานแท็บก่อนหน้ายังคงอยู่`); }
  catch (error) { tabs.delete(tab.id); tabCounter--; renderTabs(); throw error; }
}
async function closeWorkspaceTab(id) {
  if (busy || captureActive || tabs.size <= 1 || !tabs.has(id)) return;
  if (id === activeTabId) {
    saveActiveTabState();
    const ids = [...tabs.keys()], index = ids.indexOf(id), target = ids[index + 1] || ids[index - 1];
    await call('workspaceSwitch', { id: target }); activeTabId = target; restoreTabState(tabs.get(target));
    await call('workspaceClose', { id }); tabs.delete(id); renderTabs(); status('ปิดแท็บแล้ว — งานแท็บอื่นยังอยู่');
    return;
  }
  await call('workspaceClose', { id }); tabs.delete(id); renderTabs(); status('ปิดแท็บแล้ว');
}
tabs.set('tab-1', makeTabState(1));
function networkDescription(mode) {
  if (mode === 'cloudflare') return 'ใช้ Cloudflare DNS-over-HTTPS; ดาวน์โหลดในโหมด Chrome ใช้ 1.1.1.1';
  if (mode === 'google') return 'ใช้ Google DNS-over-HTTPS; ดาวน์โหลดในโหมด Chrome ใช้ 8.8.8.8';
  if (mode === 'adguard') return 'ใช้ AdGuard DNS-over-HTTPS เพื่อบล็อกโฆษณาและตัวติดตาม; ถ้าเว็บโหลดไม่ครบให้กลับ Smart Auto';
  if (mode === 'compat') return 'Compatibility ใช้ Cloudflare DNS และปิด HTTP/2 + QUIC หลังรีสตาร์ต';
  return 'Smart Auto: ใช้ Secure DNS ของ Cloudflare/Google อัตโนมัติ และสลับสำรองเมื่อเกิด timeout หรือหาโดเมนไม่เจอ';
}
function contentMode() { return $('mangaMode').classList.contains('active') ? 'manga' : 'web'; }
function setContentMode(mode, announce = true) {
  const manga = mode === 'manga';
  $('mangaMode').classList.toggle('active', manga); $('mangaMode').setAttribute('aria-pressed', String(manga));
  $('webMode').classList.toggle('active', !manga); $('webMode').setAttribute('aria-pressed', String(!manga));
  $('continuousControl').hidden = !manga;
  if (!manga) $('continuousMode').checked = false;
  $('contentModeNote').textContent = manga
    ? 'โหมดมังงะ • เปิดใช้ตัวตรวจ Chapter/ตอนถัดไปได้ • ตัวสแกนภาพเดิมยังทำงานเหมือนเดิม'
    : 'เว็บทั่วไป • เก็บภาพจากหน้าเว็บเดียว • ไม่ใช้ระบบหา Chapter';
  syncContinuousUI();
  if (announce) status(manga ? 'โหมดมังงะพร้อม — จะเปิดระบบไล่ตอนเพิ่มได้' : 'โหมดเว็บทั่วไปพร้อม — ไม่ใช้ระบบหา Chapter');
}
function syncContinuousUI() {
  const manga = contentMode() === 'manga', enabled = manga && $('continuousMode').checked;
  $('continuousControl').hidden = !manga;
  $('setNameWrap').hidden = enabled; $('continuousStartWrap').hidden = !enabled;
  $('downloadActionText').textContent = enabled ? (continuousActive ? 'กำลังเก็บต่อเนื่อง' : 'เริ่มเก็บต่อเนื่อง') : 'บันทึกภาพที่เลือก';
  $('download').title = enabled ? 'บันทึกตอนปัจจุบันลงโฟลเดอร์เลข แล้วไล่ตอนถัดไปอัตโนมัติ' : 'บันทึกภาพที่เลือก';
}
function syncCaptureControls() {
  $('capturePages').textContent = captureActive ? '■ หยุดจับทีละหน้า' : '◎ จับทีละหน้า';
  $('capturePages').disabled = busy;
  for (const id of ['open', 'scan', 'protectionCompatibility', 'browserMode', 'networkMode', 'applyNetwork', 'renameTool', 'continuousMode', 'webMode', 'mangaMode', 'autoReader']) $(id).disabled = busy || captureActive;
  $('url').disabled = busy || captureActive;
  $('restartNetwork').disabled = busy || captureActive;
  $('statusDot').classList.toggle('working', busy || captureActive);
  if (captureActive) $('progress').hidden = true;
  syncChromeControls();
  renderTabs();
}
function appendCaptured(items) {
  if (!Array.isArray(items) || !items.length) return;
  const known = new Set(all.map(item => item.id));
  for (const item of items) {
    if (known.has(item.id)) continue;
    known.add(item.id); all.push(item); sequence.push(item.id); selected.add(item.id);
  }
  mainScope = ImageHarvestFilters.mainScope(all);
  render();
}
function setBusy(value) {
  busy = value;
  for (const id of ['open', 'scan', 'capturePages', 'applyNetwork', 'restartNetwork', 'chooseFolder', 'exportLinks', 'sort', 'dedupe', 'contentPreset', 'selectAll', 'deselectAll', 'reverseOrder', 'renameTool', 'hideChrome', 'mainOnly', 'hideBlank', 'sourceFilter', 'resetFilters', 'search', 'minWidth', 'minHeight', 'setName', 'continuousMode', 'continuousStart', 'webMode', 'mangaMode', 'browserMode', 'networkMode', 'preRead', 'autoReader']) $(id).disabled = value;
  $('url').disabled = value; $('cancel').hidden = !value;
  $('statusDot').classList.toggle('working', value); $('progress').hidden = !value;
  if (!value) $('progress').value = 0;
  syncCaptureControls();
  counts();
}
function sortedItems() {
  const byId = new Map(all.map(item => [item.id, item]));
  return sequence.map(id => byId.get(id)).filter(Boolean);
}
function filterOptions() {
  return { search: $('search').value, minWidth: Math.max(0, Number($('minWidth').value) || 0),
    minHeight: Math.max(0, Number($('minHeight').value) || 0), source: $('sourceFilter').value,
    hideChrome: $('hideChrome').checked, mainOnly: $('mainOnly').checked, hideBlank: $('hideBlank').checked, mainScope };
}
function visibleItems() {
  const options = filterOptions(), seen = new Set();
  // Filter before deduplication: a header occurrence must not hide a main-content occurrence.
  return sortedItems().filter(item => ImageHarvestFilters.matches(item, options)).filter(item => {
    if (!$('dedupe').checked) return true;
    // Deduplicate the same acquired source only. Different URLs may legitimately
    // contain identical bytes (e.g. repeated/blank manga pages or test fixtures).
    const key = item.url;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
function exportItems() { return visibleItems().filter(item => selected.has(item.id)); }
function counts() {
  const count = exportItems().length, unchecked = blankCandidates().length;
  const continuousReady = contentMode() === 'manga' && $('continuousMode').checked && Boolean($('url').value.trim());
  $('selectionCount').textContent = `เลือก ${count} ภาพ`;
  $('downloadCount').textContent = count;
  $('totalCount').textContent = all.length ? `${visibleItems().length} / ${all.length}` : '0';
  $('download').disabled = busy || captureActive || (!count && !continuousReady) || (count > 0 && unchecked > 0);
  $('exportLinks').disabled = busy || captureActive || !count || unchecked > 0;
  $('preRead').disabled = busy || captureActive || !count || unchecked > 0;
  $('reverseOrder').disabled = busy || captureActive || sequence.length < 2;
  $('removeSelected').disabled = busy || captureActive || !count || unchecked > 0;
  $('removeCount').textContent = count;
  $('clearResults').disabled = busy || captureActive || (!all.length && !removedSnapshot);
  $('undoRemove').disabled = busy || captureActive || !removedSnapshot;
  const hidden = all.length - visibleItems().length;
  const scopeNote = $('mainOnly').checked ? (mainScope === 'unknown' ? ' • ระบุเขตหลักไม่ชัด: คงภาพที่ไม่แน่ใจไว้' : mainScope === 'reader' ? ' • ใช้บริเวณตัวอ่าน' : ' • ใช้บริเวณ main/article') : '';
  const blankNote = $('hideBlank').checked ? ` • หน้าว่างที่คาดว่า ${all.filter(x=>x.pixelHints?.blank).length}${unchecked ? ' • รอตรวจอีก ' + unchecked : ''}` : '';
  $('filterSummary').textContent = `แสดง ${all.length - hidden} / ${all.length} ภาพ • ซ่อนด้วยตัวกรอง/ภาพซ้ำ ${hidden} ภาพ${scopeNote}${blankNote} • คัดจากชื่อ/บริเวณ/ลิงก์ อาจผิดได้ — ปิดตัวกรองเพื่อคืนภาพ`;
  renderTabs(); queueBlankChecks();
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
  if (busy || captureActive || id === target) return;
  const a = sequence.indexOf(id), b = sequence.indexOf(target);
  if (a < 0 || b < 0) return;
  sequence.splice(a, 1); sequence.splice(b, 0, id);
  $('sort').value = 'manual'; render();
}
function updateState(id, text, failed = false, scope = '') {
  if (!all.some(item => item.id === id)) return;
  states.set(id, { text, failed, scope });
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
      // Attach the image URL only once Chrome has preserved the bytes.
      image.addEventListener('load', () => {
        if (!all.includes(item)) return;
        image.hidden = false; thumb.querySelector('.image-error')?.remove(); thumb.querySelector('.image-wait')?.remove();
        const stale = states.get(item.id);
        if (stale?.failed && stale.scope === 'preview') {
          states.delete(item.id); const node = card.querySelector('.card-state');
          if (node) { node.textContent = ''; node.title = ''; node.classList.remove('failed'); }
        }
        inspectLocalImage(item, image);
        // Measured intrinsic dimensions are more accurate than CSS background dimensions.
        if (image.naturalWidth && image.naturalHeight) {
          item.width = image.naturalWidth; item.height = image.naturalHeight;
          const dimensions = card.querySelector('.dimensions');
          if (dimensions) dimensions.textContent = `${item.width} × ${item.height}`;
          counts();
          queueLiveRender();
        }
      });
      image.addEventListener('error', () => {
        const retry = Number(image.dataset.retry || 0);
        if (retry < 2 && all.includes(item)) {
          image.dataset.retry = String(retry + 1); image.hidden = true;
          let wait = thumb.querySelector('.image-wait');
          if (!wait) { wait = el('span','image-wait'); thumb.append(wait); }
          wait.textContent = `โหลดไม่สำเร็จ • กำลังลองใหม่ ${retry + 1}/2…`;
          setTimeout(() => {
            if (!all.includes(item) || !image.isConnected) return;
            wait?.remove(); image.hidden = false; image.src = imageSource(item, retry + 1);
          }, retry === 0 ? 900 : 1800);
          return;
        }
        image.hidden = true; thumb.querySelector('.image-wait')?.remove();
        if (!thumb.querySelector('.image-error')) thumb.append(el('span', 'image-error', 'แสดงภาพไม่ได้\nดูสถานะด้านล่าง'));
      });
      thumb.append(image);
      thumb.addEventListener('click', () => {
        $('previewTitle').textContent = item.label; $('previewUrl').textContent = item.url;
        $('previewImage').src = imageSource(item); $('preview').showModal();
      });
      const top = el('div', 'card-top'), badge = el('span', 'sequence'), checkbox = el('input');
      checkbox.type = 'checkbox'; checkbox.setAttribute('aria-label', `เลือก ${item.label}`);
      checkbox.addEventListener('change', () => { checkbox.checked ? selected.add(item.id) : selected.delete(item.id); card.classList.toggle('selected', checkbox.checked); counts(); });
      top.append(badge, checkbox);
      const meta = el('div', 'card-meta'), name = el('div', 'card-name', item.label); name.title = item.url;
      const info = el('div', 'card-info'); info.append(el('span', 'dimensions', `${item.width} × ${item.height}`), el('span', 'source-tag', item.source)); meta.append(name, info);
      const hint = el('div', 'card-hint', cardHint(item));
      hint.title = item.filterHints?.reason || ''; meta.append(hint);
      const tools = el('div', 'card-tools'), state = el('span', 'card-state'), buttons = el('span'); state.dataset.state = item.id;
      const up = el('button', '', '←'), down = el('button', '', '→'); up.title = 'เลื่อนก่อนหน้า'; down.title = 'เลื่อนถัดไป';
      up.addEventListener('click', () => { const v = visibleItems(), index = v.findIndex(x => x.id === item.id); if (index > 0) moveItem(item.id, v[index - 1].id); });
      down.addEventListener('click', () => { const v = visibleItems(), index = v.findIndex(x => x.id === item.id); if (index + 1 < v.length) moveItem(item.id, v[index + 1].id); });
      buttons.append(up, down); tools.append(state, buttons);
      card.append(thumb, top, meta, tools);
      card.addEventListener('dragstart', event => { if (busy || captureActive) { event.preventDefault(); return; } dragged = item.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', item.id); });
      card.addEventListener('dragover', event => { if (dragged) { event.preventDefault(); card.classList.add('drag-over'); } });
      card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
      card.addEventListener('drop', event => { event.preventDefault(); card.classList.remove('drag-over'); if (dragged) moveItem(dragged, item.id); dragged = null; });
      card.addEventListener('dragend', () => { dragged = null; document.querySelectorAll('.drag-over').forEach(x => x.classList.remove('drag-over')); });
    }
    const thumbImage = card.querySelector('.thumb img'), thumbBox = card.querySelector('.thumb');
    if (item.previewReady === false) {
      if (!thumbBox.querySelector('.image-wait')) thumbBox.append(el('span','image-wait','พบภาพแล้ว • รอเว็บโหลด…'));
    } else if (!thumbImage.getAttribute('src')) {
      thumbBox.querySelector('.image-wait')?.remove(); thumbImage.src = imageSource(item);
    }
    const hint = card.querySelector('.card-hint');
    hint.textContent = cardHint(item); hint.title = item.pixelHints?.blank ? item.pixelHints.reason : item.filterHints?.reason || '';
    hint.classList.toggle('chrome', Boolean(item.filterHints?.chrome || item.pixelHints?.blank));
    card.querySelector('.dimensions').textContent = `${item.width} × ${item.height}`;
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
function applyReaderLayout() {
  $('readerStrip').dataset.mode = $('readerMode').value;
  $('readerStrip').dataset.width = $('readerWidth').value;
}
function openPreReader() {
  const items = exportItems();
  if (!items.length) { status('เลือกภาพที่จะ Pre-read ก่อนค่ะ', true); return; }
  const fragment = document.createDocumentFragment();
  items.forEach((item, index) => {
    const image = el('img'); image.loading = index < 3 ? 'eager' : 'lazy'; image.decoding = 'async';
    image.alt = item.alt || item.label || `หน้า ${index + 1}`; image.src = imageSource(item);
    image.dataset.page = String(index + 1); fragment.append(image);
  });
  $('readerStrip').replaceChildren(fragment); $('readerCount').textContent = `${items.length} ภาพ`;
  applyReaderLayout(); $('readerDialog').showModal();
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
function scanRequest() {
  return { autoScroll:$('autoScroll').checked, backgrounds:$('backgrounds').checked, canvases:$('canvases').checked,
    selector:$('selector').value, waitMs:Number($('waitMs').value), maxSteps:Number($('maxSteps').value) };
}
async function ensurePageOpen(show = false) {
  const input = $('url').value.trim();
  if (!input) throw new Error('กรุณาใส่ลิงก์เว็บไซต์ก่อนค่ะ');
  if (!currentURL || (input !== currentURL && `https://${input}` !== currentURL)) {
    const opened = await call('open', { url:input, show, backend:$('browserMode').value, chromeControl:$('chromeControl').value, protectionCompatibility:$('protectionCompatibility').checked });
    currentURL = opened.url; $('url').value = opened.url; touchActiveTab(opened.title, opened.url);
  }
  return currentURL;
}
function applyScanResult(result) {
  mergeScanItems(result.items, true); removedSnapshot = null; scannedURL = result.url || currentURL; render();
  $('pageTitle').textContent = result.title || result.url; touchActiveTab(result.title, result.url);
  const notices = [result.reason, result.notice].filter(Boolean);
  $('notice').textContent = notices.join(' • '); $('notice').hidden = !notices.length;
}
async function scanCurrentPage() {
  await ensurePageOpen(false);
  const result = await call('scan', scanRequest());
  applyScanResult(result);
  return result;
}
$('open').addEventListener('click', () => action(async () => {
  setBusy(true);
  try { const result = await call('open', { url: $('url').value, show: true, backend: $('browserMode').value, chromeControl: $('chromeControl').value, protectionCompatibility: $('protectionCompatibility').checked }); currentURL = result.url; $('url').value = result.url; touchActiveTab(result.title, result.url); }
  finally { setBusy(false); }
}));
$('scan').addEventListener('click', () => action(async () => {
  setBusy(true); $('notice').hidden = true;
  try {
    await ensurePageOpen(false);
    if (/^https:\/\/viewer\.bookwalker\.jp\//i.test(currentURL)) {
      await call('startCapture', { backgrounds:false, canvases:true, selector:'', intervalMs:Number($('captureInterval').value), autoAdvanceReader:true });
      captureActive = true; syncCaptureControls(); counts();
      status('BookWalker • กำลังเก็บหน้าหนังสือทั้งหมดอัตโนมัติ…');
      return;
    }
    const result = await call('scan', scanRequest());
    applyScanResult(result);
    status(`${result.cancelled ? 'หยุดสแกนแล้ว เก็บผลที่พบไว้' : result.truncated ? 'สแกนได้บางส่วน' : 'สแกนเสร็จ'} — พบ ${all.length} ภาพ (${result.steps} รอบ)`);
  } finally { activeScanId = null; clearTimeout(liveRenderTimer); liveRenderTimer = null; setBusy(false); render(); }
}));
$('capturePages').addEventListener('click', () => action(async () => {
  if (captureActive) {
    await call('stopCapture'); status('กำลังหยุดจับทีละหน้า…'); return;
  }
  setBusy(true); $('notice').hidden = true;
  try {
    const input = $('url').value.trim();
    if (!input) throw new Error('กรุณาใส่ลิงก์เว็บไซต์ก่อนค่ะ');
    if (!currentURL || (input !== currentURL && `https://${input}` !== currentURL)) {
      const opened = await call('open', { url: input, show: true, backend: $('browserMode').value, chromeControl: $('chromeControl').value, protectionCompatibility: $('protectionCompatibility').checked });
      currentURL = opened.url; $('url').value = opened.url;
    } else await call('showBrowser');
    await call('startCapture', { backgrounds: $('backgrounds').checked, canvases: $('canvases').checked, selector: $('selector').value, intervalMs: Number($('captureInterval').value), autoAdvanceReader: $('autoReader').checked });
    captureActive = true; syncCaptureControls(); counts();
    status($('autoReader').checked ? 'กำลังจับทีละหน้า — ถ้าตัวอ่านรองรับ ระบบจะเปลี่ยนหน้าให้อัตโนมัติ' : 'กำลังจับทีละหน้า — ไปที่หน้าต่างเว็บแล้วกดเปลี่ยนหน้าได้เลย');
  } finally { setBusy(false); }
}));
$('protectionCompatibility').addEventListener('change', () => {
  currentURL = '';
  if ($('protectionCompatibility').checked) { $('browserMode').value = 'chrome'; $('browserMode').dispatchEvent(new Event('change')); }
  $('protectionCompatibilityNote').textContent = $('protectionCompatibility').checked ? 'เปิดอัตโนมัติ — ตรวจเนื้อหาสคริปต์ ไม่ผูกโดเมน • เปิดหน้าใหม่เพื่อใช้' : 'ปิด — ไม่ปรับสคริปต์ แต่ยังเก็บภาพที่ Chrome โหลดแล้ว';
  status('กดเปิดเว็บหรือสแกนเพื่อใช้การตั้งค่าใหม่');
});
$('browserMode').addEventListener('change', () => {
  currentURL = '';
  $('browserModeNote').textContent = $('browserMode').value === 'chrome'
    ? 'ต้องติดตั้ง Chrome • ใช้โปรไฟล์ล็อกอินของ ImageHarvest • ไม่เปิดแผง DevTools'
    : 'เบราว์เซอร์ในแอป • ไม่ใช้เครื่องมือตรวจสคริปต์อัตโนมัติ';
  syncChromeControls();
  status('เลือกเบราว์เซอร์แล้ว — กดเปิดเว็บหรือสแกนเพื่อใช้โหมดนี้');
});

function syncChromeControls() {
  const chrome = $('browserMode').value === 'chrome', minimal = chrome && $('chromeControl').value === 'minimal';
  $('chromeControl').disabled = busy || captureActive || !chrome;
  $('protectionCompatibility').disabled = busy || captureActive || !chrome || minimal;
  if (minimal) {
    $('browserModeNote').textContent = 'Chrome Minimal • ใช้โปรไฟล์ล็อกอินเดียวกัน • ไม่เปิดแผง DevTools • ยังใช้ CDP';
    $('protectionCompatibilityNote').textContent = 'Minimal ไม่แก้สคริปต์เว็บ แม้ช่องวิธีเดิมจะติ๊กไว้';
  }
}
$('chromeControl').addEventListener('change', () => {
  currentURL = ''; $('browserMode').dispatchEvent(new Event('change'));
  $('protectionCompatibilityNote').textContent = $('chromeControl').value === 'minimal' ? 'Minimal ไม่แก้สคริปต์เว็บ' : 'Standard ใช้กฎที่รู้จักเมื่อเปิดตัวเลือกนี้';
  status('เปลี่ยนวิธีควบคุมแล้ว — เปิดเว็บใหม่เพื่อใช้โหมดนี้กับโปรไฟล์เดิม');
});
$('applyNetwork').addEventListener('click', () => action(async () => {
  const result = await call('networkMode', { mode: $('networkMode').value });
  networkRestartRequired = result.restartRequired;
  $('restartNetwork').hidden = !result.restartRequired;
  $('networkModeNote').textContent = networkDescription(result.mode) + (result.restartRequired ? ' • ต้องรีสตาร์ตแอป' : ' • ใช้งานแล้ว');
  currentURL = '';
  status(result.restartRequired ? 'บันทึกโหมดเครือข่ายแล้ว — รีสตาร์ตเพื่อให้ Compatibility มีผลครบ' : 'เปลี่ยนโหมดเครือข่ายแล้ว — เปิดเว็บใหม่เพื่อใช้การเชื่อมต่อใหม่');
}));
$('restartNetwork').addEventListener('click', () => action(() => call('restartForNetwork')));
$('webMode').addEventListener('click', () => { if (!busy && !captureActive) { setContentMode('web'); counts(); } });
$('mangaMode').addEventListener('click', () => { if (!busy && !captureActive) { setContentMode('manga'); counts(); } });
$('continuousMode').addEventListener('change', () => {
  if ($('continuousMode').checked && !$('hideChrome').checked) $('hideChrome').checked = true;
  syncContinuousUI(); render();
  status($('continuousMode').checked
    ? 'เปิดโหมดไล่ตอนแล้ว — เปิดตัวกรองโลโก้/โฆษณาให้อัตโนมัติ • ตั้งเลขโฟลเดอร์แล้วเริ่มเก็บได้เลย'
    : 'กลับเป็นโหมดบันทึกตอนเดียวแล้ว');
});
$('continuousStart').addEventListener('input', counts);
$('url').addEventListener('input', counts);
$('url').addEventListener('keydown', event => { if (event.key === 'Enter' && !busy && !captureActive) $('scan').click(); });
$('collectorNav').addEventListener('click', () => showWorkspaceView('collector'));
$('browserAccountNav').addEventListener('click', () => profileAction(async () => {
  showWorkspaceView('account');
  await refreshBrowserProfile();
  $('profileActionNote').textContent = 'รหัสผ่านกรอกใน Chrome โดยตรง แอปไม่รับหรือเก็บรหัสผ่านของบัญชี';
}));
$('harvestTsNav').addEventListener('click', () => showWorkspaceView('harvestts'));
$('ocrLabNav').addEventListener('click', () => action(() => call('ocrLabOpen')));
$('harvestNewTab').addEventListener('click', () => action(() => createHarvestTab()));
$('harvestGo').addEventListener('click', () => action(() => navigateHarvest($('harvestAddress').value)));
$('harvestAddress').addEventListener('pointerdown', event => {
  const input = $('harvestAddress');
  if (document.activeElement === input) return;
  event.preventDefault();
  input.focus();
  input.select();
});
$('harvestAddress').addEventListener('focus', () => {
  const input = $('harvestAddress');
  requestAnimationFrame(() => input.select());
});
$('harvestAddress').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); action(() => navigateHarvest($('harvestAddress').value)); }
  if (event.key === 'Escape') {
    const tab=activeHarvestTab();
    $('harvestAddress').value=tab?.kind==='downloads'?'Downloads':tab?.kind==='offline'?'Offline Library':tab?.kind==='offline-reader'?'Offline Reader':tab?.kind==='history'?'History':(tab?.url||'');
    $('harvestAddress').blur();
  }
});
$('harvestBack').addEventListener('click', () => action(() => harvestAction('back')));
$('harvestForward').addEventListener('click', () => action(() => harvestAction('forward')));
$('harvestReload').addEventListener('click', reloadHarvest);
$('harvestHome').addEventListener('click', () => action(() => harvestAction('home')));
$('harvestMenu').addEventListener('click', () => action(async () => {
  const rect = $('harvestMenu').getBoundingClientRect();
  await call('harvestTsPopupMenu', { x:Math.round(rect.left), y:Math.round(rect.bottom) });
}));
$('harvestSendToCollector').addEventListener('click', () => action(async () => {
  const tab=activeHarvestTab();
  if(!tab || tab.kind!=='web' || !/^https?:\/\//i.test(tab.url||'')) return;
  const target=tab.url;
  showWorkspaceView('collector');
  $('url').value=target;
  status('รับ URL จาก HarvestTS แล้ว • กำลังเปิดใน ImageHarvest…');
  const opened=await call('open',{
    url:target,
    show:true,
    backend:$('browserMode').value,
    chromeControl:$('chromeControl').value,
    protectionCompatibility:$('protectionCompatibility').checked
  });
  currentURL=opened.url;
  $('url').value=opened.url;
  touchActiveTab(opened.title,opened.url);
  status('ส่งจาก HarvestTS มา ImageHarvest แล้ว • พร้อมสแกนหรือ Block element');
}));
$('harvestBookmarkQuick').addEventListener('click', () => action(openHarvestBookmarks));
$('harvestPasswordQuick').addEventListener('click', () => action(async () => {
  const tab=activeHarvestTab(); if(!tab || tab.kind!=='web') return;
  const rect=$('harvestPasswordQuick').getBoundingClientRect();
  const state=await call('harvestTsPasswordPopupMenu',{id:tab.id,x:Math.round(rect.left),y:Math.round(rect.bottom)});
  harvestPasswordHints.set(tab.id,state);
  await updateHarvestPasswordButton();
}));
$('harvestZoomOut').addEventListener('click', () => action(() => harvestAction('zoom-out')));
$('harvestZoomValue').addEventListener('click', () => action(() => harvestAction('zoom-reset')));
$('harvestZoomIn').addEventListener('click', () => action(() => harvestAction('zoom-in')));
$('harvestBookmarkMenu').addEventListener('click', () => action(openHarvestBookmarks));
$('harvestPasswordMenu').addEventListener('click', () => action(openHarvestPasswords));
$('harvestBlockElementMenu').addEventListener('click', () => action(startHarvestBlockElement));
$('closeHarvestHistory').addEventListener('click', () => action(() => closeHarvestManager($('harvestHistoryDialog'))));
$('harvestHistoryDialog').addEventListener('close', () => {
  if (!$('harvestTsView').hidden) syncHarvestLayout(true).catch(() => {});
});
$('harvestClearHistory').addEventListener('click', () => action(async () => {
  await call('harvestTsHistoryClear');
  await refreshHarvestHistory();
}));
$('closeHarvestBookmarks').addEventListener('click', () => action(() => closeHarvestManager($('harvestBookmarkDialog'))));
$('closeHarvestPasswords').addEventListener('click', () => action(() => closeHarvestManager($('harvestPasswordDialog'))));
$('harvestBookmarkDialog').addEventListener('close', () => {
  if (!$('harvestTsView').hidden) syncHarvestLayout(true).catch(() => {});
});
$('harvestPasswordDialog').addEventListener('close', () => {
  if (!$('harvestTsView').hidden) syncHarvestLayout(true).catch(() => {});
});
$('harvestBookmarkCreateFolder').addEventListener('click', () => action(async () => {
  const name=$('harvestBookmarkNewFolder').value.trim();
  const result=await call('harvestTsBookmarkFolderCreate',{name});
  $('harvestBookmarkNewFolder').value='';
  await refreshHarvestBookmarks(result.folder.id);
}));
$('harvestBookmarkNewFolder').addEventListener('keydown', event => {
  if(event.key==='Enter'){event.preventDefault();$('harvestBookmarkCreateFolder').click();}
});
$('harvestAddBookmark').addEventListener('click', () => action(async () => {
  const tab = activeHarvestTab(); if (!tab || tab.kind!=='web') return;
  await call('harvestTsBookmarkAdd',{id:tab.id,folderId:$('harvestBookmarkFolderSelect').value || null});
  await refreshHarvestBookmarks($('harvestBookmarkFolderSelect').value || '');
  await updateHarvestBookmarkButton();
}));
$('harvestSavePassword').addEventListener('click', () => action(async () => {
  const tab = activeHarvestTab(); if (!tab) return;
  const result = await call('harvestTsPasswordSaveCurrent',{id:tab.id});
  $('harvestPasswordNote').textContent = result.item.username
    ? `บันทึกแล้ว • ${result.item.origin} • บัญชี ${result.item.username}`
    : `บันทึกรหัสผ่านของ ${result.item.origin} แล้ว`;
  await refreshHarvestPasswords();
}));
$('harvestFillPassword').addEventListener('click', () => action(async () => {
  const tab = activeHarvestTab(); if (!tab) return;
  await call('harvestTsPasswordFillCurrent',{id:tab.id});
  $('harvestPasswordNote').textContent = 'Autofill ข้อมูลล็อกอินให้หน้านี้แล้วค่ะ';
}));

$('closeHarvestExtensions').addEventListener('click', () => action(() => closeHarvestManager($('harvestExtensionDialog'))));
$('closeHarvestDns').addEventListener('click', () => action(() => closeHarvestManager($('harvestDnsDialog'))));
$('harvestExtensionDialog').addEventListener('close', () => {
  if (!$('harvestTsView').hidden) syncHarvestLayout(true).catch(() => {});
});
$('harvestDnsDialog').addEventListener('close', () => {
  if (!$('harvestTsView').hidden) syncHarvestLayout(true).catch(() => {});
});
$('harvestInstallExtension').addEventListener('click', () => action(async () => {
  const result = await call('harvestTsExtensionInstall',{});
  if (!result.cancelled) await refreshHarvestExtensions();
}));
$('harvestDnsMode').addEventListener('change', () => {
  $('harvestCustomDohRow').hidden = $('harvestDnsMode').value !== 'custom';
});
$('harvestApplyDns').addEventListener('click', () => action(async () => {
  const mode=$('harvestDnsMode').value, customDoh=$('harvestCustomDoh').value.trim();
  const settings=await call('harvestTsDnsSet',{mode,customDoh});
  $('harvestDnsStatus').textContent = settings.dnsMode === 'inherit' ? 'กลับไปใช้ DNS ตาม ImageHarvest แล้ว' : 'เปลี่ยน Secure DNS แล้ว';
}));
$('harvestBlockClose').addEventListener('click', () => action(() => cancelHarvestBlockMode(false)));
$('harvestBlockCancel').addEventListener('click', () => action(() => cancelHarvestBlockMode(true)));
$('harvestBlockClearDraft').addEventListener('click', () => action(async () => {
  if (!harvestBlockTabId) return;
  await call('harvestTsBlockDraftClear',{id:harvestBlockTabId});
  renderHarvestBlockState(await call('harvestTsBlockDraftState',{id:harvestBlockTabId}));
}));
$('harvestBlockCommit').addEventListener('click', () => action(async () => {
  if (!harvestBlockTabId) return;
  const result=await call('harvestTsBlockDraftCommit',{id:harvestBlockTabId});
  await closeHarvestBlockPanel();
  $('harvestStatus').textContent = result.saved
    ? `บันทึก Block element แล้ว • เพิ่ม ${result.added} กฎ • รวม ${result.count} กฎ`
    : 'ยังไม่ได้เลือก Element สำหรับบล็อก';
}));
$('harvestBlockClearSaved').addEventListener('click', () => action(async () => {
  if (!harvestBlockTabId) return;
  await call('harvestTsBlockClear',{id:harvestBlockTabId});
  renderHarvestBlockState(await call('harvestTsBlockDraftState',{id:harvestBlockTabId}));
  $('harvestStatus').textContent='ล้าง Filter ของเว็บนี้ทั้งหมดแล้ว';
}));

document.addEventListener('click', event => {
  if ($('harvestMenuPopup').hidden) return;
  if ($('harvestMenuPopup').contains(event.target) || $('harvestMenu').contains(event.target)) return;
  action(() => setHarvestMenuOpen(false));
});
document.addEventListener('keydown', event => {
  if ($('harvestTsView').hidden) return;
  if (event.ctrlKey && event.key.toLowerCase() === 'l') { event.preventDefault(); $('harvestAddress').focus(); $('harvestAddress').select(); return; }
  if (event.ctrlKey && event.key.toLowerCase() === 't') { event.preventDefault(); createHarvestTab(); return; }
  if (event.ctrlKey && event.key.toLowerCase() === 'w') { event.preventDefault(); if (activeHarvestTabId) closeHarvestTab(activeHarvestTabId); return; }
  if (event.ctrlKey && event.key.toLowerCase() === 'r') { event.preventDefault(); reloadHarvest(); return; }
  if (event.ctrlKey && (event.key==='+' || event.key==='=')) { event.preventDefault(); action(() => harvestAction('zoom-in')); return; }
  if (event.ctrlKey && event.key==='-') { event.preventDefault(); action(() => harvestAction('zoom-out')); return; }
  if (event.ctrlKey && event.key==='0') { event.preventDefault(); action(() => harvestAction('zoom-reset')); return; }
  if (event.key === 'F5') { event.preventDefault(); reloadHarvest(); return; }
  if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); action(() => harvestAction('back')); return; }
  if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); action(() => harvestAction('forward')); }
});
$('openBrowserLogin').addEventListener('click', () => profileAction(async () => {
  $('openBrowserLogin').disabled = true; $('useBrowserProfile').disabled = true;
  $('profileActionNote').textContent = 'กำลังเปิด Chrome…';
  try {
    const info = await call('openBrowserLogin'); renderBrowserProfile(info);
    $('profileActionNote').className = 'account-note success';
    $('profileActionNote').textContent = 'Chrome ปกติเปิดแล้ว — ล็อกอินหรือเปลี่ยนบัญชีได้ตามปกติ แล้วกลับมากด “ใช้บัญชีนี้เลย”';
  } finally { $('openBrowserLogin').disabled = false; refreshBrowserProfile().catch(() => {}); }
}));
$('useBrowserProfile').addEventListener('click', () => profileAction(async () => {
  $('useBrowserProfile').disabled = true;
  $('profileActionNote').textContent = 'กำลังบันทึกโปรไฟล์ Chrome…';
  const info = await call('useBrowserProfile'); renderBrowserProfile(info);
  $('browserMode').value = 'chrome'; $('browserMode').dispatchEvent(new Event('change'));
  showWorkspaceView('collector');
  status(info.email ? `ใช้บัญชี Chrome ${info.email} แล้ว — วางลิงก์แล้วเปิดเว็บได้เลย` : 'ใช้โปรไฟล์ Chrome นี้แล้ว — วางลิงก์แล้วเปิดเว็บได้เลย');
}));
$('addTab').addEventListener('click', () => action(addWorkspaceTab));
$('collectorAdblock').addEventListener('change', () => action(async () => {
  const state=await call('harvestTsAdblockSet',{enabled:$('collectorAdblock').checked});
  $('collectorAdblock').checked=Boolean(state.enabled);
  status(state.enabled?'Harvest Adblock เปิดอยู่ • ใช้ร่วมกับ HarvestTS':'ปิด Harvest Adblock แล้ว');
}));
$('collectorBlockElement').addEventListener('click', () => action(async () => {
  const input=$('url').value.trim();
  if(!input) throw new Error('กรุณาเปิดเว็บไซต์ก่อนใช้ Block element');
  if(!currentURL || (input!==currentURL && `https://${input}`!==currentURL)){
    const opened=await call('open',{url:input,show:true,backend:$('browserMode').value,chromeControl:$('chromeControl').value,protectionCompatibility:$('protectionCompatibility').checked});
    currentURL=opened.url;$('url').value=opened.url;touchActiveTab(opened.title,opened.url);
  } else await call('showBrowser');
  await call('collectorBlockElement',{});
  status('Block element • ใช้กฎร่วมกับ HarvestTS • หน้าต่างลอยเปิดแล้ว');
}));
$('showBrowser').addEventListener('click', () => action(async () => {
  const input = $('url').value.trim();
  if (!input) throw new Error('กรุณาใส่ลิงก์เว็บไซต์ก่อนค่ะ');
  if (!currentURL || (input !== currentURL && `https://${input}` !== currentURL)) {
    const opened = await call('open', { url: input, show: true, backend: $('browserMode').value, chromeControl: $('chromeControl').value, protectionCompatibility: $('protectionCompatibility').checked });
    currentURL = opened.url; $('url').value = opened.url; touchActiveTab(opened.title, opened.url);
  } else await call('showBrowser');
}));
$('cancel').addEventListener('click', () => action(async () => {
  if (continuousActive) continuousCancelled = true;
  await call('cancel');
  status(continuousActive ? 'กำลังหยุดโหมดต่อเนื่อง — เก็บตอนที่บันทึกเสร็จแล้วไว้…' : 'กำลังหยุดงาน เก็บไฟล์ที่บันทึกแล้วไว้…');
}));
$('advancedToggle').addEventListener('click', () => { $('advanced').hidden = !$('advanced').hidden; });
$('sort').addEventListener('change', () => { applySort(); render(); });
$('reverseOrder').addEventListener('click', () => { if (busy || captureActive || sequence.length < 2) return; sequence.reverse(); $('sort').value='manual'; render(); status('กลับลำดับภาพแล้ว — ภาพท้ายสุดถูกย้ายมาเป็นหน้าแรก'); });
for (const id of ['minWidth', 'minHeight', 'search']) $(id).addEventListener('input', () => { clearTimeout(renderTimer); renderTimer = setTimeout(render, 180); });
$('dedupe').addEventListener('change', render);
for (const id of ['hideChrome', 'mainOnly', 'hideBlank', 'sourceFilter']) $(id).addEventListener('change', render);
$('resetFilters').addEventListener('click', () => {
  if (busy) return;
  $('hideChrome').checked = false; $('mainOnly').checked = false; $('hideBlank').checked = false; $('sourceFilter').value = 'all';
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
    await call('clearResults'); resetLiveWork();
    all = []; sequence = []; selected.clear(); states.clear(); removedSnapshot = null; mainScope = 'unknown'; scannedURL = '';
    $('pageTitle').textContent = 'ล้างผลสแกนแล้ว — กดสแกนภาพเพื่อเริ่มใหม่';
    $('notice').textContent = ''; $('notice').hidden = true;
    if ($('preview').open) $('preview').close();
    status('ล้างทั้งหมดแล้ว — ไฟล์ที่บันทึกไว้ยังอยู่ครบ');
  } finally { setBusy(false); render(); }
}));
$('contentPreset').addEventListener('click', () => { $('minWidth').value = '300'; $('minHeight').value = '300'; render(); });
$('selectAll').addEventListener('click', () => { visibleItems().forEach(item => selected.add(item.id)); render(); });
$('deselectAll').addEventListener('click', () => { selected.clear(); render(); });
function visitKey(value) {
  try { const url = new URL(value); url.hash = ''; return url.href.replace(/\/$/, ''); }
  catch { return String(value || ''); }
}
const continuousDelay = ms => new Promise(resolve => setTimeout(resolve, ms));
let continuousSessionId = '';
function traceContinuous(message, extra = {}) {
  if (!continuousSessionId) return;
  window.eiw.continuousLog({ sessionId:continuousSessionId, message, ...extra }).catch(() => {});
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
      traceContinuous(label + ' failed', { attempt, error:error.message || String(error) });
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
    if (continuousCancelled) return { url:'', reason:'ยกเลิกแล้ว' };
    try { last = await call('nextChapter'); }
    catch (error) {
      traceContinuous('next detection failed', { attempt, error:error.message || String(error) });
      if (attempt === 3) throw error;
    }
    if (last?.url || last?.action === 'click') return last;
    traceContinuous('next not found yet', { attempt, reason:last?.reason || '' });
    if (attempt < 3) {
      status(`ยังไม่พบตอนถัดไป • รอหน้าเว็บนิ่งแล้วตรวจใหม่ ${attempt + 1}/3…`);
      await continuousDelay(900 * attempt);
    }
  }
  return last || { url:'', reason:'ไม่พบตอนถัดไป' };
}
async function scanContinuous(label) {
  return retryContinuous(label, async attempt => {
    const result = await call('scan', scanRequest());
    if (!result.cancelled && !(result.items || []).length && attempt < 3) throw new Error('ยังไม่พบภาพหลังสแกน');
    return result;
  });
}
async function waitForContinuousFilters() {
  if (!$('hideBlank').checked) return { timedOut:false, pending:0 };
  const deadline = Date.now() + 30000;
  queueBlankChecks();
  while (!continuousCancelled && blankCandidates().length && Date.now() < deadline) {
    await continuousDelay(150);
    queueBlankChecks();
  }
  const pending = blankCandidates().length;
  if (!continuousCancelled && pending) {
    traceContinuous('blank analysis timeout; keeping uncertain images', { pending });
    status(`ตรวจหน้าว่างไม่ทัน ${pending} ภาพ • เก็บภาพที่ยังไม่แน่ใจไว้เพื่อไม่ให้หน้าจริงหาย`);
    return { timedOut:true, pending };
  }
  return { timedOut:false, pending:0 };
}
async function runContinuousHarvest() {
  if (contentMode() !== 'manga') throw new Error('โหมดไล่ตอนใช้ได้เฉพาะ “มังงะ / มังฮวา”');
  const start = Number($('continuousStart').value);
  if (!Number.isInteger(start) || start < 0 || start > 99999999) throw new Error('เลขโฟลเดอร์เริ่มต้นไม่ถูกต้อง');
  if (continuousActive) return;
  continuousActive = true; continuousCancelled = false; continuousSessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`; syncContinuousUI(); setBusy(true); $('notice').hidden = true;
  let folderNumber = start, chapters = 0, totalSaved = 0, totalFailed = 0;
  const visited = new Set();
  traceContinuous('session start', { url:$('url').value.trim(), folderNumber:start });
  try {
    await ensurePageOpen(false);
    if (!all.length || visitKey(scannedURL) !== visitKey(currentURL)) {
      status('โหมดต่อเนื่อง • กำลังสแกนตอนเริ่มต้น…');
      const first = await scanContinuous('สแกนตอนเริ่มต้น'); applyScanResult(first);
      if (first.cancelled) continuousCancelled = true;
    }
    visited.add(visitKey(currentURL));
    while (!continuousCancelled && chapters < 500) {
      await waitForContinuousFilters();
      const items = exportItems();
      if (!items.length) throw new Error('ตอนนี้ไม่มีภาพที่ผ่านตัวกรองและถูกเลือก จึงยังไม่สร้างโฟลเดอร์');
      downloadPending = true;
      status(`โหมดต่อเนื่อง • กำลังบันทึกโฟลเดอร์ ${folderNumber} • ${items.length} ภาพ`);
      const saved = await call('download', { ids:items.map(item => item.id), numbered:true, folderNumber });
      downloadPending = false;
      if (!saved.folder) throw new Error('ยังไม่ได้เลือกโฟลเดอร์ปลายทาง');
      if (!saved.saved) throw new Error(`โฟลเดอร์ ${folderNumber} บันทึกภาพไม่สำเร็จเลย จึงหยุดก่อนข้ามไปตอนถัดไป`);
      chapters++; totalSaved += saved.saved || 0; totalFailed += saved.failed || 0;
      $('continuousStart').value = String(folderNumber + 1);
      if (saved.cancelled || continuousCancelled) { continuousCancelled = true; break; }
      traceContinuous('chapter saved', { folderNumber, url:currentURL, saved:saved.saved || 0, failed:saved.failed || 0 });
      const next = await nextChapterWithRetry();
      if (!next.url && next.action !== 'click') {
        status(`เก็บต่อเนื่องเสร็จ — ${chapters} ตอน • สำเร็จ ${totalSaved} ภาพ • ไม่สำเร็จ ${totalFailed} ภาพ • ${next.reason || 'ไม่พบตอนถัดไป'}`);
        return;
      }
      status(`โฟลเดอร์ ${folderNumber} เสร็จ • พบตอนถัดไป ${next.text ? '“' + next.text + '”' : ''} • กำลังเปิด…`);
      let opened, actualKey;
      if (next.action === 'click') {
        opened = await call('advanceNextChapter');
        currentURL = opened.url || $('url').value;
        actualKey = visitKey(currentURL) + '|' + (opened.title || opened.heading || '');
      } else {
        const targetKey = visitKey(next.url);
        if (visited.has(targetKey)) throw new Error('ตรวจพบว่าตอนถัดไปวนกลับ URL ที่เคยเก็บแล้ว จึงหยุดเพื่อกันลูป');
        opened = await retryContinuous('เปิดตอนถัดไป', () => call('open', { url:next.url, show:false, backend:$('browserMode').value, chromeControl:$('chromeControl').value, protectionCompatibility:$('protectionCompatibility').checked }));
        if (opened.gated) throw new Error('ตอนถัดไปเปิดได้แต่ติดหน้าแจ้ง/ตรวจสอบการเข้าถึง กรุณาตรวจหน้าต่างเว็บ');
        currentURL = opened.url; actualKey = visitKey(currentURL);
      }
      if (visited.has(actualKey)) throw new Error('เว็บพากลับไปตอนที่เก็บแล้ว จึงหยุดเพื่อกันลูป');
      visited.add(actualKey); $('url').value = currentURL; touchActiveTab(opened.title, currentURL);
      folderNumber++;
      await continuousDelay(700);
      status(`โหมดต่อเนื่อง • กำลังสแกนตอนสำหรับโฟลเดอร์ ${folderNumber}…`);
      const scanResult = await scanContinuous(`สแกนโฟลเดอร์ ${folderNumber}`); applyScanResult(scanResult);
      if (scanResult.cancelled) continuousCancelled = true;
    }
    if (chapters >= 500) status(`หยุดที่เพดานความปลอดภัย 500 ตอน • บันทึกแล้ว ${totalSaved} ภาพ`, true);
    else if (continuousCancelled) status(`หยุดโหมดต่อเนื่องแล้ว — เก็บเสร็จ ${chapters} ตอน • สำเร็จ ${totalSaved} ภาพ • ไม่สำเร็จ ${totalFailed} ภาพ`);
  } catch (error) {
    traceContinuous('session error', { folderNumber, chapters, totalSaved, totalFailed, error:error.message || String(error) });
    if (continuousCancelled || error.message === 'ยกเลิกโหมดต่อเนื่อง') {
      status(`หยุดโหมดต่อเนื่องแล้ว — เก็บเสร็จ ${chapters} ตอน • สำเร็จ ${totalSaved} ภาพ • ไม่สำเร็จ ${totalFailed} ภาพ`);
    } else throw error;
  } finally {
    traceContinuous('session end', { folderNumber, chapters, totalSaved, totalFailed, cancelled:continuousCancelled });
    downloadPending = false; activeScanId = null; clearTimeout(liveRenderTimer); liveRenderTimer = null;
    continuousActive = false; continuousSessionId = ''; syncContinuousUI(); setBusy(false); render();
  }
}
$('chooseFolder').addEventListener('click', () => action(async () => { const folder = await call('chooseFolder'); if (folder) { $('folderLabel').textContent = folder; $('chooseFolder').title = folder; } }));
$('openFolder').addEventListener('click', () => action(() => call('openFolder')));
$('download').addEventListener('click', () => action(async () => {
  if (contentMode() === 'manga' && $('continuousMode').checked) { await runContinuousHarvest(); return; }
  const items = exportItems(); if (!items.length) return;
  downloadPending = true; setBusy(true); render();
  try {
    const result = await call('download', { ids: items.map(item => item.id), name: $('setName').value });
    downloadPending = false; // Ignore progress queued before the completed IPC result.
    if (!result.folder) { status('ยังไม่ได้เลือกโฟลเดอร์'); return; }
    status(`${result.cancelled ? 'หยุดแล้ว' : 'บันทึกเสร็จ'} — สำเร็จ ${result.saved} ภาพ / ไม่สำเร็จ ${result.failed} ภาพ${result.notAttempted ? ` / ยังไม่บันทึก ${result.notAttempted} ภาพ` : ''} — ${result.folder}`, result.failed > 0);
    const settings = await call('settings'); $('folderLabel').textContent = settings.outputRoot;
  } finally { downloadPending = false; setBusy(false); render(); }
}));
$('exportLinks').addEventListener('click', () => action(async () => { if (await call('exportLinks', { ids: exportItems().map(item => item.id) })) status('บันทึกลิงก์ตามลำดับแล้ว'); }));
$('renameTool').addEventListener('click', () => { if (!busy && !captureActive) $('renameDialog').showModal(); });
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

$('preRead').addEventListener('click', openPreReader);
$('readerMode').addEventListener('change', applyReaderLayout);
$('readerWidth').addEventListener('change', applyReaderLayout);
$('closeReader').addEventListener('click', () => $('readerDialog').close());
$('readerDialog').addEventListener('close', () => $('readerStrip').replaceChildren());
$('closePreview').addEventListener('click', () => $('preview').close());
$('preview').addEventListener('close', () => $('previewImage').removeAttribute('src'));
window.eiw.on(event => {
  if (event.type === 'harvestts-state') {
    applyHarvestSnapshot(event);
    return;
  }
  if (event.type === 'harvestts-menu-action') {
    if (event.action === 'history') action(openHarvestHistory);
    else if (event.action === 'bookmark') action(openHarvestBookmarks);
    else if (event.action === 'password') action(openHarvestPasswords);
    else if (event.action === 'block-element') action(startHarvestBlockElement);
    else if (event.action === 'extensions') action(openHarvestExtensions);
    else if (event.action === 'dns') action(openHarvestDns);
    return;
  }
  if (event.type === 'harvestts-offline-saved') {
    if(!event.tabId || event.tabId===activeHarvestTabId) $('harvestStatus').textContent=`บันทึก Offline แล้ว • ${event.pages||0} หน้า • ยังอยู่หน้าเว็บเดิม`;
    return;
  }
  if (event.type === 'harvestts-browser-settings') {
    if ($('harvestHistoryDialog').open) refreshHarvestHistory().catch(() => {});
    return;
  }
  if (event.type === 'harvestts-adblock-status') {
    $('collectorAdblock').checked = event.enabled !== false;
    if ($('harvestExtensionDialog').open) refreshHarvestExtensions().catch(() => {});
    return;
  }
  if (event.type === 'harvestts-password-hint') {
    harvestPasswordHints.set(event.tabId,event);
    if(event.tabId===activeHarvestTabId) {
      updateHarvestPasswordButton().catch(()=>{});
      if(event.canSave) {
        $('harvestStatus').textContent=event.candidateUsername
          ? ('มีรหัสของ '+event.candidateUsername+' รอให้บันทึก')
          : 'มีรหัสผ่านรอให้บันทึก';
        const token=String(event.candidateToken||'');
        if(token && token!==lastPasswordPromptToken) {
          lastPasswordPromptToken=token;
          setTimeout(()=>{
            const tab=activeHarvestTab();
            if(!tab || tab.id!==event.tabId) return;
            const rect=$('harvestPasswordQuick').getBoundingClientRect();
            call('harvestTsPasswordSavePrompt',{
              id:event.tabId,
              x:Math.round(rect.left),
              y:Math.round(rect.bottom)
            }).catch(()=>{});
          },80);
        }
      }
    }
    return;
  }
  if (event.type === 'harvestts-password-message') {
    if(event.tabId===activeHarvestTabId) $('harvestStatus').textContent=event.error||event.message||'จัดการรหัสผ่านแล้ว';
    harvestPasswordHints.delete(event.tabId);
    updateHarvestPasswordButton().catch(()=>{});
    return;
  }
  if (event.type === 'harvestts-block-finished') {
    if (event.cancelled) $('harvestStatus').textContent = event.message || 'ยกเลิก Block element แล้ว';
    else $('harvestStatus').textContent = event.saved
      ? `บันทึก Block element แล้ว • เพิ่ม ${event.added || 0} กฎ • รวม ${event.count || 0} กฎ`
      : 'ยังไม่ได้เลือก Element สำหรับบล็อก';
    return;
  }
  if (event.type === 'collector-block-finished') {
    if (event.cancelled) status(event.message || 'ยกเลิก Block element แล้ว');
    else status(event.saved
      ? `บันทึก Block element แล้ว • ใช้ร่วมกับ HarvestTS • เพิ่ม ${event.added || 0} กฎ • รวม ${event.count || 0} กฎ`
      : 'ยังไม่ได้เลือก Element สำหรับบล็อก');
    return;
  }
  if (event.type === 'harvestts-error') {
    if (!$('harvestTsView').hidden && (!event.id || event.id === activeHarvestTabId)) {
      $('harvestStatus').textContent = `เปิดหน้าไม่สำเร็จ • ${event.message || 'เกิดข้อผิดพลาด'}`;
    }
    return;
  }
  if (event.type === 'harvestts-shortcut') {
    if ($('harvestTsView').hidden) return;
    if (event.key === 'l') { $('harvestAddress').focus(); $('harvestAddress').select(); }
    else if (event.key === 't') action(() => createHarvestTab());
    else if (event.key === 'w' && activeHarvestTabId) action(() => closeHarvestTab(activeHarvestTabId));
    return;
  }
  if (event.type === 'scan-items') {
    if (!activeScanId || event.scanId !== activeScanId || event.workspaceId !== activeTabId) return;
    mergeScanItems(event.items); queueLiveRender();
    if (event.title) $('pageTitle').textContent = event.title;
    return;
  }
  if (event.type === 'scan-progress' && event.scanId && event.scanId !== activeScanId) return;
  if (event.type === 'protection-compatibility' && event.controlMode === 'minimal') {
    $('chromeControl').value = 'minimal';
    $('protectionCompatibilityNote').textContent = 'Minimal • ไม่แก้สคริปต์เว็บ • ไม่เปิด Runtime/Console/Debugger events';
    $('compatibilityLog').textContent = 'Chrome Minimal (ยังใช้ CDP)\nแก้สคริปต์: 0\nไม่สลับไปใช้กฎ Standard อัตโนมัติ';
  }
  if (event.type === 'protection-compatibility' && event.controlMode !== 'minimal') {
    $('protectionCompatibilityNote').textContent = event.error || `อัตโนมัติ: ใช้กฎ ${event.applied || 0} • ไม่รู้จัก ${event.unknown || 0} • ข้ามการตรวจ ${event.skipped || 0}`;
    $('compatibilityLog').textContent = (event.events || []).map(x => `${x.kind} • ${x.family || ''} • ${x.rule || ''}\n${x.url || ''}`).join('\n\n') || 'ยังไม่พบสคริปต์ตรงกับกฎ';
    if (event.error) status(event.error, true);
  }
  if (event.type === 'status' || event.type === 'rate-limit' || event.type === 'error') status(event.message, event.type !== 'status');
  if (event.type === 'navigation') { currentURL = event.url; if (/^https?:\/\//i.test(event.url)) { $('url').value = event.url; touchActiveTab('', event.url); } else status('หน้าเว็บนำทางออกไป ' + event.url + ' — กรุณาตรวจหน้าต่างเว็บ', true); }
  if (event.type === 'scan-start') { if (event.workspaceId && event.workspaceId !== activeTabId) return; resetLiveWork(); activeScanId = event.scanId; scannedURL = ''; all = []; sequence = []; selected.clear(); states.clear(); removedSnapshot = null; mainScope = 'unknown'; render(); status('กำลังรวบรวมภาพและเลื่อนหน้า…'); }
  if (event.type === 'capture-start') {
    resetLiveWork(); captureActive = true; all = []; sequence = []; selected.clear(); states.clear(); removedSnapshot = null; mainScope = 'unknown';
    $('pageTitle').textContent = event.title || event.url || 'กำลังจับทีละหน้า';
    syncCaptureControls(); render(); status('กำลังจับทีละหน้า — เปลี่ยนหน้าในหน้าต่างเว็บได้เลย');
  }
  if (event.type === 'capture-progress') {
    appendCaptured(event.items);
    if (event.title || event.url) { $('pageTitle').textContent = event.title || event.url; touchActiveTab(event.title, event.url); }
    const extra = event.lastError ? ` • ล่าสุดลองไม่สำเร็จ: ${event.lastError}` : '';
    status(`จับทีละหน้า • เก็บแล้ว ${event.count} ภาพ • รอบล่าสุดเพิ่ม ${event.items?.length || 0} • ซ้ำ ${event.duplicates || 0}${extra}`);
  }
  if (event.type === 'capture-stop') {
    captureActive = false; syncCaptureControls(); counts();
    status(`${event.reason ? event.reason + ' • ' : ''}${event.cancelled ? 'หยุดจับทีละหน้าแล้ว' : 'จบการจับทีละหน้า'} — เก็บ ${event.count} ภาพ`);
  }
  if (event.type === 'scan-progress') { status(`กำลังสแกน • พบ ${event.count} ภาพ • รอบ ${event.step}/${event.maxSteps}`); $('progress').value = Math.round(event.progress * 100); }
  if (event.type === 'download-progress' && downloadPending) { status(`กำลังบันทึกภาพ ${event.index}/${event.total} • สำเร็จ ${event.saved} • ไม่สำเร็จ ${event.failed}`); $('progress').value = ((event.index - 1) / event.total) * 100; }
  if (event.type === 'image-saved') updateState(event.id, `✓ ${event.filename}`, false, 'download');
  if (event.type === 'image-failed') updateState(event.id, event.message, true, event.scope || 'download');
});
renderTabs();
call('settings').then(settings => {
  $('appVersion').textContent = settings.version || '—';
  if (settings.outputRoot) $('folderLabel').textContent = settings.outputRoot;
  $('protectionCompatibility').checked = settings.protectionCompatibility === true;
  $('chromeControl').value = settings.chromeControl || 'standard';
  $('browserMode').value = settings.browserMode || 'chrome';
  $('browserMode').dispatchEvent(new Event('change'));
  $('protectionCompatibilityNote').textContent = settings.protectionCompatibility ? 'เปิดอัตโนมัติ — ตรวจจากลายเซ็น ไม่จำกัดชื่อเว็บ' : 'ปิด — ไม่แก้สคริปต์ของเว็บ';
  $('networkMode').value = settings.networkMode || 'auto';
  $('networkModeNote').textContent = networkDescription(settings.networkMode || 'auto') + (settings.compatibilityActive ? ' • Compatibility ทำงานอยู่' : '');
  $('restartNetwork').hidden = true;
  syncCaptureControls(); counts();
  refreshBrowserProfile().catch(() => {});
  call('harvestTsAdblockStatus').then(state => { $('collectorAdblock').checked = state.enabled !== false; }).catch(() => {});
}).catch(error => status(error.message, true));
