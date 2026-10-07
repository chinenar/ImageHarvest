'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { chromeFetchManual } = require('./chrome-http.cjs');
const { chromeArgs, normalizeNetworkMode } = require('./network.cjs');

const { ProtectionCompatibility } = require('./protection-compatibility.cjs');
const { ChromeImageStore } = require('./chrome-image-store.cjs');
const { SiteObserver } = require('./site-observer.cjs');
const { PlaywrightBlocker } = require('@ghostery/adblocker-playwright');

// Dedicated app-owned Chrome profile. Never attach to the user's normal Chrome profile.
class ChromeBrowser {
  constructor(notify = () => {}, options = {}) {
    this.notify = notify; this.context = null; this.page = null; this.cdp = null;
    this.profileRoot = options.profileDir || ''; this.temporaryProfile = false;
    this.profile = ''; this.lastStatus = null; this.lastTitle = ''; this.userAgent = '';
    this.protectionEnabled = true; this.guard = null; this.images = null; this.observer = new SiteObserver();
    this.navigation = []; this.closing = false; this.networkMode = 'auto'; this.pageGeneration = 0;
    this.adblockEnabled = options.adblockEnabled !== false; this.adblockCacheFile = options.adblockCacheFile || ''; this.adblocker = null;
  }
  alive() { return Boolean(this.context && this.page && !this.page.isClosed()); }
  url() { return this.alive() ? this.page.url() : ''; }
  async loadAdblocker(force = false) {
    if (!this.adblockEnabled) return null;
    if (this.adblocker && !force) return this.adblocker;
    if (!this.adblockCacheFile) return null;
    try {
      const bytes = await fs.readFile(this.adblockCacheFile);
      this.adblocker = PlaywrightBlocker.deserialize(bytes);
      // ImageHarvest is a collector: block ad/tracker requests, but do not let
      // generic cosmetic rules hide page content before scanning.
      this.adblocker.config.loadCosmeticFilters = false;
      return this.adblocker;
    } catch { return null; }
  }
  async applyAdblocker(page = this.page) {
    if (!page || page.isClosed()) return false;
    const blocker = await this.loadAdblocker();
    if (!blocker) return false;
    if (this.adblockEnabled) {
      if (!blocker.isBlockingEnabled(page)) await blocker.enableBlockingInPage(page);
    } else if (blocker.isBlockingEnabled(page)) {
      await blocker.disableBlockingInPage(page);
    }
    return true;
  }
  async setAdblockEnabled(enabled) {
    this.adblockEnabled = enabled !== false;
    if (!this.page || this.page.isClosed()) return this.adblockEnabled;
    if (!this.adblockEnabled) {
      const blocker=this.adblocker;
      if (blocker?.isBlockingEnabled(this.page)) await blocker.disableBlockingInPage(this.page);
      return false;
    }
    const blocker = await this.loadAdblocker();
    if (blocker && !blocker.isBlockingEnabled(this.page)) await blocker.enableBlockingInPage(this.page);
    return true;
  }
  async reloadAdblocker() {
    if (this.adblocker && this.page && !this.page.isClosed() && this.adblocker.isBlockingEnabled(this.page)) {
      await this.adblocker.disableBlockingInPage(this.page).catch(() => {});
    }
    this.adblocker = null;
    return this.applyAdblocker(this.page);
  }
  async adoptPage(page) {
    if (!page || page.isClosed() || !this.context) return false;
    const generation = ++this.pageGeneration;
    const oldGuard = this.guard, oldImages = this.images;
    this.page = page; this.lastStatus = null; this.lastTitle = '';
    page.on('download', d => d.cancel().catch(() => {}));
    page.on('framenavigated', frame => {
      if (page !== this.page || frame !== page.mainFrame()) return;
      this.lastTitle = ''; this.navigation.push(frame.url());
      this.navigation = this.navigation.slice(-20);
      this.notify('navigation', { url: frame.url(), backend: 'chrome' });
    });
    page.on('response', response => {
      if (page === this.page && response.request().isNavigationRequest() && response.frame() === page.mainFrame()) this.lastStatus = response.status();
    });
    page.on('close', () => { if (!this.closing && this.page === page) this.notify('browser-closed', { backend: 'chrome' }); });
    const cdp = await this.context.newCDPSession(page);
    if (generation !== this.pageGeneration || this.page !== page) { await cdp.detach().catch(() => {}); return false; }
    this.cdp = cdp;
    this.observer.begin(page.url());
    const { frameTree } = await cdp.send('Page.getFrameTree');
    this.observer.attach(cdp, frameTree.frame.id);
    await oldGuard?.dispose().catch(() => {});
    await oldImages?.close().catch(() => {});
    this.guard = new ProtectionCompatibility(this.protectionEnabled, page, cdp, (type, data) => {
      if (type === 'script-observed') this.observer.scriptHash(data.url, data.hash);
      else this.notify(type, data);
    });
    await this.guard.install();
    this.images = new ChromeImageStore(cdp, path.join(this.profile, 'image-responses'));
    await this.images.install();
    await this.applyAdblocker(page).catch(() => {});
    if (!this.userAgent) this.userAgent = await page.evaluate(() => navigator.userAgent);
    this.lastTitle = await page.title().catch(() => '');
    if (/^https?:\/\//i.test(page.url())) this.notify('navigation', { url: page.url(), backend: 'chrome', adopted: true });
    await page.bringToFront().catch(() => {});
    return true;
  }
  async start() {
    if (this.alive()) return;
    if (this.context) await this.close();
    this.closing = false;
    this.temporaryProfile = !this.profileRoot;
    this.profile = this.profileRoot || await fs.mkdtemp(path.join(os.tmpdir(), 'ImageHarvest-Chrome-'));
    if (this.profileRoot) await fs.mkdir(this.profile, { recursive: true });
    try {
      const { chromium } = await import('playwright-core');
      this.context = await chromium.launchPersistentContext(this.profile, {
        channel: 'chrome', headless: false, viewport: null, chromiumSandbox: true,
        acceptDownloads: false, ...(this.protectionEnabled ? { serviceWorkers: 'block' } : {}), timeout: 45000, args: chromeArgs(this.networkMode)
      });
      const initialPage = this.context.pages()[0] || await this.context.newPage();
      await this.adoptPage(initialPage);
      // Keep popup/reader tabs alive and follow the newest page instead of closing it.
      this.context.on('page', page => {
        if (page === this.page) return;
        this.adoptPage(page).catch(error => this.notify('error', { message: `สลับไปแท็บใหม่ไม่สำเร็จ: ${error.message || error}` }));
      });
    } catch (error) {
      await this.close();
      throw new Error(`เปิด Google Chrome ไม่สำเร็จ ตรวจว่าติดตั้ง Chrome แล้วและไม่มีนโยบายองค์กรปิดการควบคุม: ${error.message.split('\n')[0]}`);
    }
  }
  async open(url, enabled = true) {
    enabled = enabled !== false;
    if (enabled !== this.protectionEnabled) { await this.close(); this.protectionEnabled = enabled; }
    await this.start(); this.lastStatus = null;
    const response = await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    this.lastStatus = response?.status() ?? this.lastStatus;
    this.lastTitle = await this.page.title();
    return { url: this.url(), title: this.lastTitle, httpStatus: this.lastStatus, backend: 'chrome' };
  }
  observationInfo(sources = []) { this.observer.seedScripts(sources); return this.observer.snapshot(); }
  compatibilityInfo() { return { ...(this.guard?.info() || { enabled: this.protectionEnabled, events: [], error: '', applied: 0, unknown: 0 }), images: this.images?.info() || null }; }
  async loadedImage(url) { return this.images ? this.images.read(url) : null; }
  async settleImages() { if (this.images) await this.images.settle(); }
  async evaluate(code) {
    if (this.guard?.error) throw new Error(this.guard.error);
    if (!this.alive()) throw new Error('หน้าต่าง Chrome ปิดแล้ว กรุณาเปิดเว็บใหม่');
    if (!/^https?:\/\//i.test(this.url())) throw new Error('หน้าอ่านเปลี่ยนไปหรือถูกส่งออกไป about:blank กรุณาตรวจหน้าต่าง Chrome');
    // Isolated DOM evaluation; content-signature response handling is optional in ProtectionCompatibility.
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
  async evaluateMain(code) {
    if (!this.alive()) throw new Error('หน้าต่าง Chrome ปิดแล้ว กรุณาเปิดเว็บใหม่');
    if (!/^https?:\/\//i.test(this.url())) throw new Error('หน้าเว็บยังไม่พร้อมสำหรับคำสั่งตัวอ่าน');
    return this.page.evaluate(code);
  }
  async setNetworkMode(mode) {
    mode = normalizeNetworkMode(mode);
    if (mode === this.networkMode) return false;
    this.networkMode = mode;
    if (this.context) await this.close();
    return true;
  }
  async show() {
    if (!this.alive()) throw new Error('กรุณาเปิดเว็บด้วย Chrome ก่อน');
    await this.page.bringToFront(); return true;
  }
  async title() { return this.alive() ? this.page.title() : this.lastTitle; }
  async fetchManual(url, options, limit) {
    if (!this.alive()) throw new Error('กรุณาเปิดหน้าต่าง Chrome ของแอปค้างไว้');
    return chromeFetchManual(url, options, this.context, this.userAgent, limit, this.networkMode);
  }
  async close() {
    this.closing = true; this.observer.detach();
    const context = this.context, profile = this.profile, temporaryProfile = this.temporaryProfile;
    this.context = null; this.page = null; this.cdp = null; this.profile = ''; this.temporaryProfile = false; this.pageGeneration++;
    if (context) await context.close().catch(() => {});
    if (this.guard) await this.guard.dispose();
    if (this.images) await this.images.close();
    this.guard = null; this.images = null;
    if (profile && temporaryProfile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
}
module.exports = { ChromeBrowser };
