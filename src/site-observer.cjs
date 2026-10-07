// Passive, bounded metadata observation. No new CDP attachment or script mutation.
'use strict';
const { createHash } = require('node:crypto');
const digest = value => createHash('sha256').update(String(value)).digest('hex');
function resourceKey(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return digest(url.origin + url.pathname);
  } catch { return ''; }
}
function versionKey(value) {
  try {
    const url = new URL(value);
    return digest(['v', 'ver', 'version', 'build', 'hash'].map(k => url.searchParams.get(k) || '').join('|'));
  } catch { return ''; }
}
function header(headers, name) {
  const value = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name)?.[1];
  return Array.isArray(value) ? value.join(',') : String(value || '');
}
class SiteObserver {
  constructor() { this.handlers = []; this.cdp = null; this.begin(''); }
  begin(url, sameDocument = false) {
    this.documentURL = String(url || ''); this.epoch = (this.epoch || 0) + 1;
    if (!sameDocument) this.scripts = new Map();
    this.documentStatus = 0; this.images = 0; this.imageErrors = 0;
    this.apiResponses = 0; this.fromCache = 0; this.dropped = 0;
  }
  scriptHash(url, hash) {
    const key = resourceKey(url);
    if (!key || !/^[a-f0-9]{64}$/.test(hash || '')) return;
    if (this.scripts.size >= 256 && !this.scripts.has(key)) { this.dropped++; return; }
    const old = this.scripts.get(key) || {};
    this.scripts.set(key, { ...old, hash, version: old.version || versionKey(url) });
  }
  seedScripts(urls) {
    for (const url of (urls || []).slice(0, 256)) {
      const key = resourceKey(url);
      if (key && !this.scripts.has(key) && this.scripts.size < 256)
        this.scripts.set(key, { version: versionKey(url) });
    }
  }
  response(info = {}) {
    const type = String(info.type || '').toLowerCase(), status = Number(info.status) || 0;
    if (info.mainDocument) this.documentStatus = status;
    if (info.fromCache) this.fromCache++;
    if (type === 'script' && status >= 200 && status < 400) {
      const key = resourceKey(info.url);
      if (!key) return;
      if (this.scripts.size >= 256 && !this.scripts.has(key)) { this.dropped++; return; }
      const old = this.scripts.get(key) || {};
      const etag = header(info.headers, 'etag'), modified = header(info.headers, 'last-modified');
      this.scripts.set(key, { ...old, version: versionKey(info.url),
        validator: (etag || modified) ? digest(etag + '|' + modified) : old.validator || '' });
    }
    const mime = String(info.mime || header(info.headers, 'content-type'));
    if (type === 'image' || /^image\//i.test(mime)) {
      if (status >= 200 && status < 400) this.images++;
      else if (status >= 400) this.imageErrors++;
    }
    if (type === 'xhr' || type === 'fetch') this.apiResponses++;
  }
  snapshot() {
    const entries = [...this.scripts].sort(([a], [b]) => a.localeCompare(b));
    // Keep identity, metadata and byte hashes separate: a missing body hash is not a change.
    return { scriptIdentity: entries.length ? digest(entries.map(([key, v]) => key + ':' + v.version).join('|')) : '',
      scriptMetadata: entries.length ? digest(entries.map(([key, v]) => key + ':' + (v.validator || '')).join('|')) : '',
      scriptBytes: entries.some(([, v]) => v.hash) ? digest(entries.filter(([, v]) => v.hash).map(([key, v]) => key + ':' + v.hash).join('|')) : '',
      hashedScripts: entries.filter(([, v]) => v.hash).length, scriptCount: entries.length,
      documentStatus: this.documentStatus, images: this.images, imageErrors: this.imageErrors,
      apiResponses: this.apiResponses, fromCache: this.fromCache, dropped: this.dropped };
  }
  attach(cdp, frameId) {
    this.detach(); this.cdp = cdp;
    const on = (name, fn) => { cdp.on(name, fn); this.handlers.push([name, fn]); };
    on('Network.requestWillBeSent', event => {
      if (event.type === 'Document' && event.frameId === frameId) this.begin(event.request.url);
    });
    on('Page.navigatedWithinDocument', event => {
      if (event.frameId === frameId) this.begin(event.url, true);
    });
    on('Network.responseReceived', event => this.response({ url: event.response.url,
      type: event.type, status: event.response.status, headers: event.response.headers,
      mime: event.response.mimeType, fromCache: event.response.fromDiskCache || event.response.fromServiceWorker,
      mainDocument: event.type === 'Document' && event.frameId === frameId }));
    // Network.enable is owned by the existing image store. Never overwrite its configuration.
  }
  detach() {
    for (const [name, fn] of this.handlers) this.cdp?.off(name, fn);
    this.handlers = []; this.cdp = null;
  }
}
module.exports = { SiteObserver, digest, resourceKey };
