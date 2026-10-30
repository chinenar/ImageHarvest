'use strict';
function createHarvestUI({ $, el, call, action, status, showWorkspaceView, sendToCollector }) {
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

  function activeHarvestTab() {
    return harvestTabs.get(activeHarvestTabId) || null;
  }

  function harvestHost(url) {
    try {
      return new URL(url).hostname || url;
    } catch {
      return url || 'แท็บใหม่';
    }
  }

  function harvestBounds() {
    const rect = $('harvestWebviews').getBoundingClientRect();
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    };
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
    const internal = tab.kind !== 'web';
    const internalLabel =
      tab.kind === 'downloads'
        ? 'Downloads'
        : tab.kind === 'offline'
          ? 'Offline Library'
          : tab.kind === 'offline-reader'
            ? 'Offline Reader'
            : 'History';
    if (document.activeElement !== $('harvestAddress'))
      $('harvestAddress').value = internal ? internalLabel : tab.url || '';
    updateHarvestSecurity(internal ? '' : tab.url);
    const zoom = Math.round((Number(tab.zoomFactor) || 1) * 100),
      zoomEnabled = !internal;
    $('harvestZoomValue').textContent = zoom + '%';
    $('harvestZoomValue').disabled = !zoomEnabled || zoom === 100;
    $('harvestZoomOut').disabled = !zoomEnabled || zoom <= 50;
    $('harvestZoomIn').disabled = !zoomEnabled || zoom >= 300;
    $('harvestReload').textContent = tab.loading ? '✕' : '↻';
    $('harvestReload').title = tab.loading ? 'หยุดโหลด' : 'โหลดใหม่ (Ctrl+R)';
    $('harvestStatus').textContent = tab.loading
      ? 'กำลังโหลด…'
      : tab.kind === 'downloads'
        ? 'Downloads • รายการดาวน์โหลดของ HarvestTS'
        : tab.kind === 'history'
          ? 'History • ค้นหาประวัติการเข้าเว็บ'
          : tab.title || harvestHost(tab.url);
  }

  function applyHarvestSnapshot(snapshot = {}) {
    harvestTabs.clear();
    for (const tab of snapshot.tabs || []) harvestTabs.set(tab.id, tab);
    activeHarvestTabId = snapshot.activeId || null;
    renderHarvestTabs();
    updateHarvestControls();
    updateHarvestSendButton();
    updateHarvestBookmarkButton().catch(() => {});
    updateHarvestPasswordButton().catch(() => {});
  }

  function updateHarvestSendButton() {
    const tab = activeHarvestTab(),
      button = $('harvestSendToCollector');
    const enabled = Boolean(tab && tab.kind === 'web' && /^https?:\/\//i.test(tab.url || ''));
    button.disabled = !enabled;
    button.title = enabled ? 'ส่งหน้านี้ไป ImageHarvest' : 'หน้านี้ส่งไป ImageHarvest ไม่ได้';
  }

  function renderHarvestTabs() {
    const host = $('harvestTabs'),
      fragment = document.createDocumentFragment();
    for (const tab of harvestTabs.values()) {
      const item = el(
        'div',
        'harvest-browser-tab' + (tab.id === activeHarvestTabId ? ' active' : ''),
      );
      item.setAttribute('role', 'tab');
      item.setAttribute('aria-selected', String(tab.id === activeHarvestTabId));
      item.dataset.tabId = tab.id;
      const open = el('button', 'harvest-tab-main');
      const icon = el('span', 'harvest-tab-icon' + (tab.loading ? ' loading' : ''));
      icon.setAttribute('aria-hidden', 'true');
      const fallback = el(
        'span',
        'harvest-tab-fallback',
        tab.kind === 'web'
          ? '◎'
          : tab.kind === 'downloads'
            ? '↓'
            : tab.kind === 'history'
              ? '◷'
              : '▤',
      );
      icon.append(fallback);
      if (tab.favicon) {
        const image = el('img', 'harvest-tab-favicon');
        image.alt = '';
        image.addEventListener('load', () => {
          fallback.hidden = true;
        });
        image.addEventListener('error', () => {
          image.remove();
          fallback.hidden = false;
        });
        image.src = tab.favicon;
        icon.append(image);
      }
      const label = el('span', 'harvest-tab-label', tab.title || harvestHost(tab.url));
      const close = el('button', 'harvest-tab-close', '×');
      open.type = close.type = 'button';
      open.title = [tab.title || harvestHost(tab.url), tab.url].filter(Boolean).join('\n');
      open.setAttribute('aria-label', tab.title || harvestHost(tab.url));
      close.title = 'ปิดแท็บ';
      open.addEventListener('click', () => switchHarvestTab(tab.id));
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        closeHarvestTab(tab.id);
      });
      item.addEventListener('auxclick', (event) => {
        if (event.button === 1) {
          event.preventDefault();
          closeHarvestTab(tab.id);
        }
      });
      open.append(icon, label);
      item.append(open, close);
      fragment.append(item);
    }
    host.replaceChildren(fragment);
  }

  async function syncHarvestLayout(visible = !$('harvestTsView').hidden) {
    const result = await call('harvestTsLayout', {
      visible,
      bounds: harvestBounds(),
    });
    applyHarvestSnapshot(result);
    return result;
  }

  async function ensureHarvestBrowser() {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const result = await syncHarvestLayout(true);
    if (!(result.tabs || []).length)
      applyHarvestSnapshot(await call('harvestTsCreate', { url: HARVEST_HOME }));
  }

  async function createHarvestTab(url = HARVEST_HOME) {
    applyHarvestSnapshot(
      await call('harvestTsCreate', {
        url: harvestTarget(url),
        activate: true,
      }),
    );
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
    const tab = activeHarvestTab();
    if (!tab) return;
    const target = harvestTarget(value);
    $('harvestStatus').textContent = 'กำลังเปิด ' + harvestHost(target) + '…';
    if (tab.kind !== 'web') await createHarvestTab(target);
    else applyHarvestSnapshot(await call('harvestTsNavigate', { id: tab.id, url: target }));
  }

  async function harvestAction(action) {
    const tab = activeHarvestTab();
    if (!tab) return;
    applyHarvestSnapshot(await call('harvestTsAction', { id: tab.id, action }));
  }

  function reloadHarvest() {
    action(() => harvestAction('reload'));
  }

  function harvestManagerSurfaceVisible() {
    return (
      !$('harvestHistoryDialog').open &&
      !$('harvestBookmarkDialog').open &&
      !$('harvestPasswordDialog').open &&
      !$('harvestExtensionDialog').open &&
      !$('harvestDnsDialog').open
    );
  }

  function harvestHistoryTime(ms) {
    try {
      return new Date(Number(ms) || Date.now()).toLocaleString('th-TH', {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
    } catch {
      return '';
    }
  }

  async function refreshHarvestHistory() {
    const data = await call('harvestTsHistoryList', { limit: 1000 }),
      host = $('harvestHistoryList');
    $('harvestHistoryState').textContent = data.enabled
      ? 'กำลังบันทึกประวัติการเข้าเว็บ'
      : 'ปิดการบันทึกประวัติอยู่';
    $('harvestClearHistory').disabled = !data.items.length;
    if (!data.items.length) {
      host.replaceChildren(harvestListEmpty('ยังไม่มีประวัติการเข้าเว็บ'));
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const item of data.items) {
      const row = el('div', 'harvest-manager-row'),
        main = el('div', 'harvest-manager-row-main');
      main.append(
        el('strong', '', item.title || harvestHost(item.url)),
        el('small', '', item.url + ' • ' + harvestHistoryTime(item.visitedAt)),
      );
      const actions = el('div', 'harvest-manager-row-actions');
      const open = el('button', 'quiet', 'เปิด'),
        remove = el('button', 'delete', 'ลบ');
      open.type = remove.type = 'button';
      open.addEventListener('click', () =>
        action(async () => {
          $('harvestHistoryDialog').close();
          await syncHarvestLayout(true);
          await navigateHarvest(item.url);
        }),
      );
      remove.addEventListener('click', () =>
        action(async () => {
          await call('harvestTsHistoryRemove', { id: item.id, limit: 1000 });
          await refreshHarvestHistory();
        }),
      );
      actions.append(open, remove);
      row.append(main, actions);
      fragment.append(row);
    }
    host.replaceChildren(fragment);
  }

  async function openHarvestHistory() {
    await call('harvestTsLayout', { visible: false, bounds: harvestBounds() });
    await refreshHarvestHistory();
    $('harvestHistoryDialog').showModal();
  }

  async function setHarvestMenuOpen(open) {
    $('harvestMenuPopup').hidden = !open;
    if (open)
      await call('harvestTsLayout', {
        visible: false,
        bounds: harvestBounds(),
      });
    else if (!$('harvestTsView').hidden && harvestManagerSurfaceVisible())
      await syncHarvestLayout(true);
  }

  function harvestListEmpty(text) {
    return el('div', 'harvest-manager-empty', text);
  }

  async function refreshHarvestBookmarks(preferredFolderId) {
    const model = await call('harvestTsBookmarkModel'),
      host = $('harvestBookmarkList');
    const tab = activeHarvestTab();
    $('harvestBookmarkCurrentTitle').textContent = tab?.title || 'หน้าปัจจุบัน';
    $('harvestBookmarkCurrentUrl').textContent =
      tab?.kind === 'web' ? tab.url || '' : 'หน้านี้ไม่สามารถบันทึกเป็น Bookmark ได้';
    $('harvestBookmarkCount').textContent = `${model.items.length} รายการ`;

    const select = $('harvestBookmarkFolderSelect'),
      current = preferredFolderId !== undefined ? preferredFolderId : null;
    select.replaceChildren(new Option('ทั่วไป — ไม่อยู่ในโฟลเดอร์', ''));
    for (const folder of model.folders) select.append(new Option(folder.name, folder.id));
    const savedCurrent = tab?.kind === 'web' ? model.items.find((x) => x.url === tab.url) : null;
    const targetFolder =
      current !== null && [...select.options].some((x) => x.value === current)
        ? current
        : savedCurrent?.folderId || '';
    select.value = targetFolder || '';
    $('harvestAddBookmark').disabled =
      !tab || tab.kind !== 'web' || !/^https?:\/\//i.test(tab.url || '');
    $('harvestAddBookmark').textContent = savedCurrent
      ? '★ อัปเดต Bookmark นี้'
      : '☆ บันทึกหน้านี้';

    if (!model.items.length) {
      host.replaceChildren(harvestListEmpty('ยังไม่มี Bookmark ค่ะ'));
      return model;
    }
    const folders = new Map(model.folders.map((x) => [x.id, x.name]));
    const fragment = document.createDocumentFragment();
    for (const item of model.items) {
      const row = el('div', 'harvest-manager-row'),
        main = el('div', 'harvest-manager-row-main');
      const meta = item.folderId
        ? `${item.url} • 📁 ${folders.get(item.folderId) || 'โฟลเดอร์'}`
        : `${item.url} • ทั่วไป`;
      main.append(el('strong', '', item.title || harvestHost(item.url)), el('small', '', meta));
      const actions = el('div', 'harvest-manager-row-actions');
      const open = el('button', 'quiet', 'เปิด'),
        remove = el('button', 'delete', 'ลบ');
      open.type = remove.type = 'button';
      open.addEventListener('click', () =>
        action(async () => {
          $('harvestBookmarkDialog').close();
          await syncHarvestLayout(true);
          await createHarvestTab(item.url);
        }),
      );
      remove.addEventListener('click', () =>
        action(async () => {
          await call('harvestTsBookmarkRemove', { id: item.id });
          await refreshHarvestBookmarks();
          updateHarvestBookmarkButton().catch(() => {});
        }),
      );
      actions.append(open, remove);
      row.append(main, actions);
      fragment.append(row);
    }
    host.replaceChildren(fragment);
    return model;
  }

  async function openHarvestBookmarks() {
    await call('harvestTsLayout', { visible: false, bounds: harvestBounds() });
    await refreshHarvestBookmarks();
    $('harvestBookmarkNewFolder').value = '';
    $('harvestBookmarkDialog').showModal();
  }

  async function updateHarvestBookmarkButton() {
    const tab = activeHarvestTab(),
      button = $('harvestBookmarkQuick');
    const eligible = Boolean(tab && tab.kind === 'web' && /^https?:\/\//i.test(tab.url || ''));
    button.disabled = !eligible;
    if (!eligible) {
      button.textContent = '☆';
      button.classList.remove('saved');
      button.title = 'บันทึก Bookmark';
      return;
    }
    const state = await call('harvestTsBookmarkStatus', { url: tab.url });
    button.textContent = state.saved ? '★' : '☆';
    button.classList.toggle('saved', state.saved);
    button.title = state.saved ? 'แก้ไข Bookmark นี้' : 'บันทึก Bookmark';
  }

  const harvestPasswordHints = new Map();

  let lastPasswordPromptToken = '';

  async function updateHarvestPasswordButton() {
    const tab = activeHarvestTab(),
      button = $('harvestPasswordQuick');
    const eligible = Boolean(tab && tab.kind === 'web' && /^https?:\/\//i.test(tab.url || ''));
    button.disabled = !eligible;
    if (!eligible) {
      button.classList.remove('available', 'pending');
      button.title = 'บัญชีและรหัสผ่าน';
      return;
    }
    let state = harvestPasswordHints.get(tab.id);
    let origin = '';
    try {
      origin = new URL(tab.url || '').origin;
    } catch {}
    if (!state || state.origin !== origin) {
      state = await call('harvestTsPasswordStatus', { id: tab.id });
      harvestPasswordHints.set(tab.id, state);
    }
    const count = Array.isArray(state.accounts) ? state.accounts.length : 0;
    button.classList.toggle('available', count > 0);
    button.classList.toggle('pending', Boolean(state.canSave));
    if (state.canSave)
      button.title = state.candidateUsername
        ? 'มีรหัสของ ' + state.candidateUsername + ' รอให้บันทึก'
        : 'มีรหัสผ่านรอให้บันทึก';
    else if (count > 1) button.title = 'เลือกจาก ' + count + ' บัญชีที่บันทึกไว้';
    else if (count === 1) button.title = 'ใช้บัญชีที่บันทึกไว้';
    else button.title = 'บันทึกหรือจัดการรหัสผ่าน';
  }

  async function refreshHarvestPasswords() {
    const items = await call('harvestTsPasswordList'),
      host = $('harvestPasswordList');
    if (!items.length) {
      host.replaceChildren(harvestListEmpty('ยังไม่มีรหัสผ่านที่บันทึกไว้'));
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const item of items) {
      const row = el('div', 'harvest-manager-row'),
        main = el('div', 'harvest-manager-row-main');
      main.append(
        el('strong', '', item.origin),
        el('small', '', item.username ? `บัญชี: ${item.username}` : 'ไม่ได้ระบุชื่อบัญชี'),
      );
      const actions = el('div', 'harvest-manager-row-actions');
      const remove = el('button', 'delete', 'ลบ');
      remove.type = 'button';
      remove.addEventListener('click', () =>
        action(async () => {
          await call('harvestTsPasswordRemove', { id: item.id });
          harvestPasswordHints.delete(activeHarvestTabId);
          await refreshHarvestPasswords();
          await updateHarvestPasswordButton();
        }),
      );
      actions.append(remove);
      row.append(main, actions);
      fragment.append(row);
    }
    host.replaceChildren(fragment);
  }

  async function openHarvestPasswords() {
    await call('harvestTsLayout', { visible: false, bounds: harvestBounds() });
    await refreshHarvestPasswords();
    $('harvestPasswordDialog').showModal();
  }

  async function closeHarvestManager(dialog) {
    dialog.close();
    if (!$('harvestTsView').hidden) await syncHarvestLayout(true);
  }

  async function refreshHarvestExtensions() {
    const [adblock, items] = await Promise.all([
      call('harvestTsAdblockStatus'),
      call('harvestTsExtensionList'),
    ]);
    const host = $('harvestExtensionList'),
      fragment = document.createDocumentFragment();
    const built = el('div', 'harvest-manager-row harvest-adblock-row'),
      builtMain = el('div', 'harvest-manager-row-main');
    const builtTitle = el('strong', '', adblock.name || 'Harvest Adblock');
    let details = adblock.loading
      ? 'กำลังโหลด EasyList / EasyPrivacy…'
      : adblock.ready
        ? `Ghostery Engine • HarvestTS + ImageHarvest • Network ${Number(adblock.networkFilters || 0).toLocaleString()} • Cosmetic ${Number(adblock.cosmeticFilters || 0).toLocaleString()} • บล็อกแล้ว ${Number(adblock.blockedSession || 0).toLocaleString()} request รอบนี้`
        : `Fallback network blocker${adblock.error ? ' • ' + adblock.error : ''}`;
    if (adblock.updatedAt) {
      try {
        details +=
          ' • อัปเดต ' +
          new Date(adblock.updatedAt).toLocaleString('th-TH', {
            dateStyle: 'short',
            timeStyle: 'short',
          });
      } catch {}
    }
    const builtMeta = el(
      'small',
      adblock.error && !adblock.ready ? 'harvest-extension-error' : '',
      details,
    );
    builtMain.append(builtTitle, builtMeta);
    const builtActions = el('div', 'harvest-manager-row-actions'),
      builtLabel = el('label', 'harvest-extension-toggle');
    const builtToggle = document.createElement('input');
    builtToggle.type = 'checkbox';
    builtToggle.checked = Boolean(adblock.enabled);
    builtLabel.append(builtToggle, el('span', '', adblock.enabled ? 'เปิด' : 'ปิด'));
    builtToggle.addEventListener('change', () =>
      action(async () => {
        await call('harvestTsAdblockSet', { enabled: builtToggle.checked });
        await refreshHarvestExtensions();
      }),
    );
    const update = el('button', 'quiet', 'อัปเดต');
    update.type = 'button';
    update.disabled = Boolean(adblock.loading);
    update.addEventListener('click', () =>
      action(async () => {
        update.disabled = true;
        update.textContent = 'กำลังอัปเดต…';
        await call('harvestTsAdblockUpdate');
        await refreshHarvestExtensions();
      }),
    );
    builtActions.append(
      el('span', 'harvest-plugin-badge', adblock.ready ? 'EASYLIST+' : 'BUILT-IN'),
      update,
      builtLabel,
    );
    built.append(builtMain, builtActions);
    fragment.append(built);

    for (const item of items) {
      const row = el('div', 'harvest-manager-row'),
        main = el('div', 'harvest-manager-row-main');
      main.append(
        el('strong', '', item.name || item.id),
        el(
          'small',
          item.error ? 'harvest-extension-error' : '',
          item.error
            ? `โหลดไม่สำเร็จ: ${item.error}`
            : `v${item.version || '?'} • Chrome Extension`,
        ),
      );
      const actions = el('div', 'harvest-manager-row-actions'),
        label = el('label', 'harvest-extension-toggle');
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = item.enabled !== false && item.loaded !== false;
      label.append(toggle, el('span', '', toggle.checked ? 'เปิด' : 'ปิด'));
      toggle.addEventListener('change', () =>
        action(async () => {
          await call('harvestTsExtensionToggle', {
            id: item.id,
            enabled: toggle.checked,
          });
          await refreshHarvestExtensions();
        }),
      );
      const remove = el('button', 'delete', 'ลบ');
      remove.type = 'button';
      remove.addEventListener('click', () =>
        action(async () => {
          await call('harvestTsExtensionRemove', { id: item.id });
          await refreshHarvestExtensions();
        }),
      );
      actions.append(label, remove);
      row.append(main, actions);
      fragment.append(row);
    }
    host.replaceChildren(fragment);
  }

  async function openHarvestExtensions() {
    await call('harvestTsLayout', { visible: false, bounds: harvestBounds() });
    await refreshHarvestExtensions();
    $('harvestExtensionDialog').showModal();
  }

  async function openHarvestDns() {
    await call('harvestTsLayout', { visible: false, bounds: harvestBounds() });
    const settings = await call('harvestTsDnsSettings');
    $('harvestDnsMode').value = settings.dnsMode || 'inherit';
    $('harvestCustomDoh').value = settings.customDoh || '';
    $('harvestCustomDohRow').hidden = $('harvestDnsMode').value !== 'custom';
    $('harvestDnsStatus').textContent = '';
    $('harvestDnsDialog').showModal();
  }

  let harvestBlockMode = false,
    harvestBlockTabId = null,
    harvestBlockPollTimer = null,
    harvestBlockPollBusy = false;

  function selectorLabel(selector) {
    const text = String(selector || '');
    return text.length > 72 ? text.slice(0, 69) + '…' : text;
  }

  function renderHarvestBlockState(state = {}) {
    $('harvestBlockOrigin').textContent = state.origin || 'เลือกส่วนที่ต้องการซ่อน';
    const selected = Array.isArray(state.selectors) ? state.selectors : [];
    const saved = Array.isArray(state.saved) ? state.saved : [];
    $('harvestBlockDraftCount').textContent = `${selected.length} จุด`;
    $('harvestBlockCommit').disabled = selected.length === 0;
    const draft = document.createDocumentFragment();
    if (!selected.length) draft.append(harvestListEmpty('ยังไม่ได้เลือก Element'));
    else
      for (const selector of selected) {
        const row = el('div', 'harvest-block-selector');
        const code = document.createElement('code');
        code.textContent = selector;
        code.title = selector;
        row.append(code);
        draft.append(row);
      }
    $('harvestBlockDraftList').replaceChildren(draft);
    $('harvestBlockSavedCount').textContent = `${saved.length} กฎ`;
    $('harvestBlockClearSaved').disabled = saved.length === 0;
    const savedFrag = document.createDocumentFragment();
    if (!saved.length) savedFrag.append(harvestListEmpty('เว็บนี้ยังไม่มี Filter ที่บันทึกไว้'));
    else
      for (const selector of saved) {
        const row = el('div', 'harvest-block-selector');
        const code = document.createElement('code');
        code.textContent = selector;
        code.title = selector;
        const remove = el('button', 'delete', 'ลบ');
        remove.type = 'button';
        remove.addEventListener('click', () =>
          action(async () => {
            const tab = activeHarvestTab();
            if (!tab) return;
            const result = await call('harvestTsBlockRemove', {
              id: tab.id,
              selector,
            });
            const latest = await call('harvestTsBlockDraftState', {
              id: tab.id,
            });
            latest.saved = result.selectors;
            renderHarvestBlockState(latest);
          }),
        );
        row.append(code, remove);
        savedFrag.append(row);
      }
    $('harvestBlockSavedList').replaceChildren(savedFrag);
  }

  function stopHarvestBlockPolling() {
    clearTimeout(harvestBlockPollTimer);
    harvestBlockPollTimer = null;
    harvestBlockPollBusy = false;
  }

  async function pollHarvestBlockState() {
    if (!harvestBlockMode || !harvestBlockTabId || harvestBlockPollBusy) return;
    harvestBlockPollBusy = true;
    try {
      const state = await call('harvestTsBlockDraftState', {
        id: harvestBlockTabId,
      });
      renderHarvestBlockState(state);
      if (state.cancelled) {
        await cancelHarvestBlockMode(true);
        return;
      }
      if (!state.active) {
        await cancelHarvestBlockMode(false);
        return;
      }
    } catch {
      await cancelHarvestBlockMode(false);
      return;
    } finally {
      harvestBlockPollBusy = false;
    }
    if (harvestBlockMode) harvestBlockPollTimer = setTimeout(pollHarvestBlockState, 220);
  }

  async function closeHarvestBlockPanel() {
    stopHarvestBlockPolling();
    harvestBlockMode = false;
    harvestBlockTabId = null;
    $('harvestBlockPanel').hidden = true;
    document.querySelector('.harvest-browser-shell').classList.remove('block-mode');
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (!$('harvestTsView').hidden && harvestManagerSurfaceVisible()) await syncHarvestLayout(true);
  }

  async function cancelHarvestBlockMode(showMessage = true) {
    const id = harvestBlockTabId;
    if (id) await call('harvestTsBlockDraftCancel', { id }).catch(() => {});
    await closeHarvestBlockPanel();
    if (showMessage) $('harvestStatus').textContent = 'ยกเลิก Block element แล้ว';
  }

  async function startHarvestBlockElement() {
    const tab = activeHarvestTab();
    if (!tab) return;
    await call('harvestTsBlockDraftBegin', { id: tab.id });
    $('harvestStatus').textContent =
      'Block element • หน้าต่างลอยเปิดแล้ว • สีเทา = กำลังชี้ • สีฟ้าอ่อน = เลือกแล้ว';
  }

  const harvestResizeObserver = new ResizeObserver(() => {
    if (!$('harvestTsView').hidden && harvestManagerSurfaceVisible())
      window.eiw.harvestTsLayout({ visible: true, bounds: harvestBounds() }).catch(() => {});
  });

  harvestResizeObserver.observe($('harvestWebviews'));

  window.addEventListener('resize', () => {
    if (!$('harvestTsView').hidden && harvestManagerSurfaceVisible())
      window.eiw.harvestTsLayout({ visible: true, bounds: harvestBounds() }).catch(() => {});
  });

  $('harvestTsNav').addEventListener('click', () => showWorkspaceView('harvestts'));

  $('ocrLabNav').addEventListener('click', () => action(() => call('ocrLabOpen')));

  $('harvestNewTab').addEventListener('click', () => action(() => createHarvestTab()));

  $('harvestGo').addEventListener('click', () =>
    action(() => navigateHarvest($('harvestAddress').value)),
  );

  $('harvestAddress').addEventListener('pointerdown', (event) => {
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

  $('harvestAddress').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      action(() => navigateHarvest($('harvestAddress').value));
    }
    if (event.key === 'Escape') {
      const tab = activeHarvestTab();
      $('harvestAddress').value =
        tab?.kind === 'downloads'
          ? 'Downloads'
          : tab?.kind === 'offline'
            ? 'Offline Library'
            : tab?.kind === 'offline-reader'
              ? 'Offline Reader'
              : tab?.kind === 'history'
                ? 'History'
                : tab?.url || '';
      $('harvestAddress').blur();
    }
  });

  $('harvestBack').addEventListener('click', () => action(() => harvestAction('back')));

  $('harvestForward').addEventListener('click', () => action(() => harvestAction('forward')));

  $('harvestReload').addEventListener('click', reloadHarvest);

  $('harvestHome').addEventListener('click', () => action(() => harvestAction('home')));

  $('harvestMenu').addEventListener('click', () =>
    action(async () => {
      const rect = $('harvestMenu').getBoundingClientRect();
      await call('harvestTsPopupMenu', {
        x: Math.round(rect.left),
        y: Math.round(rect.bottom),
      });
    }),
  );

  $('harvestSendToCollector').addEventListener('click', () =>
    action(async () => {
      const tab = activeHarvestTab();
      if (!tab || tab.kind !== 'web' || !/^https?:\/\//i.test(tab.url || '')) return;
      const target = tab.url;
      await sendToCollector(target);
    }),
  );

  $('harvestBookmarkQuick').addEventListener('click', () => action(openHarvestBookmarks));

  $('harvestPasswordQuick').addEventListener('click', () =>
    action(async () => {
      const tab = activeHarvestTab();
      if (!tab || tab.kind !== 'web') return;
      const rect = $('harvestPasswordQuick').getBoundingClientRect();
      const state = await call('harvestTsPasswordPopupMenu', {
        id: tab.id,
        x: Math.round(rect.left),
        y: Math.round(rect.bottom),
      });
      harvestPasswordHints.set(tab.id, state);
      await updateHarvestPasswordButton();
    }),
  );

  $('harvestZoomOut').addEventListener('click', () => action(() => harvestAction('zoom-out')));

  $('harvestZoomValue').addEventListener('click', () => action(() => harvestAction('zoom-reset')));

  $('harvestZoomIn').addEventListener('click', () => action(() => harvestAction('zoom-in')));

  $('harvestBookmarkMenu').addEventListener('click', () => action(openHarvestBookmarks));

  $('harvestPasswordMenu').addEventListener('click', () => action(openHarvestPasswords));

  $('harvestBlockElementMenu').addEventListener('click', () => action(startHarvestBlockElement));

  $('closeHarvestHistory').addEventListener('click', () =>
    action(() => closeHarvestManager($('harvestHistoryDialog'))),
  );

  $('harvestHistoryDialog').addEventListener('close', () => {
    if (!$('harvestTsView').hidden) syncHarvestLayout(true).catch(() => {});
  });

  $('harvestClearHistory').addEventListener('click', () =>
    action(async () => {
      await call('harvestTsHistoryClear');
      await refreshHarvestHistory();
    }),
  );

  $('closeHarvestBookmarks').addEventListener('click', () =>
    action(() => closeHarvestManager($('harvestBookmarkDialog'))),
  );

  $('closeHarvestPasswords').addEventListener('click', () =>
    action(() => closeHarvestManager($('harvestPasswordDialog'))),
  );

  $('harvestBookmarkDialog').addEventListener('close', () => {
    if (!$('harvestTsView').hidden) syncHarvestLayout(true).catch(() => {});
  });

  $('harvestPasswordDialog').addEventListener('close', () => {
    if (!$('harvestTsView').hidden) syncHarvestLayout(true).catch(() => {});
  });

  $('harvestBookmarkCreateFolder').addEventListener('click', () =>
    action(async () => {
      const name = $('harvestBookmarkNewFolder').value.trim();
      const result = await call('harvestTsBookmarkFolderCreate', { name });
      $('harvestBookmarkNewFolder').value = '';
      await refreshHarvestBookmarks(result.folder.id);
    }),
  );

  $('harvestBookmarkNewFolder').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      $('harvestBookmarkCreateFolder').click();
    }
  });

  $('harvestAddBookmark').addEventListener('click', () =>
    action(async () => {
      const tab = activeHarvestTab();
      if (!tab || tab.kind !== 'web') return;
      await call('harvestTsBookmarkAdd', {
        id: tab.id,
        folderId: $('harvestBookmarkFolderSelect').value || null,
      });
      await refreshHarvestBookmarks($('harvestBookmarkFolderSelect').value || '');
      await updateHarvestBookmarkButton();
    }),
  );

  $('harvestSavePassword').addEventListener('click', () =>
    action(async () => {
      const tab = activeHarvestTab();
      if (!tab) return;
      const result = await call('harvestTsPasswordSaveCurrent', { id: tab.id });
      $('harvestPasswordNote').textContent = result.item.username
        ? `บันทึกแล้ว • ${result.item.origin} • บัญชี ${result.item.username}`
        : `บันทึกรหัสผ่านของ ${result.item.origin} แล้ว`;
      await refreshHarvestPasswords();
    }),
  );

  $('harvestFillPassword').addEventListener('click', () =>
    action(async () => {
      const tab = activeHarvestTab();
      if (!tab) return;
      await call('harvestTsPasswordFillCurrent', { id: tab.id });
      $('harvestPasswordNote').textContent = 'Autofill ข้อมูลล็อกอินให้หน้านี้แล้วค่ะ';
    }),
  );

  $('closeHarvestExtensions').addEventListener('click', () =>
    action(() => closeHarvestManager($('harvestExtensionDialog'))),
  );

  $('closeHarvestDns').addEventListener('click', () =>
    action(() => closeHarvestManager($('harvestDnsDialog'))),
  );

  $('harvestExtensionDialog').addEventListener('close', () => {
    if (!$('harvestTsView').hidden) syncHarvestLayout(true).catch(() => {});
  });

  $('harvestDnsDialog').addEventListener('close', () => {
    if (!$('harvestTsView').hidden) syncHarvestLayout(true).catch(() => {});
  });

  $('harvestInstallExtension').addEventListener('click', () =>
    action(async () => {
      const result = await call('harvestTsExtensionInstall', {});
      if (!result.cancelled) await refreshHarvestExtensions();
    }),
  );

  $('harvestDnsMode').addEventListener('change', () => {
    $('harvestCustomDohRow').hidden = $('harvestDnsMode').value !== 'custom';
  });

  $('harvestApplyDns').addEventListener('click', () =>
    action(async () => {
      const mode = $('harvestDnsMode').value,
        customDoh = $('harvestCustomDoh').value.trim();
      const settings = await call('harvestTsDnsSet', { mode, customDoh });
      $('harvestDnsStatus').textContent =
        settings.dnsMode === 'inherit'
          ? 'กลับไปใช้ DNS ตาม ImageHarvest แล้ว'
          : 'เปลี่ยน Secure DNS แล้ว';
    }),
  );

  $('harvestBlockClose').addEventListener('click', () =>
    action(() => cancelHarvestBlockMode(false)),
  );

  $('harvestBlockCancel').addEventListener('click', () =>
    action(() => cancelHarvestBlockMode(true)),
  );

  $('harvestBlockClearDraft').addEventListener('click', () =>
    action(async () => {
      if (!harvestBlockTabId) return;
      await call('harvestTsBlockDraftClear', { id: harvestBlockTabId });
      renderHarvestBlockState(await call('harvestTsBlockDraftState', { id: harvestBlockTabId }));
    }),
  );

  $('harvestBlockCommit').addEventListener('click', () =>
    action(async () => {
      if (!harvestBlockTabId) return;
      const result = await call('harvestTsBlockDraftCommit', {
        id: harvestBlockTabId,
      });
      await closeHarvestBlockPanel();
      $('harvestStatus').textContent = result.saved
        ? `บันทึก Block element แล้ว • เพิ่ม ${result.added} กฎ • รวม ${result.count} กฎ`
        : 'ยังไม่ได้เลือก Element สำหรับบล็อก';
    }),
  );

  $('harvestBlockClearSaved').addEventListener('click', () =>
    action(async () => {
      if (!harvestBlockTabId) return;
      await call('harvestTsBlockClear', { id: harvestBlockTabId });
      renderHarvestBlockState(await call('harvestTsBlockDraftState', { id: harvestBlockTabId }));
      $('harvestStatus').textContent = 'ล้าง Filter ของเว็บนี้ทั้งหมดแล้ว';
    }),
  );

  document.addEventListener('click', (event) => {
    if ($('harvestMenuPopup').hidden) return;
    if ($('harvestMenuPopup').contains(event.target) || $('harvestMenu').contains(event.target))
      return;
    action(() => setHarvestMenuOpen(false));
  });

  document.addEventListener('keydown', (event) => {
    if ($('harvestTsView').hidden) return;
    if (event.ctrlKey && event.key.toLowerCase() === 'l') {
      event.preventDefault();
      $('harvestAddress').focus();
      $('harvestAddress').select();
      return;
    }
    if (event.ctrlKey && event.key.toLowerCase() === 't') {
      event.preventDefault();
      createHarvestTab();
      return;
    }
    if (event.ctrlKey && event.key.toLowerCase() === 'w') {
      event.preventDefault();
      if (activeHarvestTabId) closeHarvestTab(activeHarvestTabId);
      return;
    }
    if (event.ctrlKey && event.key.toLowerCase() === 'r') {
      event.preventDefault();
      reloadHarvest();
      return;
    }
    if (event.ctrlKey && (event.key === '+' || event.key === '=')) {
      event.preventDefault();
      action(() => harvestAction('zoom-in'));
      return;
    }
    if (event.ctrlKey && event.key === '-') {
      event.preventDefault();
      action(() => harvestAction('zoom-out'));
      return;
    }
    if (event.ctrlKey && event.key === '0') {
      event.preventDefault();
      action(() => harvestAction('zoom-reset'));
      return;
    }
    if (event.key === 'F5') {
      event.preventDefault();
      reloadHarvest();
      return;
    }
    if (event.altKey && event.key === 'ArrowLeft') {
      event.preventDefault();
      action(() => harvestAction('back'));
      return;
    }
    if (event.altKey && event.key === 'ArrowRight') {
      event.preventDefault();
      action(() => harvestAction('forward'));
    }
  });
  window.eiw.on((event) => {
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
      if (!event.tabId || event.tabId === activeHarvestTabId)
        $('harvestStatus').textContent =
          `บันทึก Offline แล้ว • ${event.pages || 0} หน้า • ยังอยู่หน้าเว็บเดิม`;
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
      harvestPasswordHints.set(event.tabId, event);
      if (event.tabId === activeHarvestTabId) {
        updateHarvestPasswordButton().catch(() => {});
        if (event.canSave) {
          $('harvestStatus').textContent = event.candidateUsername
            ? 'มีรหัสของ ' + event.candidateUsername + ' รอให้บันทึก'
            : 'มีรหัสผ่านรอให้บันทึก';
          const token = String(event.candidateToken || '');
          if (token && token !== lastPasswordPromptToken) {
            lastPasswordPromptToken = token;
            setTimeout(() => {
              const tab = activeHarvestTab();
              if (!tab || tab.id !== event.tabId) return;
              const rect = $('harvestPasswordQuick').getBoundingClientRect();
              call('harvestTsPasswordSavePrompt', {
                id: event.tabId,
                x: Math.round(rect.left),
                y: Math.round(rect.bottom),
              }).catch(() => {});
            }, 80);
          }
        }
      }
      return;
    }
    if (event.type === 'harvestts-password-message') {
      if (event.tabId === activeHarvestTabId)
        $('harvestStatus').textContent = event.error || event.message || 'จัดการรหัสผ่านแล้ว';
      harvestPasswordHints.delete(event.tabId);
      updateHarvestPasswordButton().catch(() => {});
      return;
    }
    if (event.type === 'harvestts-block-finished') {
      if (event.cancelled)
        $('harvestStatus').textContent = event.message || 'ยกเลิก Block element แล้ว';
      else
        $('harvestStatus').textContent = event.saved
          ? `บันทึก Block element แล้ว • เพิ่ม ${event.added || 0} กฎ • รวม ${event.count || 0} กฎ`
          : 'ยังไม่ได้เลือก Element สำหรับบล็อก';
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
      if (event.key === 'l') {
        $('harvestAddress').focus();
        $('harvestAddress').select();
      } else if (event.key === 't') action(() => createHarvestTab());
      else if (event.key === 'w' && activeHarvestTabId)
        action(() => closeHarvestTab(activeHarvestTabId));
      return;
    }
  });
  return {
    ensureHarvestBrowser,
    get harvestBlockMode() {
      return harvestBlockMode;
    },
    cancelHarvestBlockMode,
  };
}
