'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { imageType, idFor } = require('./core.cjs');
const LIMIT = 32 * 1024 * 1024, BUDGET = 512 * 1024 * 1024;
// Capture only successful image responses already received by this app-owned Chrome.
// No replay requests, cookie copying, guessed URLs or response-status changes.
class ChromeImageStore {
  constructor(cdp, directory) {
    this.cdp = cdp; this.directory = directory; this.requests = new Map();
    this.entries = new Map(); this.queue = Promise.resolve(); this.epoch = 0;
    this.bytes = 0; this.saved = 0; this.skipped = 0; this.hits = 0; this.closed = false;
    this.handlers = [];
  }
  async install() {
    await fs.mkdir(this.directory, { recursive: true });
    const { frameTree } = await this.cdp.send('Page.getFrameTree');
    const frameId = frameTree.frame.id;
    const on = (name, fn) => { this.cdp.on(name, fn); this.handlers.push([name, fn]); };
    on('Network.requestWillBeSent', event => {
      if (event.type === 'Document' && event.frameId === frameId) this.beginDocument();
    });
    on('Network.responseReceived', event => {
      if (this.closed || event.type !== 'Image' || event.response.status !== 200) return;
      const r = event.response;
      if (!/^https?:\/\//i.test(r.url) || !/^image\//i.test(r.mimeType)) return;
      const announced = Number(Object.entries(r.headers || {}).find(([key]) => key.toLowerCase() === 'content-length')?.[1] || 0);
      if (announced > LIMIT || this.requests.size >= 5000) { this.skipped++; return; }
      this.requests.set(event.requestId, { url: r.url, mime: r.mimeType, size: 0, epoch: this.epoch });
    });
    on('Network.dataReceived', event => {
      const entry = this.requests.get(event.requestId);
      if (entry && (entry.size += event.dataLength) > LIMIT) { this.requests.delete(event.requestId); this.skipped++; }
    });
    on('Network.loadingFailed', event => this.requests.delete(event.requestId));
    on('Network.loadingFinished', event => {
      const entry = this.requests.get(event.requestId); this.requests.delete(event.requestId);
      if (!entry || this.closed || entry.epoch !== this.epoch) return;
      if (event.encodedDataLength > LIMIT || this.entries.size >= 5000) { this.skipped++; return; }
      const promise = this.queue.then(() => this.save(event.requestId, entry)).catch(() => { this.skipped++; return null; });
      this.queue = promise.then(() => {});
      this.entries.set(entry.url, { promise, epoch: this.epoch });
    });
    await this.cdp.send('Network.enable', { maxTotalBufferSize: 128 * 1024 * 1024, maxResourceBufferSize: LIMIT });
  }
  beginDocument() {
    this.epoch++; this.requests.clear(); this.entries.clear();
    this.bytes = 0; this.saved = 0; this.skipped = 0; this.hits = 0;
    // Keep already-written files until close: collection snapshots may still be copying.
    // Session-wide disk usage is bounded separately below.
  }
  async save(requestId, entry) {
    if (this.closed || entry.epoch !== this.epoch) return null;
    if ((this.totalBytes || 0) >= BUDGET) { this.skipped++; return null; }
    const data = await this.cdp.send('Network.getResponseBody', { requestId });
    if (data.body.length > LIMIT * (data.base64Encoded ? 4 / 3 : 1) + 8) { this.skipped++; return null; }
    const buffer = Buffer.from(data.body, data.base64Encoded ? 'base64' : 'utf8');
    if (!buffer.length || buffer.length > LIMIT || (this.totalBytes || 0) + buffer.length > BUDGET) { this.skipped++; return null; }
    const typed = imageType(buffer, entry.mime);
    if (this.closed || entry.epoch !== this.epoch) return null;
    const file = path.join(this.directory, `${this.epoch}-${idFor(entry.url)}.${typed.ext}`);
    await fs.writeFile(file, buffer);
    this.totalBytes = (this.totalBytes || 0) + buffer.length; this.bytes += buffer.length; this.saved++;
    return { file, bytes: buffer.length, ...typed };
  }
  async read(url) {
    const entry = this.entries.get(url);
    if (!entry || entry.epoch !== this.epoch || this.closed) return null;
    const snapshot = await entry.promise;
    if (!snapshot || this.closed || entry.epoch !== this.epoch) return null;
    const buffer = await fs.readFile(snapshot.file);
    this.hits++;
    return { buffer, ext: snapshot.ext, mime: snapshot.mime, via: 'chrome-response' };
  }
  info() { return { saved: this.saved, bytes: this.bytes, hits: this.hits, skipped: this.skipped, sessionBytes: this.totalBytes || 0 }; }
  async settle() { await this.queue; }
  async close() {
    this.closed = true;
    for (const [name, handler] of this.handlers) this.cdp.off(name, handler);
    this.handlers = []; this.requests.clear(); this.entries.clear();
    await this.queue.catch(() => {});
    await fs.rm(this.directory, { recursive: true, force: true }).catch(() => {});
  }
}
module.exports = { ChromeImageStore, LIMIT, BUDGET };
