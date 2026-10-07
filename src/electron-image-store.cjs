'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { imageType, idFor } = require('./core.cjs');
const LIMIT = 32 * 1024 * 1024, BUDGET = 512 * 1024 * 1024;

class ElectronImageStore {
  constructor(webContents, directory) {
    this.wc = webContents; this.directory = directory; this.debugger = webContents.debugger;
    this.requests = new Map(); this.redirects = new Map(); this.entries = new Map();
    this.queue = Promise.resolve(); this.epoch = 0; this.totalBytes = 0; this.bytes = 0;
    this.saved = 0; this.skipped = 0; this.hits = 0; this.attachedByUs = false;
    this.closed = false; this.installed = false; this.onMessage = null; this.onDetach = null;
  }
  async install() {
    if (this.installed) return true;
    await fs.mkdir(this.directory, { recursive:true });
    if (!this.debugger.isAttached()) { this.debugger.attach('1.3'); this.attachedByUs = true; }
    this.onMessage = (_event, method, event) => this.handle(method, event).catch(() => {});
    this.onDetach = () => { this.closed = true; };
    this.debugger.on('message', this.onMessage);
    this.debugger.on('detach', this.onDetach);
    await this.debugger.sendCommand('Page.enable');
    await this.debugger.sendCommand('Network.enable', {
      maxTotalBufferSize: 128 * 1024 * 1024, maxResourceBufferSize: LIMIT
    });
    this.installed = true; return true;
  }
  beginDocument() {
    this.epoch++; this.requests.clear(); this.redirects.clear(); this.entries.clear();
    this.bytes = 0; this.saved = 0; this.skipped = 0; this.hits = 0;
  }
  async handle(method, event = {}) {
    if (this.closed) return;
    if (method === 'Page.frameNavigated' && !event.frame?.parentId) { this.beginDocument(); return; }
    if (method === 'Network.requestWillBeSent') {
      if (event.type !== 'Image' || !/^https?:\/\//i.test(event.request?.url || '')) return;
      const chain = this.redirects.get(event.requestId) || [];
      if (chain.length < 10 && !chain.includes(event.request.url)) chain.push(event.request.url);
      this.redirects.set(event.requestId, chain); return;
    }
    if (method === 'Network.responseReceived') {
      if (event.type !== 'Image') return;
      const r = event.response || {}, aliases = this.redirects.get(event.requestId) || [];
      if (r.status !== 200) {
        for (const url of [...aliases, r.url].filter(Boolean)) this.entries.delete(url);
        this.redirects.delete(event.requestId); return;
      }
      // CDP already classified this request as Image; validate the actual bytes when saving.
      // Some CDNs intentionally answer image URLs as application/octet-stream.
      if (!/^https?:\/\//i.test(r.url || '')) return;
      const announced = Number(Object.entries(r.headers || {}).find(([k]) => k.toLowerCase() === 'content-length')?.[1] || 0);
      if (announced > LIMIT || this.requests.size >= 5000) { this.skipped++; return; }
      this.requests.set(event.requestId, { url:r.url, aliases, mime:r.mimeType, size:0, epoch:this.epoch }); return;
    }
    if (method === 'Network.dataReceived') {
      const entry = this.requests.get(event.requestId);
      if (entry && (entry.size += Number(event.dataLength) || 0) > LIMIT) { this.requests.delete(event.requestId); this.skipped++; }
      return;
    }
    if (method === 'Network.loadingFailed') {
      this.requests.delete(event.requestId); this.redirects.delete(event.requestId); return;
    }
    if (method === 'Network.loadingFinished') {
      const entry = this.requests.get(event.requestId);
      this.requests.delete(event.requestId); this.redirects.delete(event.requestId);
      if (!entry || entry.epoch !== this.epoch || Number(event.encodedDataLength) > LIMIT) return;
      const promise = this.queue.then(() => this.save(event.requestId, entry)).catch(() => { this.skipped++; return null; });
      this.queue = promise.then(() => {});
      const record = { promise, epoch:this.epoch };
      for (const url of new Set([...entry.aliases, entry.url])) if (this.entries.size < 5000) this.entries.set(url, record);
    }
  }
  async save(requestId, entry) {
    if (this.closed || entry.epoch !== this.epoch || this.totalBytes >= BUDGET) return null;
    let timer;
    try {
      const data = await Promise.race([
        this.debugger.sendCommand('Network.getResponseBody', { requestId }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('response body timeout')), 4000); })
      ]);
      if (!data?.body) return null;
      if (data.body.length > LIMIT * (data.base64Encoded ? 4 / 3 : 1) + 8) { this.skipped++; return null; }
      const buffer = Buffer.from(data.body, data.base64Encoded ? 'base64' : 'utf8');
      if (!buffer.length || buffer.length > LIMIT || this.totalBytes + buffer.length > BUDGET) return null;
      const typed = imageType(buffer, entry.mime);
      const file = path.join(this.directory, `${entry.epoch}-${idFor(requestId + ':' + entry.url)}.${typed.ext}`);
      await fs.writeFile(file, buffer);
      this.totalBytes += buffer.length; this.bytes += buffer.length; this.saved++;
      return { file, bytes:buffer.length, ...typed };
    } finally { clearTimeout(timer); }
  }
  async read(url) {
    const record = this.entries.get(url);
    if (!record || record.epoch !== this.epoch || this.closed) return null;
    const snapshot = await record.promise;
    if (!snapshot || this.closed || record.epoch !== this.epoch) return null;
    const buffer = await fs.readFile(snapshot.file);
    this.hits++;
    return { buffer, ext:snapshot.ext, mime:snapshot.mime, via:'electron-response' };
  }
  info() { return { saved:this.saved, bytes:this.bytes, hits:this.hits, skipped:this.skipped, sessionBytes:this.totalBytes }; }
  async settle() { await this.queue; }
  async close() {
    this.closed = true;
    if (this.onMessage) this.debugger.off('message', this.onMessage);
    if (this.onDetach) this.debugger.off('detach', this.onDetach);
    await this.queue.catch(() => {});
    if (this.attachedByUs && this.debugger.isAttached()) this.debugger.detach();
    await fs.rm(this.directory, { recursive:true, force:true }).catch(() => {});
    this.requests.clear(); this.redirects.clear(); this.entries.clear();
  }
}
module.exports = { ElectronImageStore };