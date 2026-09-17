'use strict';
const { app, BrowserWindow, ipcMain, session, protocol, net, dialog, shell, Menu } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID, createHash } = require('node:crypto');
const { fetchManual } = require('./http.cjs');
const { ChromeBrowser } = require('./chrome-browser.cjs');
const { normalizeNetworkMode, electronResolverOptions, isCompatibility, isRetryableNetworkError, autoFallbackModes } = require('./network.cjs');
const { pageURL, imageURL, safeName, imageType, publicItem, orderItems, uniqueItems, isImageFilename, renamePlan, idFor, delay, ByteCache } = require('./core.cjs');

const MAX_IMAGE = 32 * 1024 * 1024, MAX_IMAGES = 5000;
protocol.registerSchemesAsPrivileged([
  { scheme: 'eiw', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'eiw-image', privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);
const testMode = process.argv.includes('--eiw-test');
if (testMode) app.setPath('userData', path.join(app.getPath('temp'), `eiw-test-${process.pid}`));
let startupNetworkMode = 'auto';
try {
  const startupSettings = JSON.parse(fsSync.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8'));
  startupNetworkMode = normalizeNetworkMode(startupSettings.networkMode);
} catch {}
if (isCompatibility(startupNetworkMode)) {
  app.commandLine.appendSwitch('disable-http2');
  app.commandLine.appendSwitch('disable-quic');
}
app.setName('ImageHarvest');
let mainWindow, browser, browsingSession, quitting = false, busy = null, job = null;
let browserMode = 'electron', networkMode = startupNetworkMode, activeNetworkMode = startupNetworkMode;
const autoFallbackHosts = new Map();
const compatibilityActive = isCompatibility(startupNetworkMode);
let captureSession = null;
let records = new Map(), cache = new ByteCache(), pending = new Map(), failedImages = new Map(), generation = 0;
let pageInfo = { title: '', url: '' }, lastFolder = '', outputRoot = '', renameFolder = '', canvasTempDir = '', blockedHosts = new Map();
let queue = Promise.resolve(), requestGate = 0;
let excludedIds = new Set(), lastRemoval = [];
let collector, scrollScript, canvasCaptureScript;
const emit = (type, data = {}) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('eiw:event', { type, ...data });
};
const chromeBrowser = new ChromeBrowser((type, data) => {
  if (browserMode !== 'chrome' || quitting) return;
  if (type === 'navigation') { pageInfo.url = data.url; emit(type, data); }
  if (type === 'browser-closed') {
    if (job) { job.cancelled = true; job.abort.abort(); }
    if (captureSession) { captureSession.cancelled = true; captureSession.abort.abort(); }
    emit('error', { message: 'หน้าต่าง Chrome ปิดแล้ว กดเปิดเว็บเพื่อเริ่มเซสชันใหม่' });
  }
});
function validateSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame ||
      !['eiw://app/', 'eiw://app/index.html'].includes(event.senderFrame.url)) throw new Error('Unauthorized request');
}
function handle(name, fn) {
  ipcMain.handle(`eiw:${name}`, async (event, arg) => {
    validateSender(event);
    try { return { ok: true, data: await fn(arg) }; }
    catch (error) { return { ok: false, error: error.message || String(error) }; }
  });
}
function ensureIdle() { if (busy || captureSession) throw new Error('มีงานกำลังทำอยู่ กรุณาหยุดงานปัจจุบันก่อน'); }
function allowedWeb(url) { try { return ['https:', 'http:'].includes(new URL(url).protocol); } catch { return false; } }
function secureSession(ses) {
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', event => event.preventDefault());
  ses.webRequest.onBeforeRequest({ urls: ['file://*/*', 'ftp://*/*'] }, (_details, callback) => callback({ cancel: true }));
}
function createBrowser() {
  if (browser && !browser.isDestroyed()) return browser;
  browser = new BrowserWindow({ width: 1060, height: 850, show: false,
    title: 'Website — ImageHarvest', autoHideMenuBar: true,
    webPreferences: { session: browsingSession, nodeIntegration: false, contextIsolation: true,
      sandbox: true, webSecurity: true, allowRunningInsecureContent: false, backgroundThrottling: false, spellcheck: false }
  });
  browser.setMenu(null);
  const wc = browser.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (event, url) => { if (!allowedWeb(url)) event.preventDefault(); });
  wc.on('will-redirect', (event, url) => { if (!allowedWeb(url)) event.preventDefault(); });
  wc.on('will-frame-navigate', event => { if (!allowedWeb(event.url) && event.url !== 'about:blank') event.preventDefault(); });
  wc.on('did-navigate', (_event, url) => { if (browserMode !== 'electron') return; pageInfo.url = url; emit('navigation', { url }); });
  wc.on('did-navigate-in-page', (_event, url, main) => { if (main && browserMode === 'electron') { pageInfo.url = url; emit('navigation', { url }); } });
  wc.on('page-title-updated', (_event, title) => { if (browserMode === 'electron') pageInfo.title = title; });
  wc.on('render-process-gone', () => {
    if (job) { job.cancelled = true; job.abort.abort(); }
    if (captureSession) { captureSession.cancelled = true; captureSession.abort.abort(); }
    emit('error', { message: 'หน้าต่างเว็บหยุดทำงาน กรุณาเปิดเว็บใหม่' });
  });
  browser.on('close', event => { if (!quitting) { event.preventDefault(); browser.hide(); } });
  return browser;
}
function webAlive() { return browserMode === 'chrome' ? chromeBrowser.alive() : Boolean(browser && !browser.isDestroyed()); }
function webURL() { return browserMode === 'chrome' ? chromeBrowser.url() : (browser && !browser.isDestroyed() ? browser.webContents.getURL() : ''); }
async function webTitle() { return browserMode === 'chrome' ? chromeBrowser.title() : (browser && !browser.isDestroyed() ? browser.webContents.getTitle() : ''); }
async function runPage(code, backend = browserMode) {
  if (backend === 'chrome') return chromeBrowser.evaluate(code);
  if (!browser || browser.isDestroyed()) throw new Error('กรุณาเปิดเว็บก่อน');
  return browser.webContents.executeJavaScriptInIsolatedWorld(7341, [{ code }]);
}
async function withTimeout(promise, ms, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function applyNetworkRuntime(mode) {
  const targetMode = normalizeNetworkMode(mode);
  app.configureHostResolver(electronResolverOptions(targetMode));
  for (const ses of [browsingSession, session.defaultSession].filter(Boolean)) {
    await ses.clearHostResolverCache().catch(() => {});
    await ses.closeAllConnections().catch(() => {});
  }
  await chromeBrowser.setNetworkMode(targetMode);
  activeNetworkMode = targetMode;
}
async function changeNetworkMode(input = {}) {
  ensureIdle();
  networkMode = normalizeNetworkMode(input.mode);
  autoFallbackHosts.clear();
  await saveSettings();
  const restartRequired = isCompatibility(networkMode) !== compatibilityActive;
  if (!restartRequired) await applyNetworkRuntime(networkMode);
  return { mode: networkMode, activeMode: activeNetworkMode, restartRequired, compatibilityActive };
}
function restartForNetwork() {
  app.relaunch();
  app.exit(0);
  return true;
}
async function openPageAttempt(url, mode, show = true) {
  if (mode === 'chrome') {
    if (browser && !browser.isDestroyed()) browser.hide();
    return chromeBrowser.open(url);
  }
  const win = createBrowser();
  if (show !== false) win.show();
  await withTimeout(win.loadURL(url), 45000, 'เปิดเว็บนานเกินกำหนด ลองเปิดหน้าต่างเว็บเพื่อตรวจสอบ');
  return { url: win.webContents.getURL(), title: win.webContents.getTitle(), backend: mode };
}
function networkErrorMessage(error) {
  const raw = error?.message || String(error);
  let hint = '';
  if (/ERR_HTTP2_PROTOCOL_ERROR|HTTP2/i.test(raw)) hint = ' • ลองเครือข่าย Compatibility แล้วรีสตาร์ตแอป';
  else if (isRetryableNetworkError(error)) hint = ' • Auto ลอง DNS สำรองแล้ว; ลองเลือก Cloudflare หรือ Google เองได้จากเมนูเครือข่าย';
  return `เปิดเว็บไม่สำเร็จ: ${raw}${hint}`;
}
async function openPage(input) {
  ensureIdle();
  const url = pageURL(input?.url), mode = input?.backend || browserMode;
  if (!['electron', 'chrome'].includes(mode)) throw new Error('ชนิดเบราว์เซอร์ไม่ถูกต้อง');
  busy = 'open'; browserMode = mode;
  const hostname = new URL(url).hostname.toLowerCase();
  const cachedFallback = networkMode === 'auto' ? autoFallbackHosts.get(hostname) || '' : '';
  const attempts = networkMode === 'auto' ? autoFallbackModes(cachedFallback) : [networkMode];
  let lastError, fallbackUsed = '';
  try {
    for (let i = 0; i < attempts.length; i++) {
      const attemptMode = attempts[i];
      if (activeNetworkMode !== attemptMode) await applyNetworkRuntime(attemptMode);
      const fallback = networkMode === 'auto' && attemptMode !== 'auto';
      emit('status', { message: fallback
        ? `Smart Auto • กำลังเปิดด้วย ${attemptMode === 'cloudflare' ? 'Cloudflare' : 'Google'} DNS…`
        : (mode === 'chrome' ? 'กำลังเปิด Google Chrome (โปรไฟล์แยก)…' : 'กำลังเปิดเว็บไซต์…') });
      try {
        pageInfo = await openPageAttempt(url, mode, input?.show !== false);
        if (networkMode === 'auto') {
          if (fallback) { autoFallbackHosts.set(hostname, attemptMode); fallbackUsed = attemptMode; }
          else autoFallbackHosts.delete(hostname);
        }
        const gated = /Open in Browser|403 Forbidden|Just a moment/i.test(pageInfo.title);
        const fallbackText = fallbackUsed ? ` • Smart Auto: ${fallbackUsed === 'cloudflare' ? 'Cloudflare' : 'Google'} DNS` : '';
        const message = gated
          ? `เว็บไซต์ตอบกลับแล้ว แต่ยังอยู่ที่หน้าแจ้ง/ตรวจสอบการเข้าถึง${fallbackText}`
          : `เปิดเว็บแล้ว กดสแกนเพื่อรวบรวมภาพ${fallbackText}`;
        emit('status', { message });
        return { ...pageInfo, gated, networkFallback: fallbackUsed, activeNetworkMode };
      } catch (error) {
        lastError = error;
        if (mode === 'electron' && browser && !browser.isDestroyed()) browser.webContents.stop();
        const canRetry = networkMode === 'auto' && i + 1 < attempts.length && isRetryableNetworkError(error);
        if (!canRetry) throw new Error(networkErrorMessage(error));
      }
    }
    throw new Error(networkErrorMessage(lastError || new Error('ไม่สามารถเชื่อมต่อได้')));
  } finally { busy = null; }
}
async function clearCollection() {
  excludedIds.clear(); lastRemoval = [];
  const oldCanvasDir = canvasTempDir; canvasTempDir = '';
  generation++; records = new Map(); cache.clear(); failedImages.clear(); pending.clear(); blockedHosts.clear();
  if (oldCanvasDir) await fs.rm(oldCanvasDir, { recursive: true, force: true }).catch(() => {});
}

function removeItems(input) {
  ensureIdle();
  const items = selectedItems(input);
  if (!items.length) throw new Error('ยังไม่ได้เลือกภาพ');
  lastRemoval = items.map(x => x.id);
  lastRemoval.forEach(id => excludedIds.add(id));
  return { removed: lastRemoval.length, count: records.size - excludedIds.size };
}
function undoRemove() {
  ensureIdle();
  const ids = lastRemoval.filter(id => records.has(id) && excludedIds.has(id));
  ids.forEach(id => excludedIds.delete(id)); lastRemoval = [];
  return { ids };
}
async function clearResults() {
  ensureIdle(); busy = 'clear';
  try {
    await clearCollection();
    pageInfo = { title: '', url: webURL() };
    return { cleared: true };
  } finally { busy = null; }
}
async function scan(input = {}) {
  ensureIdle();
  if (!webAlive() || !allowedWeb(webURL())) throw new Error('กรุณาเปิดเว็บไซต์ก่อนสแกน');
  if (/Open in Browser|403 Forbidden|Just a moment/i.test(await webTitle())) throw new Error('เว็บไซต์ยังไม่เปิดหน้าอ่าน (หน้าแจ้งเปิดเบราว์เซอร์/ปฏิเสธการเข้าถึง) กรุณาตรวจหน้าต่างเว็บก่อนสแกน');
  const selector = String(input.selector || '').trim().slice(0, 500);
  const options = { selector, backgrounds: Boolean(input.backgrounds), canvases: Boolean(input.canvases) };
  const maxSteps = Math.max(5, Math.min(600, Number(input.maxSteps) || 150));
  const waitMs = Math.max(350, Math.min(5000, Number(input.waitMs) || 800));
  const auto = input.autoScroll !== false;
  busy = 'scan'; job = { cancelled: false, abort: new AbortController() };
  await clearCollection();
  if (options.canvases) {
    canvasTempDir = path.join(app.getPath('temp'), 'ImageHarvest', `${process.pid}-${generation}-${Date.now()}`);
    await fs.mkdir(canvasTempDir, { recursive: true });
  }
  const startURL = webURL(), found = new Map(), canvasFailures = new Set(), blobFailures = new Map();
  let truncated = false, reason = '', steps = 0, previousHeight = -1, stable = 0, metadata = {}, canvasPositionRetries = 0;
  emit('scan-start');
  try {
    if (auto) { await runPage(`(${scrollScript})('init')`); await delay(waitMs); }
    for (let step = 0; step < (auto ? maxSteps : 1); step++) {
      steps = step + 1;
      if (job.cancelled) break;
      if (webURL() !== startURL) { reason = 'หน้าเว็บเปลี่ยนระหว่างสแกน ผลลัพธ์อาจไม่ครบ'; truncated = true; break; }
      const snap = await withTimeout(runPage(`(${collector})(${JSON.stringify(options)})`), 15000, 'หน้าเว็บไม่ตอบสนองต่อการสแกน');
      metadata = snap;
      for (const item of snap.items) {
        const url = imageURL(item.url, startURL);
        if (!url) continue;
        const key = `${item.key}|${url}`, existing = found.get(key);
        if (existing) Object.assign(existing, item, { order: existing.order, id: existing.id });
        else if (found.size < MAX_IMAGES) found.set(key, { ...item, url, id: idFor(`${generation}:${key}`), order: found.size });
        else { truncated = true; reason = 'ถึงขีดจำกัด 5,000 ภาพแล้ว'; break; }
        const record = found.get(key);
        // Blob URLs can be revoked by lazy readers before a full scan finishes.
        // Preserve original bytes now; a failed attempt must remain retryable.
        if (url.startsWith('blob:') && record && !record.capturePath) {
          try {
            const data = await acquireImage({ ...record, referrer: startURL, backend: browserMode }, job.abort.signal);
            if (job.cancelled) break;
            const dir = await ensureCaptureTempDir(), capturePath = path.join(dir, `${record.id}.${data.ext}`);
            await fs.writeFile(capturePath, data.buffer);
            Object.assign(record, { capturePath, ext: data.ext, contentHash: snapshotHash(data.buffer) });
            blobFailures.delete(key);
          } catch (error) {
            if (job.cancelled) break;
            blobFailures.set(key, error.message || String(error));
          }
        }
      }
      let retryCanvasPosition = false;
      if (options.canvases && !truncated) {
        for (const canvas of snap.canvasItems || []) {
          const key = `canvas:${canvas.captureId}`;
          if (found.has(key) || canvasFailures.has(key) || found.size >= MAX_IMAGES) continue;
          const captured = await withTimeout(runPage(`(${canvasCaptureScript})(${JSON.stringify(canvas.captureId)})`), 15000, 'Canvas ใช้เวลาส่งออกนานเกินไป');
          if (!captured || captured.error) { if (captured?.retry) retryCanvasPosition = true; else canvasFailures.add(key); continue; }
          const comma = captured.data.indexOf(','), buffer = Buffer.from(captured.data.slice(comma + 1), 'base64');
          if (!buffer.length || buffer.length > MAX_IMAGE) { canvasFailures.add(key); continue; }
          const typed = imageType(buffer, 'image/png'), url = `canvas-capture://${generation}/${canvas.captureId}`;
          const id = idFor(`${generation}:${key}`), capturePath = path.join(canvasTempDir, `${id}.png`);
          await fs.writeFile(capturePath, buffer, { flag: 'wx' });
          found.set(key, { ...canvas, key, url, id, order: found.size, source: 'canvas',
            label: canvas.alt ? `Canvas — ${canvas.alt}` : `Canvas ${String(canvas.captureId).padStart(3,'0')}`,
            width: captured.width, height: captured.height, capturePath, ext: typed.ext });
        }
      }
      if (options.canvases && retryCanvasPosition && canvasPositionRetries < 2) {
        canvasPositionRetries++;
        emit('scan-progress', { count: found.size, step: steps, maxSteps, progress: 0 });
        await delay(waitMs);
        continue;
      }
      canvasPositionRetries = 0;
      const pos = auto ? await runPage(`(${scrollScript})('status')`) : { bottom: true, progress: 1, height: 0 };
      emit('scan-progress', { count: found.size, step: steps, maxSteps, progress: pos.progress });
      if (!auto || truncated) break;
      stable = pos.bottom && pos.height === previousHeight ? stable + 1 : 0;
      previousHeight = pos.height;
      // Three quiet bottom checks allow delayed lazy/infinite loaders to settle.
      if (stable >= 3) break;
      if (step === maxSteps - 1) { truncated = true; reason = 'ถึงจำนวนรอบเลื่อนที่ตั้งไว้ เพิ่มรอบแล้วสแกนใหม่ได้'; break; }
      if (!pos.bottom) {
        const readyBlobs = [...found.values()].filter(x => x.url.startsWith('blob:') && x.capturePath).map(x => x.url);
        await runPage(`(${scrollScript})(${JSON.stringify({ action: 'step', readyBlobs })})`);
      }
      await delay(waitMs);
    }
    const all = orderItems([...found.values()], 'visual');
    for (const item of all) records.set(item.id, { ...item, referrer: startURL, backend: browserMode });
    pageInfo = { title: metadata.title || await webTitle(), url: startURL };
    const cancelled = job.cancelled;
    return { items: all.map(publicItem), ...pageInfo, cancelled, truncated, reason, steps,
      notice: [blobFailures.size ? `เก็บภาพชั่วคราวไม่สำเร็จ ${blobFailures.size} รายการ: อาจต้องสแกนใหม่` : '', metadata.frames ? `พบ iframe ${metadata.frames} ส่วน: ยังไม่สแกนภายใน iframe` : '',
        metadata.canvases ? (options.canvases ? `พบ canvas ${metadata.canvases} ส่วน: จับเฉพาะ canvas ที่วาดเสร็จและ browser อนุญาตให้อ่าน` : `พบ canvas ${metadata.canvases} ส่วน: เปิด “รวม Canvas” หากต้องการเก็บภาพที่วาดแล้ว`) : ''].filter(Boolean).join(' • ') };
  } finally {
    if (auto && webAlive() && webURL() === startURL) await runPage(`(${scrollScript})('restore')`).catch(() => {});
    job = null; busy = null;
  }
}
async function ensureCaptureTempDir() {
  if (!canvasTempDir) {
    canvasTempDir = path.join(app.getPath('temp'), 'ImageHarvest', `${process.pid}-${generation}-${Date.now()}`);
    await fs.mkdir(canvasTempDir, { recursive: true });
  }
  return canvasTempDir;
}
function snapshotHash(buffer) { return createHash('sha256').update(buffer).digest('hex'); }
async function storeSnapshot(candidate, data, sourceURL, state) {
  const hash = snapshotHash(data.buffer);
  if (state.hashes.has(hash)) return { duplicate: true };
  if (records.size >= MAX_IMAGES) return { full: true };
  const id = idFor(`snapshot:${hash}`), dir = await ensureCaptureTempDir();
  const capturePath = path.join(dir, `${id}.${data.ext}`);
  try { await fs.writeFile(capturePath, data.buffer, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  state.hashes.add(hash);
  const item = { ...candidate, id, order: records.size, referrer: sourceURL, backend: browserMode,
    capturePath, contentHash: hash, ext: data.ext };
  records.set(id, item);
  return { item: publicItem(item) };
}
async function captureVisiblePass(state) {
  const sourceURL = webURL();
  if (!allowedWeb(sourceURL)) throw new Error('หน้าต่างเว็บยังไม่อยู่บนหน้า http/https');
  const options = { selector: state.selector, backgrounds: state.backgrounds, canvases: state.canvases, visibleOnly: true };
  const snap = await withTimeout(runPage(`(${collector})(${JSON.stringify(options)})`), 15000, 'หน้าเว็บไม่ตอบสนองต่อการจับภาพ');
  const added = [], attempted = new Set();
  let duplicates = 0, failed = 0;
  for (const raw of snap.items || []) {
    if (state.cancelled || state.abort.signal.aborted || records.size >= MAX_IMAGES) break;
    const url = imageURL(raw.url, sourceURL);
    if (!url) continue;
    const attemptKey = `${raw.source}|${url}`;
    if (attempted.has(attemptKey)) continue;
    attempted.add(attemptKey);
    const candidate = { ...raw, url, referrer: sourceURL, backend: browserMode };
    try {
      const data = await acquireImage(candidate, state.abort.signal);
      const stored = await storeSnapshot(candidate, data, sourceURL, state);
      if (stored.item) added.push(stored.item);
      else if (stored.duplicate) duplicates++;
      if (stored.full) break;
    } catch (error) {
      if (state.cancelled || state.abort.signal.aborted) break;
      failed++; state.lastError = error.message || String(error);
    }
  }
  for (const canvas of snap.canvasItems || []) {
    if (state.cancelled || state.abort.signal.aborted || records.size >= MAX_IMAGES) break;
    try {
      const captured = await withTimeout(runPage(`(${canvasCaptureScript})(${JSON.stringify(canvas.captureId)})`), 15000, 'Canvas ใช้เวลาส่งออกนานเกินไป');
      if (!captured || captured.error) { failed++; state.lastError = captured?.error || 'อ่าน Canvas ไม่สำเร็จ'; continue; }
      const comma = captured.data.indexOf(','), buffer = Buffer.from(captured.data.slice(comma + 1), 'base64');
      if (!buffer.length || buffer.length > MAX_IMAGE) { failed++; continue; }
      const typed = imageType(buffer, 'image/png');
      const candidate = { ...canvas, key: `canvas:${canvas.captureId}`,
        url: `canvas-capture://${generation}/${canvas.captureId}`, source: 'canvas',
        label: canvas.alt ? `Canvas — ${canvas.alt}` : `Canvas ${String(canvas.captureId).padStart(3, '0')}`,
        width: captured.width, height: captured.height };
      const stored = await storeSnapshot(candidate, { buffer, ...typed }, sourceURL, state);
      if (stored.item) added.push(stored.item);
      else if (stored.duplicate) duplicates++;
      if (stored.full) break;
    } catch (error) {
      if (state.cancelled || state.abort.signal.aborted) break;
      failed++; state.lastError = error.message || String(error);
    }
  }
  pageInfo = { title: snap.title || await webTitle(), url: sourceURL };
  return { items: added, duplicates, failed, title: pageInfo.title, url: sourceURL };
}
async function runCaptureSession(state) {
  emit('capture-start', { title: await webTitle().catch(() => ''), url: webURL() });
  let reason = '';
  try {
    while (!state.cancelled) {
      if (!webAlive()) { reason = 'หน้าต่างเว็บถูกปิด'; break; }
      try {
        const result = await captureVisiblePass(state);
        emit('capture-progress', { ...result, count: records.size, lastError: state.lastError || '' });
        state.lastError = '';
      } catch (error) {
        if (state.cancelled || state.abort.signal.aborted) break;
        state.lastError = error.message || String(error);
        emit('capture-progress', { items: [], duplicates: 0, failed: 1, count: records.size, lastError: state.lastError });
      }
      if (records.size >= MAX_IMAGES) { reason = 'ถึงขีดจำกัด 5,000 ภาพแล้ว'; break; }
      await delay(state.intervalMs);
    }
  } finally {
    if (captureSession === state) captureSession = null;
    emit('capture-stop', { count: records.size, reason, cancelled: state.cancelled });
  }
}
async function startCaptureSession(input = {}) {
  ensureIdle();
  if (!webAlive() || !allowedWeb(webURL())) throw new Error('กรุณาเปิดเว็บไซต์ก่อนเริ่มจับทีละหน้า');
  await clearCollection();
  await ensureCaptureTempDir();
  const state = {
    cancelled: false, abort: new AbortController(), hashes: new Set(), lastError: '',
    intervalMs: Math.max(500, Math.min(5000, Number(input.intervalMs) || 900)),
    selector: String(input.selector || '').trim().slice(0, 500),
    backgrounds: Boolean(input.backgrounds), canvases: input.canvases !== false
  };
  captureSession = state;
  runCaptureSession(state).catch(error => {
    if (captureSession === state) captureSession = null;
    emit('capture-stop', { count: records.size, reason: error.message || String(error), cancelled: true });
  });
  return { started: true, intervalMs: state.intervalMs };
}
function stopCaptureSession() {
  const state = captureSession;
  if (!state) return { stopped: false, count: records.size };
  state.cancelled = true; state.abort.abort();
  return { stopped: true, count: records.size };
}

async function readLimited(response, signal) {
  const announced = Number(response.headers.get('content-length') || 0);
  if (announced > MAX_IMAGE) { await response.body?.cancel(); throw new Error('ภาพมีขนาดเกิน 32 MB'); }
  if (!response.body) throw new Error('ไม่ได้รับข้อมูลภาพ');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      if (signal?.aborted) throw new Error('ยกเลิกการดาวน์โหลด');
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > MAX_IMAGE) throw new Error('ภาพมีขนาดเกิน 32 MB');
      chunks.push(Buffer.from(value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  return Buffer.concat(chunks, size);
}
async function acquireImage(item, signal) {
  let buffer, contentType = '';
  if (item.url.startsWith('data:')) {
    const comma = item.url.indexOf(','), meta = item.url.slice(0, comma);
    if (item.url.length > MAX_IMAGE * 1.5) throw new Error('ภาพมีขนาดเกิน 32 MB');
    buffer = /;base64/i.test(meta) ? Buffer.from(item.url.slice(comma + 1), 'base64') : Buffer.from(decodeURIComponent(item.url.slice(comma + 1)));
    contentType = meta.slice(5).split(';')[0];
  } else if (item.url.startsWith('blob:')) {
    const originURL = item.backend === 'chrome' ? chromeBrowser.url() : (browser && !browser.isDestroyed() ? browser.webContents.getURL() : '');
    if (!originURL || new URL(originURL).origin !== new URL(item.referrer).origin)
      throw new Error('ภาพ blob ต้องเปิดหน้าเว็บต้นทางค้างไว้');
    const payload = await withTimeout(runPage(`(async () => {
      const r = await fetch(${JSON.stringify(item.url)}); const b = await r.blob();
      if (b.size > ${MAX_IMAGE}) throw new Error('ภาพมีขนาดเกิน 32 MB');
      return await new Promise((resolve,reject) => { const f = new FileReader(); f.onload = () => resolve(f.result); f.onerror = reject; f.readAsDataURL(b); });
    })()`, item.backend), 20000, 'อ่านภาพ blob ไม่สำเร็จ');
    if (typeof payload !== 'string' || payload.length > MAX_IMAGE * 1.5) throw new Error('ข้อมูล blob ไม่ถูกต้อง');
    buffer = Buffer.from(payload.slice(payload.indexOf(',') + 1), 'base64'); contentType = payload.slice(5, payload.indexOf(';'));
  } else {
    const host = new URL(item.url).host;
    if (blockedHosts.has(host)) throw new Error(blockedHosts.get(host));
    await delay(Math.max(0, requestGate - Date.now())); requestGate = Date.now() + 400;
    if (signal?.aborted) throw new Error('ยกเลิกการดาวน์โหลด');
    const controller = new AbortController(), abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 25000);
    try {
      // Use the isolated website session's cookies/cache. Never borrow Chrome cookies.
      let target = item.url, r;
      for (let hop = 0; hop <= 5; hop++) {
        const targetHost = new URL(target).host;
        if (blockedHosts.has(targetHost)) throw new Error(blockedHosts.get(targetHost));
        const requestOptions = { credentials: 'include', redirect: 'manual', referrer: item.referrer, referrerPolicy: 'strict-origin-when-cross-origin', signal: controller.signal };
        r = item.backend === 'chrome' ? await chromeBrowser.fetchManual(target, requestOptions, MAX_IMAGE) : await fetchManual(target, requestOptions, browsingSession, MAX_IMAGE);
        if (![301, 302, 303, 307, 308].includes(r.status)) break;
        const location = r.headers.get('location'); await r.body?.cancel();
        if (!location || hop === 5) throw new Error('เว็บ redirect มากเกินไปหรือไม่ได้ส่งปลายทาง');
        const next = new URL(location, target);
        if (!allowedWeb(next.href) || next.username || next.password) throw new Error('ปลายทาง redirect ไม่ปลอดภัย');
        target = next.href;
        await delay(400);
      }
      if (!r.ok) {
        await r.body?.cancel();
        if (r.status === 429) {
          const message = 'เว็บจำกัดคำขอ (429) หยุดโหลดจากโฮสต์นี้แล้ว กรุณาลองใหม่ภายหลัง';
          blockedHosts.set(host, message); emit('rate-limit', { message }); throw new Error(message);
        }
        throw new Error(`HTTP ${r.status}${r.status === 403 ? ' — เว็บปฏิเสธการเข้าถึง ไม่มีการข้ามข้อจำกัด' : ''}`);
      }
      buffer = await readLimited(r, controller.signal); contentType = r.headers.get('content-type') || '';
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  if (buffer.length > MAX_IMAGE) throw new Error('ภาพมีขนาดเกิน 32 MB');
  return { buffer, ...imageType(buffer, contentType) };
}
function getImage(id, signal) {
  const item = records.get(id);
  if (!item || excludedIds.has(id)) return Promise.reject(new Error('ไม่พบภาพในผลสแกนล่าสุด'));
  const gen = generation;
  const cacheKey = item.capturePath ? idFor(`snapshot:${item.id}`) : idFor(item.url), hit = cache.get(cacheKey);
  if (item.capturePath) {
    if (hit) return Promise.resolve(hit);
    return fs.readFile(item.capturePath).then(buffer => {
      const value = { buffer, ...imageType(buffer, item.ext ? `image/${item.ext}` : '') };
      if (gen === generation) cache.set(cacheKey, value); return value;
    }).catch(() => { throw new Error('ไฟล์ภาพชั่วคราวไม่อยู่แล้ว กรุณาสแกนหรือจับหน้าใหม่'); });
  }
  if (hit) return Promise.resolve(hit);
  if (failedImages.has(cacheKey)) return Promise.reject(new Error(failedImages.get(cacheKey)));
  if (pending.has(cacheKey)) return pending.get(cacheKey);
  // A single queue prevents preview + export from multiplying website requests.
  const task = queue.then(async () => {
    if (gen !== generation || signal?.aborted) throw new Error('ยกเลิกคำขอเดิม');
    const existing = cache.get(cacheKey); if (existing) return existing;
    const value = await acquireImage(item, signal);
    if (gen === generation) cache.set(cacheKey, value);
    return value;
  });
  queue = task.catch(() => {});
  pending.set(cacheKey, task);
  task.then(() => { if (pending.get(cacheKey) === task) pending.delete(cacheKey); }, error => {
    if (pending.get(cacheKey) === task) pending.delete(cacheKey);
    if (gen === generation && !signal?.aborted) failedImages.set(cacheKey, error.message);
  });
  return task;
}
function selectedItems(input) {
  if (!Array.isArray(input?.ids) || input.ids.length > MAX_IMAGES) throw new Error('รายการภาพไม่ถูกต้อง');
  const seen = new Set();
  return input.ids.map(id => {
    if (typeof id !== 'string' || !records.has(id) || excludedIds.has(id) || seen.has(id)) throw new Error('รายการภาพเปลี่ยนไป กรุณาสแกนใหม่');
    seen.add(id); return records.get(id);
  });
}
async function chooseFolder() {
  const result = await dialog.showOpenDialog(mainWindow, { title: 'เลือกโฟลเดอร์เก็บรูป', defaultPath: outputRoot || app.getPath('pictures'), properties: ['openDirectory', 'createDirectory'] });
  if (!result.canceled) { outputRoot = result.filePaths[0]; await saveSettings(); }
  return outputRoot;
}
async function saveSettings() {
  await fs.writeFile(path.join(app.getPath('userData'), 'settings.json'), JSON.stringify({ outputRoot, networkMode }), 'utf8');
}
async function readRenameFolder() {
  if (!renameFolder) throw new Error('กรุณาเลือกโฟลเดอร์รูปก่อน');
  const entries = await fs.readdir(renameFolder, { withFileTypes: true });
  return entries.filter(e => e.isFile() && isImageFilename(e.name)).map(e => e.name);
}
async function chooseRenameFolder() {
  ensureIdle();
  const result = await dialog.showOpenDialog(mainWindow, { title: 'เลือกโฟลเดอร์รูปที่จะตั้งเลขหน้า', properties: ['openDirectory'] });
  if (result.canceled) return null;
  renameFolder = path.resolve(result.filePaths[0]);
  const files = await readRenameFolder();
  return { folder: renameFolder, files };
}
async function previewRename(input = {}) {
  const files = await readRenameFolder(), plan = renamePlan(files, input);
  return { folder: renameFolder, count: plan.length, plan };
}
async function uniqueFolder(root, base) {
  for (let i = 0; i < 1000; i++) {
    const folder = path.join(root, `${base}${i ? `-${i + 1}` : ''}`);
    try { await fs.mkdir(folder); return folder; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error('สร้างโฟลเดอร์ใหม่ไม่สำเร็จ');
}
async function renameImages(input = {}, skipConfirm = false) {
  ensureIdle();
  const files = await readRenameFolder(), plan = renamePlan(files, input);
  if (!plan.length) throw new Error('ไม่พบไฟล์ภาพที่รองรับในโฟลเดอร์นี้');
  const current = new Set(files.map(x => x.toLowerCase()));
  const targets = new Set();
  for (const row of plan) {
    const key = row.to.toLowerCase();
    if (targets.has(key)) throw new Error('ชื่อปลายทางซ้ำกัน กรุณาปรับเลขเริ่มต้น');
    targets.add(key);
  }
  const entries = await fs.readdir(renameFolder, { withFileTypes: true });
  const foreign = new Set(entries.filter(e => !current.has(e.name.toLowerCase())).map(e => e.name.toLowerCase()));
  if (plan.some(row => foreign.has(row.to.toLowerCase()))) throw new Error('มีไฟล์หรือโฟลเดอร์ชื่อปลายทางอยู่แล้ว');
  const changed = plan.filter(row => row.from !== row.to);
  if (!changed.length) return { folder: renameFolder, renamed: 0, plan };
  const sample = plan.slice(0,3).map(x => `${x.from}  →  ${x.to}`).join('\n');
  if (!skipConfirm) {
    const answer = await dialog.showMessageBox(mainWindow, { type:'warning', title:'ยืนยันการตั้งเลขหน้า',
      message:`จะเปลี่ยนชื่อรูป ${plan.length} ภาพ${input.reverse ? ' แบบย้อนกลับ' : ''}`, detail:`${sample}${plan.length>3?'\n…':''}\n\nระบบจะเปลี่ยนชื่อไฟล์จริงในโฟลเดอร์นี้`,
      buttons:['ยกเลิก','เปลี่ยนชื่อ'], defaultId:0, cancelId:0, noLink:true });
    if (answer.response !== 1) return { folder: renameFolder, cancelled:true, renamed:0, plan };
  }
  busy = 'rename';
  const moved = plan.map((row, i) => ({ ...row, tmp: `.__imageharvest_${randomUUID()}_${i}${path.extname(row.from)}`, state:'original' }));
  try {
    for (const row of moved) { await fs.rename(path.join(renameFolder,row.from), path.join(renameFolder,row.tmp)); row.state='temp'; }
    for (const row of moved) { await fs.rename(path.join(renameFolder,row.tmp), path.join(renameFolder,row.to)); row.state='target'; }
    return { folder: renameFolder, renamed: changed.length, plan };
  } catch (error) {
    for (const row of moved.filter(x=>x.state==='target').reverse()) {
      try { await fs.rename(path.join(renameFolder,row.to), path.join(renameFolder,row.tmp)); row.state='temp'; } catch {}
    }
    for (const row of moved.filter(x=>x.state==='temp').reverse()) {
      try { await fs.rename(path.join(renameFolder,row.tmp), path.join(renameFolder,row.from)); row.state='original'; } catch {}
    }
    throw new Error(`เปลี่ยนชื่อไม่สำเร็จและพยายามคืนชื่อเดิมแล้ว: ${error.message}`);
  } finally { busy = null; }
}
async function download(input) {
  ensureIdle(); const items = selectedItems(input);
  if (!items.length) throw new Error('ยังไม่ได้เลือกภาพ');
  if (!outputRoot && !await chooseFolder()) return { cancelled: true };
  busy = 'download'; job = { cancelled: false, abort: new AbortController() };
  const date = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const report = { source: pageInfo.url, title: pageInfo.title, createdAt: new Date().toISOString(),
    requested: items.length, naming: 'Selected UI order, zero-padded; original image bytes', files: [] };
  let folder, saved = 0, failed = 0;
  try {
    const requestedName = String(input.name || '').trim();
    const fallbackName = `${safeName(pageInfo.title || new URL(pageInfo.url).hostname)}_${date}`;
    folder = await uniqueFolder(outputRoot, requestedName ? safeName(requestedName) : fallbackName);
    lastFolder = folder;
    for (let i = 0; i < items.length; i++) {
      if (job.cancelled) break;
      const item = items[i];
      emit('download-progress', { index: i + 1, total: items.length, saved, failed });
      try {
        const data = await getImage(item.id, job.abort.signal);
        if (job.cancelled) break;
        const filename = `${String(i + 1).padStart(4, '0')}.${data.ext}`;
        await fs.writeFile(path.join(folder, filename), data.buffer, { flag: 'wx' });
        report.files.push({ index: i + 1, filename, source: item.url.startsWith('data:') ? '[embedded image]' : item.url, status: 'saved', bytes: data.buffer.length });
        saved++; emit('image-saved', { id: item.id, filename });
      } catch (error) {
        if (job.cancelled) break;
        failed++; report.files.push({ index: i + 1, source: item.url.startsWith('data:') ? '[embedded image]' : item.url, status: 'failed', error: error.message });
        emit('image-failed', { id: item.id, message: error.message });
      }
    }
    report.saved = saved; report.failed = failed; report.cancelled = job.cancelled;
    report.notAttempted = items.length - saved - failed;
    await fs.writeFile(path.join(folder, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    return { folder, saved, failed, cancelled: report.cancelled, notAttempted: report.notAttempted };
  } finally { job = null; busy = null; }
}
async function exportLinks(input) {
  const items = selectedItems(input);
  const result = await dialog.showSaveDialog(mainWindow, { title: 'บันทึกลิงก์ตามลำดับ', defaultPath: `${safeName(pageInfo.title)}-links.txt`, filters: [{ name: 'Text', extensions: ['txt'] }] });
  if (result.canceled) return false;
  await fs.writeFile(result.filePath, items.map((item, i) => `${String(i + 1).padStart(4, '0')}\t${item.url.startsWith('data:') ? '[embedded image]' : item.url}`).join('\r\n'), 'utf8');
  return true;
}
async function main() {
  collector = await fs.readFile(path.join(__dirname, 'collector.js'), 'utf8');
  const filterSource = await fs.readFile(path.join(__dirname, 'content-filter.js'), 'utf8');
  collector = `(options => { ${filterSource}\nreturn (${collector})(options); })`;
  scrollScript = await fs.readFile(path.join(__dirname, 'scroll.js'), 'utf8');
  canvasCaptureScript = await fs.readFile(path.join(__dirname, 'canvas-capture.js'), 'utf8');
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  try {
    const value = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'settings.json'), 'utf8'));
    if (typeof value.outputRoot === 'string') outputRoot = value.outputRoot;
    networkMode = normalizeNetworkMode(value.networkMode);
  } catch {}
  browsingSession = session.fromPartition('eiw-website'); // Memory-only login session.
  secureSession(browsingSession); secureSession(session.defaultSession);
  await applyNetworkRuntime(networkMode);
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };
  protocol.handle('eiw', async request => {
    const url = new URL(request.url);
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (url.host !== 'app' || !['index.html', 'renderer.js', 'content-filter.js', 'style.css'].includes(name)) return new Response('Not found', { status: 404 });
    return new Response(await fs.readFile(path.join(__dirname, name)), { headers: { 'Content-Type': types[path.extname(name)] || 'text/plain' } });
  });
  protocol.handle('eiw-image', async request => {
    const url = new URL(request.url), id = url.pathname.slice(1);
    if (url.host !== 'cache' || !/^[a-f0-9]{24}$/.test(id)) return new Response('', { status: 404 });
    try {
      const data = await getImage(id);
      return new Response(data.buffer, { headers: { 'Content-Type': data.mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    } catch (error) {
      emit('image-failed', { id, message: error.message });
      return new Response('', { status: 502 });
    }
  });
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({ width: 1360, height: 920, minWidth: 980, minHeight: 680,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'), backgroundColor: '#10111a', title: 'ImageHarvest', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false } });
  mainWindow.on('closed', () => { mainWindow = null; app.quit(); });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.once('ready-to-show', () => { if (!testMode) mainWindow.show(); });
  handle('open', openPage);
  handle('showBrowser', async () => { if (browserMode === 'chrome') return chromeBrowser.show(); if (!browser) throw new Error('กรุณาเปิดเว็บก่อน'); browser.show(); browser.focus(); return true; });
  handle('scan', scan);
  handle('startCapture', startCaptureSession);
  handle('stopCapture', stopCaptureSession);
  handle('networkMode', changeNetworkMode);
  handle('restartForNetwork', restartForNetwork);
  handle('removeItems', removeItems);
  handle('undoRemove', undoRemove);
  handle('clearResults', clearResults);
  handle('cancel', () => {
    if (job) { job.cancelled = true; job.abort.abort(); }
    if (captureSession) stopCaptureSession();
    return true;
  });
  handle('chooseFolder', chooseFolder);
  handle('chooseRenameFolder', chooseRenameFolder);
  handle('previewRename', previewRename);
  handle('renameImages', renameImages);
  handle('download', download);
  handle('exportLinks', exportLinks);
  handle('openFolder', async () => { const folder = lastFolder || outputRoot; if (!folder) throw new Error('ยังไม่มีโฟลเดอร์'); const error = await shell.openPath(folder); if (error) throw new Error(error); return true; });
  handle('settings', () => ({ outputRoot, version: app.getVersion(), browserMode, networkMode, activeNetworkMode, compatibilityActive }));
  if (testMode) global.__eiwTest = { openPage, scan, startCaptureSession, stopCaptureSession, download, getImage, changeNetworkMode, renameImages: input => renameImages(input, true), setOutput: value => { outputRoot = value; }, setRenameFolder: value => { renameFolder = value; }, runPage, closeChrome: () => chromeBrowser.close(), chromeInfo: () => ({ profile: chromeBrowser.profile, url: chromeBrowser.url(), status: chromeBrowser.lastStatus, navigation: chromeBrowser.navigation, networkMode: chromeBrowser.networkMode }), getState: () => ({ browserMode, networkMode, activeNetworkMode, autoFallbackHosts: Object.fromEntries(autoFallbackHosts), compatibilityActive, captureActive: Boolean(captureSession), busy, count: records.size - excludedIds.size, excluded: excludedIds.size, canvasTempDir, browserId: browser?.webContents.id }),
    cancel: () => { if (job) { job.cancelled = true; job.abort.abort(); } if (captureSession) stopCaptureSession(); } };
  await mainWindow.loadURL('eiw://app/');
}
app.whenReady().then(main).catch(error => { dialog.showErrorBox('ImageHarvest', error.stack || error.message); app.exit(1); });
app.on('before-quit', () => { quitting = true; if (job) job.abort.abort(); if (captureSession) { captureSession.cancelled = true; captureSession.abort.abort(); } if (canvasTempDir) fs.rm(canvasTempDir, { recursive:true, force:true }).catch(()=>{}); });
app.on('before-quit', event => { if (chromeBrowser.context) { event.preventDefault(); chromeBrowser.close().finally(() => app.quit()); } });
app.on('window-all-closed', () => app.quit());
app.on('web-contents-created', (_event, contents) => { contents.on('will-attach-webview', event => event.preventDefault()); });
