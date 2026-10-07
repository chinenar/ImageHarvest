'use strict';
const { EventEmitter } = require('node:events');
// Only a freshly launched, app-owned browser on loopback is accepted.
class CdpTransport extends EventEmitter {
  constructor() { super(); this.ws = null; this.next = 0; this.pending = new Map(); this.methods = new Set(); }
  static async connect(endpoint, timeout = 10000) {
    const url = new URL(endpoint);
    if (url.protocol !== 'ws:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw new Error('CDP endpoint must be loopback');
    const connection = new CdpTransport(), ws = new WebSocket(endpoint); connection.ws = ws;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error('CDP connection timeout')); }, timeout);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, {once:true});
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')); }, {once:true});
    });
    ws.addEventListener('message', event => connection.receive(event.data));
    ws.addEventListener('close', () => connection.disconnected());
    ws.addEventListener('error', () => connection.disconnected());
    return connection;
  }
  get connected() { return this.ws?.readyState === WebSocket.OPEN; }
  receive(data) {
    let message; try { message = JSON.parse(String(data)); } catch { return; }
    if (!message.id) { if (message.method) this.emit(message.method, message.params || {}); return; }
    const pending = this.pending.get(message.id); if (!pending) return;
    this.pending.delete(message.id); clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result || {});
  }
  send(method, params = {}, timeout = 20000) {
    if (!this.connected) return Promise.reject(new Error('Chrome connection closed'));
    this.methods.add(method);
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Chrome timeout: ${method}`)); }, timeout);
      this.pending.set(id, {resolve, reject, timer});
      try { this.ws.send(JSON.stringify({id, method, params})); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  disconnected() {
    const ws = this.ws; if (!ws) return; this.ws = null;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Chrome connection closed')); }
    this.pending.clear(); this.emit('disconnected');
    if (ws.readyState === WebSocket.OPEN) ws.close();
  }
  close() { const ws = this.ws; this.disconnected(); if (ws?.readyState === WebSocket.OPEN) ws.close(); }
}
module.exports = { CdpTransport };
