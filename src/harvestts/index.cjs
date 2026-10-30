'use strict';
const fs = require('node:fs/promises');
function createHarvestTS(features) {
  async function initialize() {
    await fs
      .rm(features.translation.harvestTranslationTempRoot, {
        recursive: true,
        force: true,
      })
      .catch(() => {});
    await fs.mkdir(features.translation.harvestTranslationTempRoot, {
      recursive: true,
    });
    features.session.harvestBrowserRuntime = await features.session.readHarvestBrowserSettings();
    features.session.configureHarvestTsSession();
    features.session
      .initializeHarvestAdblockEngine()
      .then(() =>
        features.host.emit('harvestts-adblock-status', features.session.harvestAdblockSnapshot()),
      )
      .catch(() => {});
    await features.extensions.loadSavedHarvestExtensions();
  }
  function registerIpc(handle) {
    features.ipc.registerHarvestInternalIpc();
    features.ipc.registerHarvestGuestIpc();
    features.ipc.registerHarvestBlockManagerIpc();
    features.ipc.registerHarvestContextMenuIpc();
    handle('harvestTsCreate', features.tabs.createHarvestTsTab);
    handle('harvestTsSwitch', features.tabs.switchHarvestTsTab);
    handle('harvestTsClose', features.tabs.closeHarvestTsTab);
    handle('harvestTsNavigate', features.tabs.navigateHarvestTs);
    handle('harvestTsAction', features.tabs.harvestTsAction);
    handle('harvestTsLayout', features.tabs.harvestTsLayout);
    handle('harvestTsState', features.tabs.harvestTsSnapshot);
    handle('harvestTsPopupMenu', features.tabs.harvestTsPopupMenu);
    handle('harvestTsOpenHistory', features.tabs.harvestTsOpenHistory);
    handle('harvestTsOpenDownloads', features.tabs.harvestTsOpenDownloads);
    handle('ocrLabOpen', () => features.ocrLab.ocrLab.open());
    handle('harvestTsHistoryList', features.history.harvestTsHistoryList);
    handle('harvestTsHistoryRemove', features.history.harvestTsHistoryRemove);
    handle('harvestTsHistoryClear', features.history.harvestTsHistoryClear);
    handle('harvestTsBrowserSettings', features.history.harvestTsBrowserSettings);
    handle('harvestTsBrowserSettingsSet', features.history.harvestTsBrowserSettingsSet);
    handle('harvestTsBookmarks', features.bookmarks.harvestTsBookmarks);
    handle('harvestTsBookmarkModel', features.bookmarks.harvestTsBookmarkModel);
    handle('harvestTsBookmarkStatus', features.bookmarks.harvestTsBookmarkStatus);
    handle('harvestTsBookmarkAdd', features.bookmarks.harvestTsBookmarkAdd);
    handle('harvestTsBookmarkRemove', features.bookmarks.harvestTsBookmarkRemove);
    handle('harvestTsBookmarkFolderCreate', features.bookmarks.harvestTsBookmarkFolderCreate);
    handle('harvestTsBookmarkFolderRemove', features.bookmarks.harvestTsBookmarkFolderRemove);
    handle('harvestTsPasswordList', features.credentials.harvestTsPasswordList);
    handle('harvestTsPasswordStatus', features.credentials.harvestTsPasswordStatus);
    handle('harvestTsPasswordPopupMenu', features.credentials.harvestTsPasswordPopupMenu);
    handle('harvestTsPasswordSavePrompt', features.credentials.harvestTsPasswordSavePrompt);
    handle(
      'harvestTsPasswordDismissCandidate',
      features.credentials.harvestTsPasswordDismissCandidate,
    );
    handle('harvestTsPasswordFillById', features.credentials.harvestTsPasswordFillById);
    handle('harvestTsPasswordSaveCandidate', features.credentials.harvestTsPasswordSaveCandidate);
    handle('harvestTsPasswordSaveCurrent', features.credentials.harvestTsPasswordSaveCurrent);
    handle('harvestTsPasswordRemove', features.credentials.harvestTsPasswordRemove);
    handle('harvestTsPasswordFillCurrent', features.credentials.harvestTsPasswordFillCurrent);
    handle('harvestTsAdblockStatus', features.session.harvestTsAdblockStatus);
    handle('harvestTsAdblockSet', features.session.harvestTsAdblockSet);
    handle('harvestTsAdblockUpdate', features.session.harvestTsAdblockUpdate);
    handle('harvestTsExtensionList', features.extensions.harvestTsExtensionList);
    handle('harvestTsExtensionInstall', features.extensions.harvestTsExtensionInstall);
    handle('harvestTsExtensionToggle', features.extensions.harvestTsExtensionToggle);
    handle('harvestTsExtensionRemove', features.extensions.harvestTsExtensionRemove);
    handle('harvestTsDnsSettings', features.session.harvestTsDnsSettings);
    handle('harvestTsDnsSet', features.session.harvestTsDnsSet);
    handle('harvestTsDnsActivate', features.session.harvestTsDnsActivate);
    handle('harvestTsDnsDeactivate', features.session.harvestTsDnsDeactivate);
    handle('harvestTsBlockElement', features.blocks.harvestTsBlockElement);
    handle('harvestTsBlockList', features.blocks.harvestTsBlockList);
    handle('harvestTsBlockClear', features.blocks.harvestTsBlockClear);
    handle('harvestTsBlockDraftBegin', features.blocks.harvestTsBlockDraftBegin);
    handle('harvestTsBlockDraftState', features.blocks.harvestTsBlockDraftState);
    handle('harvestTsBlockDraftClear', features.blocks.harvestTsBlockDraftClear);
    handle('harvestTsBlockDraftCancel', features.blocks.harvestTsBlockDraftCancel);
    handle('harvestTsBlockDraftCommit', features.blocks.harvestTsBlockDraftCommit);
    handle('harvestTsBlockRemove', features.blocks.harvestTsBlockRemove);
  }
  function disposeWindows() {
    const popup = features.blockManager.liveHarvestBlockManager(),
      contextMenu = features.contextMenu.liveHarvestContextMenu();
    features.blockManager.harvestBlockManagerWindow = null;
    features.blockManager.harvestBlockManagerTabId = null;
    features.contextMenu.harvestContextMenuWindow = null;
    features.contextMenu.harvestContextMenuTarget = null;
    features.contextMenu.harvestContextMenuModel = null;
    if (popup) {
      try {
        popup.destroy();
      } catch {}
    }
    if (contextMenu) {
      try {
        contextMenu.destroy();
      } catch {}
    }
  }
  function shutdown() {
    features.ocrLab.ocrLab.close();
    features.tabs.saveHarvestTabsSync();
    features.downloads.saveHarvestDownloadsSync();
    for (const state of features.translation.harvestScreenLensStates.values())
      if (state?.timer) clearTimeout(state.timer);
    features.translation.harvestScreenLensStates.clear();
    features.translation.harvestGoogleTranslateWeb.close();
  }
  return { initialize, registerIpc, disposeWindows, shutdown };
}
module.exports = { createHarvestTS };
