'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const methods = ['open', 'showBrowser', 'scan', 'cancel', 'download', 'chooseFolder', 'chooseRenameFolder', 'previewRename', 'renameImages', 'openFolder', 'exportLinks', 'settings', 'removeItems', 'undoRemove', 'clearResults'];
const api = {};
for (const method of methods) api[method] = data => ipcRenderer.invoke(`eiw:${method}`, data);
api.on = callback => {
  if (typeof callback !== 'function') return () => {};
  const handler = (_event, data) => callback(data);
  ipcRenderer.on('eiw:event', handler);
  return () => ipcRenderer.removeListener('eiw:event', handler);
};
contextBridge.exposeInMainWorld('eiw', api);
