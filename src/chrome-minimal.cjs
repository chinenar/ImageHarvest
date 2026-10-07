'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { CdpTransport } = require('./cdp-transport.cjs');
const { ChromeImageStore } = require('./chrome-image-store.cjs');
const { SiteObserver } = require('./site-observer.cjs');
const { chromeFetchManual } = require('./chrome-http.cjs');
const { chromeArgs, normalizeNetworkMode } = require('./network.cjs');
const { FiltersEngine, Request } = require('@ghostery/adblocker');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function findChrome() {
  const candidates = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
    .filter(Boolean).map(base => path.join(base, 'Google','Chrome','Application','chrome.exe'));
  for (const file of candidates) { try { await fs.access(file); return file; } catch {} }
  throw new Error('ไม่พบ Google Chrome กรุณาติดตั้ง Chrome ก่อนใช้โหมดนี้');
}
async function findDebugPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address(), port = address && typeof address === 'object' ? address.port : 0;
      server.close(error => error ? reject(error) : (port ? resolve(port) : reject(new Error('หา local debug port ไม่สำเร็จ'))));
    });
  });
}
// No Playwright attachment, page-script patches, CSP bypass, or Runtime.enable.
class MinimalChrome {
  constructor(notify = () => {}, options = {}) {
    this.notify = notify; this.cdp = null; this.browserCdp = null; this.child = null;
    this.profileRoot = options.profileDir || ''; this.temporaryProfile = false;
    this.context = null; this.profile = ''; this.images = null; this.currentURL = '';
    this.lastStatus = null; this.lastTitle = ''; this.userAgent = ''; this.navigation = [];
    this.networkMode = 'auto'; this.closing = false; this.error = ''; this.frameId = '';
    this.debugPort = 0; this.targetId = ''; this.targetGeneration = 0; this.observer = new SiteObserver();
    this.adblockEnabled = options.adblockEnabled !== false; this.adblockCacheFile = options.adblockCacheFile || ''; this.adblocker = null; this.adblockHandler = null;
  }
  alive() { return Boolean(this.context && this.cdp?.connected); }
  url() { return this.currentURL; }
  async loadAdblocker(force=false) {
    if(!this.adblockEnabled) return null;
    if(this.adblocker && !force) return this.adblocker;
    if(!this.adblockCacheFile) return null;
    try {
      const bytes=await fs.readFile(this.adblockCacheFile);
      this.adblocker=FiltersEngine.deserialize(bytes);
      return this.adblocker;
    } catch { return null; }
  }
  normalizeAdblockType(type='Other') {
    const key=String(type||'Other').toLowerCase();
    if(key==='document') return 'document';
    if(key==='stylesheet') return 'stylesheet';
    if(key==='image') return 'image';
    if(key==='media') return 'media';
    if(key==='font') return 'font';
    if(key==='script') return 'script';
    if(key==='xhr') return 'xhr';
    if(key==='fetch') return 'fetch';
    if(key==='eventsource') return 'eventsource';
    if(key==='websocket') return 'websocket';
    if(key==='manifest') return 'manifest';
    if(key==='ping') return 'ping';
    return 'other';
  }
  async installAdblockInterception(cdp=this.cdp) {
    if(!cdp?.connected) return false;
    const blocker=await this.loadAdblocker();
    if(!blocker || !this.adblockEnabled) {
      await cdp.send('Fetch.disable').catch(()=>{});
      return false;
    }
    if(this.adblockHandler && this.adblockHandler.cdp===cdp) {
      await cdp.send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]}).catch(()=>{});
      return true;
    }
    await cdp.send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
    const handler=event=>{
      if(this.cdp!==cdp) return;
      const resume=()=>cdp.send('Fetch.continueRequest',{requestId:event.requestId}).catch(()=>{});
      if(!this.adblockEnabled || !this.adblocker){resume();return}
      try {
        const request=Request.fromRawDetails({
          requestId:String(event.requestId||'0'),
          url:event.request?.url||'',
          sourceUrl:this.currentURL||'',
          type:this.normalizeAdblockType(event.resourceType),
          _originalRequestDetails:event
        });
        if(request.isMainFrame()){resume();return}
        if(this.adblocker.config.guessRequestTypeFromUrl===true && request.type==='other') request.guessTypeOfRequest();
        const result=this.adblocker.match(request);
        if(result.redirect?.dataUrl){
          cdp.send('Fetch.continueRequest',{requestId:event.requestId,url:result.redirect.dataUrl}).catch(()=>resume());
        } else if(result.match){
          cdp.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'BlockedByClient'}).catch(()=>resume());
        } else resume();
      } catch { resume(); }
    };
    cdp.on('Fetch.requestPaused',handler);
    this.adblockHandler={cdp,handler};
    return true;
  }
  async setAdblockEnabled(enabled) {
    this.adblockEnabled=enabled!==false;
    if(!this.cdp?.connected) return this.adblockEnabled;
    if(this.adblockEnabled) await this.installAdblockInterception(this.cdp);
    else await this.cdp.send('Fetch.disable').catch(()=>{});
    return this.adblockEnabled;
  }
  async reloadAdblocker() {
    this.adblocker=null;
    if(!this.adblockEnabled) return false;
    await this.loadAdblocker(true);
    if(this.cdp?.connected) await this.installAdblockInterception(this.cdp);
    return Boolean(this.adblocker);
  }
  async adoptTarget(targetId) {
    if (!targetId || !this.debugPort) return false;
    const generation = ++this.targetGeneration;
    let target;
    for (let i = 0; i < 30 && !target; i++) {
      const list = await fetch(`http://127.0.0.1:${this.debugPort}/json/list`, {signal:AbortSignal.timeout(3000)}).then(r => r.json()).catch(() => []);
      target = list.find(item => item.type === 'page' && item.id === targetId);
      if (!target) await sleep(50);
    }
    if (!target?.webSocketDebuggerUrl) return false;
    const next = await CdpTransport.connect(target.webSocketDebuggerUrl);
    const previous = this.cdp, previousImages = this.images;
    this.adblockHandler = null;
    if (generation !== this.targetGeneration) { next.close(); return false; }
    this.cdp = next; this.targetId = targetId; this.frameId = ''; this.lastStatus = null; this.lastTitle = '';
    this.context = { cookies: async url => (await next.send('Network.getCookies', {urls:[url]})).cookies };
    const navigate = url => {
      if (this.cdp !== next) return;
      this.currentURL = url; this.lastTitle = ''; this.navigation.push(url); this.navigation = this.navigation.slice(-20);
      this.notify('navigation',{url,backend:'chrome'});
    };
    next.on('Page.frameNavigated', ({frame}) => { if (!frame.parentId && this.cdp === next) { this.frameId = frame.id; navigate(frame.url); } });
    next.on('Page.navigatedWithinDocument', event => { if (this.cdp === next && event.frameId === this.frameId) navigate(event.url); });
    next.on('Network.responseReceived', event => { if (this.cdp === next && event.type === 'Document' && event.frameId === this.frameId) this.lastStatus = event.response.status; });
    next.on('disconnected', () => { if (!this.closing && this.cdp === next) this.notify('browser-closed',{backend:'chrome'}); });
    await next.send('Page.enable');
    await this.installAdblockInterception(next).catch(()=>{});
    const tree = await next.send('Page.getFrameTree'); this.frameId = tree.frameTree.frame.id;
    this.currentURL = target.url || tree.frameTree.frame.url || this.currentURL;
    this.observer.begin(this.currentURL); this.observer.attach(next, this.frameId);
    const images = new ChromeImageStore(next,path.join(this.profile,'image-responses'));
    await images.install(); this.images = images;
    await previousImages?.close().catch(() => {}); previous?.close();
    if (/^https?:\/\//i.test(this.currentURL)) this.notify('navigation',{url:this.currentURL,backend:'chrome',adopted:true});
    await next.send('Page.bringToFront').catch(() => {});
    return true;
  }
  async start() {
    if (this.alive()) return;
    if (this.context || this.profile) await this.close();
    this.closing = false; this.error = ''; this.temporaryProfile = !this.profileRoot;
    this.profile = this.profileRoot || await fs.mkdtemp(path.join(os.tmpdir(),'ImageHarvest-Minimal-'));
    if (this.profileRoot) await fs.mkdir(this.profile,{recursive:true});
    // Persistent profiles can retain DevToolsActivePort from the previous controlled session.
    // Remove it before launch so we never connect to a stale localhost port.
    await fs.rm(path.join(this.profile,'DevToolsActivePort'),{force:true}).catch(()=>{});
    try {
      const executable = await findChrome();
      // Chrome treats --remote-debugging-port=0 as automation and exposes navigator.webdriver=true.
      // Use a random non-zero loopback port so ordinary sites keep the normal webdriver=false state.
      const port = await findDebugPort();
      const args = [`--user-data-dir=${this.profile}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
        '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
        '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--window-size=1280,900',
        ...chromeArgs(this.networkMode), 'about:blank'];
      this.child = spawn(executable, args, {stdio:'ignore'});
      let launchError; this.child.once('error', error => { launchError = error; });
      const info = async endpoint => (await fetch(`http://127.0.0.1:${port}${endpoint}`, {signal:AbortSignal.timeout(2000)})).json();
      let version;
      for (let i = 0; i < 100; i++) {
        if (launchError) throw launchError;
        if (this.child.exitCode !== null) throw new Error('Chrome exited before startup');
        try { version = await info('/json/version'); if (version?.webSocketDebuggerUrl) break; } catch {}
        await sleep(150);
      }
      if (!version?.webSocketDebuggerUrl) throw new Error('Chrome startup timeout');
      this.debugPort = port;
      const targets = await info('/json/list');
      const target = targets.find(item => item.type === 'page'); if (!target) throw new Error('Chrome has no page');
      this.browserCdp = await CdpTransport.connect(version.webSocketDebuggerUrl);
      this.userAgent = version['User-Agent'] || '';
      await this.adoptTarget(target.id);
      this.browserCdp.on('Target.targetCreated', ({targetInfo}) => {
        if (targetInfo.type !== 'page' || targetInfo.targetId === this.targetId) return;
        const followsCurrent = !targetInfo.openerId || targetInfo.openerId === this.targetId;
        if (!followsCurrent) return;
        this.adoptTarget(targetInfo.targetId).catch(error => this.notify('error', { message: `สลับไปแท็บใหม่ไม่สำเร็จ: ${error.message || error}` }));
      });
      await this.browserCdp.send('Target.setDiscoverTargets', {discover:true});
      await this.browserCdp.send('Browser.setDownloadBehavior', {behavior:'deny'});
      for (const name of ['geolocation','notifications','audioCapture','videoCapture','clipboardReadWrite']) {
        await this.browserCdp.send('Browser.setPermission', {permission:{name}, setting:'denied'}).catch(() => {});
      }
    } catch (error) { await this.close(); throw new Error(`เปิด Chrome Minimal ไม่สำเร็จ: ${error.message}`); }
  }
  async rawEvaluate(expression, timeout = 15000) {
    const frameId = this.frameId || (await this.cdp.send('Page.getFrameTree')).frameTree.frame.id;
    const {executionContextId} = await this.cdp.send('Page.createIsolatedWorld', {
      frameId, worldName:'ImageHarvestCollector', grantUniveralAccess:false});
    const result = await this.cdp.send('Runtime.evaluate', {expression, contextId:executionContextId,
      returnByValue:true, awaitPromise:true, timeout}, timeout + 1000);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }
  async open(url) {
    await this.start(); this.lastStatus = null;
    await this.show();
    const navigation = await this.cdp.send('Page.navigate',{url},45000);
    if (navigation.errorText) throw new Error(navigation.errorText);
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (!this.alive()) throw new Error('Chrome closed during navigation');
      try {
        const ready = await this.rawEvaluate('document.readyState',3000);
        if (ready !== 'loading' && this.currentURL && this.currentURL !== 'about:blank') break;
      } catch (error) {
        if (/^Chrome timeout:/.test(error.message || '')) {
          throw new Error('หน้าเว็บเปิดแล้ว แต่ viewer ไม่ตอบรับคำสั่งควบคุมของ Chrome Minimal — เว็บไซต์อาจป้องกันหรือหยุด browser automation');
        }
      }
      await sleep(150);
    }
    if (!this.currentURL || this.currentURL === 'about:blank') throw new Error('Chrome did not reach the requested page');
    await this.show();
    // Allow client-side readers to hydrate before the first scan; not a detector override.
    await sleep(3000);
    this.lastTitle = await this.title(); this.notify('protection-compatibility',this.compatibilityInfo());
    return {url:this.url(),title:this.lastTitle,httpStatus:this.lastStatus,backend:'chrome',controlMode:'minimal'};
  }
  async evaluate(code) {
    if (!this.alive()) throw new Error('หน้าต่าง Chrome ปิดแล้ว กรุณาเปิดเว็บใหม่');
    if (!/^https?:\/\//i.test(this.url())) throw new Error('หน้าเว็บนำทางออกจากหน้าอ่าน กรุณาตรวจหน้าต่าง Chrome');
    return this.rawEvaluate(code);
  }
  async evaluateMain(expression, timeout = 15000) {
    if (!this.alive()) throw new Error('หน้าต่าง Chrome ปิดแล้ว กรุณาเปิดเว็บใหม่');
    if (!/^https?:\/\//i.test(this.url())) throw new Error('หน้าเว็บยังไม่พร้อมสำหรับคำสั่งตัวอ่าน');
    const result = await this.cdp.send('Runtime.evaluate', {expression, returnByValue:true, awaitPromise:true, timeout}, timeout + 1000);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }
  observationInfo(sources = []) { this.observer.seedScripts(sources); return this.observer.snapshot(); }
  compatibilityInfo() { return {enabled:false,controlMode:'minimal',error:this.error,applied:0,unknown:0,skipped:0,inspected:0,events:[],
    scriptsModified:false,devtoolsPanel:false,cdpMethods:[...(this.cdp?.methods || [])].sort(),images:this.images?.info() || null}; }
  async loadedImage(url) { return this.images ? this.images.read(url) : null; }
  async settleImages() { await this.images?.settle(); }
  async show() { if (!this.alive()) throw new Error('กรุณาเปิดเว็บด้วย Chrome ก่อน'); await this.cdp.send('Page.bringToFront'); return true; }
  async title() { return this.alive() ? this.rawEvaluate('document.title') : this.lastTitle; }
  async fetchManual(url,options,limit) { if (!this.alive()) throw new Error('กรุณาเปิด Chrome ค้างไว้'); return chromeFetchManual(url,options,this.context,this.userAgent,limit,this.networkMode); }
  async setNetworkMode(mode) { mode = normalizeNetworkMode(mode); if (mode === this.networkMode) return false;
    this.networkMode = mode; if (this.context || this.profile) await this.close(); return true; }
  async close() {
    if (this.closing && !this.profile) return;
    this.closing = true; this.observer.detach();
    const profile = this.profile, temporaryProfile = this.temporaryProfile, child = this.child, browserCdp = this.browserCdp, cdp = this.cdp, images = this.images;
    this.context = null; this.profile = ''; this.temporaryProfile = false; this.child = null; this.browserCdp = null; this.cdp = null; this.images = null;
    this.debugPort = 0; this.targetId = ''; this.frameId = ''; this.targetGeneration++;
    if (browserCdp?.connected) await browserCdp.send('Browser.close',{},2500).catch(() => {});
    cdp?.close(); browserCdp?.close();
    if (child) {
      for (let i = 0; i < 10 && child.exitCode === null && child.signalCode === null; i++) await sleep(100);
      // Kill ONLY this app-created browser tree if graceful closure failed.
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        await new Promise(resolve => execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:5000},() => resolve()));
      }
    }
    await images?.close().catch(() => {});
    if (profile && temporaryProfile) await fs.rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:200}).catch(() => {});
    this.currentURL = '';
  }
}
module.exports = { MinimalChrome, findChrome };
