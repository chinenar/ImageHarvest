'use strict';
const { app, BrowserView, Menu } = require('electron');
const fsSync = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ElectronImageStore } = require('../electron-image-store.cjs');
const { readerDocumentKey } = require('../reader-document.cjs');
const { loadFavicon } = require('./favicon.cjs');
const sourceDir = require('node:path').resolve(__dirname, '..');

function createTabs({
  blockManager: blockManagerService,
  blocks: blocksService,
  contextMenu: contextMenuService,
  history: historyService,
  offlineLibrary: offlineLibraryService,
  offlineReader: offlineReaderService,
  session: sessionService,
  storage: storageService,
  translation: translationService,
  host: hostService,
}) {
  const harvestTsTabs = new Map();

  let harvestTsCounter = 0;

  let activeHarvestTsId = null;

  let harvestTsVisible = false;

  let harvestTsBounds = { x: 220, y: 116, width: 900, height: 700 };

  let harvestTabsRestoreAttempted = false;

  let harvestTabsRestorePromise = null;

  let harvestTabsSaveTimer = null;

  const HARVEST_ZOOM_LEVELS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

  function normalizeHarvestZoom(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0.5, Math.min(3, n)) : 1;
  }

  function harvestNavigationSnapshot(tab) {
    const wc = tab?.view?.webContents;
    if (!wc || wc.isDestroyed() || tab.kind !== 'web') return { entries: [], index: 0 };
    try {
      const all = wc.navigationHistory?.getAllEntries?.() || [],
        active = wc.navigationHistory?.getActiveIndex?.() ?? Math.max(0, all.length - 1);
      const valid = all
        .map((entry, sourceIndex) => ({
          sourceIndex,
          url: String(entry?.url || ''),
          title: String(entry?.title || entry?.url || ''),
        }))
        .filter((entry) => /^https?:\/\//i.test(entry.url));
      if (!valid.length) return { entries: [], index: 0 };
      let pos = valid.findIndex((entry) => entry.sourceIndex === active);
      if (pos < 0) {
        pos = 0;
        for (let i = 0; i < valid.length; i++) if (valid[i].sourceIndex <= active) pos = i;
      }
      const limit = 120,
        start = Math.max(0, Math.min(pos - 60, Math.max(0, valid.length - limit))),
        slice = valid.slice(start, start + limit);
      return {
        entries: slice.map(({ url, title }) => ({ url, title })),
        index: Math.max(0, Math.min(slice.length - 1, pos - start)),
      };
    } catch {
      return { entries: [], index: 0 };
    }
  }

  function stepHarvestZoom(tab, direction) {
    if (!tab || tab.kind !== 'web' || tab.view.webContents.isDestroyed()) return false;
    const current = normalizeHarvestZoom(
      tab.zoomFactor || tab.view.webContents.getZoomFactor?.() || 1,
    );
    let index = HARVEST_ZOOM_LEVELS.findIndex((x) => Math.abs(x - current) < 0.001);
    if (index < 0) {
      index = HARVEST_ZOOM_LEVELS.reduce(
        (best, x, i) =>
          Math.abs(x - current) < Math.abs(HARVEST_ZOOM_LEVELS[best] - current) ? i : best,
        0,
      );
    }
    const next =
      direction === 0
        ? 1
        : HARVEST_ZOOM_LEVELS[
            Math.max(0, Math.min(HARVEST_ZOOM_LEVELS.length - 1, index + (direction > 0 ? 1 : -1)))
          ];
    tab.zoomFactor = normalizeHarvestZoom(next);
    tab.view.webContents.setZoomFactor(tab.zoomFactor);
    try {
      tab.view.webContents.send('harvest-guest:zoom-display', {
        percent: Math.round(tab.zoomFactor * 100),
      });
    } catch {}
    emitHarvestTs();
    scheduleHarvestTabsSave();
    return true;
  }

  function stepHarvestZoomWheel(tab, direction) {
    const now = Date.now();
    if (now - Number(tab.lastZoomWheelAt || 0) < 90) return false;
    tab.lastZoomWheelAt = now;
    return stepHarvestZoom(tab, direction);
  }

  function harvestTabsPayload() {
    const source = [...harvestTsTabs.values()]
      .filter(
        (tab) =>
          tab &&
          tab.kind === 'web' &&
          !tab.view.webContents.isDestroyed() &&
          /^https?:\/\//i.test(tab.view.webContents.getURL() || tab.url || ''),
      )
      .slice(0, 25);
    const tabs = source.map((tab) => {
      const wc = tab.view.webContents,
        url = wc.getURL() || tab.url || '',
        history = harvestNavigationSnapshot(tab);
      return {
        url,
        title: wc.getTitle() || tab.title || url,
        zoomFactor: normalizeHarvestZoom(tab.zoomFactor || wc.getZoomFactor?.() || 1),
        history,
      };
    });
    let activeIndex = source.findIndex((x) => x.id === activeHarvestTsId);
    if (activeIndex < 0) activeIndex = 0;
    return {
      version: 2,
      savedAt: Date.now(),
      activeIndex: Math.min(activeIndex, Math.max(0, tabs.length - 1)),
      tabs,
    };
  }

  async function saveHarvestTabsNow() {
    clearTimeout(harvestTabsSaveTimer);
    harvestTabsSaveTimer = null;
    await storageService.writeHarvestJson(storageService.harvestTsTabsFile, harvestTabsPayload());
  }

  function saveHarvestTabsSync() {
    try {
      fsSync.mkdirSync(storageService.harvestTsDataDir, { recursive: true });
      fsSync.writeFileSync(
        storageService.harvestTsTabsFile,
        JSON.stringify(harvestTabsPayload(), null, 2),
        'utf8',
      );
    } catch {}
  }

  function scheduleHarvestTabsSave(delayMs = 180) {
    clearTimeout(harvestTabsSaveTimer);
    harvestTabsSaveTimer = setTimeout(() => {
      saveHarvestTabsNow().catch(() => {});
    }, delayMs);
  }

  async function restoreHarvestTabsIfNeeded() {
    if (harvestTsTabs.size) return harvestTsSnapshot();
    if (harvestTabsRestorePromise) return harvestTabsRestorePromise;
    if (harvestTabsRestoreAttempted) return harvestTsSnapshot();
    harvestTabsRestoreAttempted = true;
    harvestTabsRestorePromise = (async () => {
      if (sessionService.harvestBrowserRuntime.restoreTabs === false) return harvestTsSnapshot();
      const data = await storageService.readHarvestJson(storageService.harvestTsTabsFile, {
        version: 2,
        tabs: [],
        activeIndex: 0,
      });
      const tabs = Array.isArray(data.tabs)
        ? data.tabs.filter((x) => x && /^https?:\/\//i.test(x.url || '')).slice(0, 25)
        : [];
      if (!tabs.length) return harvestTsSnapshot();
      const created = [];
      for (const row of tabs) {
        const entries = Array.isArray(row.history?.entries)
          ? row.history.entries.filter((e) => e && /^https?:\/\//i.test(e.url || '')).slice(0, 120)
          : [];
        const snap = createHarvestTsTab({
          url: row.url,
          activate: false,
          skipSave: true,
          skipEmit: true,
          restored: true,
          navigationHistory: entries,
          navigationIndex: row.history?.index,
          zoomFactor: row.zoomFactor,
        });
        const last = snap.tabs[snap.tabs.length - 1];
        if (last) created.push(last.id);
      }
      await Promise.all(created.map((id) => harvestTsTabs.get(id)?.bootstrapReady).filter(Boolean));
      const index = Math.max(0, Math.min(created.length - 1, Number(data.activeIndex) || 0));
      activeHarvestTsId = created[index] || created[0] || null;
      applyHarvestTsView();
      emitHarvestTs();
      scheduleHarvestTabsSave();
      return harvestTsSnapshot();
    })();
    try {
      return await harvestTabsRestorePromise;
    } finally {
      harvestTabsRestorePromise = null;
    }
  }

  function activeHarvestTsTab() {
    return harvestTsTabs.get(activeHarvestTsId) || null;
  }

  function harvestTsPageInfo(tab = activeHarvestTsTab()) {
    if (!tab || tab.view.webContents.isDestroyed()) throw new Error('ไม่พบแท็บ HarvestTS');
    const wc = tab.view.webContents,
      url = wc.getURL() || tab.url || '';
    if (!/^https?:\/\//i.test(url)) throw new Error('หน้านี้ยังไม่มี URL ที่บันทึกได้');
    return { tab, wc, url, title: wc.getTitle() || tab.title || url };
  }

  function harvestGuestTab(event) {
    const tab = [...harvestTsTabs.values()].find(
      (row) =>
        row.kind === 'web' &&
        !row.view.webContents.isDestroyed() &&
        row.view.webContents === event.sender,
    );
    if (!tab) throw new Error('Unauthorized HarvestTS guest IPC');
    return tab;
  }

  function harvestTsState(tab) {
    if (!tab || tab.view.webContents.isDestroyed()) return null;
    const wc = tab.view.webContents,
      nav = wc.navigationHistory;
    const web = tab.kind === 'web';
    return {
      id: tab.id,
      kind: tab.kind || 'web',
      title:
        wc.getTitle() ||
        tab.title ||
        (tab.kind === 'history'
          ? 'History'
          : tab.kind === 'downloads'
            ? 'Downloads'
            : tab.kind === 'offline'
              ? 'Offline'
              : tab.kind === 'offline-reader'
                ? 'Offline Reader'
                : 'แท็บใหม่'),
      url: wc.getURL() || tab.url || '',
      favicon: tab.favicon || '',
      loading: wc.isLoading(),
      canGoBack: web ? Boolean(nav?.canGoBack?.()) : wc.canGoBack(),
      canGoForward: web ? Boolean(nav?.canGoForward?.()) : wc.canGoForward(),
      zoomFactor: web ? normalizeHarvestZoom(tab.zoomFactor || wc.getZoomFactor?.() || 1) : 1,
      historyLength: web ? Number(nav?.length?.() || 0) : 0,
      historyIndex: web ? Number(nav?.getActiveIndex?.() || 0) : 0,
    };
  }

  function harvestTsSnapshot() {
    return {
      activeId: activeHarvestTsId,
      tabs: [...harvestTsTabs.values()].map(harvestTsState).filter(Boolean),
    };
  }

  function emitHarvestTs() {
    hostService.emit('harvestts-state', harvestTsSnapshot());
  }

  function applyHarvestTsView() {
    if (!hostService.mainWindow || hostService.mainWindow.isDestroyed()) return;
    if (!harvestTsVisible || !activeHarvestTsId) {
      hostService.mainWindow.setBrowserView(null);
      return;
    }
    const tab = harvestTsTabs.get(activeHarvestTsId);
    if (!tab || tab.view.webContents.isDestroyed()) {
      hostService.mainWindow.setBrowserView(null);
      return;
    }
    hostService.mainWindow.setBrowserView(tab.view);
    tab.view.setBounds(harvestTsBounds);
    tab.view.setAutoResize({ width: true, height: true });
    // BrowserView needs native focus for physical mouse-wheel/touchpad input.
    // Without this, Chromium can scroll programmatically while Windows routes
    // wheel input to the parent renderer instead.
    setImmediate(() => {
      if (harvestTsVisible && activeHarvestTsId === tab.id && !tab.view.webContents.isDestroyed()) {
        tab.view.webContents.focus();
        require('../reader-mode.cjs')
          .repairContinuousReaderScroll(tab.view.webContents)
          .catch(() => {});
      }
    });
  }

  function sanitizeHarvestTsBounds(input = {}) {
    const area = hostService.mainWindow?.getContentBounds?.() || {
      width: 1360,
      height: 920,
    };
    const x = Math.max(0, Math.min(area.width - 1, Math.round(Number(input.x) || 0)));
    const y = Math.max(0, Math.min(area.height - 1, Math.round(Number(input.y) || 0)));
    const width = Math.max(1, Math.min(area.width - x, Math.round(Number(input.width) || 1)));
    const height = Math.max(1, Math.min(area.height - y, Math.round(Number(input.height) || 1)));
    return { x, y, width, height };
  }

  function normalizeHarvestTsURL(raw) {
    const value = String(raw || '').trim();
    if (!value) return 'https://www.google.com/';
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      return url.href;
    } catch {
      throw new Error('HarvestTS รองรับเฉพาะ http/https');
    }
  }

  function bindHarvestTs(tab) {
    const wc = tab.view.webContents;
    let imageStoreInstalling = false;
    const ensureHarvestImageStore = () => {
      if (tab.kind !== 'web' || !tab.imageStore || tab.imageStore.installed || imageStoreInstalling)
        return tab.imageStoreReady;
      imageStoreInstalling = true;
      tab.imageStoreReady = tab.imageStore
        .install()
        .then(() => true)
        .catch(() => false)
        .finally(() => {
          imageStoreInstalling = false;
        });
      return tab.imageStoreReady;
    };
    let preparedReaderDocument = '';
    let readerPrepareTimer = null,
      offlineRestoreTimer = null,
      temporaryRestoreTimer = null,
      offlineRestoreAttempt = 0;
    const clearOfflineRestore = () => {
      if (offlineRestoreTimer) clearTimeout(offlineRestoreTimer);
      offlineRestoreTimer = null;
      offlineRestoreAttempt = 0;
    };
    const clearTemporaryRestore = () => {
      if (temporaryRestoreTimer) clearTimeout(temporaryRestoreTimer);
      temporaryRestoreTimer = null;
    };
    const scheduleOfflineRestore = (delayMs = 520) => {
      if (tab.kind !== 'web' || wc.isDestroyed()) return;
      if (offlineRestoreTimer) clearTimeout(offlineRestoreTimer);
      const documentId = readerDocumentKey(wc.getURL() || tab.url || '');
      offlineRestoreTimer = setTimeout(async () => {
        offlineRestoreTimer = null;
        if (wc.isDestroyed() || readerDocumentKey(wc.getURL() || '') !== documentId) return;
        const result = await offlineReaderService
          .restoreHarvestOfflineOverlay(tab)
          .catch(() => null);
        if (!tab.offlineOverlayDocument && result && offlineRestoreAttempt < 5) {
          offlineRestoreAttempt++;
          scheduleOfflineRestore(450 + offlineRestoreAttempt * 300);
        }
      }, delayMs);
    };
    const scheduleTemporaryRestore = (delayMs = 520) => {
      if (tab.kind !== 'web' || wc.isDestroyed()) return;
      clearTemporaryRestore();
      const documentId = readerDocumentKey(wc.getURL() || tab.url || '');
      temporaryRestoreTimer = setTimeout(async () => {
        temporaryRestoreTimer = null;
        if (wc.isDestroyed() || readerDocumentKey(wc.getURL() || '') !== documentId) return;
        const result = await translationService
          .restoreHarvestTemporaryOverlay(tab)
          .catch(() => null);
        if (!result?.regions) scheduleOfflineRestore(0);
      }, delayMs);
    };
    const scheduleContinuousReader = (url = wc.getURL()) => {
      let parsed;
      try {
        parsed = new URL(url || '');
      } catch {
        return;
      }
      if (
        !['mangadex.org', 'www.mangadex.org'].includes(parsed.hostname) ||
        !parsed.pathname.startsWith('/chapter/')
      ) {
        preparedReaderDocument = '';
        return;
      }
      const documentId = readerDocumentKey(parsed.href);
      if (preparedReaderDocument === documentId) {
        require('../reader-mode.cjs')
          .repairContinuousReaderScroll(wc)
          .catch(() => {});
        return;
      }
      if (readerPrepareTimer) clearTimeout(readerPrepareTimer);
      readerPrepareTimer = setTimeout(async () => {
        readerPrepareTimer = null;
        if (wc.isDestroyed()) return;
        const currentUrl = wc.getURL();
        if (readerDocumentKey(currentUrl) !== documentId) return;
        try {
          const state = await require('../reader-mode.cjs').ensureContinuousReader(wc);
          if (state?.supported && state.mode === 'Long Strip') preparedReaderDocument = documentId;
        } catch (error) {
          hostService.emit('harvestts-error', {
            id: tab.id,
            message: error.message || String(error),
            url: currentUrl,
          });
        }
      }, 220);
    };
    const update = () => {
      tab.url = wc.getURL() || tab.url;
      tab.title = wc.getTitle() || tab.title;
      emitHarvestTs();
      scheduleHarvestTabsSave();
    };
    wc.on('did-start-loading', () => {
      ensureHarvestImageStore();
      clearTemporaryRestore();
      clearOfflineRestore();
      tab.offlineOverlayDocument = '';
      update();
    });
    wc.on('did-start-navigation', (details, url, isInPlace, isMainFrame) => {
      ensureHarvestImageStore();
      const target = details.url || url,
        mainFrame = details.isMainFrame ?? isMainFrame,
        sameDocument = details.isSameDocument ?? isInPlace;
      if (mainFrame === false) return;
      if (!sameDocument) {
        tab.faviconRequest?.abort();
        tab.favicon = '';
        emitHarvestTs();
      }
      const translation = translationService.harvestTranslationJobFor(tab);
      if (
        translation?.running &&
        target &&
        (!sameDocument ||
          !translationService.sameHarvestTranslationPage(
            translation.sourceUrl || wc.getURL(),
            target,
          ))
      ) {
        translationService.cancelHarvestTranslationJob(tab, true).catch(() => {});
      }
    });
    wc.on('did-stop-loading', update);
    wc.on('page-title-updated', update);
    wc.on('page-favicon-updated', async (_event, urls) => {
      if (tab.kind !== 'web') return;
      tab.faviconRequest?.abort();
      const request = new AbortController();
      tab.faviconRequest = request;
      const timer = setTimeout(() => request.abort(), 8000);
      try {
        const favicon = await loadFavicon(wc.session, urls, request.signal);
        if (wc.isDestroyed() || request.signal.aborted || tab.faviconRequest !== request) return;
        tab.favicon = favicon;
        emitHarvestTs();
        historyService.rememberHistoryFavicon(wc.getURL() || tab.url, favicon).catch(() => {});
      } finally {
        clearTimeout(timer);
      }
    });
    wc.once('destroyed', () => tab.faviconRequest?.abort());
    wc.on('did-navigate', (_event, url) => {
      update();
      scheduleContinuousReader(url || wc.getURL());
    });
    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      update();
      if (isMainFrame !== false) {
        scheduleContinuousReader(url || wc.getURL());
        if (!tab.skipNextHistory)
          historyService.queueHarvestHistory(url || wc.getURL(), wc.getTitle());
      }
    });
    wc.on('did-finish-load', () => {
      if (tab.kind === 'web') wc.setZoomFactor(normalizeHarvestZoom(tab.zoomFactor || 1));
      blocksService.applyHarvestBlocks(tab).catch(() => {});
      scheduleContinuousReader(wc.getURL());
      if (tab.kind === 'web') scheduleTemporaryRestore(520);
      if (tab.skipNextHistory) tab.skipNextHistory = false;
      else historyService.queueHarvestHistory(wc.getURL() || tab.url, wc.getTitle() || tab.title);
      scheduleHarvestTabsSave();
    });
    wc.once('destroyed', () => {
      if (readerPrepareTimer) clearTimeout(readerPrepareTimer);
      readerPrepareTimer = null;
      clearTemporaryRestore();
      clearOfflineRestore();
    });
    wc.on('will-redirect', (event, url, _inPlace, isMainFrame) => {
      if (
        isMainFrame !== false &&
        tab.popupSourceUrl &&
        sessionService.harvestBrowserRuntime.adblockEnabled !== false &&
        sessionService.harvestAdUrl(url, tab.popupSourceUrl)
      ) {
        event.preventDefault();
        sessionService.recordBlockedHarvestPopup();
        closeHarvestTsTab({ id: tab.id }).catch(() => {});
      }
    });
    wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3)
        hostService.emit('harvestts-error', {
          id: tab.id,
          code,
          message: description,
          url,
        });
      update();
    });
    wc.on('zoom-changed', (_event, direction) => {
      if (tab.kind === 'web') stepHarvestZoomWheel(tab, direction === 'in' ? 1 : -1);
    });
    wc.on('before-input-event', (event, input) => {
      if (hostService.screenshotInput(event, input)) return;
      if (input.type !== 'keyDown') return;
      const key = String(input.key || '').toLowerCase();
      if (input.control && !input.alt && ['+', '=', 'add'].includes(key) && tab.kind === 'web') {
        event.preventDefault();
        stepHarvestZoom(tab, 1);
        return;
      }
      if (input.control && !input.alt && ['-', 'subtract'].includes(key) && tab.kind === 'web') {
        event.preventDefault();
        stepHarvestZoom(tab, -1);
        return;
      }
      if (input.control && !input.alt && key === '0' && tab.kind === 'web') {
        event.preventDefault();
        stepHarvestZoom(tab, 0);
        return;
      }
      if (input.control && ['l', 't', 'w'].includes(key)) {
        event.preventDefault();
        hostService.emit('harvestts-shortcut', { key });
        return;
      }
      if (input.control && key === 'r') {
        event.preventDefault();
        wc.isLoading() ? wc.stop() : wc.reload();
        return;
      }
      if (input.control && key === 'd' && tab.kind === 'web') {
        event.preventDefault();
        hostService.emit('harvestts-menu-action', { action: 'bookmark' });
        return;
      }
      if (input.control && key === 's' && tab.kind === 'web') {
        event.preventDefault();
        contextMenuService.harvestContextSavePage(tab).catch((error) =>
          hostService.emit('harvestts-error', {
            id: tab.id,
            message: error.message,
            url: wc.getURL(),
          }),
        );
        return;
      }
      if (input.control && key === 'p' && tab.kind === 'web') {
        event.preventDefault();
        wc.print({ silent: false, printBackground: true });
        return;
      }
      if (key === 'f11' && !input.control && !input.alt && !input.shift) {
        event.preventDefault();
        hostService.mainWindow.setFullScreen(!hostService.mainWindow.isFullScreen());
        return;
      }
      if (input.control && input.shift && key === 'c' && tab.kind === 'web') {
        event.preventDefault();
        if (!wc.isDevToolsOpened()) wc.openDevTools({ mode: 'detach' });
        return;
      }
      if (input.alt && key === 'arrowleft' && wc.navigationHistory?.canGoBack?.()) {
        event.preventDefault();
        wc.navigationHistory.goBack();
        return;
      }
      if (input.alt && key === 'arrowright' && wc.navigationHistory?.canGoForward?.()) {
        event.preventDefault();
        wc.navigationHistory.goForward();
      }
    });
    wc.on('context-menu', (event, params) => {
      if (tab.kind !== 'web') return;
      event.preventDefault();
      (async () => {
        const enriched = { ...params };
        if (!String(enriched.selectionText || '').trim()) {
          enriched.selectionText = await wc
            .executeJavaScript('String(getSelection()?.toString?.()||"")')
            .catch(() => '');
        }
        await contextMenuService.showHarvestContextMenu(tab, enriched);
      })().catch(() => {});
    });
    wc.setWindowOpenHandler(({ url }) => {
      try {
        const explicit =
          tab.popupIntent &&
          Date.now() - tab.popupIntent.at < 1500 &&
          new URL(url).href === tab.popupIntent.url;
        if (
          sessionService.harvestBrowserRuntime.adblockEnabled !== false &&
          (!explicit || sessionService.harvestAdUrl(url, wc.getURL()))
        ) {
          sessionService.recordBlockedHarvestPopup();
          return { action: 'deny' };
        }
        tab.popupIntent = null;
        createHarvestTsTab({ url, activate: true, popupSourceUrl: wc.getURL() });
      } catch {}
      return { action: 'deny' };
    });
  }

  function createHarvestTsTab(input = {}) {
    const id = `harvest-${++harvestTsCounter}`;
    const kind = ['history', 'downloads', 'offline', 'offline-reader'].includes(input.kind)
      ? input.kind
      : 'web';
    const internalFile =
      kind === 'history'
        ? 'history.html'
        : kind === 'downloads'
          ? 'downloads.html'
          : kind === 'offline'
            ? 'offline.html'
            : kind === 'offline-reader'
              ? 'offline-reader.html'
              : '';
    let projectId = String(input.projectId || '');
    if (!projectId && kind === 'offline-reader' && input.url) {
      try {
        projectId = new URL(input.url).searchParams.get('id') || '';
      } catch {}
    }
    const internalBase = internalFile ? pathToFileURL(path.join(sourceDir, internalFile)).href : '';
    const url = internalFile
      ? kind === 'offline-reader'
        ? internalBase + '?id=' + encodeURIComponent(projectId)
        : internalBase
      : normalizeHarvestTsURL(input.url || 'https://www.google.com/');
    const internal = kind !== 'web';
    const view = new BrowserView({
      webPreferences: {
        partition: internal ? 'harvest-internal' : 'persist:harvestts',
        preload: internal
          ? path.join(sourceDir, 'harvest-internal-preload.cjs')
          : path.join(sourceDir, 'harvest-guest-preload.cjs'),
        nodeIntegration: false,
        nodeIntegrationInSubFrames: !internal,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
      },
    });
    const zoomFactor = normalizeHarvestZoom(input.zoomFactor),
      restoreEntries =
        kind === 'web' && Array.isArray(input.navigationHistory)
          ? input.navigationHistory
              .filter((e) => e && /^https?:\/\//i.test(e.url || ''))
              .slice(0, 120)
              .map((e) => ({
                url: String(e.url),
                title: String(e.title || e.url),
              }))
          : [];
    const restoreIndex = Math.max(
      0,
      Math.min(Math.max(0, restoreEntries.length - 1), Number(input.navigationIndex) || 0),
    );
    const tab = {
      id,
      kind,
      view,
      url,
      projectId,
      zoomFactor,
      popupSourceUrl: input.popupSourceUrl || null,
      title:
        kind === 'history'
          ? 'History'
          : kind === 'downloads'
            ? 'Downloads'
            : kind === 'offline'
              ? 'Offline'
              : kind === 'offline-reader'
                ? 'Offline Reader'
                : 'แท็บใหม่',
      skipNextHistory: input.restored === true,
    };
    if (kind === 'web') {
      tab.imageStore = new ElectronImageStore(
        view.webContents,
        path.join(
          app.getPath('temp'),
          'ImageHarvest',
          `harvestts-responses-${process.pid}-${id}-${Date.now()}`,
        ),
      );
      tab.imageStoreReady = Promise.resolve(false);
    }
    harvestTsTabs.set(id, tab);
    bindHarvestTs(tab);
    if (kind === 'web') {
      view.webContents.setZoomMode('manual');
      view.webContents.setZoomFactor(zoomFactor);
    }
    if (input.activate !== false || !activeHarvestTsId) activeHarvestTsId = id;
    const navigation = view.webContents.navigationHistory;
    const removeBootstrapHistory = () => {
      try {
        const entries = navigation?.getAllEntries?.() || [];
        for (let i = entries.length - 1; i >= 0; i--)
          if (entries[i]?.url === 'about:blank') navigation.removeEntryAtIndex(i);
      } catch {}
    };
    const loadTarget = async () => {
      if (restoreEntries.length && navigation?.restore) {
        // navigationHistory.restore must run on a fresh WebContents; navigating
        // to a bootstrap page first collapses the restored stack to one entry.
        await navigation.restore({
          entries: restoreEntries,
          index: restoreIndex,
        });
        return;
      }
      if (kind === 'web' && tab.imageStore) {
        await view.webContents.loadURL('about:blank');
        await Promise.resolve(tab.imageStoreReady).catch(() => false);
      }
      await view.webContents.loadURL(url);
      removeBootstrapHistory();
    };
    tab.bootstrapReady = loadTarget().catch((error) => {
      hostService.emit('harvestts-error', {
        id,
        message:
          (restoreEntries.length ? 'กู้ประวัติแท็บไม่ได้: ' : '') +
          (error.message || String(error)),
        url,
      });
      if (restoreEntries.length)
        return view.webContents
          .loadURL(url)
          .then(removeBootstrapHistory)
          .catch(() => {});
    });
    applyHarvestTsView();
    if (input.skipEmit !== true) emitHarvestTs();
    if (input.skipSave !== true) scheduleHarvestTabsSave();
    return harvestTsSnapshot();
  }

  async function switchHarvestTsTab(input = {}) {
    const id = String(input.id || '');
    if (!harvestTsTabs.has(id)) throw new Error('ไม่พบแท็บ HarvestTS');
    if (
      blockManagerService.harvestBlockManagerKind === 'harvestts' &&
      blockManagerService.harvestBlockManagerTabId &&
      blockManagerService.harvestBlockManagerTabId !== id
    )
      await blockManagerService.cancelHarvestBlockManagerDraft();
    activeHarvestTsId = id;
    applyHarvestTsView();
    emitHarvestTs();
    scheduleHarvestTabsSave();
    return harvestTsSnapshot();
  }

  async function closeHarvestTsTab(input = {}) {
    const id = String(input.id || '');
    const tab = harvestTsTabs.get(id);
    if (!tab) return harvestTsSnapshot();
    if (
      blockManagerService.harvestBlockManagerKind === 'harvestts' &&
      blockManagerService.harvestBlockManagerTabId === id
    )
      await blockManagerService.cancelHarvestBlockManagerDraft();
    const ids = [...harvestTsTabs.keys()],
      index = ids.indexOf(id);
    await translationService.cancelHarvestTranslationJob(tab, true).catch(() => {});
    await translationService.stopHarvestScreenLens(tab).catch(() => {});
    await tab.imageStore?.close().catch(() => {});
    harvestTsTabs.delete(id);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    if (activeHarvestTsId === id) {
      activeHarvestTsId =
        ids[index + 1] && harvestTsTabs.has(ids[index + 1])
          ? ids[index + 1]
          : ids[Math.max(0, index - 1)] || null;
    }
    if (!activeHarvestTsId && !harvestTsTabs.size) {
      const result = createHarvestTsTab();
      scheduleHarvestTabsSave();
      return result;
    }
    applyHarvestTsView();
    emitHarvestTs();
    scheduleHarvestTabsSave();
    return harvestTsSnapshot();
  }

  async function navigateHarvestTs(input = {}) {
    const tab = harvestTsTabs.get(String(input.id || activeHarvestTsId));
    if (!tab) throw new Error('ไม่พบแท็บ HarvestTS');
    if (
      blockManagerService.harvestBlockManagerKind === 'harvestts' &&
      blockManagerService.harvestBlockManagerTabId === tab.id
    )
      await blockManagerService.cancelHarvestBlockManagerDraft();
    const url = normalizeHarvestTsURL(input.url);
    tab.url = url;
    tab.view.webContents.loadURL(url).catch((error) =>
      hostService.emit('harvestts-error', {
        id: tab.id,
        message: error.message,
        url,
      }),
    );
    scheduleHarvestTabsSave();
    return harvestTsSnapshot();
  }

  async function harvestTsAction(input = {}) {
    const tab = harvestTsTabs.get(String(input.id || activeHarvestTsId));
    if (!tab) throw new Error('ไม่พบแท็บ HarvestTS');
    if (
      blockManagerService.harvestBlockManagerKind === 'harvestts' &&
      blockManagerService.harvestBlockManagerTabId === tab.id &&
      ['back', 'forward', 'reload', 'home'].includes(input.action)
    )
      await blockManagerService.cancelHarvestBlockManagerDraft();
    const wc = tab.view.webContents,
      nav = wc.navigationHistory;
    if (input.action === 'back' && (tab.kind === 'web' ? nav?.canGoBack?.() : wc.canGoBack()))
      (tab.kind === 'web' ? nav : wc).goBack();
    else if (
      input.action === 'forward' &&
      (tab.kind === 'web' ? nav?.canGoForward?.() : wc.canGoForward())
    )
      (tab.kind === 'web' ? nav : wc).goForward();
    else if (input.action === 'reload') wc.isLoading() ? wc.stop() : wc.reload();
    else if (input.action === 'home') wc.loadURL('https://www.google.com/').catch(() => {});
    else if (input.action === 'zoom-in') stepHarvestZoom(tab, 1);
    else if (input.action === 'zoom-out') stepHarvestZoom(tab, -1);
    else if (input.action === 'zoom-reset') stepHarvestZoom(tab, 0);
    emitHarvestTs();
    scheduleHarvestTabsSave();
    return harvestTsSnapshot();
  }

  async function harvestTsLayout(input = {}) {
    if (input.bounds) harvestTsBounds = sanitizeHarvestTsBounds(input.bounds);
    if (typeof input.visible === 'boolean') harvestTsVisible = input.visible;
    if (harvestTsVisible && !harvestTsTabs.size) await restoreHarvestTabsIfNeeded();
    applyHarvestTsView();
    if (harvestTsVisible && !harvestTsTabs.size) return createHarvestTsTab();
    return harvestTsSnapshot();
  }

  async function harvestTsOpenHistory() {
    const existing = [...harvestTsTabs.values()].find(
      (tab) => tab.kind === 'history' && !tab.view.webContents.isDestroyed(),
    );
    if (existing) return switchHarvestTsTab({ id: existing.id });
    return createHarvestTsTab({ kind: 'history', activate: true });
  }

  async function harvestTsOpenDownloads() {
    const existing = [...harvestTsTabs.values()].find(
      (tab) => tab.kind === 'downloads' && !tab.view.webContents.isDestroyed(),
    );
    if (existing) return switchHarvestTsTab({ id: existing.id });
    return createHarvestTsTab({ kind: 'downloads', activate: true });
  }

  async function harvestTsOpenOffline() {
    const existing = [...harvestTsTabs.values()].find(
      (tab) => tab.kind === 'offline' && !tab.view.webContents.isDestroyed(),
    );
    if (existing) return switchHarvestTsTab({ id: existing.id });
    return createHarvestTsTab({ kind: 'offline', activate: true });
  }

  async function harvestTsOpenOfflineReader(id) {
    const saved = await offlineLibraryService.harvestOfflineReadProject(String(id || ''));
    const existing = [...harvestTsTabs.values()].find(
      (tab) =>
        tab.kind === 'offline-reader' &&
        tab.projectId === saved.project.id &&
        !tab.view.webContents.isDestroyed(),
    );
    if (existing) return switchHarvestTsTab({ id: existing.id });
    return createHarvestTsTab({
      kind: 'offline-reader',
      projectId: saved.project.id,
      activate: true,
    });
  }

  function harvestTsPopupMenu(input = {}) {
    if (!hostService.mainWindow || hostService.mainWindow.isDestroyed())
      throw new Error('หน้าต่างหลักไม่พร้อม');
    const tab = activeHarvestTsTab();
    const menu = Menu.buildFromTemplate([
      {
        label: '↶ History',
        click: () => {
          harvestTsOpenHistory().catch(() => {});
        },
      },
      {
        label: '↓ Downloads',
        click: () => {
          harvestTsOpenDownloads().catch(() => {});
        },
      },
      {
        label: '▣ Offline Library',
        click: () => {
          harvestTsOpenOffline().catch(() => {});
        },
      },
      {
        label: '▤ Save Offline',
        enabled: Boolean(tab && tab.kind === 'web'),
        click: () => {
          offlineLibraryService
            .harvestOfflineSave(tab)
            .then((row) =>
              hostService.emit('harvestts-offline-saved', {
                tabId: tab.id,
                title: row.title,
                pages: row.pages,
              }),
            )
            .catch((error) =>
              hostService.emit('harvestts-error', {
                id: tab?.id,
                message: error.message,
                url: tab?.view?.webContents?.getURL?.() || '',
              }),
            );
        },
      },
      {
        label: '☆ Bookmark',
        enabled: Boolean(tab),
        click: () => hostService.emit('harvestts-menu-action', { action: 'bookmark' }),
      },
      {
        label: '⌘ Password',
        enabled: Boolean(tab),
        click: () => hostService.emit('harvestts-menu-action', { action: 'password' }),
      },
      {
        label: '▱ Block element',
        enabled: Boolean(tab),
        click: () =>
          hostService.emit('harvestts-menu-action', {
            action: 'block-element',
          }),
      },
      { type: 'separator' },
      {
        label: `Zoom ${Math.round(normalizeHarvestZoom(tab?.zoomFactor || 1) * 100)}%`,
        enabled: Boolean(tab && tab.kind === 'web'),
        submenu: [
          {
            label: '− Zoom out',
            accelerator: 'CmdOrCtrl+-',
            click: () => stepHarvestZoom(tab, -1),
          },
          {
            label: '100% Reset zoom',
            accelerator: 'CmdOrCtrl+0',
            click: () => stepHarvestZoom(tab, 0),
          },
          {
            label: '+ Zoom in',
            accelerator: 'CmdOrCtrl+=',
            click: () => stepHarvestZoom(tab, 1),
          },
        ],
      },
      { type: 'separator' },
      {
        label: 'บันทึกประวัติการเข้าเว็บ',
        type: 'checkbox',
        checked: sessionService.harvestBrowserRuntime.historyEnabled !== false,
        click: (item) => {
          historyService
            .harvestTsBrowserSettingsSet({ historyEnabled: item.checked })
            .catch(() => {});
        },
      },
      {
        label: 'เปิดแท็บเดิมเมื่อเปิดแอป',
        type: 'checkbox',
        checked: sessionService.harvestBrowserRuntime.restoreTabs !== false,
        click: (item) => {
          historyService.harvestTsBrowserSettingsSet({ restoreTabs: item.checked }).catch(() => {});
        },
      },
      { type: 'separator' },
      {
        label: '🧩 Extensions',
        click: () => hostService.emit('harvestts-menu-action', { action: 'extensions' }),
      },
      {
        label: '◉ DNS & Privacy',
        click: () => hostService.emit('harvestts-menu-action', { action: 'dns' }),
      },
    ]);
    const area = hostService.mainWindow.getContentBounds();
    const x = Math.max(
      0,
      Math.min(area.width - 20, Math.round(Number(input.x) || area.width - 220)),
    );
    const y = Math.max(0, Math.min(area.height - 20, Math.round(Number(input.y) || 90)));
    menu.popup({ window: hostService.mainWindow, x, y });
    if (hostService.testMode && Number(input.autoCloseMs) > 0)
      setTimeout(
        () => menu.closePopup(hostService.mainWindow),
        Math.min(2000, Number(input.autoCloseMs)),
      );
    return true;
  }
  return {
    get harvestTsTabs() {
      return harvestTsTabs;
    },
    get activeHarvestTsId() {
      return activeHarvestTsId;
    },
    get harvestTsBounds() {
      return harvestTsBounds;
    },
    stepHarvestZoom,
    stepHarvestZoomWheel,
    saveHarvestTabsSync,
    activeHarvestTsTab,
    harvestTsPageInfo,
    harvestGuestTab,
    harvestTsState,
    harvestTsSnapshot,
    normalizeHarvestTsURL,
    createHarvestTsTab,
    switchHarvestTsTab,
    closeHarvestTsTab,
    navigateHarvestTs,
    harvestTsAction,
    harvestTsLayout,
    harvestTsOpenHistory,
    harvestTsOpenDownloads,
    harvestTsOpenOfflineReader,
    harvestTsPopupMenu,
  };
}
module.exports = { createTabs };
