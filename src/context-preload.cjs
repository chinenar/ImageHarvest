'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('harvestContext', {
  model: () => ipcRenderer.invoke('harvest-context:model'),
  action: id => ipcRenderer.invoke('harvest-context:action', { id }),
  close: () => ipcRenderer.invoke('harvest-context:close')
});
