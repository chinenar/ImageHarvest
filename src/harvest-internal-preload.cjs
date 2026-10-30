'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('harvestInternal', {
  historyList: query => ipcRenderer.invoke('harvest-internal:history-list', query || {}),
  historyFavicons: query => ipcRenderer.invoke('harvest-internal:history-favicons', query || {}),
  historyRemove: id => ipcRenderer.invoke('harvest-internal:history-remove', { id, limit:1000 }),
  historyClear: () => ipcRenderer.invoke('harvest-internal:history-clear'),
  historySettings: () => ipcRenderer.invoke('harvest-internal:browser-settings'),
  historySetEnabled: enabled => ipcRenderer.invoke('harvest-internal:history-set-enabled', { enabled:Boolean(enabled) }),
  openUrl: url => ipcRenderer.invoke('harvest-internal:open-url', { url }),
  downloadsList: () => ipcRenderer.invoke('harvest-internal:downloads-list'),
  downloadsRemove: id => ipcRenderer.invoke('harvest-internal:downloads-remove', { id }),
  downloadsClear: () => ipcRenderer.invoke('harvest-internal:downloads-clear'),
  downloadsOpen: id => ipcRenderer.invoke('harvest-internal:downloads-open', { id }),
  downloadsShow: id => ipcRenderer.invoke('harvest-internal:downloads-show', { id }),
  downloadsCancel: id => ipcRenderer.invoke('harvest-internal:downloads-cancel', { id }),
  offlineList: () => ipcRenderer.invoke('harvest-internal:offline-list'),
  offlineCover: id => ipcRenderer.invoke('harvest-internal:offline-cover', { id }),
  offlineGroupCreate: title => ipcRenderer.invoke('harvest-internal:offline-group-create', { title }),
  offlineGroupRename: (id,title) => ipcRenderer.invoke('harvest-internal:offline-group-rename', { id,title }),
  offlineGroupRemove: id => ipcRenderer.invoke('harvest-internal:offline-group-remove', { id }),
  offlineLibraryReorder: (scope,ids,groupId='') => ipcRenderer.invoke('harvest-internal:offline-library-reorder', { scope,ids,groupId }),
  offlineLibraryProjectCreate: (title,groupId) => ipcRenderer.invoke('harvest-internal:offline-library-project-create', { title,groupId }),
  offlineLibraryProjectRename: (id,title) => ipcRenderer.invoke('harvest-internal:offline-library-project-rename', { id,title }),
  offlineLibraryProjectGroup: (id,groupId) => ipcRenderer.invoke('harvest-internal:offline-library-project-group', { id,groupId }),
  offlineItemProject: (id,projectId) => ipcRenderer.invoke('harvest-internal:offline-item-project', { id,projectId }),
  offlineRemove: id => ipcRenderer.invoke('harvest-internal:offline-remove', { id }),
  offlineOpen: id => ipcRenderer.invoke('harvest-internal:offline-open', { id }),
  offlineOpenSource: id => ipcRenderer.invoke('harvest-internal:offline-open-source', { id }),
  offlineProject: id => ipcRenderer.invoke('harvest-internal:offline-project', { id }),
  offlineImage: (id,file) => ipcRenderer.invoke('harvest-internal:offline-image', { id,file }),
  offlineExportStart: (id,mode) => ipcRenderer.invoke('harvest-internal:offline-export-start', { id,mode }),
  offlineExportPage: (token,index,bytes) => ipcRenderer.invoke('harvest-internal:offline-export-page', { token,index,bytes }),
  offlineExportFinish: token => ipcRenderer.invoke('harvest-internal:offline-export-finish', { token }),
  onDownloadsChanged: callback => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event,payload) => callback(payload || {items:[]});
    ipcRenderer.on('harvest-internal:downloads-changed', handler);
    return () => ipcRenderer.removeListener('harvest-internal:downloads-changed', handler);
  }
});
