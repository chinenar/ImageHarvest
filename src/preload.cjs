'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const methods = ['open', 'showBrowser', 'collectorBlockElement', 'browserProfile', 'openBrowserLogin', 'useBrowserProfile', 'harvestTsCreate', 'harvestTsSwitch', 'harvestTsClose', 'harvestTsNavigate', 'harvestTsAction', 'harvestTsLayout', 'harvestTsState', 'harvestTsPopupMenu', 'harvestTsOpenHistory', 'harvestTsOpenDownloads', 'ocrLabOpen', 'harvestTsHistoryList', 'harvestTsHistoryRemove', 'harvestTsHistoryClear', 'harvestTsBrowserSettings', 'harvestTsBrowserSettingsSet', 'harvestTsBookmarks', 'harvestTsBookmarkModel', 'harvestTsBookmarkStatus', 'harvestTsBookmarkAdd', 'harvestTsBookmarkRemove', 'harvestTsBookmarkFolderCreate', 'harvestTsBookmarkFolderRemove', 'harvestTsPasswordList', 'harvestTsPasswordStatus', 'harvestTsPasswordPopupMenu', 'harvestTsPasswordSavePrompt', 'harvestTsPasswordDismissCandidate', 'harvestTsPasswordFillById', 'harvestTsPasswordSaveCandidate', 'harvestTsPasswordSaveCurrent', 'harvestTsPasswordRemove', 'harvestTsPasswordFillCurrent', 'harvestTsAdblockStatus', 'harvestTsAdblockSet', 'harvestTsAdblockUpdate', 'harvestTsExtensionList', 'harvestTsExtensionInstall', 'harvestTsExtensionToggle', 'harvestTsExtensionRemove', 'harvestTsDnsSettings', 'harvestTsDnsSet', 'harvestTsDnsActivate', 'harvestTsDnsDeactivate', 'harvestTsBlockElement', 'harvestTsBlockList', 'harvestTsBlockClear', 'harvestTsBlockDraftBegin', 'harvestTsBlockDraftState', 'harvestTsBlockDraftClear', 'harvestTsBlockDraftCancel', 'harvestTsBlockDraftCommit', 'harvestTsBlockRemove', 'scan', 'nextChapter', 'advanceNextChapter', 'startCapture', 'stopCapture', 'networkMode', 'restartForNetwork', 'cancel', 'download', 'chooseFolder', 'chooseRenameFolder', 'previewRename', 'renameImages', 'openFolder', 'exportLinks', 'settings', 'removeItems', 'undoRemove', 'clearResults', 'workspaceSwitch', 'workspaceClose', 'continuousLog'];
const api = {};
for (const method of methods) api[method] = data => ipcRenderer.invoke(`eiw:${method}`, data);
api.on = callback => {
  if (typeof callback !== 'function') return () => {};
  const handler = (_event, data) => callback(data);
  ipcRenderer.on('eiw:event', handler);
  return () => ipcRenderer.removeListener('eiw:event', handler);
};
contextBridge.exposeInMainWorld('eiw', api);
