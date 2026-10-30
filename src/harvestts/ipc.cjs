'use strict';
const { ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const sourceDir = require('node:path').resolve(__dirname, '..');

function createIpc({
  collectorBlocks: collectorBlocksService,
  blockManager: blockManagerService,
  blocks: blocksService,
  contextMenu: contextMenuService,
  credentials: credentialsService,
  downloads: downloadsService,
  history: historyService,
  ocrLab: ocrLabService,
  offlineLibrary: offlineLibraryService,
  offlineReader: offlineReaderService,
  tabs: tabsService,
  translation: translationService,
  host: hostService,
}) {
  function registerHarvestGuestIpc() {
    ipcMain.removeAllListeners('harvest-guest:password-focus');
    ipcMain.removeAllListeners('harvest-guest:password-submit');
    ipcMain.removeHandler('harvest-guest:choose-account');
    ipcMain.removeHandler('harvest-guest:region-style-save');
    ipcMain.handle('harvest-guest:region-style-save', async (event, input = {}) => {
      const tab = tabsService.harvestGuestTab(event);
      if (event.senderFrame && event.senderFrame !== event.sender.mainFrame)
        throw Error('ไม่อนุญาตเฟรมย่อย');
      const scope = translationService.harvestRegionStyleSources.get(tab.id)?.get(input.pageId),
        styleKey = scope?.regions.get(input.regionId);
      if (
        !scope ||
        !styleKey ||
        scope.imageDigest !== input.imageDigest ||
        !translationService.sameHarvestTranslationPage(
          scope.documentUrl,
          tab.view.webContents.getURL(),
        )
      )
        throw Error('ภาพหรือหน้าเว็บเปลี่ยนแล้ว กรุณาเลือกกล่องใหม่');
      const saved = await translationService.regionStyles().set(styleKey, input.style);
      await offlineLibraryService
        .harvestOfflineUpdateStyle(scope.documentUrl, input.pageId, input.regionId, saved)
        .catch(() => {});
      return saved;
    });
    ipcMain.removeHandler('harvest-guest:zoom-factor');
    ipcMain.handle('harvest-guest:zoom-factor', (event) => {
      const tab = tabsService.harvestGuestTab(event);
      return tab.view.webContents.getZoomFactor();
    });
    ipcMain.removeHandler('harvest-guest:zoom');
    ipcMain.removeAllListeners('harvest-guest:link-intent');
    ipcMain.on('harvest-guest:link-intent', (event, input = {}) => {
      try {
        const tab = tabsService.harvestGuestTab(event);
        if (typeof input.url !== 'string' || input.url.length > 8192) return;
        const url = new URL(input.url);
        if (!['http:', 'https:'].includes(url.protocol)) return;
        tab.popupIntent = { url: url.href, at: Date.now() };
      } catch {}
    });
    ipcMain.handle('harvest-guest:zoom', (event, input = {}) => {
      const tab = tabsService.harvestGuestTab(event),
        direction = Math.sign(Number(input.direction) || 0);
      if (input.wheel) tabsService.stepHarvestZoomWheel(tab, direction);
      else tabsService.stepHarvestZoom(tab, direction);
      return tabsService.harvestTsState(tab);
    });
    ipcMain.removeHandler('harvest-guest:translation-start');
    ipcMain.removeHandler('harvest-guest:translation-retry');
    ipcMain.handle('harvest-guest:translation-retry', async (event) =>
      translationService.retryHarvestTsTranslation(tabsService.harvestGuestTab(event)),
    );
    ipcMain.removeHandler('harvest-guest:translation-cancel');
    ipcMain.removeHandler('harvest-guest:translate-settings-get');
    ipcMain.removeHandler('harvest-guest:translate-settings-update');
    ipcMain.removeHandler('harvest-guest:translate-symbol');
    ipcMain.removeHandler('harvest-guest:screen-lens-status');
    ipcMain.removeHandler('harvest-guest:screen-lens-toggle');
    ipcMain.removeHandler('harvest-guest:ocr-lab');
    ipcMain.handle('harvest-guest:ocr-lab', async (event) => {
      tabsService.harvestGuestTab(event);
      return ocrLabService.ocrLab.open();
    });
    ipcMain.on('harvest-guest:password-focus', (event, input = {}) => {
      let tab;
      try {
        tab = tabsService.harvestGuestTab(event);
      } catch {
        return;
      }
      const origin = String(input.origin || '');
      if (!/^https?:\/\//i.test(origin)) return;
      credentialsService
        .harvestPasswordAccountsForOrigin(origin)
        .then((accounts) => {
          if (event.sender.isDestroyed()) return;
          event.sender.send('harvest-guest:account-suggestions', {
            origin,
            accounts: accounts.map((x) => ({
              id: x.id,
              username: x.username,
              updatedAt: x.updatedAt,
            })),
          });
        })
        .catch(() => {});
      credentialsService.emitHarvestPasswordHint(tab, origin).catch(() => {});
    });
    ipcMain.handle('harvest-guest:choose-account', async (event, input = {}) => {
      const tab = tabsService.harvestGuestTab(event);
      const credentialId = String(input.credentialId || '');
      if (!credentialId) throw new Error('ไม่พบบัญชีที่เลือก');
      return credentialsService.fillHarvestCredentialById(tab, credentialId);
    });
    ipcMain.handle('harvest-guest:translation-start', async (event) => {
      const tab = tabsService.harvestGuestTab(event);
      return translationService.runHarvestTsTranslationJob(tab);
    });
    ipcMain.handle('harvest-guest:translation-cancel', async (event) => {
      const tab = tabsService.harvestGuestTab(event);
      return translationService.cancelHarvestTranslationJob(tab, false);
    });
    ipcMain.handle('harvest-guest:translate-settings-get', async (event) => {
      tabsService.harvestGuestTab(event);
      return translationService.harvestTsTranslateSettings();
    });
    ipcMain.handle('harvest-guest:translate-settings-update', async (event, input = {}) => {
      const tab = tabsService.harvestGuestTab(event),
        settings = await translationService.updateHarvestTsTranslateSettings(input);
      await tab.view.webContents
        .executeJavaScript(
          `(() => {const overlay=window.__harvestTsTranslationOverlay;if(!overlay)return;overlay.settings(${JSON.stringify({ fontScale: settings.fontScale })});overlay.setVisible(${JSON.stringify(!settings.showOriginal)});})()`,
        )
        .catch(() => {});
      return settings;
    });
    ipcMain.handle('harvest-guest:translate-symbol', async (event) => {
      tabsService.harvestGuestTab(event);
      try {
        const bytes = await fs.readFile(
          path.join(sourceDir, '..', 'assets', 'translate-symbol.png'),
        );
        return 'data:image/png;base64,' + bytes.toString('base64');
      } catch {
        return '';
      }
    });
    ipcMain.handle('harvest-guest:screen-lens-status', async (event) => {
      const tab = tabsService.harvestGuestTab(event);
      return translationService.harvestScreenLensSnapshot(tab);
    });
    ipcMain.handle('harvest-guest:screen-lens-toggle', async (event, input = {}) => {
      const tab = tabsService.harvestGuestTab(event);
      const current = translationService.harvestScreenLensSnapshot(tab);
      const enabled = typeof input.enabled === 'boolean' ? input.enabled : !current.enabled;
      return enabled
        ? translationService.startHarvestScreenLens(tab)
        : translationService.stopHarvestScreenLens(tab);
    });
    ipcMain.on('harvest-guest:password-submit', (event, input = {}) => {
      let tab;
      try {
        tab = tabsService.harvestGuestTab(event);
      } catch {
        return;
      }
      const origin = String(input.origin || ''),
        url = String(input.url || ''),
        password = String(input.password || ''),
        username = String(input.username || '');
      if (
        !/^https?:\/\//i.test(origin) ||
        !/^https?:\/\//i.test(url) ||
        !password ||
        password.length > 4096 ||
        username.length > 512
      )
        return;
      tab.passwordCandidate = {
        origin,
        url,
        username,
        password,
        createdAt: Date.now(),
      };
      credentialsService.emitHarvestPasswordHint(tab, origin).catch(() => {});
    });
  }

  function harvestInternalSender(event, kind = 'history') {
    const tab = [...tabsService.harvestTsTabs.values()].find(
      (row) =>
        row.kind === kind &&
        !row.view.webContents.isDestroyed() &&
        row.view.webContents === event.sender,
    );
    const files = {
        history: 'history.html',
        downloads: 'downloads.html',
        offline: 'offline.html',
        'offline-reader': 'offline-reader.html',
      },
      file = files[kind] || files.history;
    const expected = pathToFileURL(path.join(sourceDir, file)).href;
    const actual = String(event.senderFrame?.url || '').split(/[?#]/)[0];
    if (!tab || actual !== expected) throw new Error('Unauthorized HarvestTS internal IPC');
    return tab;
  }

  function registerHarvestInternalIpc() {
    const channels = [
      'history-list',
      'history-favicons',
      'history-remove',
      'history-clear',
      'browser-settings',
      'history-set-enabled',
      'open-url',
      'downloads-list',
      'downloads-remove',
      'downloads-clear',
      'downloads-open',
      'downloads-show',
      'downloads-cancel',
      'offline-list',
      'offline-remove',
      'offline-open',
      'offline-open-source',
      'offline-project',
      'offline-image',
      'offline-cover',
      'offline-group-create',
      'offline-group-rename',
      'offline-group-remove',
      'offline-library-reorder',
      'offline-library-project-create',
      'offline-library-project-rename',
      'offline-library-project-group',
      'offline-item-project',
      'offline-export-start',
      'offline-export-page',
      'offline-export-finish',
    ];
    for (const name of channels) ipcMain.removeHandler(`harvest-internal:${name}`);
    ipcMain.handle('harvest-internal:history-list', async (event, input = {}) => {
      harvestInternalSender(event, 'history');
      return historyService.harvestTsHistoryList(input);
    });
    ipcMain.handle('harvest-internal:history-favicons', async (event, input = {}) => {
      harvestInternalSender(event, 'history');
      return historyService.harvestTsHistoryFavicons(input);
    });
    ipcMain.handle('harvest-internal:history-remove', async (event, input = {}) => {
      harvestInternalSender(event, 'history');
      return historyService.harvestTsHistoryRemove(input);
    });
    ipcMain.handle('harvest-internal:history-clear', async (event) => {
      harvestInternalSender(event, 'history');
      return historyService.harvestTsHistoryClear();
    });
    ipcMain.handle('harvest-internal:browser-settings', async (event) => {
      harvestInternalSender(event, 'history');
      return historyService.harvestTsBrowserSettings();
    });
    ipcMain.handle('harvest-internal:history-set-enabled', async (event, input = {}) => {
      harvestInternalSender(event, 'history');
      return historyService.harvestTsBrowserSettingsSet({
        historyEnabled: Boolean(input.enabled),
      });
    });
    ipcMain.handle('harvest-internal:open-url', async (event, input = {}) => {
      harvestInternalSender(event, 'history');
      return tabsService.createHarvestTsTab({
        url: tabsService.normalizeHarvestTsURL(input.url),
        activate: true,
      });
    });
    ipcMain.handle('harvest-internal:downloads-list', async (event) => {
      harvestInternalSender(event, 'downloads');
      return downloadsService.harvestTsDownloadList();
    });
    ipcMain.handle('harvest-internal:downloads-remove', async (event, input = {}) => {
      harvestInternalSender(event, 'downloads');
      return downloadsService.harvestTsDownloadRemove(input);
    });
    ipcMain.handle('harvest-internal:downloads-clear', async (event) => {
      harvestInternalSender(event, 'downloads');
      return downloadsService.harvestTsDownloadClear();
    });
    ipcMain.handle('harvest-internal:downloads-open', async (event, input = {}) => {
      harvestInternalSender(event, 'downloads');
      return downloadsService.harvestTsDownloadOpen(input);
    });
    ipcMain.handle('harvest-internal:downloads-show', async (event, input = {}) => {
      harvestInternalSender(event, 'downloads');
      return downloadsService.harvestTsDownloadShow(input);
    });
    ipcMain.handle('harvest-internal:downloads-cancel', async (event, input = {}) => {
      harvestInternalSender(event, 'downloads');
      return downloadsService.harvestTsDownloadCancel(input);
    });
    ipcMain.handle('harvest-internal:offline-list', async (event) => {
      harvestInternalSender(event, 'offline');
      return offlineLibraryService.harvestOfflineList();
    });
    ipcMain.handle('harvest-internal:offline-cover', async (event, input = {}) => {
      harvestInternalSender(event, 'offline');
      return offlineLibraryService.harvestOfflineCover(input.id);
    });
    ipcMain.handle('harvest-internal:offline-group-create', async (event, input = {}) => {
      harvestInternalSender(event, 'offline');
      return offlineLibraryService.harvestOfflineGroupCreate(input);
    });
    ipcMain.handle('harvest-internal:offline-group-rename', async (event, input = {}) => {
      harvestInternalSender(event, 'offline');
      return offlineLibraryService.harvestOfflineGroupRename(input);
    });
    ipcMain.handle('harvest-internal:offline-group-remove', async (event, input = {}) => {
      harvestInternalSender(event, 'offline');
      return offlineLibraryService.harvestOfflineGroupRemove(input);
    });
    ipcMain.handle('harvest-internal:offline-library-reorder', async (event, input = {}) => {
      harvestInternalSender(event, 'offline');
      return offlineLibraryService.harvestOfflineLibraryReorder(input);
    });
    ipcMain.handle('harvest-internal:offline-library-project-create', async (event, input = {}) => {
      harvestInternalSender(event, 'offline');
      return offlineLibraryService.harvestOfflineLibraryProjectCreate(input);
    });
    ipcMain.handle('harvest-internal:offline-library-project-rename', async (event, input = {}) => {
      harvestInternalSender(event, 'offline');
      return offlineLibraryService.harvestOfflineLibraryProjectRename(input);
    });
    ipcMain.handle('harvest-internal:offline-library-project-group', async (event, input = {}) => {
      harvestInternalSender(event, 'offline');
      return offlineLibraryService.harvestOfflineLibraryProjectGroup(input);
    });
    ipcMain.handle('harvest-internal:offline-item-project', async (event, input = {}) => {
      harvestInternalSender(event, 'offline');
      return offlineLibraryService.harvestOfflineItemProject(input);
    });
    ipcMain.handle('harvest-internal:offline-remove', async (event, input = {}) => {
      harvestInternalSender(event, 'offline');
      return offlineLibraryService.harvestOfflineRemove(input.id);
    });
    ipcMain.handle('harvest-internal:offline-open', async (event, input = {}) => {
      harvestInternalSender(event, 'offline');
      return tabsService.harvestTsOpenOfflineReader(input.id);
    });
    ipcMain.handle('harvest-internal:offline-open-source', async (event, input = {}) => {
      harvestInternalSender(event, 'offline');
      const saved = await offlineLibraryService.harvestOfflineReadProject(String(input.id || ''));
      return tabsService.createHarvestTsTab({
        url: saved.project.url,
        activate: true,
      });
    });
    ipcMain.handle('harvest-internal:offline-project', async (event, input = {}) => {
      const tab = harvestInternalSender(event, 'offline-reader');
      return offlineReaderService.harvestOfflineProjectData(
        String(input.id || tab.projectId || ''),
      );
    });
    ipcMain.handle('harvest-internal:offline-image', async (event, input = {}) => {
      const tab = harvestInternalSender(event, 'offline-reader'),
        projectId = String(input.id || tab.projectId || ''),
        file = String(input.file || '');
      if (path.basename(file) !== file) throw Error('ชื่อไฟล์ Offline ไม่ถูกต้อง');
      const saved = await offlineLibraryService.harvestOfflineReadProject(projectId),
        page = saved.manifest.pages.find((p) => p.file === file && !p.error);
      if (!page) throw Error('ไม่พบภาพ Offline');
      const bytes = await fs.readFile(path.join(saved.dir, file));
      return {
        mime: page.mime || 'application/octet-stream',
        bytes: new Uint8Array(bytes),
      };
    });
    ipcMain.handle('harvest-internal:offline-export-start', async (event, input = {}) => {
      const tab = harvestInternalSender(event, 'offline-reader');
      return offlineReaderService.harvestOfflineExportStart(tab, input);
    });
    ipcMain.handle('harvest-internal:offline-export-page', async (event, input = {}) => {
      const tab = harvestInternalSender(event, 'offline-reader');
      return offlineReaderService.harvestOfflineExportPage(tab, input);
    });
    ipcMain.handle('harvest-internal:offline-export-finish', async (event, input = {}) => {
      const tab = harvestInternalSender(event, 'offline-reader');
      return offlineReaderService.harvestOfflineExportFinish(tab, input);
    });
  }

  function registerHarvestBlockManagerIpc() {
    const channels = [
      'state',
      'clear-draft',
      'commit',
      'cancel',
      'remove',
      'clear-saved',
      'collapse',
      'close',
    ];
    for (const name of channels) ipcMain.removeHandler(`harvest-block:${name}`);
    const isCollector = () => blockManagerService.harvestBlockManagerKind === 'collector';
    const eventType = () =>
      isCollector() ? 'collector-block-finished' : 'harvestts-block-finished';

    ipcMain.handle('harvest-block:state', async (event) => {
      blockManagerService.harvestBlockManagerSender(event);
      if (isCollector()) return collectorBlocksService.collectorBlockDraftState();
      if (!blockManagerService.harvestBlockManagerTabId)
        return {
          active: false,
          cancelled: false,
          selectors: [],
          saved: [],
          count: 0,
          origin: '',
        };
      return blocksService.harvestTsBlockDraftState({
        id: blockManagerService.harvestBlockManagerTabId,
      });
    });
    ipcMain.handle('harvest-block:clear-draft', async (event) => {
      blockManagerService.harvestBlockManagerSender(event);
      return isCollector()
        ? collectorBlocksService.collectorBlockDraftClear()
        : blocksService.harvestTsBlockDraftClear({
            id: blockManagerService.harvestBlockManagerTabId,
          });
    });
    ipcMain.handle('harvest-block:commit', async (event) => {
      blockManagerService.harvestBlockManagerSender(event);
      const kind = blockManagerService.harvestBlockManagerKind,
        id = blockManagerService.harvestBlockManagerTabId;
      const result =
        kind === 'collector'
          ? await collectorBlocksService.collectorBlockDraftCommit()
          : await blocksService.harvestTsBlockDraftCommit({ id });
      const next =
        kind === 'collector'
          ? await collectorBlocksService.collectorBlockDraftBegin({
              showManager: false,
            })
          : await blocksService.harvestTsBlockDraftBegin({
              id,
              showManager: false,
            });
      hostService.emit(
        kind === 'collector' ? 'collector-block-finished' : 'harvestts-block-finished',
        { cancelled: false, keptOpen: true, ...result },
      );
      return { ...result, keptOpen: true, next };
    });
    ipcMain.handle('harvest-block:cancel', async (event) => {
      blockManagerService.harvestBlockManagerSender(event);
      const kind = blockManagerService.harvestBlockManagerKind,
        id = blockManagerService.harvestBlockManagerTabId;
      const result =
        kind === 'collector'
          ? await collectorBlocksService.collectorBlockDraftCancel()
          : await blocksService.harvestTsBlockDraftCancel({ id });
      await blockManagerService.closeHarvestBlockManagerWindow();
      hostService.emit(
        kind === 'collector' ? 'collector-block-finished' : 'harvestts-block-finished',
        { cancelled: true },
      );
      return result;
    });
    ipcMain.handle('harvest-block:remove', async (event, input = {}) => {
      blockManagerService.harvestBlockManagerSender(event);
      return isCollector()
        ? collectorBlocksService.collectorBlockRemove({
            selector: input.selector,
          })
        : blocksService.harvestTsBlockRemove({
            id: blockManagerService.harvestBlockManagerTabId,
            selector: input.selector,
          });
    });
    ipcMain.handle('harvest-block:clear-saved', async (event) => {
      blockManagerService.harvestBlockManagerSender(event);
      return isCollector()
        ? collectorBlocksService.collectorBlockClear()
        : blocksService.harvestTsBlockClear({
            id: blockManagerService.harvestBlockManagerTabId,
          });
    });
    ipcMain.handle('harvest-block:collapse', async (event, input = {}) => {
      blockManagerService.harvestBlockManagerSender(event);
      return blockManagerService.setHarvestBlockManagerCollapsed(input.collapsed);
    });
    ipcMain.handle('harvest-block:close', async (event) => {
      blockManagerService.harvestBlockManagerSender(event);
      const kind = blockManagerService.harvestBlockManagerKind,
        id = blockManagerService.harvestBlockManagerTabId;
      if (kind === 'collector')
        await collectorBlocksService.collectorBlockDraftCancel().catch(() => {});
      else if (id) await blocksService.harvestTsBlockDraftCancel({ id }).catch(() => {});
      await blockManagerService.closeHarvestBlockManagerWindow();
      hostService.emit(
        kind === 'collector' ? 'collector-block-finished' : 'harvestts-block-finished',
        { cancelled: true },
      );
      return true;
    });
  }

  function registerHarvestContextMenuIpc() {
    for (const name of ['model', 'action', 'close'])
      ipcMain.removeHandler('harvest-context:' + name);
    ipcMain.handle('harvest-context:model', (event) => {
      contextMenuService.harvestContextSender(event);
      return contextMenuService.harvestContextMenuModel || { items: [] };
    });
    ipcMain.handle('harvest-context:action', async (event, input = {}) => {
      contextMenuService.harvestContextSender(event);
      const id = String(input.id || ''),
        target = contextMenuService.harvestContextMenuTarget
          ? { ...contextMenuService.harvestContextMenuTarget }
          : null;
      const tab = target && tabsService.harvestTsTabs.get(target.tabId);
      if (!tab) throw new Error('แท็บต้นทางปิดไปแล้ว');
      // Keep the target while the action runs, then close the custom menu.
      try {
        return {
          ok: true,
          result: await contextMenuService.executeHarvestContextAction(id),
        };
      } finally {
        await contextMenuService.closeHarvestContextMenu();
      }
    });
    ipcMain.handle('harvest-context:close', async (event) => {
      contextMenuService.harvestContextSender(event);
      await contextMenuService.closeHarvestContextMenu();
      return true;
    });
  }
  return {
    registerHarvestGuestIpc,
    registerHarvestInternalIpc,
    registerHarvestBlockManagerIpc,
    registerHarvestContextMenuIpc,
  };
}
module.exports = { createIpc };
