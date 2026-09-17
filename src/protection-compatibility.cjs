'use strict';
const { RULE_VERSION, MAX_SCRIPT, inspectScript, patchScript, modifiedHeaders } = require('./protection-rules.cjs');
const SCRIPT_BUDGET = 32 * 1024 * 1024, SCRIPT_COUNT = 300;
function publicURL(value) { try { const u = new URL(value); return u.origin + u.pathname.slice(0, 300); } catch { return '[script]'; } }
class ProtectionCompatibility {
  constructor(enabled, page, cdp, notify = () => {}) {
    this.enabled = enabled; this.page = page; this.cdp = cdp; this.notify = notify; this.closed = false; this.reset();
  }
  reset() { this.epoch = (this.epoch || 0) + 1; this.events = []; this.error = ''; this.inspected = 0; this.bytes = 0; this.applied = 0; this.unknown = 0; this.skipped = 0; this.seen = new Set(); }
  info() { return { enabled: this.enabled, ruleVersion: RULE_VERSION, error: this.error, inspected: this.inspected, applied: this.applied, unknown: this.unknown, skipped: this.skipped, events: this.events.slice() }; }
  record(kind, event, extra = {}) {
    const url = publicURL(event.request.url), key = `${kind}|${url}|${extra.hash || ''}`;
    if (this.seen.has(key)) return; this.seen.add(key);
    if (this.events.length < 60) this.events.push({ kind, url, ...extra });
    this.notify('protection-compatibility', this.info());
  }
  async install() {
    if (!this.enabled) return;
    this.listener = event => { void this.paused(event).catch(error => {
      if (this.closed) return; this.error = `ระบบตรวจสคริปต์หยุด: ${error.message}`; this.record('error', event);
      this.cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    }); };
    this.navigationListener = ({ frame }) => { if (!frame.parentId) { this.reset(); this.notify('protection-compatibility', this.info()); } };
    this.cdp.on('Page.frameNavigated', this.navigationListener); this.cdp.on('Fetch.requestPaused', this.listener);
    await this.cdp.send('Page.enable');
    // No domain, extension, filename or vendor-CDN filter.
    await this.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Script', requestStage: 'Response' }] });
  }
  async paused(event) {
    const epoch = this.epoch, requestId = event.requestId, proceed = () => this.cdp.send('Fetch.continueRequest', { requestId });
    if (this.closed || !this.enabled || !/^https?:\/\//i.test(event.request.url)) return proceed();
    // Authentication, errors and server challenges are not converted to success.
    if (event.responseStatusCode !== 200 || event.responseErrorReason) return proceed();
    const headers = event.responseHeaders || [];
    const length = Number(headers.find(h => h.name.toLowerCase() === 'content-length')?.value || 0);
    if (length > MAX_SCRIPT || this.inspected >= SCRIPT_COUNT || this.bytes >= SCRIPT_BUDGET) { this.skipped++; this.record('analysis-limit', event); return proceed(); }
    let data, timer;
    try {
      data = await Promise.race([this.cdp.send('Fetch.getResponseBody', { requestId }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('body timeout')), 4000); })]);
    } catch { this.skipped++; this.record('body-unavailable', event); return proceed(); }
    finally { clearTimeout(timer); }
    if (this.closed || epoch !== this.epoch) return proceed();
    if (data.body.length > MAX_SCRIPT * (data.base64Encoded ? 4 / 3 : 1) + 8) { this.skipped++; this.record('analysis-limit', event); return proceed(); }
    const bytes = Buffer.from(data.body, data.base64Encoded ? 'base64' : 'utf8');
    this.inspected++; this.bytes += bytes.length;
    const analysis = inspectScript(bytes);
    if (analysis.kind === 'known') {
      const patched = patchScript(bytes);
      await this.cdp.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: modifiedHeaders(headers, patched.body.length), body: patched.body.toString('base64') });
      this.applied++; this.record('applied', event, { family: patched.rule.family, rule: patched.rule.id, hash: patched.hash }); return;
    }
    if (analysis.kind === 'unsafe-unknown') {
      this.error = 'พบโค้ดเสี่ยงทำให้แท็บค้างที่ยังไม่ตรงกฎ — ระงับสคริปต์นี้และหยุดสแกนให้ตรวจใหม่';
      this.unknown++; this.record('blocked-unsafe-unknown', event, { family: analysis.family, hash: analysis.hash });
      return this.cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    }
    if (analysis.kind === 'unknown') { this.unknown++; this.record('unknown-unchanged', event, { family: analysis.family, hash: analysis.hash }); }
    return proceed();
  }
  async dispose() {
    this.closed = true;
    if (this.listener) this.cdp.off('Fetch.requestPaused', this.listener);
    if (this.navigationListener) this.cdp.off('Page.frameNavigated', this.navigationListener);
    if (this.enabled) await this.cdp.send('Fetch.disable').catch(() => {});
  }
}
module.exports = { ProtectionCompatibility, SCRIPT_BUDGET, SCRIPT_COUNT, publicURL };
