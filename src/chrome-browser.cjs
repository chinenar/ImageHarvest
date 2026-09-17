'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { chromeFetchManual } = require('./chrome-http.cjs');

// Google Chrome is a separate, visible browser. Never attach to a personal profile.
class ChromeBrowser {
  constructor(notify = () => {}) {
    this.notify = notify; this.context = null; this.page = null; this.cdp = null;
    this.profile = ''; this.lastStatus = null; this.lastTitle = ''; this.userAgent = '';
    this.navigation = []; this.closing = false;
  }
  alive() { return Boolean(this.context && this.page && !this.page.isClosed()); }
  url() { return this.alive() ? this.page.url() : ''; }
  async start() {
    if (this.alive()) return;
    if (this.context) await this.close();
    this.closing = false;
    this.profile = await fs.mkdtemp(path.join(os.tmpdir(), 'ImageHarvest-Chrome-'));
    try {
      const { chromium } = await import('playwright-core');
      this.context = await chromium.launchPersistentContext(this.profile, {
        channel: 'chrome', headless: false, viewport: null, chromiumSandbox: true,
        acceptDownloads: false, timeout: 45000
      });
      this.page = this.context.pages()[0] || await this.context.newPage();
      // This mode owns one tab. Extra popups are closed, not silently scanned.
      this.context.on('page', p => { if (p !== this.page) p.close().catch(() => {}); });
      this.page.on('download', d => d.cancel().catch(() => {}));
      this.page.on('framenavigated', frame => {
        if (frame !== this.page?.mainFrame()) return;
        this.lastTitle = ''; this.navigation.push(frame.url());
        this.navigation = this.navigation.slice(-20);
        this.notify('navigation', { url: frame.url(), backend: 'chrome' });
      });
      this.page.on('response', r => {
        if (r.request().isNavigationRequest() && r.frame() === this.page?.mainFrame()) this.lastStatus = r.status();
      });
      this.page.on('close', () => { if (!this.closing) this.notify('browser-closed', { backend: 'chrome' }); });
      this.cdp = await this.context.newCDPSession(this.page);
      this.userAgent = await this.page.evaluate(() => navigator.userAgent);
    } catch (error) {
      await this.close();
      throw new Error(`เปิด Google Chrome ไม่สำเร็จ ตรวจว่าติดตั้ง Chrome แล้วและไม่มีนโยบายองค์กรปิดการควบคุม: ${error.message.split('\n')[0]}`);
    }
  }
  async open(url) {
    await this.start(); this.lastStatus = null;
    const response = await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    this.lastStatus = response?.status() ?? this.lastStatus;
    this.lastTitle = await this.page.title();
    return { url: this.url(), title: this.lastTitle, httpStatus: this.lastStatus, backend: 'chrome' };
  }
  async evaluate(code) {
    if (!this.alive()) throw new Error('หน้าต่าง Chrome ปิดแล้ว กรุณาเปิดเว็บใหม่');
    if (!/^https?:\/\//i.test(this.url())) throw new Error('หน้าอ่านเปลี่ยนไปหรือถูกส่งออกไป about:blank กรุณาตรวจหน้าต่าง Chrome');
    // CDP transport is not the DevTools UI. No Debugger.enable or script interception.
    const { frameTree } = await this.cdp.send('Page.getFrameTree');
    const { executionContextId } = await this.cdp.send('Page.createIsolatedWorld', {
      frameId: frameTree.frame.id, worldName: 'ImageHarvestCollector', grantUniveralAccess: false
    });
    const response = await this.cdp.send('Runtime.evaluate', {
      expression: code, contextId: executionContextId, returnByValue: true,
      awaitPromise: true, timeout: 15000
    });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'หน้าเว็บประมวลผลไม่ได้');
    return response.result.value;
  }
  async show() {
    if (!this.alive()) throw new Error('กรุณาเปิดเว็บด้วย Chrome ก่อน');
    await this.page.bringToFront(); return true;
  }
  async title() { return this.alive() ? this.page.title() : this.lastTitle; }
  async fetchManual(url, options, limit) {
    if (!this.alive()) throw new Error('กรุณาเปิดหน้าต่าง Chrome ของแอปค้างไว้');
    return chromeFetchManual(url, options, this.context, this.userAgent, limit);
  }
  async close() {
    this.closing = true;
    const context = this.context, profile = this.profile;
    this.context = null; this.page = null; this.cdp = null; this.profile = '';
    if (context) await context.close().catch(() => {});
    if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
}
module.exports = { ChromeBrowser };
