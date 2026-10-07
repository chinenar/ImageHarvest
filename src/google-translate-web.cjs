'use strict';

const { BrowserWindow } = require('electron');
const {extractMarkedTranslations,googleInteractionRequired}=require('./google-web-result.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function normalizeLanguage(value, { source = false } = {}) {
  const code = String(value || '').trim().toLowerCase();
  if (source && (!code || code === 'auto')) return 'auto';
  const map = {
    th: 'th',
    en: 'en',
    ja: 'ja',
    fr: 'fr',
    ko: 'ko',
    zh: 'zh-CN'
  };
  const result = map[code];
  if (!result) throw new Error('ภาษานี้ยังไม่รองรับกับ Google Translate Web');
  return result;
}

function translateUrl(sourceLanguage, targetLanguage) {
  const sl = normalizeLanguage(sourceLanguage, { source: true });
  const tl = normalizeLanguage(targetLanguage);
  return 'https://translate.google.com/?sl=' + encodeURIComponent(sl) +
    '&tl=' + encodeURIComponent(tl) + '&op=translate&hl=en';
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&');
}

class GoogleTranslateWebClient {
  constructor({
    partition = 'persist:harvest-google-translate',
    idleMs = 60000,
    batchChars = 3600,
    batchItems = 24
  } = {}) {
    this.partition = partition;
    this.idleMs = idleMs;
    this.batchChars = batchChars;
    this.batchItems = batchItems;
    this.window = null;
    this.pageKey = '';
    this.idleTimer = null;
    this.queue = Promise.resolve();
    this.sequence = 0;
  }

  close() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.pageKey = '';
    const win = this.window;
    this.window = null;
    if (win && !win.isDestroyed()) win.destroy();
  }

  scheduleIdleClose() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), this.idleMs);
  }

  async waitReady(win, timeoutMs = 15000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (!win || win.isDestroyed()) throw new Error('Google Translate Web ปิดตัวก่อนพร้อมใช้งาน');
      const ready = await win.webContents.executeJavaScript(
        `Boolean(document.querySelector('textarea[aria-label="Source text"]') || document.querySelector('textarea'))`,
        true
      ).catch(() => false);
      if (ready) return true;
      const body=await win.webContents.executeJavaScript('document.body?.innerText?.slice(0,2000)||""',true).catch(()=>'');
      if(googleInteractionRequired(body,win.webContents.getURL())){const e=Error('Google ต้องให้ผู้ใช้ยืนยันบนหน้าเว็บก่อน • หยุดลองอัตโนมัติ');e.code='GOOGLE_INTERACTION_REQUIRED';throw e;}
      await sleep(120);
    }
    throw new Error('Google Translate Web โหลดไม่ทันเวลา');
  }

  async ensureWindow(sourceLanguage, targetLanguage) {
    const url = translateUrl(sourceLanguage, targetLanguage);
    let win = this.window;

    if (!win || win.isDestroyed()) {
      win = new BrowserWindow({
        show: false,
        width: 1000,
        height: 800,
        backgroundColor: '#ffffff',
        webPreferences: {
          partition: this.partition,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false
        }
      });
      this.window = win;
      win.setSkipTaskbar(true);
      win.webContents.setUserAgent(win.webContents.getUserAgent().replace(/ Electron\/[^ ]+/, ''));
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.on('closed', () => {
        if (this.window === win) this.window = null;
        this.pageKey = '';
      });
    }

    if (this.pageKey !== url || !/^https:\/\/translate\.google\.com\//i.test(win.webContents.getURL() || '')) {
      await win.loadURL(url);
      this.pageKey = url;
    }

    await this.waitReady(win);
    this.scheduleIdleClose();
    return win;
  }

  marker(batchId, index) {
    return '[[IH' + batchId + '_' + String(index + 1).padStart(4, '0') + ']]';
  }

  async translateBatch(items, { sourceLanguage = 'auto', targetLanguage = 'th', signal } = {}) {
    if (!Array.isArray(items) || !items.length) return [];
    if(signal?.aborted)throw Error('ยกเลิกการแปลแล้ว');
    const abort=()=>this.close();
    signal?.addEventListener('abort',abort,{once:true});
    try {
    const win = await this.ensureWindow(sourceLanguage, targetLanguage);
    this.scheduleIdleClose();

    const batchId = String(++this.sequence).padStart(6, '0');
    const sourceText = items.map((item, index) =>
      this.marker(batchId, index) + '\n' + String(item.text || '').trim()
    ).join('\n')+'\n'+this.marker(batchId,items.length);

    const jsInput = JSON.stringify(sourceText);
    await win.webContents.executeJavaScript(`(() => {
      const ta = document.querySelector('textarea[aria-label="Source text"]') || document.querySelector('textarea');
      if (!ta) throw new Error('source textarea missing');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(ta, ${jsInput}); else ta.value = ${jsInput};
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`, true);

    const firstMarker = this.marker(batchId, 0);
    const lastMarker = this.marker(batchId, items.length);
    let lastOutput='',stableSince=0;
    const started = Date.now();
    let translatedText = '';

    while (Date.now() - started < 15000) {
      if(signal?.aborted)throw Error('ยกเลิกการแปลแล้ว');
      if (win.isDestroyed()) throw new Error('Google Translate Web ปิดตัวระหว่างแปล');
      translatedText = await win.webContents.executeJavaScript(`(() => {
        const nodes = [...document.querySelectorAll('span.ryNqvb')];
        return nodes.map(node => node.innerText || node.textContent || '').join('');
      })()`, true).catch(() => '');

      const parsed=extractMarkedTranslations(translatedText,items,batchId);
      if(parsed.some(r=>r.translation)){
        if(translatedText!==lastOutput){lastOutput=translatedText;stableSince=Date.now();}
        else if(Date.now()-stableSince>=360)break;
      }
      if(googleInteractionRequired(translatedText,win.webContents.getURL())){const e=Error('Google ต้องให้ผู้ใช้ยืนยันก่อน');e.code='GOOGLE_INTERACTION_REQUIRED';throw e;}
      await sleep(120);
    }

    if (!extractMarkedTranslations(translatedText,items,batchId).some(r=>r.translation)) {
      throw new Error('Google Translate Web ไม่ส่งคำแปลกลับมา');
    }

    const results=extractMarkedTranslations(translatedText,items,batchId);
    if(signal?.aborted)throw Error('ยกเลิกการแปลแล้ว');
    return results;
    } finally {signal?.removeEventListener('abort',abort);}
  }

  async translateSingle(item,{sourceLanguage='auto',targetLanguage='th',signal}={}){
    if(signal?.aborted)throw Error('ยกเลิกการแปลแล้ว');
    const abort=()=>this.close();signal?.addEventListener('abort',abort,{once:true});
    try{
      const win=await this.ensureWindow(sourceLanguage,targetLanguage);
      await win.loadURL(translateUrl(sourceLanguage,targetLanguage)+'&text='+encodeURIComponent(item.text));
      this.pageKey='';await this.waitReady(win);let last='',since=0;const start=Date.now();
      while(Date.now()-start<15000){
        if(signal?.aborted)throw Error('ยกเลิกการแปลแล้ว');
        const state=await win.webContents.executeJavaScript("(() => ({text:[...document.querySelectorAll('span.ryNqvb')].map(n=>n.innerText||n.textContent||'').join(''),body:document.body?.innerText?.slice(0,1000)||''}))()",true);
        if(googleInteractionRequired(state.body,win.webContents.getURL())){const e=Error('Google ต้องให้ผู้ใช้ยืนยันก่อน');e.code='GOOGLE_INTERACTION_REQUIRED';throw e;}
        if(state.text.trim()){if(state.text!==last){last=state.text;since=Date.now();}else if(Date.now()-since>=450)return {id:item.id,translation:last.trim()};}
        await sleep(150);
      }
      throw Error('Google Translate Web ไม่ส่งคำแปลรายกล่องกลับมา');
    }finally{signal?.removeEventListener('abort',abort);this.scheduleIdleClose();}
  }

  async translateRegions(regions, {
    sourceLanguage = 'auto',
    targetLanguage = 'th',
    onBatch, signal
  } = {}) {
    const source = (Array.isArray(regions) ? regions : [])
      .filter(region => String(region?.text || '').trim());
    if (!source.length) return [];

    const batches = [];
    let current = [];
    let chars = 0;

    for (const region of source) {
      const text = String(region.text || '').trim();
      const estimated = text.length + 24;
      if (current.length && (current.length >= this.batchItems || chars + estimated > this.batchChars)) {
        batches.push(current);
        current = [];
        chars = 0;
      }
      current.push(region);
      chars += estimated;
    }
    if (current.length) batches.push(current);

    const output = [];
    let done = 0;

    for (const batch of batches) {
      if(signal?.aborted)throw Error('ยกเลิกการแปลแล้ว');
      let translated;
      try{translated=await this.translateBatch(batch,{sourceLanguage,targetLanguage,signal});}
      catch(first){
        if(signal?.aborted||first.code==='GOOGLE_INTERACTION_REQUIRED')throw first;
        this.close();await sleep(600);if(signal?.aborted)throw Error('ยกเลิกการแปลแล้ว');
        try{translated=await this.translateBatch(batch,{sourceLanguage,targetLanguage,signal});}
        catch(error){
          if(signal?.aborted||error.code==='GOOGLE_INTERACTION_REQUIRED')throw error;
          output.push(...batch.map(item=>({id:item.id,translation:'',error:error.message})));
          done+=batch.length;onBatch?.({done,total:source.length,batch:batch.length,failed:batch.length});continue;
        }
      }
      const byId = new Map(translated.map(item => [String(item.id), item]));
      const missing = [];

      for (const item of batch) {
        const result = byId.get(String(item.id));
        if (result?.translation) output.push(result);
        else missing.push(item);
      }

      for (const item of missing) {
        try{output.push(await this.translateSingle(item,{sourceLanguage,targetLanguage,signal}));}
        catch(error){if(signal?.aborted||error.code==='GOOGLE_INTERACTION_REQUIRED')throw error;output.push({id:String(item.id||''),translation:'',error:error.message});}
      }

      done += batch.length;
      onBatch?.({ done, total: source.length, batch: batch.length });
    }

    return output;
  }

  translate(regions, options = {}) {
    const run = () => this.translateRegions(regions, options);
    const task = this.queue.then(run, run);
    this.queue = task.catch(() => {});
    return task;
  }
}



class GoogleTranslateWebPool {
  constructor({ size = 4, partition = 'persist:harvest-google-translate', clientFactory, ...clientOptions } = {}) {
    this.size = Math.max(1, Math.min(4, Number(size) || 4));
    this.clients = Array.from({ length:this.size }, (_, index) => typeof clientFactory === 'function'
      ? clientFactory(index)
      : new GoogleTranslateWebClient({
          partition,
          ...clientOptions
        }));
    this.idle = [...this.clients];
    this.waiters = [];
    this.closed = false;
  }

  async acquire(signal) {
    if (this.closed) throw new Error('Google Translate worker pool ปิดแล้ว');
    if (signal?.aborted) throw new Error('ยกเลิกการแปลแล้ว');
    if (this.idle.length) return this.idle.shift();
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal };
      const abort = () => {
        const index = this.waiters.indexOf(entry);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error('ยกเลิกการแปลแล้ว'));
      };
      entry.abort = abort;
      signal?.addEventListener('abort', abort, { once:true });
      this.waiters.push(entry);
    });
  }

  release(client) {
    if (!client) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.signal?.removeEventListener('abort', waiter.abort);
      waiter.resolve(client);
    } else if (!this.closed) {
      this.idle.push(client);
    } else {
      client.close();
    }
  }

  async translate(regions, options = {}) {
    const client = await this.acquire(options.signal);
    try {
      return await client.translate(regions, options);
    } finally {
      this.release(client);
    }
  }

  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal?.removeEventListener('abort', waiter.abort);
      waiter.reject(new Error('Google Translate worker pool ปิดแล้ว'));
    }
    for (const client of this.clients) client.close();
    this.idle = [];
  }
}

module.exports = {
  GoogleTranslateWebClient,
  GoogleTranslateWebPool,
  normalizeLanguage,
  translateUrl
};
