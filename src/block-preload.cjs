'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const invoke = (name, arg) => ipcRenderer.invoke('harvest-block:' + name, arg);
contextBridge.exposeInMainWorld('harvestBlock', {
  state: () => invoke('state'),
  clearDraft: () => invoke('clear-draft'),
  commit: () => invoke('commit'),
  cancel: () => invoke('cancel'),
  remove: selector => invoke('remove', { selector }),
  clearSaved: () => invoke('clear-saved'),
  collapse: collapsed => invoke('collapse', { collapsed }),
  close: () => invoke('close')
});
