'use strict';
const {contextBridge,ipcRenderer}=require('electron');
const api={};
for(const name of ['info','preview','import','folder','clipboard','capture','harvest','run','cancel','translate','translation-models','overlay','evaluate','save','load'])api[name]=arg=>ipcRenderer.invoke('ocr-lab:'+name,arg);
api.onProgress=callback=>{const handler=(_event,data)=>callback(data);ipcRenderer.on('ocr-lab:progress',handler);return ()=>ipcRenderer.removeListener('ocr-lab:progress',handler);};
contextBridge.exposeInMainWorld('ocrLab',api);
