'use strict';
const { app, BrowserWindow, ipcMain, session, protocol, net, dialog, shell, Menu } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { fetchManual } = require('./http.cjs');
const { pageURL, imageURL, safeName, imageType, publicItem, orderItems, uniqueItems, isImageFilename, renamePlan, idFor, delay, ByteCache } = require('./core.cjs');

const MAX_IMAGE = 32 * 1024 * 1024, MAX_IMAGES = 5000;
protocol.registerSchemesAsPrivileged([
  { scheme: 'eiw', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'eiw-image', privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);
const testMode = process.argv.includes('--eiw-test');
if (testMode) app.setPath('userData', path.join(app.getPath('temp'), `eiw-test-${process.pid}`));
app.setName('ImageHarvest');
let mainWindow, browser, browsingSession, quitting = false, busy = null, job = null;
let records = new Map(), cache = new ByteCache(), pending = new Map(), failedImages = new Map(), generation = 0;
let pageInfo = { title: '', url: '' }, lastFolder = '', outputRoot = '', renameFolder = '', canvasTempDir = '', blockedHosts = new Map();
let queue = Promise.resolve(), requestGate = 0;
let collector, scrollScript, canvasCaptureScript;
const emit = (type, data = {}) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('eiw:event', { type, ...data });
};
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
function ensureIdle() { if (busy) throw new Error('มีงานกำลังทำอยู่ กรุณาหยุดหรือรอให้งานจบก่อน'); }
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
  wc.on('did-navigate', (_event, url) => { pageInfo.url = url; emit('navigation', { url }); });
  wc.on('did-navigate-in-page', (_event, url, main) => { if (main) { pageInfo.url = url; emit('navigation', { url }); } });
  wc.on('page-title-updated', (_event, title) => { pageInfo.title = title; });
  wc.on('render-process-gone', () => { if (job) { job.cancelled = true; job.abort.abort(); } emit('error', { message: 'หน้าต่างเว็บหยุดทำงาน กรุณาเปิดเว็บใหม่' }); });
  browser.on('close', event => { if (!quitting) { event.preventDefault(); browser.hide(); } });
  return browser;
}
async function runPage(code) {
  if (!browser || browser.isDestroyed()) throw new Error('กรุณาเปิดเว็บก่อน');
  return browser.webContents.executeJavaScriptInIsolatedWorld(7341, [{ code }]);
}
async function withTimeout(promise, ms, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function openPage(input) {
  ensureIdle();
  const url = pageURL(input?.url);
  busy = 'open'; emit('status', { message: 'กำลังเปิดเว็บไซต์…' });
  const win = createBrowser();
  if (input?.show !== false) win.show();
  try {
    await withTimeout(win.loadURL(url), 45000, 'เปิดเว็บนานเกินกำหนด ลองเปิดหน้าต่างเว็บเพื่อตรวจสอบ');
    pageInfo = { url: win.webContents.getURL(), title: win.webContents.getTitle() };
    emit('status', { message: 'เปิดเว็บแล้ว กดสแกนเพื่อรวบรวมภาพ' });
    return pageInfo;
  } catch (error) {
    win.webContents.stop();
    throw new Error(`เปิดเว็บไม่สำเร็จ: ${error.message}`);
  } finally { busy = null; }
}
async function clearCollection() {
  const oldCanvasDir = canvasTempDir; canvasTempDir = '';
  generation++; records = new Map(); cache.clear(); failedImages.clear(); pending.clear(); blockedHosts.clear();
  if (oldCanvasDir) await fs.rm(oldCanvasDir, { recursive: true, force: true }).catch(() => {});
}

async function scan(input = {}) {
  ensureIdle();
  if (!browser || browser.isDestroyed() || !allowedWeb(browser.webContents.getURL())) throw new Error('กรุณาเปิดเว็บไซต์ก่อนสแกน');
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
  const startURL = browser.webContents.getURL(), found = new Map(), canvasFailures = new Set();
  let truncated = false, reason = '', steps = 0, previousHeight = -1, stable = 0, metadata = {}, canvasPositionRetries = 0;
  emit('scan-start');
  try {
    if (auto) { await runPage(`(${scrollScript})('init')`); await delay(waitMs); }
    for (let step = 0; step < (auto ? maxSteps : 1); step++) {
      steps = step + 1;
      if (job.cancelled) break;
      if (browser.webContents.getURL() !== startURL) { reason = 'หน้าเว็บเปลี่ยนระหว่างสแกน ผลลัพธ์อาจไม่ครบ'; truncated = true; break; }
      const snap = await withTimeout(runPage(`(${collector})(${JSON.stringify(options)})`), 15000, 'หน้าเว็บไม่ตอบสนองต่อการสแกน');
      metadata = snap;
      for (const item of snap.items) {
        const url = imageURL(item.url, startURL);
        if (!url) continue;
        const key = `${item.key}|${url}`, existing = found.get(key);
        if (existing) Object.assign(existing, item, { order: existing.order, id: existing.id });
        else if (found.size < MAX_IMAGES) found.set(key, { ...item, url, id: idFor(`${generation}:${key}`), order: found.size });
        else { truncated = true; reason = 'ถึงขีดจำกัด 5,000 ภาพแล้ว'; break; }
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
      if (!pos.bottom) await runPage(`(${scrollScript})('step')`);
      await delay(waitMs);
    }
    const all = orderItems([...found.values()], 'visual');
    for (const item of all) records.set(item.id, { ...item, referrer: startURL });
    pageInfo = { title: metadata.title || browser.webContents.getTitle(), url: startURL };
    const cancelled = job.cancelled;
    return { items: all.map(publicItem), ...pageInfo, cancelled, truncated, reason, steps,
      notice: [metadata.frames ? `พบ iframe ${metadata.frames} ส่วน: ยังไม่สแกนภายใน iframe` : '',
        metadata.canvases ? (options.canvases ? `พบ canvas ${metadata.canvases} ส่วน: จับเฉพาะ canvas ที่วาดเสร็จและ browser อนุญาตให้อ่าน` : `พบ canvas ${metadata.canvases} ส่วน: เปิด “รวม Canvas” หากต้องการเก็บภาพที่วาดแล้ว`) : ''].filter(Boolean).join(' • ') };
  } finally {
    if (auto && browser && !browser.isDestroyed()) await runPage(`(${scrollScript})('restore')`).catch(() => {});
    job = null; busy = null;
  }
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
    if (!browser || browser.isDestroyed() || new URL(browser.webContents.getURL()).origin !== new URL(item.referrer).origin)
      throw new Error('ภาพ blob ต้องเปิดหน้าเว็บต้นทางค้างไว้');
    const payload = await withTimeout(runPage(`(async () => {
      const r = await fetch(${JSON.stringify(item.url)}); const b = await r.blob();
      if (b.size > ${MAX_IMAGE}) throw new Error('ภาพมีขนาดเกิน 32 MB');
      return await new Promise((resolve,reject) => { const f = new FileReader(); f.onload = () => resolve(f.result); f.onerror = reject; f.readAsDataURL(b); });
    })()`), 20000, 'อ่านภาพ blob ไม่สำเร็จ');
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
        r = await fetchManual(target, { credentials: 'include', redirect: 'manual',
          referrer: item.referrer, referrerPolicy: 'strict-origin-when-cross-origin', signal: controller.signal }, browsingSession, MAX_IMAGE);
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
  if (!item) return Promise.reject(new Error('ไม่พบภาพในผลสแกนล่าสุด'));
  const cacheKey = idFor(item.url), hit = cache.get(cacheKey);
  if (item.source === 'canvas' && item.capturePath) {
    if (hit) return Promise.resolve(hit);
    return fs.readFile(item.capturePath).then(buffer => {
      const value = { buffer, ...imageType(buffer, 'image/png') };
      cache.set(cacheKey, value); return value;
    }).catch(() => { throw new Error('ไฟล์ Canvas ชั่วคราวไม่อยู่แล้ว กรุณาสแกนใหม่'); });
  }
  if (hit) return Promise.resolve(hit);
  if (failedImages.has(cacheKey)) return Promise.reject(new Error(failedImages.get(cacheKey)));
  if (pending.has(cacheKey)) return pending.get(cacheKey);
  const gen = generation;
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
    if (typeof id !== 'string' || !records.has(id) || seen.has(id)) throw new Error('รายการภาพเปลี่ยนไป กรุณาสแกนใหม่');
    seen.add(id); return records.get(id);
  });
}
async function chooseFolder() {
  const result = await dialog.showOpenDialog(mainWindow, { title: 'เลือกโฟลเดอร์เก็บรูป', defaultPath: outputRoot || app.getPath('pictures'), properties: ['openDirectory', 'createDirectory'] });
  if (!result.canceled) { outputRoot = result.filePaths[0]; await saveSettings(); }
  return outputRoot;
}
async function saveSettings() {
  await fs.writeFile(path.join(app.getPath('userData'), 'settings.json'), JSON.stringify({ outputRoot }), 'utf8');
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
  scrollScript = await fs.readFile(path.join(__dirname, 'scroll.js'), 'utf8');
  canvasCaptureScript = await fs.readFile(path.join(__dirname, 'canvas-capture.js'), 'utf8');
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  try { const value = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'settings.json'), 'utf8')); if (typeof value.outputRoot === 'string') outputRoot = value.outputRoot; } catch {}
  browsingSession = session.fromPartition('eiw-website'); // Memory-only login session.
  secureSession(browsingSession); secureSession(session.defaultSession);
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };
  protocol.handle('eiw', async request => {
    const url = new URL(request.url);
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (url.host !== 'app' || !['index.html', 'renderer.js', 'style.css'].includes(name)) return new Response('Not found', { status: 404 });
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
  handle('showBrowser', async () => { if (!browser) throw new Error('กรุณาเปิดเว็บก่อน'); browser.show(); browser.focus(); return true; });
  handle('scan', scan);
  handle('cancel', () => { if (job) { job.cancelled = true; job.abort.abort(); } return true; });
  handle('chooseFolder', chooseFolder);
  handle('chooseRenameFolder', chooseRenameFolder);
  handle('previewRename', previewRename);
  handle('renameImages', renameImages);
  handle('download', download);
  handle('exportLinks', exportLinks);
  handle('openFolder', async () => { const folder = lastFolder || outputRoot; if (!folder) throw new Error('ยังไม่มีโฟลเดอร์'); const error = await shell.openPath(folder); if (error) throw new Error(error); return true; });
  handle('settings', () => ({ outputRoot, version: app.getVersion() }));
  if (testMode) global.__eiwTest = { openPage, scan, download, getImage, renameImages: input => renameImages(input, true), setOutput: value => { outputRoot = value; }, setRenameFolder: value => { renameFolder = value; }, getState: () => ({ busy, count: records.size, browserId: browser?.webContents.id }),
    cancel: () => { if (job) { job.cancelled = true; job.abort.abort(); } } };
  await mainWindow.loadURL('eiw://app/');
}
app.whenReady().then(main).catch(error => { dialog.showErrorBox('ImageHarvest', error.stack || error.message); app.exit(1); });
app.on('before-quit', () => { quitting = true; if (job) job.abort.abort(); if (canvasTempDir) fs.rm(canvasTempDir, { recursive:true, force:true }).catch(()=>{}); });
app.on('window-all-closed', () => app.quit());
app.on('web-contents-created', (_event, contents) => { contents.on('will-attach-webview', event => event.preventDefault()); });
