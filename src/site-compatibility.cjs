'use strict';
const { RULE_VERSION, MAX_SCRIPT, sha256, siteForURL, ntrBlockedScript, patchPengi, classifyPengi, modifiedHeaders } = require('./site-rules.cjs');
class SiteCompatibility {
  constructor(site, page, cdp, notify = () => {}) {
    this.site = site; this.page = page; this.cdp = cdp; this.notify = notify;
    this.events = []; this.error = ''; this.closed = false;
  }
  info() { return { site: this.site, ruleVersion: RULE_VERSION, error: this.error, events: this.events.slice() }; }
  record(kind, path, hash = '') {
    if (this.events.length < 50) this.events.push({ kind, path, ...(hash ? { sha256: hash } : {}) });
    this.notify('site-compatibility', this.info());
  }
  async install() {
    if (!this.site) return;
    this.listener = event => this.paused(event).catch(error => {
      this.error = error.message; this.notify('site-compatibility', this.info());
      this.cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    });
    this.cdp.on('Fetch.requestPaused', this.listener);
    const patterns = this.site === 'ntrnaja' ? [
      { urlPattern: 'https://cdn.jsdelivr.net/npm/disable-devtool@0.3.9*', resourceType: 'Script', requestStage: 'Request' },
      { urlPattern: 'https://ntrnaja.com/wp-content/plugins/wccp-pro/index.js*', resourceType: 'Script', requestStage: 'Request' }
    ] : [{ urlPattern: 'https://pengi.co/_nuxt/*.js*', resourceType: 'Script', requestStage: 'Response' }];
    await this.cdp.send('Fetch.enable', { patterns });
  }
  async paused(event) {
    const id = event.requestId, u = new URL(event.request.url);
    const proceed = () => this.cdp.send('Fetch.continueRequest', { requestId: id });
    if (this.closed || siteForURL(this.page.url()) !== this.site) return proceed();
    if (this.site === 'ntrnaja') {
      if (!ntrBlockedScript(u.href)) return proceed();
      this.record('blocked-script', u.hostname + u.pathname);
      return this.cdp.send('Fetch.failRequest', { requestId: id, errorReason: 'BlockedByClient' });
    }
    if (u.hostname !== 'pengi.co' || !u.pathname.startsWith('/_nuxt/') || !u.pathname.endsWith('.js')) return proceed();
    // Never replace 401/403/challenge responses with successful content.
    if (event.responseStatusCode !== 200) {
      this.record('http-' + event.responseStatusCode, u.pathname); return proceed();
    }
    try {
      const headers = event.responseHeaders || [];
      const length = Number(headers.find(h => h.name.toLowerCase() === 'content-length')?.value || 0);
      if (length > MAX_SCRIPT) throw new Error('Pengi: ไฟล์สคริปต์ใหญ่เกินขอบเขตที่ตรวจไว้');
      const data = await this.cdp.send('Fetch.getResponseBody', { requestId: id });
      const bytes = Buffer.from(data.body, data.base64Encoded ? 'base64' : 'utf8');
      if (bytes.length > MAX_SCRIPT) throw new Error('Pengi: ไฟล์สคริปต์ใหญ่เกินขอบเขตที่ตรวจไว้');
      const classification = classifyPengi(u.pathname, bytes);
      if (classification === 'unrelated') return proceed();
      if (classification === 'unknown-guard') throw new Error('Pengi เปลี่ยนไฟล์ตัวอ่าน: หยุดไว้ก่อน ต้องอัปเดตกฎที่ตรวจแล้ว');
      const body = patchPengi(bytes);
      await this.cdp.send('Fetch.fulfillRequest', { requestId: id, responseCode: 200,
        responseHeaders: modifiedHeaders(headers, body.length), body: body.toString('base64') });
      this.record('patched-reviewed-reader', u.pathname, sha256(bytes));
    } catch (error) {
      this.error = error.message;
      this.record('stopped-unreviewed-script', u.pathname);
      await this.cdp.send('Fetch.failRequest', { requestId: id, errorReason: 'BlockedByClient' }).catch(() => {});
    }
  }
  async dispose() {
    this.closed = true;
    if (this.listener) this.cdp.off('Fetch.requestPaused', this.listener);
    await this.cdp.send('Fetch.disable').catch(() => {});
  }
}
module.exports = { SiteCompatibility };
