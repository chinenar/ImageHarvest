'use strict';
const { app, BrowserWindow, BrowserView, ipcMain, session, protocol, net, dialog, shell, Menu, safeStorage, globalShortcut, clipboard, nativeImage, screen } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID, createHash } = require('node:crypto');
const { fetchManual } = require('./http.cjs');
const { compatibilitySettings } = require('./compatibility-settings.cjs');
const { ChromeBrowser } = require('./chrome-browser.cjs');
const { ManualChromeLogin } = require('./manual-chrome-login.cjs');
const { chromeProfileInfo } = require('./browser-profile.cjs');
const { SiteObserver } = require('./site-observer.cjs');
const { ElectronImageStore } = require('./electron-image-store.cjs');
const { SiteProfiles, contentItems, verification } = require('./adaptive-core.cjs');
const { AdaptiveSession, describeAdaptive } = require('./adaptive-session.cjs');
const { normalizeNetworkMode, electronResolverOptions, isCompatibility, isRetryableNetworkError, autoFallbackModes } = require('./network.cjs');
const { pageURL, imageURL, safeName, imageType, publicItem, orderItems, uniqueItems, isImageFilename, renamePlan, chooseNextChapter, chapterIndexLink, nextFromChapterListing, idFor, delay, ByteCache } = require('./core.cjs');
const { DEFAULT_TRANSLATION_ENDPOINT, HarvestTranslationClient, selectMangaPages } = require('./harvest-translate.cjs');
const { GoogleTranslateWebPool } = require('./google-translate-web.cjs');
const { OcrTranslationService } = require('./ocr-translation.cjs');
const { MangaOcrPool } = require('./manga-ocr.cjs');
const { EnhancedMangaOcrPool } = require('./enhanced-manga-ocr.cjs');
const { LocalOcrBackend,runtimeRoot } = require('./ocr-backend.cjs');
const { overlayPage,createTranslationOverlay } = require('./translation-overlay.cjs');
const { RegionStyleStore,regionStyleKey } = require('./region-style-store.cjs');
let harvestRegionStyles=null;const harvestRegionStyleSources=new Map();
function regionStyles(){return harvestRegionStyles||(harvestRegionStyles=new RegionStyleStore(path.join(app.getPath('userData'),'harvestts','region-fonts.json')));}
async function prepareOverlayStyles(tab,payload){
  const scope={documentUrl:payload.documentUrl,imageDigest:payload.imageDigest,regions:new Map()};
  for(const r of payload.regions){r.styleKey=regionStyleKey(payload,{...r,text:r.original},payload.targetLanguage);r.userStyle=await regionStyles().get(r.styleKey);scope.regions.set(r.id,r.styleKey);}
  let sources=harvestRegionStyleSources.get(tab.id);if(!sources){sources=new Map();harvestRegionStyleSources.set(tab.id,sources);}sources.set(payload.id,scope);while(sources.size>400)sources.delete(sources.keys().next().value);return payload;
}
const { TextPlacementPlanner } = require('./text-placement.cjs');
const { runPageTaskGroups } = require('./page-task-pool.cjs');
const { readerDocumentKey, sameReaderDocument } = require('./reader-document.cjs');
const { createReaderInteractionLock } = require('./reader-interaction-lock.cjs');
const { createOcrLab } = require('./ocr-lab-main.cjs');
const { ElectronBlocker, fromElectronDetails } = require('@ghostery/adblocker-electron');

const MAX_IMAGE = 32 * 1024 * 1024, MAX_IMAGES = 5000;
protocol.registerSchemesAsPrivileged([
  { scheme: 'eiw', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'eiw-image', privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);
const testMode = process.argv.includes('--eiw-test');
if (testMode) app.setPath('userData', process.env.EIW_TEST_USER_DATA ? path.resolve(process.env.EIW_TEST_USER_DATA) : path.join(app.getPath('temp'), `eiw-test-${process.pid}`));
let startupNetworkMode = 'auto', protectionCompatibilityEnabled = true, startupBrowserMode = 'chrome', chromeControl = 'standard';
try {
  const startupSettings = JSON.parse(fsSync.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8'));
  startupNetworkMode = normalizeNetworkMode(startupSettings.networkMode);
  chromeControl = startupSettings.chromeControl === 'minimal' ? 'minimal' : 'standard';
  const migrated = compatibilitySettings(startupSettings);
  protectionCompatibilityEnabled = migrated.protectionCompatibility; startupBrowserMode = migrated.browserMode;
} catch {}
if (isCompatibility(startupNetworkMode)) {
  app.commandLine.appendSwitch('disable-http2');
  app.commandLine.appendSwitch('disable-quic');
}
app.setName('ImageHarvest');
let mainWindow, browser, browsingSession, quitting = false, busy = null, job = null;
let electronImageStore = null, electronImageStoreReady = Promise.resolve(false);
let harvestBlockManagerWindow = null, harvestBlockManagerTabId = null, harvestBlockManagerKind = 'harvestts', harvestBlockManagerCollapsed = false;
let harvestContextMenuWindow = null, harvestContextMenuTarget = null, harvestContextMenuModel = null;

let screenClipBusy = false, printScreenRegistered = false;
async function openWindowsScreenClip() {
  if (process.platform !== 'win32' || screenClipBusy) return false;
  screenClipBusy = true;
  try {
    await shell.openExternal('ms-screenclip:');
    return true;
  } finally {
    setTimeout(() => { screenClipBusy = false; }, 700);
  }
}
function screenshotInput(event, input = {}) {
  if (process.platform !== 'win32') return false;
  const key = String(input.key || '').toLowerCase();
  const isPrintScreen = key === 'printscreen';
  const isSystemSnip = key === 's' && Boolean(input.shift) && Boolean(input.meta);
  if (!isPrintScreen && !isSystemSnip) return false;
  try { event.preventDefault(); } catch {}
  openWindowsScreenClip().catch(() => {});
  return true;
}
function screenshotWindowFocused() {
  const mainFocused = mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused();
  const popup = harvestBlockManagerWindow && !harvestBlockManagerWindow.isDestroyed() ? harvestBlockManagerWindow : null;
  return Boolean(mainFocused || popup?.isFocused());
}
function syncPrintScreenShortcut() {
  if (process.platform !== 'win32' || !app.isReady()) return;
  const shouldRegister = screenshotWindowFocused();
  if (shouldRegister && !printScreenRegistered) {
    printScreenRegistered = globalShortcut.register('PrintScreen', () => { openWindowsScreenClip().catch(() => {}); });
  } else if (!shouldRegister && printScreenRegistered) {
    globalShortcut.unregister('PrintScreen');
    printScreenRegistered = false;
  }
}
function bindScreenshotWindow(win) {
  if (!win || win.isDestroyed()) return;
  const sync = () => setTimeout(syncPrintScreenShortcut, 0);
  win.on('focus', sync);
  win.on('blur', sync);
  win.webContents.on('before-input-event', (event, input) => { screenshotInput(event, input); });
}

let browserMode = startupBrowserMode, networkMode = startupNetworkMode, activeNetworkMode = startupNetworkMode;
const autoFallbackHosts = new Map();
const compatibilityActive = isCompatibility(startupNetworkMode);
let captureSession = null;
let records = new Map(), cache = new ByteCache(), pending = new Map(), failedImages = new Map(), generation = 0;
let pageInfo = { title: '', url: '' }, lastFolder = '', outputRoot = '', renameFolder = '', canvasTempDir = '', blockedHosts = new Map();
let queue = Promise.resolve(), requestGate = 0;
let excludedIds = new Set(), lastRemoval = [];
let activeWorkspaceId = 'tab-1';
const workspaceStates = new Map();

const harvestTsTabs = new Map();
let harvestTsCounter = 0, activeHarvestTsId = null, harvestTsVisible = false;
let harvestTsBounds = { x: 220, y: 116, width: 900, height: 700 };

const harvestTsDataDir = path.join(app.getPath('userData'), 'harvestts');
const harvestTsBookmarkFile = path.join(harvestTsDataDir, 'bookmarks.json');
const harvestTsPasswordFile = path.join(harvestTsDataDir, 'passwords.json');
const harvestTsBlockFile = path.join(harvestTsDataDir, 'blocked-elements.json');
const harvestTsHistoryFile = path.join(harvestTsDataDir, 'history.json');
const harvestTsTabsFile = path.join(harvestTsDataDir, 'tabs.json');

const harvestTsExtensionFile = path.join(harvestTsDataDir, 'extensions.json');
const harvestTsBrowserSettingsFile = path.join(harvestTsDataDir, 'browser-settings.json');
const harvestTsDownloadsFile = path.join(harvestTsDataDir, 'downloads.json');
const harvestTsTranslateSettingsFile = path.join(harvestTsDataDir, 'translate-settings.json');
const harvestTsOfflineDir = path.join(harvestTsDataDir, 'offline-library');
const harvestTsOfflineIndexFile = path.join(harvestTsOfflineDir, 'index.json');
const harvestOfflineExportSessions = new Map();
let harvestOfflineWriteQueue = Promise.resolve();
const harvestAdblockCacheFile = path.join(harvestTsDataDir, 'harvest-adblock-engine.bin');
const harvestAdblockMetaFile = path.join(harvestTsDataDir, 'harvest-adblock-meta.json');
const HARVEST_BROWSER_DEFAULTS = { adblockEnabled:true, dnsMode:'inherit', customDoh:'', historyEnabled:true, restoreTabs:true };
let harvestBrowserRuntime = { ...HARVEST_BROWSER_DEFAULTS };
let harvestSessionConfigured = false;
let harvestDownloadsLoaded = false, harvestDownloadWriteTimer = null;
const harvestDownloadRecords = new Map();
const harvestLiveDownloads = new Map();
const harvestTranslationClient = new HarvestTranslationClient({ baseUrl: DEFAULT_TRANSLATION_ENDPOINT });
const harvestGoogleTranslateWeb = new GoogleTranslateWebPool({ size:4 });
const ocrTranslationService = new OcrTranslationService({google:harvestGoogleTranslateWeb,ai:harvestTranslationClient});
const harvestTranslationJobs = new Map();
const harvestTranslationTempRoot = path.join(app.getPath('temp'), 'ImageHarvest', testMode ? 'harvestts-translate-test-'+process.pid : 'harvestts-translate');
let harvestTranslationProbeCache = null;
const HARVEST_TRANSLATE_DEFAULTS = {
  engine:'ai',
  sourceLanguage:'auto',
  targetLanguage:'th',
  contentType:'manga',
  fontScale:1,
  showOriginal:false
};
const harvestScreenLensStates = new Map();
const harvestOriginalCaptureQueues = new WeakMap();
async function captureHarvestOriginal(wc){
  const pending=harvestOriginalCaptureQueues.get(wc)||Promise.resolve();
  const task=pending.catch(()=>{}).then(async()=>{
    const source=await wc.executeJavaScript(`(() => {
      const hidden=['__harvestts_manga_translate__','__harvestts_translation_overlay__','__harvestts_reader_lock__'].map(id=>document.getElementById(id)).filter(Boolean).map(host=>{const previous=host.style.display;host.style.display='none';return {id:host.id,previous};});
      return {type:'screenshot',url:location.href,scrollX,scrollY,viewportWidth:innerWidth,viewportHeight:innerHeight,devicePixelRatio,hidden};
    })()`);
    try{
      const image=await wc.capturePage(),after=await wc.executeJavaScript('({url:location.href,scrollX,scrollY})');
      if(after.url!==source.url||after.scrollX!==source.scrollX||after.scrollY!==source.scrollY)throw Error('หน้าเว็บเปลี่ยนระหว่างจับภาพ กรุณาจับใหม่');
      const {hidden,...metadata}=source;return {image,source:metadata};
    }finally{
      if(!wc.isDestroyed())await wc.executeJavaScript(`(${JSON.stringify(source.hidden)}).forEach(row=>{const host=document.getElementById(row.id);if(host)host.style.display=row.previous;})`).catch(()=>{});
    }
  });
  harvestOriginalCaptureQueues.set(wc,task);
  try{return await task;}finally{if(harvestOriginalCaptureQueues.get(wc)===task)harvestOriginalCaptureQueues.delete(wc);}
}
const ocrLab = createOcrLab({
  parent:() => mainWindow,
  translate:(regions,options)=>ocrTranslationService.translate(regions,options),
  translationModels:()=>ocrTranslationService.models(),
  overlay:async(image,regions,{targetLanguage='th'}={})=>{
    const source=image.source||{},tab=harvestTsTabs.get(source.tabId)||activeHarvestTsTab();
    if(!tab||tab.kind!=='web'||!sameHarvestTranslationPage(source.url,tab.view.webContents.getURL()))throw Error('เปิดแท็บเว็บต้นทางเดิมก่อนวางคำแปล');
    if(!['screenshot','harvest'].includes(source.type))throw Error('ภาพนี้ไม่มีตำแหน่งเว็บต้นทาง กรุณานำเข้าจาก HarvestTS');
    const planner=new TextPlacementPlanner();let planned;
    try{planned=await planner.planPage(image.buffer,regions);}finally{planner.close();}
    const page={id:source.pageId||image.id,source:source.type==='screenshot'?'screenshot':'img',sourceUrl:source.imageUrl,capture:source,width:image.width,height:image.height,imageDigest:image.digest,ocr:{regions:planned.regions}};
    const settings=await harvestTsTranslateSettings(),payload=await prepareOverlayStyles(tab,overlayPage(page,{documentUrl:source.url,targetLanguage}));
    if(!payload.regions.length)throw Error('ไม่มีคำแปลที่ยังตรงกับภาพและต้นฉบับ กรุณาแปลก่อน');
    return tab.view.webContents.executeJavaScript(`(() => {const overlay=window.__harvestTsTranslationOverlay||(window.__harvestTsTranslationOverlay=(${createTranslationOverlay.toString()})(${readerDocumentKey.toString()}));return overlay.apply(${JSON.stringify(payload)},${JSON.stringify({fontScale:settings.fontScale,visible:!settings.showOriginal})});})()`);
  },
  capture:async () => {
    const tab=activeHarvestTsTab();
    if(!tab||tab.kind!=='web'||tab.view.webContents.isDestroyed())throw new Error('เปิดแท็บเว็บ HarvestTS ก่อนจับภาพ');
    const {image,source}=await captureHarvestOriginal(tab.view.webContents);
    return {buffer:image.toPNG(),source:{...source,tabId:tab.id,capturedAt:new Date().toISOString()}};
  },
  harvest:async () => {
    const tab=activeHarvestTsTab(),state=harvestTranslationJobFor(tab),rows=[];
    if(state?.running)throw new Error('รอ Harvest และ OCR รอบปัจจุบันเสร็จก่อน');
    if(state?.manifest)for(const p of state.manifest.pages||[]){
      if(!p.file||p.error)continue;
      rows.push({buffer:await fs.readFile(path.join(state.dir,p.file)),name:p.file,
        source:{type:'harvest',tabId:tab.id,url:state.manifest.source?.url,imageUrl:p.sourceUrl,pageId:p.id},regions:p.ocr?.regions||[]});
    }
    if(!rows.length)for(const [id,item] of records){
      if(excludedIds.has(id))continue;
      const data=await getImage(id);
      rows.push({buffer:data.buffer,name:item.name||`image-${rows.length+1}`,source:{type:'collector',url:pageInfo.url,imageUrl:item.url,imageId:id}});
    }
    if(!rows.length)throw new Error('ยังไม่มีผล Harvest หรือภาพที่รวบรวม กรุณานำเข้าภาพหรือแคปแท็บ');
    return rows;
  }
});

const HARVEST_AD_HOSTS = [
  'doubleclick.net','googlesyndication.com','googleadservices.com','adservice.google.com',
  'adnxs.com','adsrvr.org','rubiconproject.com','pubmatic.com','openx.net','criteo.com','criteo.net',
  'amazon-adsystem.com','taboola.com','outbrain.com','scorecardresearch.com','quantserve.com',
  'popads.net','popcash.net','propellerads.com','adsterra.com','clickadu.com','exoclick.com',
  'hilltopads.net','monetag.com','trafficstars.com','juicyads.com','mgid.com','revcontent.com',
  'media.net','smartadserver.com','yieldmo.com','zedo.com','advertising.com','casalemedia.com',
  'lijit.com','bidswitch.net','contextweb.com','33across.com','sharethrough.com','teads.tv'
];
function harvestTsSession() { return session.fromPartition('persist:harvestts'); }
function harvestAdHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/,'');
  return HARVEST_AD_HOSTS.some(base => host === base || host.endsWith('.'+base));
}

const HARVEST_ADBLOCK_ENGINE_VERSION = '2.0';
const HARVEST_ADBLOCK_REFRESH_MS = 24 * 60 * 60 * 1000;
let harvestAdblockEngine = null;
let collectorElectronAdblocker = null;
let harvestAdblockLoading = null;
let harvestAdblockError = '';
let harvestAdblockSource = 'fallback';
let harvestAdblockUpdatedAt = 0;
let harvestAdblockBlockedSession = 0;
let harvestAdblockNetworkFilters = 0;
let harvestAdblockCosmeticFilters = 0;

function harvestAdblockSnapshot() {
  return {
    enabled: harvestBrowserRuntime.adblockEnabled !== false,
    name:'Harvest Adblock',
    version:HARVEST_ADBLOCK_ENGINE_VERSION,
    builtin:true,
    engine:harvestAdblockEngine ? 'Ghostery Engine' : 'Fallback',
    ready:Boolean(harvestAdblockEngine),
    loading:Boolean(harvestAdblockLoading),
    source:harvestAdblockSource,
    error:harvestAdblockError,
    updatedAt:harvestAdblockUpdatedAt || 0,
    blockedSession:harvestAdblockBlockedSession,
    networkFilters:harvestAdblockNetworkFilters,
    cosmeticFilters:harvestAdblockCosmeticFilters,
    sharedWithImageHarvest:true,
    collectorElectronActive:Boolean(browsingSession && collectorElectronAdblocker?.isBlockingEnabled?.(browsingSession)),
    features:{
      network:true,
      cosmetic:Boolean(harvestAdblockEngine),
      scriptlets:Boolean(harvestAdblockEngine),
      tracking:Boolean(harvestAdblockEngine)
    }
  };
}
function harvestAdblockFetch(input, init={}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  return globalThis.fetch(input, { ...init, signal:controller.signal }).finally(() => clearTimeout(timer));
}
async function readHarvestAdblockMeta() {
  return readHarvestJson(harvestAdblockMetaFile, {updatedAt:0,version:HARVEST_ADBLOCK_ENGINE_VERSION});
}
async function writeHarvestAdblockMeta(updatedAt=Date.now()) {
  harvestAdblockUpdatedAt = updatedAt;
  await writeHarvestJson(harvestAdblockMetaFile, {
    updatedAt,
    version:HARVEST_ADBLOCK_ENGINE_VERSION,
    source:'Ghostery Ads + Tracking prebuilt'
  });
}
function attachHarvestAdblockEvents(blocker) {
  blocker.on('request-blocked', () => { harvestAdblockBlockedSession += 1; });
  blocker.on('request-redirected', () => { harvestAdblockBlockedSession += 1; });
}
function installHarvestFallbackAdblockListener(ses = harvestTsSession()) {
  ses.webRequest.onBeforeRequest({ urls:['http://*/*','https://*/*'] }, (details, callback) => {
    let cancel = false;
    if (harvestBrowserRuntime.adblockEnabled && details.resourceType !== 'mainFrame') {
      try { cancel = harvestAdHost(new URL(details.url).hostname); } catch {}
    }
    if (cancel) harvestAdblockBlockedSession += 1;
    callback({ cancel });
  });
}

async function syncCollectorElectronAdblocker(force=false) {
  if (!browsingSession) return false;
  if (collectorElectronAdblocker?.isBlockingEnabled(browsingSession)) {
    if (force || harvestBrowserRuntime.adblockEnabled === false) {
      try { collectorElectronAdblocker.disableBlockingInSession(browsingSession); } catch {}
    }
  }
  if (harvestBrowserRuntime.adblockEnabled === false) return false;
  if (!harvestAdblockEngine) await initializeHarvestAdblockEngine().catch(()=>{});
  if (!harvestAdblockEngine) {
    installHarvestFallbackAdblockListener(browsingSession);
    return false;
  }
  if (!collectorElectronAdblocker || force) {
    try {
      collectorElectronAdblocker = ElectronBlocker.deserialize(harvestAdblockEngine.serialize());
      // Collector should block network ads/trackers without cosmetic hiding that
      // could remove content ImageHarvest is trying to scan.
      collectorElectronAdblocker.config.loadCosmeticFilters = false;
    } catch {
      collectorElectronAdblocker = null;
    }
  }
  if (collectorElectronAdblocker && !collectorElectronAdblocker.isBlockingEnabled(browsingSession)) {
    collectorElectronAdblocker.enableBlockingInSession(browsingSession);
    return true;
  }
  return Boolean(collectorElectronAdblocker);
}
async function syncCollectorAdblock(force=false) {
  await syncCollectorElectronAdblocker(force).catch(()=>{});
  if (typeof chromeBrowser !== 'undefined') {
    if (harvestBrowserRuntime.adblockEnabled === false) {
      await chromeBrowser.setAdblockEnabled(false).catch(()=>{});
    } else {
      await chromeBrowser.setAdblockEnabled(true).catch(()=>{});
      if (force) await chromeBrowser.reloadAdblocker().catch(()=>{});
    }
  }
}

async function attachHarvestAdblockEngine(blocker, source='fresh') {
  const ses = harvestTsSession();
  const previous = harvestAdblockEngine;
  if (previous && previous !== blocker && previous.isBlockingEnabled(ses)) {
    try { previous.disableBlockingInSession(ses); } catch {}
  }
  harvestAdblockEngine = blocker;
  harvestAdblockSource = source;
  harvestAdblockError = '';
  try {
    const filters = blocker.getFilters();
    harvestAdblockNetworkFilters = filters.networkFilters.length;
    harvestAdblockCosmeticFilters = filters.cosmeticFilters.length;
  } catch {
    harvestAdblockNetworkFilters = 0;
    harvestAdblockCosmeticFilters = 0;
  }
  attachHarvestAdblockEvents(blocker);
  if (harvestBrowserRuntime.adblockEnabled !== false && !blocker.isBlockingEnabled(ses)) {
    blocker.enableBlockingInSession(ses);
  }
  if (browsingSession) setTimeout(() => syncCollectorAdblock(true).catch(()=>{}), 0);
  return blocker;
}
async function loadHarvestAdblockCache() {
  const bytes = await fs.readFile(harvestAdblockCacheFile);
  const blocker = ElectronBlocker.deserialize(bytes);
  const meta = await readHarvestAdblockMeta();
  harvestAdblockUpdatedAt = Number(meta.updatedAt) || 0;
  await attachHarvestAdblockEngine(blocker, 'cache');
  return blocker;
}
async function fetchFreshHarvestAdblock() {
  if (typeof globalThis.fetch !== 'function') throw new Error('Fetch API ไม่พร้อมสำหรับอัปเดต Adblock');
  const blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(harvestAdblockFetch);
  await fs.mkdir(harvestTsDataDir, {recursive:true});
  await fs.writeFile(harvestAdblockCacheFile, blocker.serialize());
  await writeHarvestAdblockMeta(Date.now());
  await attachHarvestAdblockEngine(blocker, 'fresh');
  return blocker;
}
async function refreshHarvestAdblockEngine() {
  const old = harvestAdblockEngine;
  try {
    const blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(harvestAdblockFetch);
    await fs.mkdir(harvestTsDataDir, {recursive:true});
    await fs.writeFile(harvestAdblockCacheFile, blocker.serialize());
    await writeHarvestAdblockMeta(Date.now());
    await attachHarvestAdblockEngine(blocker, 'fresh');
    return harvestAdblockSnapshot();
  } catch (error) {
    harvestAdblockError = error.message || String(error);
    if (!old) installHarvestFallbackAdblockListener();
    throw error;
  }
}
async function initializeHarvestAdblockEngine() {
  if (harvestAdblockEngine) return harvestAdblockEngine;
  if (harvestAdblockLoading) return harvestAdblockLoading;
  harvestAdblockLoading = (async () => {
    let blocker = null;
    try { blocker = await loadHarvestAdblockCache(); }
    catch {}
    if (blocker) {
      const stale = !harvestAdblockUpdatedAt || (Date.now() - harvestAdblockUpdatedAt) > HARVEST_ADBLOCK_REFRESH_MS;
      if (stale) setTimeout(() => refreshHarvestAdblockEngine().catch(() => {}), 400);
      return blocker;
    }
    try { return await fetchFreshHarvestAdblock(); }
    catch (error) {
      harvestAdblockError = error.message || String(error);
      harvestAdblockSource = 'fallback';
      installHarvestFallbackAdblockListener();
      return null;
    }
  })();
  try { return await harvestAdblockLoading; }
  finally { harvestAdblockLoading = null; }
}

async function readHarvestBrowserSettings() {
  const data = await readHarvestJson(harvestTsBrowserSettingsFile, HARVEST_BROWSER_DEFAULTS);
  const mode = ['inherit','cloudflare','google','adguard','quad9','mullvad','custom'].includes(data.dnsMode) ? data.dnsMode : 'inherit';
  return {
    adblockEnabled:data.adblockEnabled !== false,
    dnsMode:mode,
    customDoh:typeof data.customDoh === 'string' ? data.customDoh : '',
    historyEnabled:data.historyEnabled !== false,
    restoreTabs:data.restoreTabs !== false
  };
}
async function saveHarvestBrowserSettings(next) {
  harvestBrowserRuntime = { ...HARVEST_BROWSER_DEFAULTS, ...next };
  await writeHarvestJson(harvestTsBrowserSettingsFile, harvestBrowserRuntime);
  return { ...harvestBrowserRuntime };
}

let harvestTabsRestoreAttempted = false, harvestTabsRestorePromise = null, harvestTabsSaveTimer = null, harvestHistoryWrite = Promise.resolve();

async function harvestTsHistoryList(input = {}) {
  const data = await readHarvestJson(harvestTsHistoryFile, { version:1, items:[] });
  let items = Array.isArray(data.items) ? data.items : [];
  items = items.filter(x => x && /^https?:\/\//i.test(x.url || ''));
  const limit = Math.max(1, Math.min(3000, Number(input.limit) || 1000));
  return { enabled:harvestBrowserRuntime.historyEnabled !== false, items:items.slice(0, limit) };
}
async function writeHarvestHistory(items) {
  await writeHarvestJson(harvestTsHistoryFile, { version:1, items:items.slice(0,3000) });
}
function queueHarvestHistory(url, title='') {
  if (harvestBrowserRuntime.historyEnabled === false || !/^https?:\/\//i.test(String(url || ''))) return;
  const visitedAt = Date.now();
  harvestHistoryWrite = harvestHistoryWrite.then(async () => {
    const data = await readHarvestJson(harvestTsHistoryFile, { version:1, items:[] });
    const items = Array.isArray(data.items) ? data.items : [];
    const first = items[0];
    if (first && first.url === url && visitedAt - Number(first.visitedAt || 0) < 5000) {
      first.title = String(title || first.title || url);
      first.visitedAt = visitedAt;
    } else {
      items.unshift({ id:randomUUID(), title:String(title || url), url:String(url), visitedAt });
    }
    await writeHarvestHistory(items);
  }).catch(() => {});
}
async function harvestTsHistoryRemove(input = {}) {
  const data = await readHarvestJson(harvestTsHistoryFile, { version:1, items:[] });
  const id = String(input.id || '');
  const items = (Array.isArray(data.items) ? data.items : []).filter(x => x?.id !== id);
  await writeHarvestHistory(items);
  return harvestTsHistoryList(input);
}
async function harvestTsHistoryClear() {
  await writeHarvestHistory([]);
  return { enabled:harvestBrowserRuntime.historyEnabled !== false, items:[] };
}
async function harvestTsBrowserSettings() { return { ...harvestBrowserRuntime }; }
async function harvestTsBrowserSettingsSet(input = {}) {
  const next = { ...harvestBrowserRuntime };
  if (typeof input.historyEnabled === 'boolean') next.historyEnabled = input.historyEnabled;
  if (typeof input.restoreTabs === 'boolean') next.restoreTabs = input.restoreTabs;
  await saveHarvestBrowserSettings(next);
  emit('harvestts-browser-settings', { ...harvestBrowserRuntime });
  return { ...harvestBrowserRuntime };
}

const HARVEST_ZOOM_LEVELS=[0.5,0.67,0.75,0.8,0.9,1,1.1,1.25,1.5,1.75,2,2.5,3];
function normalizeHarvestZoom(value){
  const n=Number(value);return Number.isFinite(n)?Math.max(.5,Math.min(3,n)):1;
}
function harvestNavigationSnapshot(tab){
  const wc=tab?.view?.webContents;
  if(!wc||wc.isDestroyed()||tab.kind!=='web')return {entries:[],index:0};
  try{
    const all=wc.navigationHistory?.getAllEntries?.()||[],active=wc.navigationHistory?.getActiveIndex?.()??Math.max(0,all.length-1);
    const valid=all.map((entry,sourceIndex)=>({sourceIndex,url:String(entry?.url||''),title:String(entry?.title||entry?.url||'')})).filter(entry=>/^https?:\/\//i.test(entry.url));
    if(!valid.length)return {entries:[],index:0};
    let pos=valid.findIndex(entry=>entry.sourceIndex===active);
    if(pos<0){pos=0;for(let i=0;i<valid.length;i++)if(valid[i].sourceIndex<=active)pos=i;}
    const limit=120,start=Math.max(0,Math.min(pos-60,Math.max(0,valid.length-limit))),slice=valid.slice(start,start+limit);
    return {entries:slice.map(({url,title})=>({url,title})),index:Math.max(0,Math.min(slice.length-1,pos-start))};
  }catch{return {entries:[],index:0};}
}
function stepHarvestZoom(tab,direction){
  if(!tab||tab.kind!=='web'||tab.view.webContents.isDestroyed())return false;
  const current=normalizeHarvestZoom(tab.zoomFactor||tab.view.webContents.getZoomFactor?.()||1);
  let index=HARVEST_ZOOM_LEVELS.findIndex(x=>Math.abs(x-current)<.001);
  if(index<0){index=HARVEST_ZOOM_LEVELS.reduce((best,x,i)=>Math.abs(x-current)<Math.abs(HARVEST_ZOOM_LEVELS[best]-current)?i:best,0);}
  const next=direction===0?1:HARVEST_ZOOM_LEVELS[Math.max(0,Math.min(HARVEST_ZOOM_LEVELS.length-1,index+(direction>0?1:-1)))];
  tab.zoomFactor=normalizeHarvestZoom(next);tab.view.webContents.setZoomFactor(tab.zoomFactor);
  try{tab.view.webContents.send('harvest-guest:zoom-display',{percent:Math.round(tab.zoomFactor*100)});}catch{}
  emitHarvestTs();scheduleHarvestTabsSave();return true;
}
function harvestTabsPayload() {
  const source=[...harvestTsTabs.values()].filter(tab=>tab&&tab.kind==='web'&&!tab.view.webContents.isDestroyed()&&/^https?:\/\//i.test(tab.view.webContents.getURL()||tab.url||'')).slice(0,25);
  const tabs=source.map(tab=>{
    const wc=tab.view.webContents,url=wc.getURL()||tab.url||'',history=harvestNavigationSnapshot(tab);
    return {url,title:wc.getTitle()||tab.title||url,zoomFactor:normalizeHarvestZoom(tab.zoomFactor||wc.getZoomFactor?.()||1),history};
  });
  let activeIndex=source.findIndex(x=>x.id===activeHarvestTsId);if(activeIndex<0)activeIndex=0;
  return {version:2,savedAt:Date.now(),activeIndex:Math.min(activeIndex,Math.max(0,tabs.length-1)),tabs};
}
async function saveHarvestTabsNow() {
  clearTimeout(harvestTabsSaveTimer); harvestTabsSaveTimer = null;
  await writeHarvestJson(harvestTsTabsFile, harvestTabsPayload());
}
function saveHarvestTabsSync() {
  try {
    fsSync.mkdirSync(harvestTsDataDir, { recursive:true });
    fsSync.writeFileSync(harvestTsTabsFile, JSON.stringify(harvestTabsPayload(), null, 2), 'utf8');
  } catch {}
}
function scheduleHarvestTabsSave(delayMs = 180) {
  clearTimeout(harvestTabsSaveTimer);
  harvestTabsSaveTimer = setTimeout(() => { saveHarvestTabsNow().catch(() => {}); }, delayMs);
}
async function restoreHarvestTabsIfNeeded() {
  if (harvestTsTabs.size) return harvestTsSnapshot();
  if (harvestTabsRestorePromise) return harvestTabsRestorePromise;
  if (harvestTabsRestoreAttempted) return harvestTsSnapshot();
  harvestTabsRestoreAttempted = true;
  harvestTabsRestorePromise = (async () => {
    if (harvestBrowserRuntime.restoreTabs === false) return harvestTsSnapshot();
    const data = await readHarvestJson(harvestTsTabsFile, { version:2, tabs:[], activeIndex:0 });
    const tabs = Array.isArray(data.tabs) ? data.tabs.filter(x => x && /^https?:\/\//i.test(x.url || '')).slice(0,25) : [];
    if (!tabs.length) return harvestTsSnapshot();
    const created = [];
    for (const row of tabs) {
      const entries=Array.isArray(row.history?.entries)?row.history.entries.filter(e=>e&&/^https?:\/\//i.test(e.url||'')).slice(0,120):[];
      const snap = createHarvestTsTab({ url:row.url, activate:false, skipSave:true, skipEmit:true, restored:true, navigationHistory:entries, navigationIndex:row.history?.index, zoomFactor:row.zoomFactor });
      const last = snap.tabs[snap.tabs.length - 1];
      if (last) created.push(last.id);
    }
    await Promise.all(created.map(id=>harvestTsTabs.get(id)?.bootstrapReady).filter(Boolean));
    const index = Math.max(0, Math.min(created.length - 1, Number(data.activeIndex) || 0));
    activeHarvestTsId = created[index] || created[0] || null;
    applyHarvestTsView();
    emitHarvestTs();
    scheduleHarvestTabsSave();
    return harvestTsSnapshot();
  })();
  try { return await harvestTabsRestorePromise; }
  finally { harvestTabsRestorePromise = null; }
}

function harvestDnsOptions(settings = harvestBrowserRuntime) {
  const templates = {
    cloudflare:'https://cloudflare-dns.com/dns-query',
    google:'https://dns.google/dns-query',
    adguard:'https://dns.adguard-dns.com/dns-query',
    quad9:'https://dns.quad9.net/dns-query',
    mullvad:'https://doh.mullvad.net/dns-query'
  };
  if (settings.dnsMode === 'inherit') return electronResolverOptions(networkMode);
  const secure = settings.dnsMode === 'custom' ? String(settings.customDoh || '').trim() : templates[settings.dnsMode];
  if (!secure) return electronResolverOptions(networkMode);
  return { enableBuiltInResolver:true, enableHappyEyeballs:true, secureDnsMode:'secure', secureDnsServers:[secure] };
}
function validateCustomDoh(raw) {
  const value = String(raw || '').trim();
  let url;
  try { url = new URL(value); } catch { throw new Error('Custom DNS ต้องเป็น DoH URL ที่ถูกต้อง'); }
  if (url.protocol !== 'https:' || url.username || url.password || value.length > 500) throw new Error('Custom DNS ต้องเป็น https:// DoH URL');
  return url.href;
}
async function applyHarvestDns() {
  app.configureHostResolver(harvestDnsOptions());
  const ses = harvestTsSession();
  await ses.clearHostResolverCache().catch(() => {});
  await ses.closeAllConnections().catch(() => {});
}
async function harvestTsDnsSettings() { return { ...harvestBrowserRuntime }; }
async function harvestTsDnsSet(input = {}) {
  const mode = String(input.mode || 'inherit');
  if (!['inherit','cloudflare','google','adguard','quad9','mullvad','custom'].includes(mode)) throw new Error('DNS mode ไม่ถูกต้อง');
  const customDoh = mode === 'custom' ? validateCustomDoh(input.customDoh) : '';
  const next = await saveHarvestBrowserSettings({ ...harvestBrowserRuntime, dnsMode:mode, customDoh });
  await applyHarvestDns();
  return next;
}
async function harvestTsDnsActivate() { await applyHarvestDns(); return { ...harvestBrowserRuntime }; }
async function harvestTsDnsDeactivate() {
  app.configureHostResolver(electronResolverOptions(networkMode));
  const ses = harvestTsSession();
  await ses.clearHostResolverCache().catch(() => {});
  await ses.closeAllConnections().catch(() => {});
  return true;
}
function configureHarvestTsSession() {
  if (harvestSessionConfigured) return harvestTsSession();
  const ses = harvestTsSession();
  ses.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  ses.setPermissionCheckHandler(()=>false);
  installHarvestFallbackAdblockListener(ses);
  configureHarvestDownloads(ses);
  harvestSessionConfigured = true;
  return ses;
}
async function harvestTsAdblockSet(input = {}) {
  const enabled = input.enabled !== false;
  await saveHarvestBrowserSettings({ ...harvestBrowserRuntime, adblockEnabled:enabled });
  const ses = configureHarvestTsSession();
  if (!enabled) {
    if (harvestAdblockEngine?.isBlockingEnabled(ses)) {
      try { harvestAdblockEngine.disableBlockingInSession(ses); } catch {}
    }
  } else {
    if (!harvestAdblockEngine) await initializeHarvestAdblockEngine();
    if (harvestAdblockEngine && !harvestAdblockEngine.isBlockingEnabled(ses)) {
      harvestAdblockEngine.enableBlockingInSession(ses);
    } else if (!harvestAdblockEngine) {
      installHarvestFallbackAdblockListener(ses);
    }
  }
  await syncCollectorAdblock(true).catch(()=>{});
  if (!enabled && webAlive()) {
    await runMainPage(`document.getElementById('__imageharvest_adblock_cosmetic__')?.remove();true`,browserMode).catch(()=>{});
  }
  emit('harvestts-adblock-status', harvestAdblockSnapshot());
  return harvestAdblockSnapshot();
}
async function harvestTsAdblockStatus() {
  if (!harvestAdblockEngine && !harvestAdblockLoading) initializeHarvestAdblockEngine().then(()=>emit('harvestts-adblock-status',harvestAdblockSnapshot())).catch(()=>{});
  return harvestAdblockSnapshot();
}
async function harvestTsAdblockUpdate() {
  if (harvestAdblockLoading) await harvestAdblockLoading.catch(()=>{});
  harvestAdblockLoading = refreshHarvestAdblockEngine();
  try { await harvestAdblockLoading; }
  finally { harvestAdblockLoading = null; }
  await syncCollectorAdblock(true).catch(()=>{});
  emit('harvestts-adblock-status', harvestAdblockSnapshot());
  return harvestAdblockSnapshot();
}
async function harvestTsExtensionData() {
  const data = await readHarvestJson(harvestTsExtensionFile, {version:1,items:[]});
  return {version:1,items:Array.isArray(data.items)?data.items:[]};
}
async function writeHarvestExtensions(data) { await writeHarvestJson(harvestTsExtensionFile, data); }
async function loadSavedHarvestExtensions() {
  const ses = configureHarvestTsSession(), data = await harvestTsExtensionData();
  let changed = false;
  for (const item of data.items) {
    item.error = '';
    if (item.enabled === false || !item.path) continue;
    try {
      const ext = await ses.loadExtension(item.path, { allowFileAccess:true });
      item.id = ext.id; item.name = ext.name || item.name; item.version = ext.version || item.version;
    } catch (error) { item.error = error.message; changed = true; }
  }
  if (changed) await writeHarvestExtensions(data);
  return data.items;
}
async function harvestTsExtensionList() {
  const data = await harvestTsExtensionData();
  const loaded = new Set(configureHarvestTsSession().getAllExtensions().map(x=>x.id));
  return data.items.map(item=>({ ...item, loaded:loaded.has(item.id), path:undefined }));
}
async function harvestTsExtensionInstall(input = {}) {
  let source = '';
  if (testMode && typeof input.sourcePath === 'string') source = path.resolve(input.sourcePath);
  else {
    const result = await dialog.showOpenDialog(mainWindow, { title:'ติดตั้ง Extension แบบ unpacked', properties:['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return {cancelled:true};
    source = result.filePaths[0];
  }
  const manifestPath = path.join(source,'manifest.json');
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(manifestPath,'utf8')); } catch { throw new Error('โฟลเดอร์นี้ไม่มี manifest.json ที่ถูกต้อง'); }
  if (![2,3].includes(Number(manifest.manifest_version))) throw new Error('รองรับ Chrome Extension Manifest V2/V3 เท่านั้น');
  const installRoot = path.join(harvestTsDataDir,'extensions');
  await fs.mkdir(installRoot,{recursive:true});
  const dest = path.join(installRoot, randomUUID());
  await fs.cp(source,dest,{recursive:true,errorOnExist:true});
  const ses = configureHarvestTsSession();
  try {
    const ext = await ses.loadExtension(dest,{allowFileAccess:true});
    const data = await harvestTsExtensionData();
    data.items.push({id:ext.id,name:ext.name || manifest.name || 'Extension',version:ext.version || manifest.version || '',path:dest,enabled:true,installedAt:Date.now(),error:''});
    await writeHarvestExtensions(data);
    return {cancelled:false,item:{id:ext.id,name:ext.name || manifest.name || 'Extension',version:ext.version || manifest.version || '',enabled:true,loaded:true}};
  } catch (error) {
    await fs.rm(dest,{recursive:true,force:true}).catch(()=>{});
    throw error;
  }
}
async function harvestTsExtensionToggle(input = {}) {
  const data = await harvestTsExtensionData(), item = data.items.find(x=>x.id===String(input.id||''));
  if (!item) throw new Error('ไม่พบ Extension');
  const ses = configureHarvestTsSession(), enabled = input.enabled !== false;
  if (!enabled) {
    if (item.id) ses.removeExtension(item.id);
    item.enabled = false; item.error = '';
  } else {
    try {
      const ext = await ses.loadExtension(item.path,{allowFileAccess:true});
      item.id = ext.id; item.name = ext.name || item.name; item.version = ext.version || item.version; item.enabled = true; item.error = '';
    } catch (error) { item.enabled = false; item.error = error.message; }
  }
  await writeHarvestExtensions(data);
  return harvestTsExtensionList();
}
async function harvestTsExtensionRemove(input = {}) {
  const data = await harvestTsExtensionData(), index = data.items.findIndex(x=>x.id===String(input.id||''));
  if (index < 0) throw new Error('ไม่พบ Extension');
  const [item] = data.items.splice(index,1);
  if (item.id) configureHarvestTsSession().removeExtension(item.id);
  if (item.path) await fs.rm(item.path,{recursive:true,force:true}).catch(()=>{});
  await writeHarvestExtensions(data);
  return harvestTsExtensionList();
}

async function readHarvestJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return structuredClone(fallback); }
}
async function writeHarvestJson(file, value) {
  await fs.mkdir(harvestTsDataDir, { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}

function harvestDownloadDirectory() {
  return testMode ? path.join(app.getPath('userData'),'Downloads') : app.getPath('downloads');
}
function harvestDownloadFilename(raw='download') {
  const base=path.basename(String(raw||'download')).replace(/[<>:"/\\|?*\x00-\x1F]/g,'_').replace(/[. ]+$/,'').slice(0,180);
  return base || 'download';
}
function uniqueHarvestDownloadPath(filename) {
  const dir=harvestDownloadDirectory(), parsed=path.parse(harvestDownloadFilename(filename));
  let candidate=path.join(dir,parsed.base), n=1;
  while(fsSync.existsSync(candidate) && n<10000){
    candidate=path.join(dir,`${parsed.name || 'download'} (${n++})${parsed.ext}`);
  }
  return candidate;
}
async function loadHarvestDownloads() {
  if(harvestDownloadsLoaded) return;
  const data=await readHarvestJson(harvestTsDownloadsFile,{version:1,items:[]});
  for(const row of Array.isArray(data.items)?data.items:[]){
    if(!row?.id) continue;
    const record={...row};
    if(record.state==='progressing') record.state='interrupted';
    harvestDownloadRecords.set(record.id,record);
  }
  harvestDownloadsLoaded=true;
}
function publicHarvestDownload(record) {
  if(!record) return null;
  return {
    id:record.id,
    filename:record.filename||'download',
    url:record.url||'',
    mimeType:record.mimeType||'',
    state:record.state||'interrupted',
    receivedBytes:Number(record.receivedBytes)||0,
    totalBytes:Number(record.totalBytes)||0,
    startedAt:Number(record.startedAt)||0,
    updatedAt:Number(record.updatedAt)||0,
    exists:Boolean(record.savePath && fsSync.existsSync(record.savePath)),
    active:harvestLiveDownloads.has(record.id)
  };
}
async function persistHarvestDownloadsNow() {
  clearTimeout(harvestDownloadWriteTimer); harvestDownloadWriteTimer=null;
  const items=[...harvestDownloadRecords.values()].sort((a,b)=>(b.startedAt||0)-(a.startedAt||0)).slice(0,1000);
  await writeHarvestJson(harvestTsDownloadsFile,{version:1,items});
}
function saveHarvestDownloadsSync() {
  if(!harvestDownloadsLoaded && !harvestDownloadRecords.size) return;
  try{
    fsSync.mkdirSync(harvestTsDataDir,{recursive:true});
    const items=[...harvestDownloadRecords.values()].map(row=>({
      ...row,
      state:harvestLiveDownloads.has(row.id)?'interrupted':row.state,
      updatedAt:harvestLiveDownloads.has(row.id)?Date.now():row.updatedAt
    })).sort((a,b)=>(b.startedAt||0)-(a.startedAt||0)).slice(0,1000);
    fsSync.writeFileSync(harvestTsDownloadsFile,JSON.stringify({version:1,items},null,2),'utf8');
  }catch{}
}
function scheduleHarvestDownloadWrite(delay=160) {
  clearTimeout(harvestDownloadWriteTimer);
  harvestDownloadWriteTimer=setTimeout(()=>persistHarvestDownloadsNow().catch(()=>{}),delay);
}
function emitHarvestDownloadsChanged() {
  const payload={items:[...harvestDownloadRecords.values()].sort((a,b)=>(b.startedAt||0)-(a.startedAt||0)).map(publicHarvestDownload)};
  for(const tab of harvestTsTabs.values()){
    if(tab?.kind==='downloads' && !tab.view.webContents.isDestroyed()){
      try{tab.view.webContents.send('harvest-internal:downloads-changed',payload)}catch{}
    }
  }
}
async function harvestTsDownloadList() {
  await loadHarvestDownloads();
  return {items:[...harvestDownloadRecords.values()].sort((a,b)=>(b.startedAt||0)-(a.startedAt||0)).map(publicHarvestDownload)};
}
async function harvestTsDownloadRemove(input={}) {
  await loadHarvestDownloads();
  const id=String(input.id||''), live=harvestLiveDownloads.get(id);
  if(live){try{live.cancel()}catch{} harvestLiveDownloads.delete(id);}
  harvestDownloadRecords.delete(id);
  await persistHarvestDownloadsNow();
  emitHarvestDownloadsChanged();
  return harvestTsDownloadList();
}
async function harvestTsDownloadClear() {
  await loadHarvestDownloads();
  for(const [id,record] of [...harvestDownloadRecords]){
    if(!harvestLiveDownloads.has(id) && record.state!=='progressing') harvestDownloadRecords.delete(id);
  }
  await persistHarvestDownloadsNow();
  emitHarvestDownloadsChanged();
  return harvestTsDownloadList();
}
async function harvestTsDownloadOpen(input={}) {
  await loadHarvestDownloads();
  const record=harvestDownloadRecords.get(String(input.id||''));
  if(!record?.savePath || !fsSync.existsSync(record.savePath)) throw new Error('ไม่พบไฟล์ดาวน์โหลดแล้ว');
  const error=await shell.openPath(record.savePath);
  if(error) throw new Error(error);
  return true;
}
async function harvestTsDownloadShow(input={}) {
  await loadHarvestDownloads();
  const record=harvestDownloadRecords.get(String(input.id||''));
  if(!record?.savePath || !fsSync.existsSync(record.savePath)) throw new Error('ไม่พบไฟล์ดาวน์โหลดแล้ว');
  shell.showItemInFolder(record.savePath);
  return true;
}
async function harvestTsDownloadCancel(input={}) {
  await loadHarvestDownloads();
  const id=String(input.id||''),item=harvestLiveDownloads.get(id);
  if(!item) return {cancelled:false};
  try{item.cancel()}catch{}
  return {cancelled:true};
}
function configureHarvestDownloads(ses) {
  ses.on('will-download', (_event,item) => {
    const id=randomUUID(), now=Date.now(), savePath=uniqueHarvestDownloadPath(item.getFilename());
    try{fsSync.mkdirSync(path.dirname(savePath),{recursive:true})}catch{}
    try{item.setSavePath(savePath)}catch{}
    const record={
      id,
      filename:path.basename(savePath),
      url:item.getURL()||'',
      mimeType:item.getMimeType?.()||'',
      savePath,
      state:'progressing',
      receivedBytes:Number(item.getReceivedBytes?.())||0,
      totalBytes:Number(item.getTotalBytes?.())||0,
      startedAt:now,
      updatedAt:now
    };
    harvestDownloadRecords.set(id,record);
    harvestLiveDownloads.set(id,item);
    loadHarvestDownloads().then(()=>{
      harvestDownloadRecords.set(id,record);
      scheduleHarvestDownloadWrite(0);
      emitHarvestDownloadsChanged();
    }).catch(()=>{});
    item.on('updated',(_e,state)=>{
      record.state=state==='interrupted'?'interrupted':'progressing';
      record.receivedBytes=Number(item.getReceivedBytes?.())||record.receivedBytes||0;
      record.totalBytes=Number(item.getTotalBytes?.())||record.totalBytes||0;
      record.updatedAt=Date.now();
      emitHarvestDownloadsChanged();
    });
    item.once('done',(_e,state)=>{
      record.state=state||'interrupted';
      record.receivedBytes=Number(item.getReceivedBytes?.())||record.receivedBytes||0;
      record.totalBytes=Number(item.getTotalBytes?.())||record.totalBytes||0;
      record.updatedAt=Date.now();
      harvestLiveDownloads.delete(id);
      loadHarvestDownloads().then(()=>{
        harvestDownloadRecords.set(id,record);
        scheduleHarvestDownloadWrite(0);
        emitHarvestDownloadsChanged();
      }).catch(()=>{});
    });
  });
}

function normalizeHarvestTranslateSettings(input = {}) {
  const engine = input.engine === 'google' ? 'google' : 'ai';
  const sourceAllowed = new Set(['auto','th','en','ja','fr','ko','zh']);
  const targetAllowed = new Set(['th','en','ja','fr','ko','zh']);
  const sourceLanguage = sourceAllowed.has(input.sourceLanguage) ? input.sourceLanguage : 'auto';
  const targetLanguage = targetAllowed.has(input.targetLanguage) ? input.targetLanguage : 'th';
  const contentType = input.contentType === 'novel' ? 'novel' : 'manga';
  const fontScale = Math.max(0.7, Math.min(1.8, Number(input.fontScale) || 1));
  const showOriginal = Boolean(input.showOriginal);
  return { engine, sourceLanguage, targetLanguage, contentType, fontScale, showOriginal };
}
async function harvestTsTranslateSettings() {
  const raw = await readHarvestJson(harvestTsTranslateSettingsFile, HARVEST_TRANSLATE_DEFAULTS);
  return normalizeHarvestTranslateSettings(raw);
}
async function updateHarvestTsTranslateSettings(input = {}) {
  const current = await harvestTsTranslateSettings();
  const next = normalizeHarvestTranslateSettings({ ...current, ...input });
  await writeHarvestJson(harvestTsTranslateSettingsFile, next);
  // Translation owns its browser queue. Settings must not navigate an active worker.
  return next;
}
function activeHarvestTsTab() {
  return harvestTsTabs.get(activeHarvestTsId) || null;
}
function harvestTsPageInfo(tab = activeHarvestTsTab()) {
  if (!tab || tab.view.webContents.isDestroyed()) throw new Error('ไม่พบแท็บ HarvestTS');
  const wc = tab.view.webContents, url = wc.getURL() || tab.url || '';
  if (!/^https?:\/\//i.test(url)) throw new Error('หน้านี้ยังไม่มี URL ที่บันทึกได้');
  return { tab, wc, url, title: wc.getTitle() || tab.title || url };
}

async function harvestTsBookmarkData() {
  const raw = await readHarvestJson(harvestTsBookmarkFile, { version:2, folders:[], items:[] });
  const folders = Array.isArray(raw.folders) ? raw.folders.filter(x => x && x.id && typeof x.name === 'string') : [];
  const folderIds = new Set(folders.map(x => x.id));
  const items = (Array.isArray(raw.items) ? raw.items : [])
    .filter(x => x && x.id && /^https?:\/\//i.test(x.url || ''))
    .map(x => ({ ...x, folderId:folderIds.has(x.folderId) ? x.folderId : null }))
    .slice(0,2000);
  return { version:2, folders, items };
}
async function writeHarvestBookmarkData(data) {
  await writeHarvestJson(harvestTsBookmarkFile, { version:2, folders:data.folders || [], items:data.items || [] });
}
async function harvestTsBookmarks() {
  const data = await harvestTsBookmarkData();
  const names = new Map(data.folders.map(x => [x.id,x.name]));
  return data.items.map(x => ({ ...x, folderName:x.folderId ? names.get(x.folderId) || '' : '' }));
}
async function harvestTsBookmarkModel() {
  const data = await harvestTsBookmarkData();
  return { folders:data.folders, items:(await harvestTsBookmarks()) };
}
async function harvestTsBookmarkStatus(input = {}) {
  const url = String(input.url || '').trim();
  const data = await harvestTsBookmarkData();
  const item = data.items.find(x => x.url === url) || null;
  return { saved:Boolean(item), item, folders:data.folders };
}
async function harvestTsBookmarkAdd(input = {}) {
  const page = harvestTsPageInfo(harvestTsTabs.get(String(input.id || activeHarvestTsId)));
  const data = await harvestTsBookmarkData();
  const folderId = input.folderId == null || input.folderId === '' ? null : String(input.folderId);
  if (folderId && !data.folders.some(x => x.id === folderId)) throw new Error('ไม่พบโฟลเดอร์ Bookmark');
  const now = Date.now();
  let existing = data.items.find(x => x.url === page.url);
  if (existing) {
    existing.title = page.title; existing.folderId = folderId; existing.updatedAt = now;
  } else {
    existing = { id:randomUUID(), title:page.title, url:page.url, folderId, createdAt:now, updatedAt:now };
    data.items.unshift(existing);
  }
  await writeHarvestBookmarkData(data);
  return { saved:true, item:existing, folders:data.folders, items:await harvestTsBookmarks() };
}
async function harvestTsBookmarkRemove(input = {}) {
  const data = await harvestTsBookmarkData(), id = String(input.id || '');
  data.items = data.items.filter(x => x.id !== id);
  await writeHarvestBookmarkData(data);
  return { items:await harvestTsBookmarks(), folders:data.folders };
}
async function harvestTsBookmarkFolderCreate(input = {}) {
  const name = String(input.name || '').trim().replace(/\s+/g,' ');
  if (!name) throw new Error('กรุณาตั้งชื่อโฟลเดอร์');
  if (name.length > 80) throw new Error('ชื่อโฟลเดอร์ยาวเกินไป');
  const data = await harvestTsBookmarkData();
  const duplicate = data.folders.find(x => x.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (duplicate) return { folder:duplicate, folders:data.folders };
  const folder = { id:randomUUID(), name, createdAt:Date.now() };
  data.folders.push(folder);
  await writeHarvestBookmarkData(data);
  return { folder, folders:data.folders };
}
async function harvestTsBookmarkFolderRemove(input = {}) {
  const id = String(input.id || '');
  const data = await harvestTsBookmarkData();
  data.folders = data.folders.filter(x => x.id !== id);
  for (const item of data.items) if (item.folderId === id) item.folderId = null;
  await writeHarvestBookmarkData(data);
  return harvestTsBookmarkModel();
}

function encryptHarvestSecret(value) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows ยังไม่พร้อมเข้ารหัส Password Vault');
  return safeStorage.encryptString(String(value || '')).toString('base64');
}
function decryptHarvestSecret(value) {
  try {
    if (!value || !safeStorage.isEncryptionAvailable()) return '';
    return safeStorage.decryptString(Buffer.from(String(value), 'base64'));
  } catch { return ''; }
}

async function harvestTsPasswordData() {
  const data = await readHarvestJson(harvestTsPasswordFile, { version:1, items:[] });
  return { version:1, items:Array.isArray(data.items) ? data.items : [] };
}
async function harvestTsPasswordList() {
  const data = await harvestTsPasswordData();
  return data.items.map(x => ({
    id:x.id, origin:x.origin, url:x.url, username:decryptHarvestSecret(x.username),
    updatedAt:x.updatedAt || x.createdAt || 0
  })).filter(x => x.id && x.origin);
}

async function harvestPasswordAccountsForOrigin(origin) {
  const data = await harvestTsPasswordData();
  return data.items.filter(x => x.origin === origin).map(x => ({
    id:x.id, origin:x.origin, url:x.url,
    username:decryptHarvestSecret(x.username),
    updatedAt:x.updatedAt || x.createdAt || 0
  })).filter(x => x.id);
}
function harvestGuestTab(event) {
  const tab=[...harvestTsTabs.values()].find(row => row.kind==='web' && !row.view.webContents.isDestroyed() && row.view.webContents===event.sender);
  if(!tab) throw new Error('Unauthorized HarvestTS guest IPC');
  return tab;
}

function harvestScreenLensSnapshot(tab) {
  const state = tab ? harvestScreenLensStates.get(tab.id) : null;
  return state ? {
    enabled:Boolean(state.enabled),
    frames:Number(state.frames) || 0,
    lastAt:Number(state.lastAt) || 0,
    bytes:Number(state.bytes) || 0,
    width:Number(state.width) || 0,
    height:Number(state.height) || 0,
    error:state.error || ''
  } : { enabled:false, frames:0, lastAt:0, bytes:0, width:0, height:0, error:'' };
}
function sendHarvestScreenLens(tab) {
  if (!tab || tab.view.webContents.isDestroyed()) return;
  tab.view.webContents.send('harvest-guest:screen-lens-status', harvestScreenLensSnapshot(tab));
}
async function stopHarvestScreenLens(tab) {
  if (!tab) return { enabled:false };
  const state = harvestScreenLensStates.get(tab.id);
  if (!state) return { enabled:false };
  state.enabled = false;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.latestBuffer = null;
  sendHarvestScreenLens(tab);
  harvestScreenLensStates.delete(tab.id);
  return { enabled:false };
}
async function startHarvestScreenLens(tab) {
  if (!tab || tab.view.webContents.isDestroyed()) throw new Error('ไม่พบหน้าเว็บสำหรับ Screen Lens');
  const existing = harvestScreenLensStates.get(tab.id);
  if (existing?.enabled) return harvestScreenLensSnapshot(tab);

  const state = {
    enabled:true, frames:0, lastAt:0, bytes:0, width:0, height:0,
    error:'', timer:null, latestBuffer:null, capturing:false
  };
  harvestScreenLensStates.set(tab.id, state);

  const tick = async () => {
    if (!state.enabled || tab.view.webContents.isDestroyed()) return;
    if (!state.capturing) {
      state.capturing = true;
      try {
        const {image} = await captureHarvestOriginal(tab.view.webContents);
        const size = image.getSize();
        const buffer = image.toJPEG(72);
        state.latestBuffer = buffer;
        state.frames += 1;
        state.lastAt = Date.now();
        state.bytes = buffer.length;
        state.width = size.width;
        state.height = size.height;
        state.error = '';
      } catch (error) {
        state.error = error.message || String(error);
      } finally {
        state.capturing = false;
        sendHarvestScreenLens(tab);
      }
    }
    if (state.enabled) state.timer = setTimeout(tick, 850);
  };

  sendHarvestScreenLens(tab);
  tick();
  return harvestScreenLensSnapshot(tab);
}

function sendHarvestTranslation(tab, payload = {}) {
  if (!tab || tab.view.webContents.isDestroyed()) return;
  tab.view.webContents.send('harvest-guest:translation-progress', { tabId:tab.id, ...payload });
}
function harvestTranslationJobFor(tab) {
  return tab ? harvestTranslationJobs.get(tab.id) || null : null;
}
function assertHarvestTranslationRunning(job) {
  if (!job || job.abort.signal.aborted) throw new Error('ยกเลิกการเตรียมหน้าแล้ว');
}
async function setHarvestReaderLock(tab, job, action) {
  const wc=tab?.view?.webContents;
  if(!wc||wc.isDestroyed())return false;
  if(action==='acquire')return wc.executeJavaScript(`(() => {
    const lock=window.__harvestTsReaderLock||(window.__harvestTsReaderLock=(${createReaderInteractionLock.toString()})(${readerDocumentKey.toString()}));
    return lock.acquire(${JSON.stringify(job.id)});
  })()`,true);
  return wc.executeJavaScript(`window.__harvestTsReaderLock?.${action}(${JSON.stringify(job.id)})`,true);
}
async function cancelHarvestTranslationJob(tab, removeFiles = false) {
  const state = harvestTranslationJobFor(tab);
  if (!state) return { cancelled:false };
  if (!state.abort.signal.aborted) state.abort.abort();
  state.running = false;
  await setHarvestReaderLock(tab,state,'release').catch(()=>{});
  sendHarvestTranslation(tab, { type:'cancelled', jobId:state.id });
  if (removeFiles && state.dir && !state.persistent) await fs.rm(state.dir, { recursive:true, force:true }).catch(() => {});
  if (removeFiles) harvestTranslationJobs.delete(tab.id);
  return { cancelled:true, jobId:state.id };
}
async function probeHarvestTranslationApi(tab, job) {
  sendHarvestTranslation(tab, { type:'model', ok:null, endpoint:DEFAULT_TRANSLATION_ENDPOINT, message:'กำลังเชื่อม LM Studio และตรวจโมเดล…' });
  assertHarvestTranslationRunning(job);
  const discovered=harvestTranslationProbeCache&&Date.now()-harvestTranslationProbeCache.checkedAt<10*60*1000
    ? {...harvestTranslationProbeCache}
    : await harvestTranslationClient.probe({ sample:false });
  assertHarvestTranslationRunning(job);
  sendHarvestTranslation(tab,{type:'model',ok:null,endpoint:discovered.endpoint||DEFAULT_TRANSLATION_ENDPOINT,model:discovered.model,message:'พบ '+discovered.model+' • กำลังโหลดและ warm-up ให้พร้อมจริง…'});
  const ready=await harvestTranslationClient.ensureModelReady(discovered.model,{signal:job.abort.signal,timeoutMs:8*60*1000,onStatus:status=>{if(!job.abort.signal.aborted)sendHarvestTranslation(tab,{type:'model',ok:null,endpoint:discovered.endpoint||DEFAULT_TRANSLATION_ENDPOINT,model:discovered.model,message:status.message||'กำลังเตรียมโมเดล…'});}});
  assertHarvestTranslationRunning(job);
  harvestTranslationProbeCache={...discovered,...ready,checkedAt:Date.now()};
  sendHarvestTranslation(tab,{type:'model',ok:true,...harvestTranslationProbeCache,message:'โมเดลพร้อมจริง • '+discovered.model+(ready.parallel>1?' • parallel '+ready.parallel:'')});
  return harvestTranslationProbeCache;
}
function sameHarvestTranslationPage(a, b) { return sameReaderDocument(a, b); }
async function scanHarvestTsTranslationPages(tab, job) {
  const scanStartedAt = Date.now();
  const wc = tab.view.webContents;
  const startURL = wc.getURL() || tab.url || '';
  if (!/^https?:\/\//i.test(startURL)) throw new Error('เปิดหน้ามังงะใน HarvestTS ก่อนกด Start');

  // Translation scan is intentionally faster than the general collector:
  // first inspect the whole DOM once, then scroll only when the reader really needs it.
  const maxSteps = 180, waitMs = 140, found = new Map();
  let previousHeight = -1, previousCount = -1, stableSince = 0, steps = 0, lastMeta = {}, fastPath = false;
  const options = { selector:'', backgrounds:true, canvases:false, smartBackgrounds:true, adaptiveBackgrounds:true };

  const mergeSnapshot = snap => {
    lastMeta = snap || {};
    for (const raw of snap?.items || []) {
      const url = imageURL(raw.url, startURL);
      if (!url) continue;
      const key = `${raw.key || raw.dom || found.size}|${url}`;
      const existing = found.get(key);
      if (existing) Object.assign(existing, raw, { url, order:existing.order });
      else if (found.size < MAX_IMAGES) found.set(key, { ...raw, url, order:found.size });
    }
  };
  const candidatePages = () => selectMangaPages([...found.values()]);

  sendHarvestTranslation(tab, { type:'scan', progress:0, found:0, message:'กำลังให้ Harvest ตรวจหน้า reader…' });
  await wc.executeJavaScript(`(${scrollScript})('init')`, true);
  await delay(40);

  try {
    assertHarvestTranslationRunning(job);
    const first = await withTimeout(
      wc.executeJavaScript(`(${collector})(${JSON.stringify(options)})`, true),
      15000,
      'หน้าเว็บไม่ตอบสนองต่อ Harvest'
    );
    mergeSnapshot(first);
    steps = 1;

    const structure = await wc.executeJavaScript(`(${readerProbe})(${JSON.stringify({ selector:'' })})`, true).catch(() => ({}));
    const expectedTotal = Math.max(0, Number(structure?.expectedTotal) || 0);
    const geometry = await wc.executeJavaScript(`(() => ({
      height: Math.max(document.scrollingElement?.scrollHeight || 0, document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0),
      viewport: innerHeight
    }))()`, true);
    const initialPages = candidatePages();
    const lastBottom = initialPages.reduce((max, item) => {
      const displayHeight = Number(item.filterHints?.displayHeight) || Number(item.height) || 0;
      return Math.max(max, (Number(item.top) || 0) + displayHeight);
    }, 0);
    const coverage = Number(geometry?.height) > 0 ? lastBottom / Number(geometry.height) : 0;
    const decoded = initialPages.filter(item => item.source !== 'img' || item.decoded === true).length;
    const decodedRatio = initialPages.length ? decoded / initialPages.length : 0;

    // Do not use a magic page-count threshold. A reader with 4, 10, 20 or 40
    // initially visible pages can still lazy-load more. Any DOM-complete candidate
    // must survive a bottom verification window before we trust the fast path.
    fastPath = initialPages.length >= 2 &&
      coverage >= 0.78 && coverage <= 1.15 &&
      decodedRatio >= 0.75 &&
      (!expectedTotal || initialPages.length >= expectedTotal);

    if (fastPath) {
      const beforeCount=initialPages.length,beforeHeight=Number(geometry?.height)||0;
      let verifyCount=beforeCount,verifyHeight=beforeHeight,quietRounds=0;
      // Without an explicit total, give slow lazy loaders a real settle window.
      // Readers with a trustworthy data-page-count can finish sooner once that
      // count is already present.
      const requiredQuietRounds=expectedTotal>0?3:13;
      for(let verify=0;verify<16;verify++){
        // Actually touch the current end on every round. Lazy readers often
        // extend scrollHeight only after the viewport reaches the old end.
        await wc.executeJavaScript(`(${scrollScript})('end')`, true);
        await delay(320);
        const probe = await withTimeout(
          wc.executeJavaScript(`(${collector})(${JSON.stringify(options)})`, true),
          15000,
          'หน้าเว็บไม่ตอบสนองต่อ Harvest'
        );
        mergeSnapshot(probe);steps++;
        const probePos=await wc.executeJavaScript(`(${scrollScript})('status')`, true);
        const nextCount=candidatePages().length,nextHeight=Number(probePos?.height)||0;
        const expectedMissing=expectedTotal>0&&nextCount<expectedTotal;
        if(nextCount>verifyCount || nextHeight>verifyHeight*1.01 || expectedMissing){
          fastPath=false;verifyCount=nextCount;verifyHeight=Math.max(verifyHeight,nextHeight);break;
        }
        verifyCount=nextCount;verifyHeight=Math.max(verifyHeight,nextHeight);quietRounds++;
        if(quietRounds>=requiredQuietRounds)break;
      }
    }

    if (fastPath) {
      sendHarvestTranslation(tab, {
        type:'scan',
        progress:1,
        found:candidatePages().length,
        step:steps,
        fast:true,
        message:`ตรวจปลายหน้าแล้ว • พบหน้ามังงะครบ ${candidatePages().length} หน้า • ข้ามการเลื่อนต่อ`
      });
    } else {
      // A failed fast-path probe may already be sitting at the end. Rewind to
      // the scan start without overwriting the user's saved scroll position,
      // then walk the whole reader so virtual/lazy middle pages are not skipped.
      await wc.executeJavaScript(`(${scrollScript})('start')`, true);
      await delay(80);
      let currentCount = candidatePages().length;
      const initialPos = await wc.executeJavaScript(`(${scrollScript})('status')`, true);
      previousHeight = Number(initialPos?.height) || 0;
      previousCount = currentCount;

      for (let step = 0; step < maxSteps; step++) {
        assertHarvestTranslationRunning(job);
        const currentURL = wc.getURL() || tab.url || '';
        if (!sameHarvestTranslationPage(startURL, currentURL)) throw new Error('หน้าเว็บเปลี่ยนระหว่าง Harvest กรุณากด Start ใหม่');

        await wc.executeJavaScript(`(${scrollScript})({action:'step',conservative:false,factor:1.55})`, true);
        await delay(waitMs);

        const snap = await withTimeout(
          wc.executeJavaScript(`(${collector})(${JSON.stringify(options)})`, true),
          15000,
          'หน้าเว็บไม่ตอบสนองต่อ Harvest'
        );
        mergeSnapshot(snap);
        steps = step + 2;

        const pos = await wc.executeJavaScript(`(${scrollScript})('status')`, true);
        currentCount = candidatePages().length;
        const height = Number(pos?.height) || 0;
        const unchanged = currentCount === previousCount;
        const stableAtBottom=Boolean(pos?.bottom&&height===previousHeight&&unchanged);
        if(stableAtBottom){if(!stableSince)stableSince=Date.now();}else stableSince=0;
        previousHeight = height;
        previousCount = currentCount;

        sendHarvestTranslation(tab, {
          type:'scan',
          progress:Math.max(0, Math.min(1, Number(pos?.progress) || 0)),
          found:currentCount,
          step:steps,
          message:`สแกนแบบเร็ว • พบหน้ามังงะ ${currentCount} หน้า`
        });

        if (stableSince&&Date.now()-stableSince>=4200) break;
        if (pos?.bottom) await delay(260);
      }
    }
  } finally {
    if (!wc.isDestroyed() && sameHarvestTranslationPage(startURL, wc.getURL() || '')) {
      await wc.executeJavaScript(`(${scrollScript})('restore')`, true).catch(() => {});
    }
  }

  const pages = candidatePages().map((item, index) => ({
    ...item,
    pageId:`${job.id}-p${String(index + 1).padStart(4, '0')}`,
    pageIndex:index
  }));
  if (!pages.length) {
    const canvasNote = Number(lastMeta?.canvases || 0) > 0 ? ' หน้านี้มี Canvas ซึ่งตัวเชื่อมรอบแรกยังไม่ดึงเข้า pipeline แปล' : '';
    throw new Error('Harvest ไม่พบภาพที่เข้าเกณฑ์หน้ามังงะในหน้านี้' + canvasNote);
  }

  const scanMs = Date.now() - scanStartedAt;
  sendHarvestTranslation(tab, {
    type:'pages',
    pages:pages.map(x => ({
      id:x.pageId, index:x.pageIndex, width:x.width || 0, height:x.height || 0,
      label:x.alt || x.url.split('/').pop() || `หน้า ${x.pageIndex + 1}`
    })),
    total:pages.length,
    scanMs,
    fastPath,
    message:`พบหน้ามังงะ ${pages.length} หน้าใน ${(scanMs / 1000).toFixed(1)} วิ • กำลังเตรียมไฟล์ให้ระบบแปล`
  });
  return { startURL, title:lastMeta?.title || wc.getTitle() || tab.title || '', pages, steps, scanMs, fastPath };
}
async function acquireHarvestTsTranslationImage(tab, item, signal) {
  if (signal?.aborted) throw new Error('ยกเลิกการเตรียมหน้าแล้ว');
  // Prefer the exact image bytes Chromium already loaded for this reader.
  // This preserves the page's real session/cookies and avoids a second hotlink
  // request that some CDNs intentionally answer with 403.
  if (/^https?:/i.test(item.url) && tab?.imageStore) {
    await Promise.resolve(tab.imageStoreReady).catch(() => false);
    await tab.imageStore.settle().catch(() => {});
    const loaded = await tab.imageStore.read(item.url).catch(() => null);
    if (loaded?.buffer?.length) return { buffer:loaded.buffer, ext:loaded.ext, mime:loaded.mime };
  }
  let buffer, contentType = '';
  if (item.url.startsWith('data:')) {
    const comma = item.url.indexOf(','), meta = item.url.slice(0, comma);
    if (comma < 0 || item.url.length > MAX_IMAGE * 1.5) throw new Error('Embedded image ไม่ถูกต้องหรือใหญ่เกินไป');
    buffer = /;base64/i.test(meta) ? Buffer.from(item.url.slice(comma + 1), 'base64') : Buffer.from(decodeURIComponent(item.url.slice(comma + 1)));
    contentType = meta.slice(5).split(';')[0];
  } else if (item.url.startsWith('blob:')) {
    const payload = await withTimeout(tab.view.webContents.executeJavaScript(`(async()=>{const r=await fetch(${JSON.stringify(item.url)});const b=await r.blob();if(b.size>${MAX_IMAGE})throw new Error('too large');return await new Promise((resolve,reject)=>{const f=new FileReader();f.onload=()=>resolve(f.result);f.onerror=reject;f.readAsDataURL(b)})})()`, true), 25000, 'อ่านภาพ blob ไม่สำเร็จ');
    if (typeof payload !== 'string' || payload.length > MAX_IMAGE * 1.5) throw new Error('ข้อมูล blob ไม่ถูกต้อง');
    const comma = payload.indexOf(',');
    contentType = payload.slice(5, payload.indexOf(';'));
    buffer = Buffer.from(payload.slice(comma + 1), 'base64');
  } else {
    let target = item.url, response = null;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once:true });
    const timer = setTimeout(abort, 30000);
    try {
      for (let hop = 0; hop <= 5; hop++) {
        assertHarvestTranslationRunning({ abort:{ signal:controller.signal } });
        response = await fetchManual(target, {
          credentials:'include',
          redirect:'manual',
          referrer:item.referrer || tab.view.webContents.getURL() || tab.url || '',
          referrerPolicy:'strict-origin-when-cross-origin',
          headers:{ Accept:'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8' },
          signal:controller.signal
        }, tab.view.webContents.session, MAX_IMAGE);
        if (![301,302,303,307,308].includes(response.status)) break;
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || hop === 5) throw new Error('ภาพ redirect มากเกินไป');
        const next = new URL(location, target);
        if (!allowedWeb(next.href) || next.username || next.password) throw new Error('ปลายทางภาพไม่ปลอดภัย');
        target = next.href;
      }
      if (!response?.ok) {
        await response?.body?.cancel();
        throw new Error(`HTTP ${response?.status || 0}`);
      }
      buffer = await readLimited(response, controller.signal);
      contentType = response.headers.get('content-type') || '';
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  if (!buffer?.length || buffer.length > MAX_IMAGE) throw new Error('ข้อมูลภาพไม่ถูกต้องหรือใหญ่เกิน 32 MB');
  return { buffer, ...imageType(buffer, contentType) };
}
async function runHarvestOcrStage(tab, job, manifestPages, settings={}) {
  const candidates = manifestPages
    .map((row, index) => row?.file && !row.error ? {
      manifestIndex:index,
      pageIndex:Number.isInteger(row.index) ? row.index : index,
      filePath:path.join(job.dir, row.file),
      width:row.width,height:row.height,
      id:row.id
    } : null)
    .filter(Boolean);

  if (!candidates.length) return { pages:0, regions:0, failed:0, ms:0 };

  const startedAt = Date.now();
  let completed = 0, failed = 0, regions = 0;
  sendHarvestTranslation(tab, {
    type:'stage', stage:'ocr', progress:0.32,
    message:`กำลัง OCR ${candidates.length} หน้า…`
  });

  const enhanced=fsSync.existsSync(path.join(runtimeRoot(),'Scripts','python.exe'));
  const backend=new LocalOcrBackend();
  const languages=[{en:'eng',ja:'jpn',th:'tha',fr:'fra'}[settings.sourceLanguage]].filter(Boolean);
  if(!languages.length)languages.push('eng','fra','jpn','tha');
  const Pool=enhanced?EnhancedMangaOcrPool:MangaOcrPool;
  const pool = new Pool({
    langPath:path.join(__dirname, '..', 'assets', 'tessdata'),
    languages,backend,
    concurrency:Math.min(4, Math.max(1, candidates.length)),
    detailDetection:true,
    ...(enhanced?{discovery:false}: {})
  });
  const placementPlanner = new TextPlacementPlanner({backend});
  const placementSummary = { pages:0, bubble:0, scene:0, reviewRequired:0, requiresInpaint:0, failed:0, ms:0 };

  try {
    const results = await pool.recognizePages(candidates, {
      signal:job.abort.signal,
      onStart:(page) => {
        const row = manifestPages[page.manifestIndex];
        if (!row) return;
        sendHarvestTranslation(tab, {
          type:'page', index:page.manifestIndex, id:row.id,
          progress:0.38, status:'กำลัง OCR หา text region…'
        });
      },
      onDone:(page, result) => {
        const row = manifestPages[page.manifestIndex];
        if (!row) return;
        completed++;
        if (result.error) failed++;
        regions += result.regions?.length || 0;
        row.ocr = {
          engine:result.engine||'comic-text-detector+tesseract.js',
          languages,performance:result.performance,
          ms:result.ms || 0,
          text:result.text || '',
          regions:require('./ocr-content-role.cjs').annotateContent(result.regions || []),
          passes:result.passes || [],
          error:result.error || ''
        };
        sendHarvestTranslation(tab, {
          type:'page', index:page.manifestIndex, id:row.id,
          progress:result.error ? 1 : 0.72,
          error:Boolean(result.error),
          status:result.error
            ? `OCR ไม่สำเร็จ • ${result.error}`
            : `OCR พบ ${result.regions?.length || 0} จุด • กำลังสร้างพื้นที่ข้อความ`
        });
        sendHarvestTranslation(tab, {
          type:'stage', stage:'ocr',
          progress:0.32 + 0.36 * (completed / candidates.length),
          message:`OCR ${completed}/${candidates.length} หน้า • พบข้อความ ${regions} จุด`
        });
      }
    });

    for (let i = 0; i < candidates.length; i++) {
      const page = candidates[i], result = results[i];
      const row = manifestPages[page.manifestIndex];
      if (row && result && !row.ocr) {
        row.ocr = {
          engine:'tesseract.js', languages:['eng','fra','jpn','tha'],
          ms:result.ms || 0, text:result.text || '', regions:result.regions || [],
          error:result.error || ''
        };
      }
    }

    const layoutStartedAt = Date.now();
    sendHarvestTranslation(tab, {
      type:'stage', stage:'layout', progress:0.69,
      message:`กำลังสร้างพื้นที่วางคำแปล ${candidates.length} หน้า…`
    });
    for (let i = 0; i < candidates.length; i++) {
      assertHarvestTranslationRunning(job);
      const page = candidates[i], row = manifestPages[page.manifestIndex];
      if (!row?.ocr || row.ocr.error) continue;
      sendHarvestTranslation(tab, {
        type:'page', index:page.manifestIndex, id:row.id,
        progress:0.71, status:'กำลังจับขอบกล่องคำพูด / พื้นที่ข้อความ…'
      });
      const planned = await placementPlanner.planPage(page.filePath, row.ocr.regions || [], { signal:job.abort.signal, refineText:true, sourceLanguage:settings.sourceLanguage, onRefine:({reason})=>sendHarvestTranslation(tab,{type:'page',index:page.manifestIndex,id:row.id,progress:0.71,status:reason==='paragraph-recovery'?'กำลังรวมข้อความที่ OCR อ่านซ้อนกัน…':'กำลังแยกข้อความของบับเบิลคู่…'}) });
      row.width=planned.width||row.width;row.height=planned.height||row.height;
      row.ocr.observations=row.ocr.regions;row.ocr.unitChanges=planned.changes||[];
      row.ocr.regions = require('./ocr-content-role.cjs').annotateContent(planned.regions);
      for(const region of row.ocr.regions)if(region.contentRole.excluded&&region.placement)region.placement={...region.placement,paintMode:'none',translationExcluded:true};
      row.placement = {
        engine:planned.engine||'opencv-surface-v1',
        ms:planned.ms || 0,
        error:planned.error || '',
        ...planned.stats
      };
      placementSummary.pages++;
      placementSummary.bubble += planned.stats.bubble || 0;
      placementSummary.scene += planned.stats.scene || 0;
      placementSummary.reviewRequired += planned.stats.reviewRequired || 0;
      placementSummary.requiresInpaint += planned.stats.requiresInpaint || 0;
      if (planned.error) placementSummary.failed++;
      sendHarvestTranslation(tab, {
        type:'page', index:page.manifestIndex, id:row.id,
        progress:0.73,
        status:`พื้นที่พร้อม • bubble ${planned.stats.bubble || 0} • ฉาก ${planned.stats.scene || 0} • รอแปล`
      });
      sendHarvestTranslation(tab, {
        type:'stage', stage:'layout',
        progress:0.69 + 0.04 * ((i + 1) / candidates.length),
        message:`พื้นที่ข้อความ ${i + 1}/${candidates.length} หน้า • bubble ${placementSummary.bubble} • ฉาก ${placementSummary.scene}`
      });
    }
    placementSummary.ms = Date.now() - layoutStartedAt;
  } finally {
    await pool.close().catch(() => {});
    placementPlanner.close();
    backend.close();
  }

  return { pages:candidates.length, observationRegions:regions, regions:manifestPages.reduce((sum,p)=>sum+(p.ocr?.regions?.length||0),0), failed, placement:placementSummary, ms:Date.now() - startedAt };
}

async function runHarvestTranslateStage(tab, job, manifestPages, settings, model='', {retryOnly=false}={}) {
  const summary={provider:settings.engine,sourceLanguage:settings.sourceLanguage,targetLanguage:settings.targetLanguage,regions:0,translated:0,failed:0,review:0,skipped:0,ms:0,tasks:0,taskSize:4};
  const started=Date.now(),reusable=require('./google-web-result.cjs').reusableTranslation;
  const pages=manifestPages.filter(page=>(page?.ocr?.regions||[]).some(r=>r.text?.trim()));
  if(!pages.length){summary.ms=Date.now()-started;return summary;}

  await tab.view.webContents.executeJavaScript(`window.__harvestTsTranslationOverlay||(window.__harvestTsTranslationOverlay=(${createTranslationOverlay.toString()})(${readerDocumentKey.toString()}))`).catch(()=>{});

  const taskCount=Math.min(4,Math.ceil(pages.length/4));
  summary.tasks=taskCount;
  sendHarvestTranslation(tab,{type:'stage',stage:'translate-parallel',progress:0.73,message:`${settings.engine==='ai'?'AI':'Google'} แปลพร้อมกัน ${taskCount} task • ชุดละไม่เกิน 4 หน้า`});

  let finishedPages=0;
  const processPage=async(page,taskId)=>{
    assertHarvestTranslationRunning(job);
    const regions=(page?.ocr?.regions||[]).filter(r=>r.text?.trim());
    if(!regions.length)return;
    for(let i=0;i<regions.length;i++)if(!regions[i].id)regions[i].id=page.id+'-r'+(i+1);
    try {
      const retryOptions={provider:settings.engine,sourceLanguage:settings.sourceLanguage,targetLanguage:settings.targetLanguage,imageDigest:page.imageDigest||''};
      const pending=retryOnly?regions.filter(r=>!reusable(r,retryOptions)):regions;
      if(retryOnly&&pending.length)sendHarvestTranslation(tab,{type:'page',index:page.index,id:page.id,progress:.78,error:false,status:'Task '+taskId+' • ส่ง '+pending.length+' จุดที่พลาดกลับเข้า queue แปลใหม่…'});
      let result=await ocrTranslationService.translate(pending,{provider:settings.engine,sourceLanguage:settings.sourceLanguage,targetLanguage:settings.targetLanguage,model,imageDigest:page.imageDigest||'',signal:job.abort.signal,
        context:'Translate the supplied manga dialogue in reading order. Page '+(Number(page.index)+1)+'.',
        onProgress:({done,total})=>sendHarvestTranslation(tab,{type:'page',index:page.index,id:page.id,progress:0.73+0.20*done/Math.max(1,total),status:(settings.engine==='ai'?'AI':'Google')+' Task '+taskId+' • '+done+'/'+total+' จุด'})});
      assertHarvestTranslationRunning(job);
      if(retryOnly){const retained=regions.filter(r=>!pending.includes(r)).map(r=>r.translationRecord).filter(Boolean);result={...result,items:[...retained,...result.items]};result.total=result.items.length;result.translated=result.items.filter(r=>r.status==='translated').length;result.failed=result.items.filter(r=>r.status==='failed').length;}
      const byId=new Map(result.items.map(r=>[r.id,r]));
      for(const r of regions){const t=byId.get(r.id);if(t){r.translation=t.translation;r.translationProvider=result.provider;r.translationRecord=t;}}
      for(const skipped of result.skipped||[]){const r=regions.find(r=>r.id===skipped.id);if(r){r.contentRole={...skipped};delete r.translation;delete r.translationRecord;}}
      page.translation=result;summary.regions+=result.total;summary.translated+=result.translated;summary.failed+=result.failed;summary.skipped+=(result.skipped||[]).length;summary.review+=(result.skipped||[]).filter(r=>r.role==='uncertain').length;
      try {
        const rendered=await prepareOverlayStyles(tab,overlayPage(page,{documentUrl:job.sourceUrl,targetLanguage:settings.targetLanguage}));
        assertHarvestTranslationRunning(job);
        if(!sameHarvestTranslationPage(job.sourceUrl,tab.view.webContents.getURL()))throw Error('หน้าเว็บเปลี่ยน กรุณาเริ่มแปลใหม่');
        page.overlay=await tab.view.webContents.executeJavaScript(`(() => {const overlay=window.__harvestTsTranslationOverlay;const state=overlay.apply(${JSON.stringify(rendered)},${JSON.stringify({fontScale:settings.fontScale,visible:!settings.showOriginal})});return state.error?state:overlay.whenReady(${JSON.stringify(rendered.id)});})()`);
      } catch(error) {assertHarvestTranslationRunning(job);page.overlay={error:error.message};}
      sendHarvestTranslation(tab,{type:'page',index:page.index,id:page.id,progress:1,error:Boolean(page.overlay.error||result.failed),status:'Task '+taskId+' • แปลแล้ว '+result.translated+'/'+result.total+' จุด'+(result.failed?' • ไม่สำเร็จ '+result.failed+' จุด':'')+((result.skipped||[]).some(r=>r.role==='uncertain')?' • รอตรวจ '+result.skipped.filter(r=>r.role==='uncertain').length+' จุด':'')+' • '+(page.overlay.error?'วางไม่ได้: '+page.overlay.error:page.overlay.pending?'คำแปลพร้อม • รอภาพนี้แสดงบนเว็บ':page.overlay.pageDrawn>0?'วางแล้ว '+page.overlay.pageDrawn+' จุด':'พร้อม')});
    }catch(error){
      assertHarvestTranslationRunning(job);
      summary.regions+=regions.length;summary.failed+=regions.length;page.translation={provider:settings.engine,error:error.message};
      sendHarvestTranslation(tab,{type:'page',index:page.index,id:page.id,progress:0.9,error:true,status:'Task '+taskId+' • แปลไม่สำเร็จ: '+error.message});
    }finally{
      finishedPages++;
      sendHarvestTranslation(tab,{type:'stage',stage:'translate-parallel',progress:0.73+0.22*(finishedPages/Math.max(1,pages.length)),message:`${settings.engine==='ai'?'AI':'Google'} ทำงาน ${taskCount} task • เสร็จ ${finishedPages}/${pages.length} หน้า`});
    }
  };

  if(settings.engine==='ai'&&!retryOnly){
    const groups=[];for(let i=0;i<pages.length;i+=4)groups.push(pages.slice(i,i+4));
    const parallel=Math.min(4,groups.length,Math.max(1,Number(harvestTranslationProbeCache?.parallel)||4));
    summary.tasks=groups.length;
    sendHarvestTranslation(tab,{type:'stage',stage:'translate-parallel',progress:0.73,message:`AI แปลแบบ batch • ${groups.length} ชุด • พร้อมกัน ${parallel} task • สูงสุด 4 หน้า/ชุด`});
    const processGroup=async(group,taskId)=>{
      assertHarvestTranslationRunning(job);
      const all=[];
      for(const page of group){
        const regions=(page?.ocr?.regions||[]).filter(r=>r.text?.trim());
        for(let i=0;i<regions.length;i++)if(!regions[i].id)regions[i].id=page.id+'-r'+(i+1);
        all.push(...regions);
        sendHarvestTranslation(tab,{type:'page',index:page.index,id:page.id,progress:0.74,status:`AI Task ${taskId} • รวม ${group.length} หน้า • กำลังแปลเป็นชุดเดียว`});
      }
      if(!all.length){finishedPages+=group.length;return;}
      const first=Number(group[0]?.index)+1,last=Number(group[group.length-1]?.index)+1;
      let result;
      try{
        result=await ocrTranslationService.translate(all,{
          provider:'ai',sourceLanguage:settings.sourceLanguage,targetLanguage:settings.targetLanguage,model,
          imageDigest:'batch:'+group.map(p=>p.imageDigest||'').join('|'),signal:job.abort.signal,
          context:`Translate the supplied manga dialogue in reading order across pages ${first}-${last}. Preserve every item id exactly.`,
          onProgress:({done,total})=>{
            const progress=0.74+0.18*done/Math.max(1,total);
            for(const page of group)sendHarvestTranslation(tab,{type:'page',index:page.index,id:page.id,progress,status:`AI Task ${taskId} • ${done}/${total} จุด • หน้า ${first}-${last}`});
          }
        });
      }catch(error){
        assertHarvestTranslationRunning(job);
        for(const page of group)sendHarvestTranslation(tab,{type:'page',index:page.index,id:page.id,progress:.82,status:`Task ${taskId} • batch ตอบไม่ครบ กำลัง fallback แปลทีละหน้า…`});
        for(const page of group)await processPage(page,taskId);
        return;
      }
      const allById=new Map(result.items.map(r=>[r.id,r])),skipById=new Map((result.skipped||[]).map(r=>[r.id,r]));
      for(const page of group){
        const regions=(page?.ocr?.regions||[]).filter(r=>r.text?.trim()),ids=new Set(regions.map(r=>r.id));
        const items=result.items.filter(r=>ids.has(r.id)),skipped=(result.skipped||[]).filter(r=>ids.has(r.id));
        for(const region of regions){const t=allById.get(region.id);if(t){region.translation=t.translation;region.translationProvider=result.provider;region.translationRecord=t;}const sk=skipById.get(region.id);if(sk){region.contentRole={...sk};delete region.translation;delete region.translationRecord;}}
        const pageResult={...result,items,skipped,total:items.length,translated:items.filter(r=>r.status==='translated').length,failed:items.filter(r=>r.status==='failed').length};
        page.translation=pageResult;summary.regions+=pageResult.total;summary.translated+=pageResult.translated;summary.failed+=pageResult.failed;summary.skipped+=skipped.length;summary.review+=skipped.filter(r=>r.role==='uncertain').length;
        try{const rendered=await prepareOverlayStyles(tab,overlayPage(page,{documentUrl:job.sourceUrl,targetLanguage:settings.targetLanguage}));if(!sameHarvestTranslationPage(job.sourceUrl,tab.view.webContents.getURL()))throw Error('หน้าเว็บเปลี่ยน กรุณาเริ่มแปลใหม่');page.overlay=await tab.view.webContents.executeJavaScript(`(() => {const overlay=window.__harvestTsTranslationOverlay;const state=overlay.apply(${JSON.stringify(rendered)},${JSON.stringify({fontScale:settings.fontScale,visible:!settings.showOriginal})});return state.error?state:overlay.whenReady(${JSON.stringify(rendered.id)});})()`);}catch(error){page.overlay={error:error.message};}
        sendHarvestTranslation(tab,{type:'page',index:page.index,id:page.id,progress:1,error:Boolean(page.overlay.error||pageResult.failed),status:`Task ${taskId} • แปลแล้ว ${pageResult.translated}/${pageResult.total} จุด${pageResult.failed?' • ไม่สำเร็จ '+pageResult.failed+' จุด':''}${skipped.some(r=>r.role==='uncertain')?' • รอตรวจ '+skipped.filter(r=>r.role==='uncertain').length+' จุด':''} • ${page.overlay.error?'วางไม่ได้: '+page.overlay.error:page.overlay.pending?'คำแปลพร้อม • รอภาพนี้แสดงบนเว็บ':page.overlay.pageDrawn>0?'วางแล้ว '+page.overlay.pageDrawn+' จุด':'พร้อม'}`});
      }
      finishedPages+=group.length;
    };
    await runPageTaskGroups(groups,{taskSize:1,concurrency:parallel,signal:job.abort.signal,handlePage:(group,{taskId})=>processGroup(group,taskId)});
  }else{
    await runPageTaskGroups(pages,{taskSize:4,concurrency:4,signal:job.abort.signal,handlePage:(page,{taskId})=>processPage(page,taskId)});
  }
  summary.ms=Date.now()-started;return summary;
}


function harvestOfflineDocumentKey(url){return readerDocumentKey(String(url||''));}
function harvestOfflineProjectId(url){return createHash('sha256').update(harvestOfflineDocumentKey(url)).digest('hex').slice(0,24);}
async function harvestOfflineReadJson(file,fallback){
  try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return fallback;throw error;}
}
async function harvestOfflineWriteJson(file,value){
  await fs.mkdir(path.dirname(file),{recursive:true});
  const temp=file+'.'+randomUUID()+'.tmp';
  try{
    await fs.writeFile(temp,JSON.stringify(value,null,2),'utf8');
    for(let n=0;;n++){try{await fs.rename(temp,file);break;}catch(error){if(n>=4||!['EPERM','EBUSY','EACCES','EEXIST'].includes(error.code))throw error;await fs.rm(file,{force:true}).catch(()=>{});await new Promise(r=>setTimeout(r,45*(n+1)));}}
  }finally{await fs.rm(temp,{force:true}).catch(()=>{});}
}
function harvestOfflineQueued(task){
  const next=harvestOfflineWriteQueue.then(task);
  harvestOfflineWriteQueue=next.catch(()=>{});
  return next;
}
function harvestOfflineSeriesInfo(url,title=''){
  let display=String(title||'').trim().replace(/^\s*\d+\s*\|\s*/,'').replace(/^\s*Manga:\s*/i,'');
  display=display.replace(/\s*[-|]\s*MangaDex\s*$/i,'').trim();
  const prefix=display.match(/^(?:Chapter|Ch\.?)[\s#:_-]*\d+(?:\.\d+)*(?:\s*[-–—|:]\s*)(.+)$/i);
  if(prefix)display=prefix[1].trim();
  display=display.replace(/\s+(?:Chapter|Ch\.?)[\s#:_-]*\d+(?:\.\d+)*\b.*$/i,'').trim();
  display=display.replace(/\s*[-–—|:]\s*$/,'').trim();
  let sourceKey='';
  try{
    const u=new URL(url),decoded=decodeURIComponent(u.pathname);
    const m=decoded.match(/^(.*?)(?:[-_/](?:chapter|chap|ch)[-_ ]?\d+(?:\.\d+)?\b)/i);
    if(m&&m[1].length>1)sourceKey=u.hostname.toLowerCase()+m[1].toLowerCase();
  }catch{}
  if(!display){try{display=new URL(url).hostname.replace(/^www\./,'');}catch{display='Offline Project';}}
  const normalized=display.toLowerCase().replace(/[\s\u00a0]+/g,' ').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
  const key=sourceKey||normalized||harvestOfflineDocumentKey(url);
  return {id:'series-'+createHash('sha256').update(key).digest('hex').slice(0,16),title:display};
}
async function harvestOfflineIndex(){
  const value=await harvestOfflineReadJson(harvestTsOfflineIndexFile,{version:2,items:[],projects:[],groups:[]});
  const items=Array.isArray(value.items)?value.items.filter(Boolean).map(row=>({...row})):[];
  const groups=Array.isArray(value.groups)?value.groups.filter(x=>x&&x.id&&x.title).map(x=>({...x})):[];
  const projects=Array.isArray(value.projects)?value.projects.filter(x=>x&&x.id&&x.title).map(x=>({...x})):[];
  const byId=new Map(projects.map(x=>[x.id,x]));
  for(const row of items){
    if(!row.projectId){
      const info=harvestOfflineSeriesInfo(row.url,row.title);row.projectId=info.id;
      if(!byId.has(info.id)){const project={id:info.id,title:info.title,groupId:'',manual:false,createdAt:Number(row.createdAt)||Date.now(),updatedAt:Number(row.updatedAt)||Date.now()};projects.push(project);byId.set(project.id,project);}
    }else if(!byId.has(row.projectId)){
      const info=harvestOfflineSeriesInfo(row.url,row.title),project={id:row.projectId,title:info.title,groupId:'',manual:false,createdAt:Number(row.createdAt)||Date.now(),updatedAt:Number(row.updatedAt)||Date.now()};projects.push(project);byId.set(project.id,project);
    }
  }
  return {version:2,items,projects,groups};
}
async function harvestOfflineWriteIndex(index){
  await harvestOfflineWriteJson(harvestTsOfflineIndexFile,{version:2,items:index.items||[],projects:index.projects||[],groups:index.groups||[]});
}
function harvestOfflineSafeTitle(value,fallback='โปรเจกต์'){
  const title=String(value||'').replace(/[\x00-\x1f]/g,' ').replace(/\s+/g,' ').trim().slice(0,120);
  if(!title)throw Error('กรุณาใส่ชื่อ'+fallback);
  return title;
}
function harvestOfflineChapterNumber(row){
  const text=String(row?.title||'')+' '+String(row?.url||'');
  const m=text.match(/(?:chapter|chap|ch)[\s_/#-]*(\d+(?:\.\d+)?)/i);return m?Number(m[1]):Number.POSITIVE_INFINITY;
}
function harvestOfflineNextHomeOrder(index){
  const values=[...index.groups.map(x=>Number(x.homeOrder)),...index.projects.filter(x=>!x.groupId).map(x=>Number(x.homeOrder))].filter(Number.isFinite);
  return values.length?Math.max(...values)+1:0;
}
function harvestOfflineNextGroupOrder(index,groupId){
  const values=index.projects.filter(x=>x.groupId===groupId).map(x=>Number(x.groupOrder)).filter(Number.isFinite);
  return values.length?Math.max(...values)+1:0;
}
async function harvestOfflineLibraryList(){
  const index=await harvestOfflineIndex(),items=[...index.items];
  for(const row of items){
    if(row.coverFile)continue;
    try{const saved=await harvestOfflineReadProject(row.id),page=(saved.manifest.pages||[]).find(p=>p?.file&&!p.error);if(page){row.coverFile=page.file;row.coverMime=page.mime||'';}}catch{}
  }
  let fallbackHome=Math.max(-1,...index.groups.map(x=>Number(x.homeOrder)).filter(Number.isFinite),...index.projects.map(x=>Number(x.homeOrder)).filter(Number.isFinite))+1;
  const stories=index.projects.map((story,storyIndex)=>{
    const chapters=items.filter(x=>x.projectId===story.id).sort((a,b)=>harvestOfflineChapterNumber(a)-harvestOfflineChapterNumber(b)||Number(a.createdAt||0)-Number(b.createdAt||0));
    if(!chapters.length)return null;
    const latest=[...chapters].sort((a,b)=>Number(b.updatedAt||0)-Number(a.updatedAt||0))[0];
    const homeOrder=Number.isFinite(Number(story.homeOrder))?Number(story.homeOrder):fallbackHome++;
    const groupOrder=Number.isFinite(Number(story.groupOrder))?Number(story.groupOrder):storyIndex;
    return {...story,homeOrder,groupOrder,chapterCount:chapters.length,pageCount:chapters.reduce((n,x)=>n+(Number(x.pages)||0),0),sizeBytes:chapters.reduce((n,x)=>n+(Number(x.sizeBytes)||0),0),updatedAt:Math.max(Number(story.updatedAt)||0,...chapters.map(x=>Number(x.updatedAt)||0)),coverItemId:latest?.id||'',coverFile:latest?.coverFile||'',chapters};
  }).filter(Boolean);
  const groups=index.groups.map((group,groupIndex)=>{
    const members=stories.filter(x=>x.groupId===group.id).sort((a,b)=>Number(a.groupOrder)-Number(b.groupOrder)||a.title.localeCompare(b.title));
    const homeOrder=Number.isFinite(Number(group.homeOrder))?Number(group.homeOrder):fallbackHome++;
    return {...group,homeOrder,storyCount:members.length,pageCount:members.reduce((n,x)=>n+x.pageCount,0),sizeBytes:members.reduce((n,x)=>n+x.sizeBytes,0),stories:members,updatedAt:Math.max(Number(group.updatedAt)||0,...members.map(x=>Number(x.updatedAt)||0))};
  });
  const home=[
    ...groups.map(x=>({type:'group',id:x.id,order:x.homeOrder})),
    ...stories.filter(x=>!x.groupId).map(x=>({type:'story',id:x.id,order:x.homeOrder}))
  ].sort((a,b)=>Number(a.order)-Number(b.order)||a.id.localeCompare(b.id));
  return {version:3,groups,stories,items,home};
}
async function harvestOfflineGroupCreate(input={}){
  const title=harvestOfflineSafeTitle(input.title,'กลุ่ม');
  return harvestOfflineQueued(async()=>{const index=await harvestOfflineIndex(),group={id:'group-'+randomUUID(),title,createdAt:Date.now(),updatedAt:Date.now(),homeOrder:harvestOfflineNextHomeOrder(index)};index.groups.push(group);await harvestOfflineWriteIndex(index);return group;});
}
async function harvestOfflineGroupRename(input={}){
  const id=String(input.id||''),title=harvestOfflineSafeTitle(input.title,'กลุ่ม');
  return harvestOfflineQueued(async()=>{const index=await harvestOfflineIndex(),group=index.groups.find(x=>x.id===id);if(!group)throw Error('ไม่พบกลุ่ม');group.title=title;group.updatedAt=Date.now();await harvestOfflineWriteIndex(index);return group;});
}
async function harvestOfflineGroupRemove(input={}){
  const id=String(input.id||'');return harvestOfflineQueued(async()=>{const index=await harvestOfflineIndex();index.groups=index.groups.filter(x=>x.id!==id);let order=harvestOfflineNextHomeOrder(index);for(const p of index.projects.filter(x=>x.groupId===id).sort((a,b)=>Number(a.groupOrder||0)-Number(b.groupOrder||0))){p.groupId='';p.groupOrder=0;p.homeOrder=order++;p.updatedAt=Date.now();}await harvestOfflineWriteIndex(index);return true;});
}
async function harvestOfflineLibraryReorder(input={}){
  const scope=String(input.scope||''),ids=Array.isArray(input.ids)?input.ids.map(String):[];
  return harvestOfflineQueued(async()=>{
    const index=await harvestOfflineIndex();
    if(scope==='home'){
      const valid=new Map();
      for(const g of index.groups)valid.set('group:'+g.id,g);
      for(const story of index.projects.filter(x=>!x.groupId))valid.set('story:'+story.id,story);
      let order=0;const seen=new Set();
      for(const key of ids){const row=valid.get(key);if(!row||seen.has(key))continue;row.homeOrder=order++;seen.add(key);}
      const rest=[...valid.entries()].filter(([key])=>!seen.has(key)).sort((a,b)=>Number(a[1].homeOrder||1e9)-Number(b[1].homeOrder||1e9));
      for(const [,row] of rest)row.homeOrder=order++;
    }else if(scope==='group'){
      const groupId=String(input.groupId||'');if(!index.groups.some(x=>x.id===groupId))throw Error('ไม่พบกลุ่ม');
      const valid=new Map(index.projects.filter(x=>x.groupId===groupId).map(x=>[x.id,x]));let order=0;const seen=new Set();
      for(const id of ids){const row=valid.get(id);if(!row||seen.has(id))continue;row.groupOrder=order++;seen.add(id);}
      const rest=[...valid.entries()].filter(([id])=>!seen.has(id)).sort((a,b)=>Number(a[1].groupOrder||1e9)-Number(b[1].groupOrder||1e9));
      for(const [,row] of rest)row.groupOrder=order++;
    }else throw Error('รูปแบบการเรียงไม่ถูกต้อง');
    await harvestOfflineWriteIndex(index);return true;
  });
}
async function harvestOfflineLibraryProjectCreate(input={}){
  const title=harvestOfflineSafeTitle(input.title,'โปรเจกต์'),groupId=String(input.groupId||'');
  return harvestOfflineQueued(async()=>{const index=await harvestOfflineIndex();if(groupId&&!index.groups.some(x=>x.id===groupId))throw Error('ไม่พบกลุ่มที่เลือก');const project={id:'series-'+randomUUID(),title,groupId,manual:true,createdAt:Date.now(),updatedAt:Date.now()};index.projects.push(project);await harvestOfflineWriteIndex(index);return project;});
}
async function harvestOfflineLibraryProjectRename(input={}){
  const id=String(input.id||''),title=harvestOfflineSafeTitle(input.title,'โปรเจกต์');
  return harvestOfflineQueued(async()=>{const index=await harvestOfflineIndex(),project=index.projects.find(x=>x.id===id);if(!project)throw Error('ไม่พบโปรเจกต์');project.title=title;project.updatedAt=Date.now();await harvestOfflineWriteIndex(index);return project;});
}
async function harvestOfflineLibraryProjectGroup(input={}){
  const id=String(input.id||''),groupId=String(input.groupId||'');
  return harvestOfflineQueued(async()=>{
    const index=await harvestOfflineIndex(),story=index.projects.find(x=>x.id===id);if(!story)throw Error('ไม่พบเรื่อง');
    if(groupId&&!index.groups.some(x=>x.id===groupId))throw Error('ไม่พบกลุ่มที่เลือก');
    if(story.groupId===groupId)return story;
    story.groupId=groupId;story.updatedAt=Date.now();
    if(groupId){story.groupOrder=harvestOfflineNextGroupOrder(index,groupId);}else{story.homeOrder=harvestOfflineNextHomeOrder(index);story.groupOrder=0;}
    await harvestOfflineWriteIndex(index);return story;
  });
}
async function harvestOfflineItemProject(input={}){
  const id=String(input.id||''),projectId=String(input.projectId||'');
  return harvestOfflineQueued(async()=>{const index=await harvestOfflineIndex(),item=index.items.find(x=>x.id===id),project=index.projects.find(x=>x.id===projectId);if(!item)throw Error('ไม่พบตอนที่บันทึกไว้');if(!project)throw Error('ไม่พบโปรเจกต์');item.projectId=projectId;item.updatedAt=Date.now();project.updatedAt=item.updatedAt;await harvestOfflineWriteIndex(index);return true;});
}
async function harvestOfflineCover(itemId){
  const saved=await harvestOfflineReadProject(String(itemId||'')),page=(saved.manifest.pages||[]).find(p=>p?.file&&!p.error);if(!page)throw Error('ไม่พบภาพปก');
  const bytes=await fs.readFile(path.join(saved.dir,page.file));return {mime:page.mime||'application/octet-stream',bytes:new Uint8Array(bytes),file:page.file};
}
function harvestOfflineProjectDir(id){if(!/^[0-9a-f]{24}$/.test(String(id||'')))throw Error('Offline project ID ไม่ถูกต้อง');return path.join(harvestTsOfflineDir,String(id));}
async function harvestOfflineReadProject(id){
  const dir=harvestOfflineProjectDir(id);
  const [project,manifest]=await Promise.all([
    harvestOfflineReadJson(path.join(dir,'project.json'),null),
    harvestOfflineReadJson(path.join(dir,'manifest.json'),null)
  ]);
  if(!project||!manifest||project.id!==id||!Array.isArray(manifest.pages))throw Error('ไม่พบงาน Offline นี้');
  return {dir,project,manifest};
}
async function harvestOfflineFindByUrl(url){
  const key=harvestOfflineDocumentKey(url),index=await harvestOfflineIndex();
  return index.items.find(row=>row.documentKey===key)||null;
}
async function harvestOfflineList(){ return harvestOfflineLibraryList(); }
async function harvestOfflineSave(tab){
  if(!tab||tab.kind!=='web'||tab.view.webContents.isDestroyed())throw Error('เปิดหน้าเว็บที่แปลแล้วก่อนบันทึก Offline');
  const currentUrl=tab.view.webContents.getURL()||tab.url||'';
  let job=harvestTranslationJobFor(tab);
  if(job?.running)throw Error('รอ Harvest Translate ทำงานให้เสร็จก่อน');
  if(!job?.manifest?.pages){
    const existing=await harvestOfflineFindByUrl(currentUrl);
    if(existing)return existing;
    throw Error('ยังไม่มีงาน Harvest Translate สำหรับหน้านี้');
  }
  if(!sameHarvestTranslationPage(job.sourceUrl||job.manifest.source?.url,currentUrl))throw Error('งานแปลปัจจุบันไม่ได้เป็นของหน้าเว็บนี้');
  const documentUrl=job.manifest.source?.url||job.sourceUrl||currentUrl,documentKey=harvestOfflineDocumentKey(documentUrl),id=harvestOfflineProjectId(documentUrl);
  return harvestOfflineQueued(async()=>{
    const index=await harvestOfflineIndex(),old=index.items.find(row=>row.id===id),createdAt=old?.createdAt||Date.now(),updatedAt=Date.now();
    const series=harvestOfflineSeriesInfo(documentUrl,job.manifest.source?.title||tab.view.webContents.getTitle()||''),projectId=old?.projectId||series.id;
    let libraryProject=index.projects.find(x=>x.id===projectId);
    if(!libraryProject){libraryProject={id:projectId,title:series.title,groupId:'',manual:false,createdAt,updatedAt,homeOrder:harvestOfflineNextHomeOrder(index),groupOrder:0};index.projects.push(libraryProject);}else libraryProject.updatedAt=updatedAt;
    const target=harvestOfflineProjectDir(id),temp=target+'.tmp-'+randomUUID();
    await fs.mkdir(temp,{recursive:true});
    let sizeBytes=0;
    const pages=job.manifest.pages.filter(p=>p?.file&&!p.error);
    try{
      for(const page of pages){
        const name=path.basename(String(page.file||''));if(name!==page.file)throw Error('ชื่อไฟล์หน้า Offline ไม่ถูกต้อง');
        const from=path.join(job.dir,name),to=path.join(temp,name),stat=await fs.stat(from);
        if(!stat.isFile())throw Error('ไม่พบภาพ '+name);
        await fs.copyFile(from,to);sizeBytes+=stat.size;
      }
      const styles={};const targetLanguage=job.manifest.settings?.targetLanguage||'th';
      for(const page of job.manifest.pages){
        let rendered;try{rendered=overlayPage(page,{documentUrl,targetLanguage});}catch{continue;}
        const pageStyles={};
        for(const region of rendered.regions||[]){
          const key=regionStyleKey(rendered,{...region,text:region.original},targetLanguage),style=await regionStyles().get(key);
          if(style)pageStyles[String(region.id)]=style;
        }
        if(Object.keys(pageStyles).length)styles[String(page.id)]=pageStyles;
      }
      const manifest=JSON.parse(JSON.stringify(job.manifest));
      const project={version:1,id,documentKey,url:documentUrl,title:manifest.source?.title||tab.view.webContents.getTitle()||'Offline',createdAt,updatedAt,pages:pages.length,sizeBytes,targetLanguage,styles};
      await fs.writeFile(path.join(temp,'manifest.json'),JSON.stringify(manifest,null,2),'utf8');
      await fs.writeFile(path.join(temp,'project.json'),JSON.stringify(project,null,2),'utf8');
      await fs.rm(target,{recursive:true,force:true});await fs.rename(temp,target);
      const coverPage=pages[0]||null;
      const row={id,documentKey,url:documentUrl,title:project.title,createdAt,updatedAt,pages:project.pages,sizeBytes,targetLanguage,projectId,coverFile:coverPage?.file||'',coverMime:coverPage?.mime||''};
      index.items=[row,...index.items.filter(x=>x.id!==id)];await harvestOfflineWriteIndex(index);
      job={...job,dir:target,persistent:true,manifest};harvestTranslationJobs.set(tab.id,job);
      tab.offlineProjectId=id;
      return row;
    }finally{await fs.rm(temp,{recursive:true,force:true}).catch(()=>{});}
  });
}
async function harvestOfflineRemove(id){
  return harvestOfflineQueued(async()=>{
    const index=await harvestOfflineIndex(),row=index.items.find(x=>x.id===String(id||''));if(!row)return {removed:false};
    await fs.rm(harvestOfflineProjectDir(row.id),{recursive:true,force:true});
    index.items=index.items.filter(x=>x.id!==row.id);await harvestOfflineWriteIndex(index);
    return {removed:true,id:row.id};
  });
}
async function harvestOfflineUpdateStyle(documentUrl,pageId,regionId,style){
  const key=harvestOfflineDocumentKey(documentUrl);
  return harvestOfflineQueued(async()=>{
    const index=await harvestOfflineIndex(),row=index.items.find(x=>x.documentKey===key);if(!row)return false;
    const file=path.join(harvestOfflineProjectDir(row.id),'project.json'),project=await harvestOfflineReadJson(file,null);if(!project)return false;
    project.styles=project.styles&&typeof project.styles==='object'?project.styles:{};
    const pageKey=String(pageId),regionKey=String(regionId),pageStyles={...(project.styles[pageKey]||{})};
    if(style)pageStyles[regionKey]=style;else delete pageStyles[regionKey];
    if(Object.keys(pageStyles).length)project.styles[pageKey]=pageStyles;else delete project.styles[pageKey];
    project.updatedAt=Date.now();await harvestOfflineWriteJson(file,project);
    row.updatedAt=project.updatedAt;await harvestOfflineWriteIndex(index);
    return true;
  });
}
async function harvestOfflineProjectData(id){
  const {project,manifest}=await harvestOfflineReadProject(String(id||'')),targetLanguage=manifest.settings?.targetLanguage||project.targetLanguage||'th',pages=[];
  for(const page of manifest.pages||[]){
    if(!page.file||page.error)continue;
    let overlay;try{overlay=overlayPage(page,{documentUrl:'offline://'+project.id,targetLanguage});}catch{overlay={regions:[],reviewCount:0};}
    for(const region of overlay.regions||[])region.userStyle=project.styles?.[String(page.id)]?.[String(region.id)]||null;
    pages.push({id:String(page.id),index:Number(page.index)||0,file:page.file,width:Number(page.width)||0,height:Number(page.height)||0,mime:page.mime||'',imageUrl:`eiw://offline/${project.id}/${encodeURIComponent(page.file)}`,regions:overlay.regions||[]});
  }
  return {project:{id:project.id,title:project.title,url:project.url,createdAt:project.createdAt,updatedAt:project.updatedAt,targetLanguage},pages};
}
async function harvestOfflineLiveReaderPages(wc,documentUrl,expectedCount=0){
  const options={selector:'',backgrounds:true,canvases:false,smartBackgrounds:true,adaptiveBackgrounds:true};
  let best=[];
  for(let attempt=0;attempt<4;attempt++){
    if(wc.isDestroyed())break;
    const snap=await withTimeout(wc.executeJavaScript(`(${collector})(${JSON.stringify(options)})`,true),12000,'หน้าเว็บไม่ตอบสนองระหว่างกู้งานแปล').catch(()=>null);
    const rows=[];
    for(const raw of snap?.items||[]){
      const url=imageURL(raw.url,documentUrl);
      if(url)rows.push({...raw,url});
    }
    const pages=selectMangaPages(rows);
    if(pages.length>best.length)best=pages;
    if(best.length&&(expectedCount<=0||best.length>=expectedCount))break;
    await delay(180*(attempt+1));
  }
  if(!best.length)return best;
  try{
    const urls=best.map(x=>x.url);
    const digests=await wc.executeJavaScript(`(async()=>{const urls=${JSON.stringify(urls)},out={};for(let i=0;i<urls.length;i+=4){await Promise.all(urls.slice(i,i+4).map(async url=>{try{const r=await fetch(url);const b=await r.arrayBuffer();const h=await crypto.subtle.digest('SHA-256',b);out[url]=Array.from(new Uint8Array(h),x=>x.toString(16).padStart(2,'0')).join('');}catch{}}));}return out;})()`,true).catch(()=>null);
    if(digests)best=best.map(x=>({...x,imageDigest:digests[x.url]||''}));
  }catch{}
  return best;
}
function harvestOfflineMatchLivePages(savedPages,livePages){
  const used=new Set(),result=[];
  const size=item=>({w:Math.max(Number(item?.width)||0,Number(item?.filterHints?.displayWidth)||0),h:Math.max(Number(item?.height)||0,Number(item?.filterHints?.displayHeight)||0)});
  for(let i=0;i<savedPages.length;i++){
    const page=savedPages[i];let match=-1;
    if(page.imageDigest)match=livePages.findIndex((x,j)=>!used.has(j)&&x.imageDigest&&x.imageDigest===page.imageDigest);
    if(match<0)match=livePages.findIndex((x,j)=>!used.has(j)&&String(x.url||'')===String(page.sourceUrl||''));
    if(match<0&&livePages.length===savedPages.length&&!used.has(i))match=i;
    if(match<0){
      const target=size(page),targetAspect=target.w&&target.h?target.w/target.h:0;
      let best=Infinity;
      for(let j=0;j<livePages.length;j++){
        if(used.has(j))continue;
        const cur=size(livePages[j]),aspect=cur.w&&cur.h?cur.w/cur.h:0;
        const aspectCost=targetAspect&&aspect?Math.abs(Math.log(aspect/targetAspect))*30:0;
        const widthCost=target.w&&cur.w?Math.abs(Math.log(cur.w/target.w))*4:0;
        const heightCost=target.h&&cur.h?Math.abs(Math.log(cur.h/target.h))*4:0;
        const orderCost=Math.abs(j-(Number(page.index)||i))*1.5,score=aspectCost+widthCost+heightCost+orderCost;
        if(score<best){best=score;match=j;}
      }
    }
    if(match>=0){used.add(match);result.push(livePages[match]);}else result.push(null);
  }
  return result;
}
async function restoreHarvestOfflineOverlay(tab){
  if(!tab||tab.kind!=='web'||tab.view.webContents.isDestroyed())return null;
  const wc=tab.view.webContents,url=wc.getURL()||tab.url||'',documentKey=harvestOfflineDocumentKey(url);
  if(!/^https?:/i.test(url)||tab.offlineOverlayDocument===documentKey)return null;
  const active=harvestTranslationJobFor(tab);if(active?.running)return null;
  const row=await harvestOfflineFindByUrl(url);if(!row)return null;
  const saved=await harvestOfflineReadProject(row.id),manifest=saved.manifest,settings=manifest.settings||HARVEST_TRANSLATE_DEFAULTS;
  if(!sameHarvestTranslationPage(manifest.source?.url||row.url,url))return null;
  sendHarvestTranslation(tab,{type:'restore-start',message:'พบคำแปลที่บันทึกไว้ • กำลังวางกลับบนหน้าเดิม…'});
  await require('./reader-mode.cjs').ensureContinuousReader(wc).catch(()=>{});
  if(wc.isDestroyed()||!sameHarvestTranslationPage(url,wc.getURL()))return null;
  const savedPages=(manifest.pages||[]).filter(page=>page?.ocr?.regions?.length&&!page.error);
  const livePages=await harvestOfflineLiveReaderPages(wc,url,savedPages.length);
  const matches=harvestOfflineMatchLivePages(savedPages,livePages);
  const job={id:manifest.jobId||('offline-'+row.id),dir:saved.dir,sourceUrl:manifest.source?.url||row.url,manifest,running:false,persistent:true,abort:new AbortController()};
  harvestTranslationJobs.set(tab.id,job);
  await wc.executeJavaScript(`window.__harvestTsTranslationOverlay||(window.__harvestTsTranslationOverlay=(${createTranslationOverlay.toString()})(${readerDocumentKey.toString()}))`).catch(()=>{});
  let regions=0,pages=0,drawn=0,mapped=0,pending=0;
  for(let i=0;i<savedPages.length;i++){
    const page=savedPages[i],live=matches[i];
    try{
      const overlaySource=live?{...page,sourceUrl:live.url,source:live.source||page.source}:page;
      if(live)mapped++;
      const rendered=await prepareOverlayStyles(tab,overlayPage(overlaySource,{documentUrl:job.sourceUrl,targetLanguage:settings.targetLanguage||'th'}));
      for(const region of rendered.regions||[])region.userStyle=saved.project.styles?.[String(page.id)]?.[String(region.id)]||region.userStyle||null;
      if(!rendered.regions.length)continue;
      const state=await wc.executeJavaScript(`window.__harvestTsTranslationOverlay?.apply(${JSON.stringify(rendered)},${JSON.stringify({fontScale:settings.fontScale||1,visible:!settings.showOriginal})})`);
      regions+=rendered.regions.length;pages++;drawn+=Number(state?.pageDrawn)||0;if(state?.pending)pending++;
    }catch{}
  }
  tab.offlineProjectId=row.id;
  if((savedPages.length>0&&mapped>=savedPages.length)||(!livePages.length&&drawn>0))tab.offlineOverlayDocument=documentKey;
  if(regions){
    const message=drawn
      ? `โหลดคำแปลเดิมแล้ว • ${pages} หน้า • แสดง ${drawn} จุด`
      : mapped
        ? `โหลดคำแปลเดิมแล้ว • รอภาพหน้าอ่านแสดง ${pending||pages} หน้า`
        : 'พบคำแปลเดิมแล้ว • กำลังรอหน้าอ่านโหลดภาพ';
    sendHarvestTranslation(tab,{type:'complete',jobId:job.id,total:manifest.pages.length,ready:pages,failed:0,translatedRegions:regions,translationFailed:0,message});
  }
  return {id:row.id,pages,regions,drawn,mapped,livePages:livePages.length,pending};
}
async function harvestOfflineExportStart(tab,input={}){
  const projectId=String(input.id||tab.projectId||''),data=await harvestOfflineProjectData(projectId),mode=['original','clean','translated'].includes(input.mode)?input.mode:'translated';
  const pick=await dialog.showOpenDialog(mainWindow,{title:'เลือกโฟลเดอร์สำหรับ Export',properties:['openDirectory','createDirectory']});
  if(pick.canceled||!pick.filePaths?.[0])return {cancelled:true};
  const cleanName=String(data.project.title||'ImageHarvest').replace(/[<>:"/\\|?*\x00-\x1f]/g,' ').replace(/\s+/g,' ').trim().slice(0,80)||'ImageHarvest';
  const suffix=mode==='translated'?'translated':mode==='clean'?'clean':'original',folder=path.join(pick.filePaths[0],cleanName+' - '+suffix);
  await fs.mkdir(folder,{recursive:true});const token=randomUUID();
  harvestOfflineExportSessions.set(token,{tabId:tab.id,projectId:data.project.id,folder,mode,total:data.pages.length,written:0,createdAt:Date.now()});
  return {cancelled:false,token,total:data.pages.length,mode};
}
async function harvestOfflineExportPage(tab,input={}){
  const session=harvestOfflineExportSessions.get(String(input.token||''));if(!session||session.tabId!==tab.id)throw Error('Export session หมดอายุ');
  const index=Number(input.index);if(!Number.isInteger(index)||index<0||index>=session.total)throw Error('ลำดับหน้า Export ไม่ถูกต้อง');
  const bytes=input.bytes;let buffer=null;
  if(bytes instanceof ArrayBuffer)buffer=Buffer.from(bytes);else if(ArrayBuffer.isView(bytes))buffer=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(!buffer||!buffer.length||buffer.length>64*1024*1024)throw Error('ข้อมูลภาพ Export ไม่ถูกต้อง');
  await fs.writeFile(path.join(session.folder,String(index+1).padStart(4,'0')+'.png'),buffer);session.written++;
  return {written:session.written,total:session.total};
}
async function harvestOfflineExportFinish(tab,input={}){
  const token=String(input.token||''),session=harvestOfflineExportSessions.get(token);if(!session||session.tabId!==tab.id)throw Error('Export session หมดอายุ');
  harvestOfflineExportSessions.delete(token);const first=path.join(session.folder,'0001.png');if(session.written&&fsSync.existsSync(first))shell.showItemInFolder(first);
  return {folder:session.folder,written:session.written,total:session.total};
}

async function restoreHarvestTranslationJob(tab){
  const url=tab.view.webContents.getURL();
  const entries=await fs.readdir(harvestTranslationTempRoot,{withFileTypes:true}).catch(()=>[]);
  const folders=entries.filter(e=>e.isDirectory()&&/^harvest-/.test(e.name)).map(e=>e.name).sort((a,b)=>Number(b.split('-').at(-1))-Number(a.split('-').at(-1)));
  for(const folder of folders.slice(0,40)){
    const dir=path.join(harvestTranslationTempRoot,folder);
    try{const p=path.join(dir,'manifest.json'),stat=await fs.stat(p);if(stat.size>128*1024*1024)continue;
      const manifest=JSON.parse(await fs.readFile(p,'utf8'));
      if(!sameHarvestTranslationPage(manifest.source?.url,url)||!Array.isArray(manifest.pages)||!manifest.settings)continue;
      const job={id:manifest.jobId||randomUUID(),dir,sourceUrl:manifest.source.url,manifest,running:false,abort:new AbortController()};harvestTranslationJobs.set(tab.id,job);return job;
    }catch{}
  }
  return null;
}
async function retryHarvestTsTranslation(tab){
  const job=harvestTranslationJobFor(tab)||await restoreHarvestTranslationJob(tab);
  if(!job?.manifest?.pages)throw Error('ไม่พบงานเดิมสำหรับลองแปลซ้ำ กรุณา Start ก่อน');
  if(job.running)throw Error('งานแปลยังทำงานอยู่');
  if(!sameHarvestTranslationPage(job.sourceUrl,tab.view.webContents.getURL()))throw Error('เปลี่ยนตอนแล้ว กรุณา Start ใหม่');
  const settings=job.manifest.settings;job.running=true;job.abort=new AbortController();
  try{
    await setHarvestReaderLock(tab,job,'acquire');await setHarvestReaderLock(tab,job,'freeze');
    sendHarvestTranslation(tab,{type:'retry-start',jobId:job.id,message:'ลองแปลเฉพาะส่วนที่ขาด • ใช้ OCR และภาพคลีนเดิม'});
    const summary=await runHarvestTranslateStage(tab,job,job.manifest.pages,settings,job.manifest.translationApi?.model||'',{retryOnly:true});
    job.manifest.translation={...summary,status:summary.failed?'partial':'translated'};
    await fs.writeFile(path.join(job.dir,'manifest.json'),JSON.stringify(job.manifest,null,2),'utf8');
    sendHarvestTranslation(tab,{type:'complete',jobId:job.id,translatedRegions:summary.translated,translationFailed:summary.failed,message:'แปลแล้ว '+summary.translated+'/'+summary.regions+' จุด'+(summary.failed?' • ยังไม่สำเร็จ '+summary.failed+' จุด':'')+(summary.review?' • รอตรวจ '+summary.review+' จุด':'')+' • ปลดล็อกหน้าอ่านแล้ว'});
    return summary;
  }catch(error){if(!job.abort.signal.aborted)sendHarvestTranslation(tab,{type:'error',jobId:job.id,message:error.message});throw error;}
  finally{job.running=false;await setHarvestReaderLock(tab,job,'release').catch(()=>{});}
}

async function runHarvestTsTranslationJob(tab) {
  const previous = harvestTranslationJobFor(tab);
  if (previous?.running) throw new Error('ระบบกำลังเตรียมหน้ามังงะอยู่');
  if (previous?.dir && !previous.persistent) await fs.rm(previous.dir, { recursive:true, force:true }).catch(() => {});

  const job = {
    id:randomUUID(),
    abort:new AbortController(),
    dir:path.join(harvestTranslationTempRoot, `${tab.id}-${Date.now()}`),
    startedAt:Date.now(),
    sourceUrl:tab.view.webContents.getURL()||tab.url||'',
    running:true
  };
  harvestTranslationJobs.set(tab.id, job);
  try {
    job.readerMode=await require('./reader-mode.cjs').ensureContinuousReader(tab.view.webContents,{signal:job.abort.signal});
    await setHarvestReaderLock(tab,job,'acquire');
    await fs.mkdir(job.dir, { recursive:true });
    await tab.view.webContents.executeJavaScript('window.__harvestTsTranslationOverlay?.clear()').catch(()=>{});
    sendHarvestTranslation(tab, { type:'job-start', jobId:job.id, endpoint:DEFAULT_TRANSLATION_ENDPOINT, message:'ล็อกหน้าอ่าน • เริ่ม Harvest สำหรับ Manga Translate' });
    const settings = await harvestTsTranslateSettings();
    let provider = null;
    let probePromise = null;

    if (settings.engine === 'google') {
      provider = { provider:'google', model:'Google Translate', endpoint:'Google Translate Web', connected:true };
      sendHarvestTranslation(tab, { type:'model', ok:true, model:'Google Translate', endpoint:'Google Translate Web • background' });
      probePromise = Promise.resolve(provider);
    } else {
      probePromise = probeHarvestTranslationApi(tab, job).catch(error => {
        const value = { provider:'ai', endpoint:DEFAULT_TRANSLATION_ENDPOINT, error:error.message || String(error) };
        sendHarvestTranslation(tab, { type:'model', ok:false, ...value });
        return value;
      });
    }

    const scan = await scanHarvestTsTranslationPages(tab, job);
    job.sourceUrl=scan.startURL;
    assertHarvestTranslationRunning(job);
    await setHarvestReaderLock(tab,job,'freeze');
    let model = null;
    const manifestPages = [];
    let failed = 0;

    for (let i = 0; i < scan.pages.length; i++) {
      assertHarvestTranslationRunning(job);
      const page = scan.pages[i];
      sendHarvestTranslation(tab, { type:'page', index:i, id:page.pageId, progress:0.08, status:'กำลังดึงภาพต้นฉบับ' });
      try {
        const data = await acquireHarvestTsTranslationImage(tab, { ...page, referrer:scan.startURL }, job.abort.signal);
        assertHarvestTranslationRunning(job);
        const fileName = `${String(i + 1).padStart(4, '0')}.${data.ext}`;
        const filePath = path.join(job.dir, fileName);
        await fs.writeFile(filePath, data.buffer);
        manifestPages.push({
          id:page.pageId, index:i, file:fileName, sourceUrl:page.url, source:page.source,
          width:page.width || 0, height:page.height || 0, bytes:data.buffer.length, mime:data.mime,
          imageDigest:createHash('sha256').update(data.buffer).digest('hex')
        });
        sendHarvestTranslation(tab, { type:'page', index:i, id:page.pageId, progress:0.28, status:'Harvest พร้อม • เข้า OCR ต่ออัตโนมัติ', bytes:data.buffer.length });
      } catch (error) {
        failed++;
        manifestPages.push({ id:page.pageId, index:i, sourceUrl:page.url, error:error.message || String(error) });
        sendHarvestTranslation(tab, { type:'page', index:i, id:page.pageId, progress:1, error:true, status:error.message || 'ดึงภาพไม่สำเร็จ' });
      }
    }

    const ocr = await runHarvestOcrStage(tab, job, manifestPages,settings);
    assertHarvestTranslationRunning(job);

    // Model loading/warm-up runs in parallel with Harvest + OCR, but translation tasks wait here until it is truly ready.
    model = await probePromise;
    assertHarvestTranslationRunning(job);

    let translation = {
      provider:settings.engine,
      regions:ocr.regions,
      translated:0,
      failed:0,
      ms:0,
      status:'pending'
    };
    if (settings.engine === 'google' || !model?.error) {
      translation = await runHarvestTranslateStage(tab, job, manifestPages, settings, model?.model || '');
      let previousFailed = Number(translation.failed) || 0;
      let autoRetryAttempts = 0, staleRetryRounds = 0;
      while (previousFailed > 0 && autoRetryAttempts < 3) {
        autoRetryAttempts++;
        sendHarvestTranslation(tab, {
          type:'stage',
          stage:'translate-retry',
          progress:0.94,
          message:`พบ ${previousFailed} จุดที่แปลไม่สำเร็จ • ส่งกลับเข้า queue อัตโนมัติ ${autoRetryAttempts}/3`
        });
        const retried = await runHarvestTranslateStage(tab, job, manifestPages, settings, model?.model || '', { retryOnly:true });
        retried.autoRetryAttempts = autoRetryAttempts;
        translation = retried;
        const nextFailed = Number(retried.failed) || 0;
        if (nextFailed <= 0) break;
        if (nextFailed < previousFailed) staleRetryRounds = 0;
        else staleRetryRounds++;
        previousFailed = nextFailed;
        // A transient Google result often repeats once. Give it a second stale
        // round before stopping, but never loop indefinitely.
        if (staleRetryRounds >= 2) break;
      }
      translation.status = translation.failed ? 'partial' : 'translated';
    } else {
      translation.status='failed';translation.failed=ocr.regions;translation.error=model.error;
    }

    const manifest = {
      version:5,
      jobId:job.id,
      createdAt:new Date().toISOString(),
      source:{ url:scan.startURL, title:scan.title },
      settings:{ ...settings },
      scan:{ ms:scan.scanMs, fastPath:scan.fastPath, steps:scan.steps },
      ocr,
      translation,
      translationApi:settings.engine === 'google'
        ? { provider:'google', endpoint:'Google Translate Web (background)', model:'Google Translate', connected:true }
        : { provider:'ai', endpoint:DEFAULT_TRANSLATION_ENDPOINT, model:model?.model || '', connected:!model?.error, sample:model?.sample || '', error:model?.error || '' },
      pages:manifestPages
    };
    await fs.writeFile(path.join(job.dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    job.running = false;
    job.completedAt = Date.now();
    job.manifest = manifest;
    const ready = manifestPages.length - failed;
    const completeMessage = (settings.engine==='ai'?'AI':'Google Translate')+' แปลแล้ว '+translation.translated+'/'+translation.regions+' จุด'+(translation.failed?' • ไม่สำเร็จ '+translation.failed+' จุด':'')+(translation.review?' • รอตรวจ '+translation.review+' จุด':'')+(manifestPages.some(p=>p.overlay?.error)?' • บางหน้าวางคำแปลไม่ได้':manifestPages.some(p=>p.overlay?.pending)?' • คำแปลพร้อม รอภาพบางหน้าแสดง':' • วางคำแปลแล้ว ปลดล็อกให้เลื่อนอ่านได้');
    sendHarvestTranslation(tab, {
      type:'complete', jobId:job.id, total:manifestPages.length, ready, failed,
      model:model?.model || (settings.engine === 'google' ? 'Google Translate' : ''),
      modelConnected:!model?.error,
      provider:settings.engine,
      scanMs:scan.scanMs, fastPath:scan.fastPath,
      ocrPages:ocr.pages, ocrRegions:ocr.regions, ocrFailed:ocr.failed,
      translatedRegions:translation.translated || 0,
      translationFailed:translation.failed || 0,
      message:completeMessage
    });
    return {
      jobId:job.id, total:manifestPages.length, ready, failed,
      model:model?.model || (settings.engine === 'google' ? 'Google Translate' : ''),
      modelConnected:!model?.error, provider:settings.engine,
      scanMs:scan.scanMs, fastPath:scan.fastPath, ocr, translation
    };
  } catch (error) {
    job.running = false;
    if (!job.abort.signal.aborted) sendHarvestTranslation(tab, { type:'error', jobId:job.id, message:error.message || String(error) });
    throw error;
  } finally {
    await setHarvestReaderLock(tab,job,'release').catch(()=>{});
  }
}

async function emitHarvestPasswordHint(tab, originOverride='') {
  if(!tab || tab.view.webContents.isDestroyed()) return null;
  let origin=originOverride;
  if(!origin){try{origin=new URL(tab.view.webContents.getURL()||tab.url||'').origin}catch{}}
  if(!/^https?:\/\//i.test(origin||'')) return null;
  const accounts=await harvestPasswordAccountsForOrigin(origin);
  const candidate=tab.passwordCandidate && tab.passwordCandidate.origin===origin ? tab.passwordCandidate : null;
  const hint={
    tabId:tab.id, origin,
    accounts:accounts.map(x=>({id:x.id,username:x.username,updatedAt:x.updatedAt})),
    canSave:Boolean(candidate?.password),
    candidateUsername:candidate?.username || '',
    candidateToken:candidate ? String(candidate.createdAt || '')+':'+String(candidate.username || '') : ''
  };
  emit('harvestts-password-hint',hint);
  return hint;
}
async function saveHarvestPasswordCandidate(tab) {
  const candidate=tab?.passwordCandidate;
  if(!candidate?.password) throw new Error('ยังไม่มีรหัสผ่านที่รอบันทึก');
  const data=await harvestTsPasswordData(), now=Date.now();
  let entry=data.items.find(x=>x.origin===candidate.origin && decryptHarvestSecret(x.username)===candidate.username);
  if(!entry){
    entry={id:randomUUID(),origin:candidate.origin,url:candidate.url,createdAt:now};
    data.items.unshift(entry);
  }
  entry.url=candidate.url;
  entry.username=encryptHarvestSecret(candidate.username||'');
  entry.password=encryptHarvestSecret(candidate.password);
  entry.updatedAt=now;
  await writeHarvestJson(harvestTsPasswordFile,data);
  tab.passwordCandidate=null;
  await emitHarvestPasswordHint(tab,candidate.origin);
  return {saved:true,item:{id:entry.id,origin:entry.origin,url:entry.url,username:candidate.username||'',updatedAt:now}};
}
async function credentialById(id) {
  const data=await harvestTsPasswordData(), item=data.items.find(x=>x.id===String(id||''));
  if(!item) return null;
  const username=decryptHarvestSecret(item.username), password=decryptHarvestSecret(item.password);
  if(!password) return null;
  return {id:item.id,origin:item.origin,url:item.url,username,password};
}
async function fillHarvestCredentialById(tab,id) {
  if(!tab || tab.view.webContents.isDestroyed()) return {filled:false};
  const credential=await credentialById(id);
  if(!credential) return {filled:false};
  let currentOrigin='';
  try{currentOrigin=new URL(tab.view.webContents.getURL()||tab.url||'').origin}catch{}
  if(currentOrigin!==credential.origin) throw new Error('บัญชีนี้ไม่ได้บันทึกไว้สำหรับเว็บไซต์นี้');
  const payload=JSON.stringify({username:credential.username,password:credential.password});
  const filled=await tab.view.webContents.executeJavaScript(`(() => {
    const data=${payload};
    const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden'};
    const set=(el,value)=>{if(!el)return false;const p=Object.getPrototypeOf(el),setter=Object.getOwnPropertyDescriptor(p,'value')?.set;if(setter)setter.call(el,value);else el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true};
    const pass=[...document.querySelectorAll('input[type="password"]')].find(visible);if(!pass)return false;
    const scope=pass.form||document;
    const users=[...scope.querySelectorAll('input')].filter(x=>x!==pass&&visible(x)&&!x.disabled&&['text','email','tel'].includes((x.type||'text').toLowerCase()));
    const user=users.find(x=>/user|email|login|account/i.test((x.autocomplete||'')+' '+(x.name||'')+' '+(x.id||'')+' '+(x.placeholder||'')))||users[0];
    const a=set(user,data.username),b=set(pass,data.password);pass.focus();return a||b;
  })()`,true).catch(()=>false);
  return {filled:Boolean(filled),origin:credential.origin,username:credential.username};
}
async function harvestTsPasswordStatus(input={}) {
  const tab=harvestTsTabs.get(String(input.id||activeHarvestTsId));
  if(!tab || tab.kind!=='web' || tab.view.webContents.isDestroyed()) return {eligible:false,accounts:[],canSave:false};
  let origin='';try{origin=new URL(tab.view.webContents.getURL()||tab.url||'').origin}catch{}
  if(!/^https?:\/\//i.test(origin)) return {eligible:false,accounts:[],canSave:false};
  const accounts=await harvestPasswordAccountsForOrigin(origin);
  const candidate=tab.passwordCandidate?.origin===origin?tab.passwordCandidate:null;
  return {
    eligible:true,origin,
    accounts:accounts.map(x=>({id:x.id,username:x.username,updatedAt:x.updatedAt})),
    canSave:Boolean(candidate?.password),
    candidateUsername:candidate?.username||'',
    candidateToken:candidate ? String(candidate.createdAt || '')+':'+String(candidate.username || '') : ''
  };
}

async function harvestTsPasswordFillById(input={}) {
  const tab=harvestTsTabs.get(String(input.id||activeHarvestTsId));
  const result=await fillHarvestCredentialById(tab,input.credentialId);
  if(!result.filled) throw new Error('ไม่พบฟอร์มล็อกอินที่กรอกได้');
  return result;
}
async function harvestTsPasswordSaveCandidate(input={}) {
  const tab=harvestTsTabs.get(String(input.id||activeHarvestTsId));
  if(!tab) throw new Error('ไม่พบแท็บ HarvestTS');
  return saveHarvestPasswordCandidate(tab);
}


async function harvestTsPasswordDismissCandidate(input={}) {
  const tab=harvestTsTabs.get(String(input.id||activeHarvestTsId));
  if(!tab) return {dismissed:false};
  const origin=tab.passwordCandidate?.origin || '';
  tab.passwordCandidate=null;
  if(origin) await emitHarvestPasswordHint(tab,origin).catch(()=>{});
  return {dismissed:true};
}
async function harvestTsPasswordSavePrompt(input={}) {
  if(!mainWindow || mainWindow.isDestroyed()) throw new Error('หน้าต่างหลักไม่พร้อม');
  const tab=harvestTsTabs.get(String(input.id||activeHarvestTsId));
  if(!tab || tab.kind!=='web') throw new Error('แท็บนี้ไม่มีฟอร์มรหัสผ่าน');
  const state=await harvestTsPasswordStatus({id:tab.id});
  if(!state.canSave) return {...state,shown:false};
  const exists=state.accounts.some(x=>String(x.username||'')===String(state.candidateUsername||''));
  const originLabel=(()=>{try{return new URL(state.origin).hostname}catch{return state.origin}})();
  const menu=Menu.buildFromTemplate([
    {label:exists?'อัปเดตรหัสผ่านไหม?':'บันทึกรหัสผ่านไหม?',enabled:false},
    {label:state.candidateUsername || '(ไม่มีชื่อบัญชี)',sublabel:originLabel,enabled:false},
    {type:'separator'},
    {
      label:exists?'อัปเดต':'บันทึก',
      click:()=>{saveHarvestPasswordCandidate(tab).then(result=>{
        emit('harvestts-password-message',{tabId:tab.id,message:exists?'อัปเดตรหัสผ่านแล้ว':'บันทึกรหัสผ่านแล้ว',saved:true,item:result.item});
      }).catch(error=>emit('harvestts-password-message',{tabId:tab.id,error:error.message}));}
    },
    {
      label:'ไม่ใช่ตอนนี้',
      click:()=>{harvestTsPasswordDismissCandidate({id:tab.id}).then(()=>emit('harvestts-password-message',{tabId:tab.id,message:'ยังไม่บันทึกรหัสผ่าน'})).catch(()=>{});}
    },
    {type:'separator'},
    {label:'จัดการรหัสผ่าน…',click:()=>emit('harvestts-menu-action',{action:'password'})}
  ]);
  const area=mainWindow.getContentBounds();
  const x=Math.max(0,Math.min(area.width-20,Math.round(Number(input.x)||area.width-280)));
  const y=Math.max(0,Math.min(area.height-20,Math.round(Number(input.y)||90)));
  menu.popup({window:mainWindow,x,y});
  if(testMode)setTimeout(()=>menu.closePopup(mainWindow),Math.min(2000,Number(input.autoCloseMs)||300));
  return {...state,shown:true,update:exists};
}

async function harvestTsPasswordPopupMenu(input={}) {
  if(!mainWindow || mainWindow.isDestroyed()) throw new Error('หน้าต่างหลักไม่พร้อม');
  const tab=harvestTsTabs.get(String(input.id||activeHarvestTsId));
  if(!tab || tab.kind!=='web') throw new Error('แท็บนี้ไม่มีฟอร์มรหัสผ่าน');
  const state=await harvestTsPasswordStatus({id:tab.id});
  const template=[];
  if(state.accounts.length){
    template.push({label:'ใช้บัญชีที่บันทึกไว้',enabled:false});
    for(const account of state.accounts){
      template.push({
        label:account.username || '(ไม่มีชื่อบัญชี)',
        click:()=>{fillHarvestCredentialById(tab,account.id).then(()=>emitHarvestPasswordHint(tab,state.origin)).catch(()=>{});}
      });
    }
    template.push({type:'separator'});
  } else template.push({label:'ยังไม่มีบัญชีที่บันทึกสำหรับเว็บนี้',enabled:false});
  if(state.canSave){
    template.push({
      label:state.candidateUsername ? `บันทึก/อัปเดตรหัสของ ${state.candidateUsername}` : 'บันทึกรหัสที่เพิ่งกรอก',
      click:()=>{saveHarvestPasswordCandidate(tab).catch(()=>{});}
    });
  } else {
    template.push({
      label:'บันทึกรหัสที่กำลังกรอก',
      click:()=>{harvestTsPasswordSaveCurrent({id:tab.id}).then(()=>emitHarvestPasswordHint(tab,state.origin)).catch(error=>emit('harvestts-password-message',{tabId:tab.id,error:error.message}));}
    });
  }
  template.push({type:'separator'});
  template.push({label:'จัดการรหัสผ่าน…',click:()=>emit('harvestts-menu-action',{action:'password'})});
  const menu=Menu.buildFromTemplate(template);
  const area=mainWindow.getContentBounds();
  const x=Math.max(0,Math.min(area.width-20,Math.round(Number(input.x)||area.width-250)));
  const y=Math.max(0,Math.min(area.height-20,Math.round(Number(input.y)||90)));
  menu.popup({window:mainWindow,x,y});
  if(testMode&&Number(input.autoCloseMs)>0)setTimeout(()=>menu.closePopup(mainWindow),Math.min(2000,Number(input.autoCloseMs)));
  return state;
}
function registerHarvestGuestIpc() {
  ipcMain.removeAllListeners('harvest-guest:password-focus');
  ipcMain.removeAllListeners('harvest-guest:password-submit');
  ipcMain.removeHandler('harvest-guest:choose-account');
  ipcMain.removeHandler('harvest-guest:region-style-save');
  ipcMain.handle('harvest-guest:region-style-save',async(event,input={})=>{
    const tab=harvestGuestTab(event);if(event.senderFrame&&event.senderFrame!==event.sender.mainFrame)throw Error('ไม่อนุญาตเฟรมย่อย');
    const scope=harvestRegionStyleSources.get(tab.id)?.get(input.pageId),styleKey=scope?.regions.get(input.regionId);
    if(!scope||!styleKey||scope.imageDigest!==input.imageDigest||!sameHarvestTranslationPage(scope.documentUrl,tab.view.webContents.getURL()))throw Error('ภาพหรือหน้าเว็บเปลี่ยนแล้ว กรุณาเลือกกล่องใหม่');
    const saved=await regionStyles().set(styleKey,input.style);
    await harvestOfflineUpdateStyle(scope.documentUrl,input.pageId,input.regionId,saved).catch(()=>{});
    return saved;
  });
  ipcMain.removeHandler('harvest-guest:zoom');
  ipcMain.handle('harvest-guest:zoom',(event,input={})=>{
    const tab=harvestGuestTab(event),direction=Math.sign(Number(input.direction)||0);
    stepHarvestZoom(tab,direction);return harvestTsState(tab);
  });
  ipcMain.removeHandler('harvest-guest:translation-start');
  ipcMain.removeHandler('harvest-guest:translation-retry');
  ipcMain.handle('harvest-guest:translation-retry',async event=>retryHarvestTsTranslation(harvestGuestTab(event)));
  ipcMain.removeHandler('harvest-guest:translation-cancel');
  ipcMain.removeHandler('harvest-guest:translate-settings-get');
  ipcMain.removeHandler('harvest-guest:translate-settings-update');
  ipcMain.removeHandler('harvest-guest:translate-symbol');
  ipcMain.removeHandler('harvest-guest:screen-lens-status');
  ipcMain.removeHandler('harvest-guest:screen-lens-toggle');
  ipcMain.removeHandler('harvest-guest:ocr-lab');
  ipcMain.handle('harvest-guest:ocr-lab',async event=>{harvestGuestTab(event);return ocrLab.open();});
  ipcMain.on('harvest-guest:password-focus',(event,input={})=>{
    let tab;try{tab=harvestGuestTab(event)}catch{return}
    const origin=String(input.origin||'');
    if(!/^https?:\/\//i.test(origin)) return;
    harvestPasswordAccountsForOrigin(origin).then(accounts=>{
      if(event.sender.isDestroyed()) return;
      event.sender.send('harvest-guest:account-suggestions',{
        origin,
        accounts:accounts.map(x=>({id:x.id,username:x.username,updatedAt:x.updatedAt}))
      });
    }).catch(()=>{});
    emitHarvestPasswordHint(tab,origin).catch(()=>{});
  });
  ipcMain.handle('harvest-guest:choose-account',async(event,input={})=>{
    const tab=harvestGuestTab(event);
    const credentialId=String(input.credentialId||'');
    if(!credentialId) throw new Error('ไม่พบบัญชีที่เลือก');
    return fillHarvestCredentialById(tab,credentialId);
  });
  ipcMain.handle('harvest-guest:translation-start',async(event)=>{
    const tab=harvestGuestTab(event);
    return runHarvestTsTranslationJob(tab);
  });
  ipcMain.handle('harvest-guest:translation-cancel',async(event)=>{
    const tab=harvestGuestTab(event);
    return cancelHarvestTranslationJob(tab, false);
  });
  ipcMain.handle('harvest-guest:translate-settings-get',async(event)=>{
    harvestGuestTab(event);
    return harvestTsTranslateSettings();
  });
  ipcMain.handle('harvest-guest:translate-settings-update',async(event,input={})=>{
    const tab=harvestGuestTab(event),settings=await updateHarvestTsTranslateSettings(input);
    await tab.view.webContents.executeJavaScript(`(() => {const overlay=window.__harvestTsTranslationOverlay;if(!overlay)return;overlay.settings(${JSON.stringify({fontScale:settings.fontScale})});overlay.setVisible(${JSON.stringify(!settings.showOriginal)});})()`).catch(()=>{});
    return settings;
  });
  ipcMain.handle('harvest-guest:translate-symbol',async(event)=>{
    harvestGuestTab(event);
    try {
      const bytes=await fs.readFile(path.join(__dirname,'..','assets','translate-symbol.png'));
      return 'data:image/png;base64,'+bytes.toString('base64');
    } catch { return ''; }
  });
  ipcMain.handle('harvest-guest:screen-lens-status',async(event)=>{
    const tab=harvestGuestTab(event);
    return harvestScreenLensSnapshot(tab);
  });
  ipcMain.handle('harvest-guest:screen-lens-toggle',async(event,input={})=>{
    const tab=harvestGuestTab(event);
    const current=harvestScreenLensSnapshot(tab);
    const enabled=typeof input.enabled==='boolean' ? input.enabled : !current.enabled;
    return enabled ? startHarvestScreenLens(tab) : stopHarvestScreenLens(tab);
  });
  ipcMain.on('harvest-guest:password-submit',(event,input={})=>{
    let tab;try{tab=harvestGuestTab(event)}catch{return}
    const origin=String(input.origin||''),url=String(input.url||''),password=String(input.password||''),username=String(input.username||'');
    if(!/^https?:\/\//i.test(origin)||!/^https?:\/\//i.test(url)||!password||password.length>4096||username.length>512)return;
    tab.passwordCandidate={origin,url,username,password,createdAt:Date.now()};
    emitHarvestPasswordHint(tab,origin).catch(()=>{});
  });
}

function harvestPasswordProbeScript() {
  return `(() => {
    const visible = el => {
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      return r.width > 1 && r.height > 1 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const passwords = [...document.querySelectorAll('input[type="password"]')].filter(visible);
    const password = passwords.find(x => x.value) || passwords[0];
    if (!password || !password.value) return null;
    const scope = password.form || document;
    const candidates = [...scope.querySelectorAll('input')].filter(x => {
      if (x === password || !visible(x) || x.disabled) return false;
      const type = (x.type || 'text').toLowerCase();
      return ['text','email','tel'].includes(type);
    });
    const username = candidates.find(x => /user|email|login|account/i.test((x.autocomplete||'')+' '+(x.name||'')+' '+(x.id||'')+' '+(x.placeholder||'')) && x.value)
      || candidates.find(x => x.value) || candidates[0];
    return { url:location.href, origin:location.origin, username:username?.value || '', password:password.value };
  })()`;
}
async function harvestTsPasswordSaveCurrent(input = {}) {
  const page = harvestTsPageInfo(harvestTsTabs.get(String(input.id || activeHarvestTsId)));
  const captured = await page.wc.executeJavaScript(harvestPasswordProbeScript(), true);
  if (!captured?.password) throw new Error('ไม่พบช่องรหัสผ่านที่กรอกอยู่ในหน้านี้');
  if (!/^https?:\/\//i.test(captured.url || '') || !captured.origin) throw new Error('ไม่สามารถระบุเว็บไซต์ของรหัสผ่านนี้');
  const data = await harvestTsPasswordData();
  const now = Date.now();
  let entry = data.items.find(x => x.origin === captured.origin && decryptHarvestSecret(x.username) === String(captured.username || ''));
  if (!entry) {
    entry = { id:randomUUID(), origin:captured.origin, url:captured.url, createdAt:now };
    data.items.unshift(entry);
  }
  entry.url = captured.url;
  entry.username = encryptHarvestSecret(captured.username || '');
  entry.password = encryptHarvestSecret(captured.password);
  entry.updatedAt = now;
  await writeHarvestJson(harvestTsPasswordFile, data);
  page.tab.passwordCandidate = null;
  await emitHarvestPasswordHint(page.tab, captured.origin).catch(()=>{});
  return { saved:true, item:{ id:entry.id, origin:entry.origin, url:entry.url, username:captured.username || '', updatedAt:now } };
}
async function harvestTsPasswordRemove(input = {}) {
  const data = await harvestTsPasswordData(), id = String(input.id || '');
  data.items = data.items.filter(x => x.id !== id);
  await writeHarvestJson(harvestTsPasswordFile, data);
  return { items:await harvestTsPasswordList() };
}
async function credentialForURL(url) {
  let origin = '';
  try { origin = new URL(url).origin; } catch { return null; }
  const data = await harvestTsPasswordData();
  const item = data.items.find(x => x.origin === origin);
  if (!item) return null;
  const username = decryptHarvestSecret(item.username), password = decryptHarvestSecret(item.password);
  if (!password) return null;
  return { username, password };
}
async function fillHarvestCredential(tab = activeHarvestTsTab()) {
  if (!tab || tab.view.webContents.isDestroyed()) return { filled:false };
  const wc = tab.view.webContents, url = wc.getURL() || tab.url || '';
  const credential = await credentialForURL(url);
  if (!credential) return { filled:false };
  const payload = JSON.stringify(credential);
  const result = await wc.executeJavaScript(`(() => {
    const data = ${payload};
    const visible = el => {
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      return r.width > 1 && r.height > 1 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const set = (el, value) => {
      if (!el || !value || el.value) return false;
      const proto = Object.getPrototypeOf(el), setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, value); else el.value = value;
      el.dispatchEvent(new Event('input',{bubbles:true}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
      return true;
    };
    const password = [...document.querySelectorAll('input[type="password"]')].find(visible);
    if (!password) return false;
    const scope = password.form || document;
    const users = [...scope.querySelectorAll('input')].filter(x => x !== password && visible(x) && !x.disabled && ['text','email','tel'].includes((x.type||'text').toLowerCase()));
    const username = users.find(x => /user|email|login|account/i.test((x.autocomplete||'')+' '+(x.name||'')+' '+(x.id||'')+' '+(x.placeholder||''))) || users[0];
    const a = set(username, data.username), b = set(password, data.password);
    return a || b;
  })()`, true).catch(() => false);
  return { filled:Boolean(result), origin:new URL(url).origin };
}
async function harvestTsPasswordFillCurrent(input = {}) {
  const tab = harvestTsTabs.get(String(input.id || activeHarvestTsId));
  if(!tab || tab.kind!=='web') throw new Error('แท็บนี้ไม่มีฟอร์มล็อกอิน');
  let origin='';try{origin=new URL(tab.view.webContents.getURL()||tab.url||'').origin}catch{}
  const accounts=await harvestPasswordAccountsForOrigin(origin);
  if(!accounts.length) throw new Error('ไม่มีรหัสผ่านที่บันทึกไว้สำหรับเว็บนี้');
  if(accounts.length>1) throw new Error('มีหลายบัญชี กรุณาเลือกจากปุ่มบัญชีข้างช่อง URL');
  const result=await fillHarvestCredentialById(tab,accounts[0].id);
  if(!result.filled) throw new Error('ไม่พบฟอร์มล็อกอินที่กรอกได้');
  return result;
}

async function harvestTsBlockData() {
  const data = await readHarvestJson(harvestTsBlockFile, { version:1, rules:{} });
  return { version:1, rules:data && typeof data.rules === 'object' && data.rules ? data.rules : {} };
}

function sharedBlockSelectorsForOrigin(data, origin) {
  return Array.isArray(data?.rules?.[origin])
    ? data.rules[origin].filter(x => typeof x === 'string' && x.length < 700)
    : [];
}
function sharedBlockStyleScript(selectors) {
  return `(() => {
    const styleId='__imageharvest_shared_block_rules__';
    document.getElementById(styleId)?.remove();
    const selectors=${JSON.stringify(selectors)};
    const safe=selectors.filter(selector=>{
      try {
        const count=document.querySelectorAll(selector).length;
        const precise=selector.includes('>')||selector.includes('#')||selector.includes(':nth-of-type(');
        if(count>1)return false;
        if(count===0&&!precise)return false;
        return true;
      } catch { return false; }
    });
    if(!safe.length)return {applied:0,selectors:[]};
    const style=document.createElement('style');
    style.id=styleId;
    style.textContent=safe.map(s=>s+'{display:none!important;visibility:hidden!important}').join('\\n');
    (document.head||document.documentElement).append(style);
    return {applied:safe.length,selectors:safe};
  })()`;
}
async function collectorBlockInfo() {
  const url=webURL();
  if(!webAlive() || !allowedWeb(url)) throw new Error('กรุณาเปิดเว็บใน ImageHarvest ก่อน');
  return { url, origin:new URL(url).origin, backend:browserMode };
}

async function applyCollectorBlocks() {
  if(!webAlive() || !allowedWeb(webURL())) return {applied:0,selectors:[]};
  const info=await collectorBlockInfo();
  const data=await harvestTsBlockData();
  const selectors=sharedBlockSelectorsForOrigin(data,info.origin);
  return runMainPage(sharedBlockStyleScript(selectors),info.backend).catch(()=>({applied:0,selectors:[]}));
}
async function syncSharedBlockRules(origin='') {
  const tasks=[];
  for(const tab of harvestTsTabs.values()){
    if(!tab || tab.kind==='history' || tab.view.webContents.isDestroyed()) continue;
    let tabOrigin='';
    try { tabOrigin=new URL(tab.view.webContents.getURL()||tab.url||'').origin; } catch {}
    if(!origin || tabOrigin===origin) tasks.push(applyHarvestBlocks(tab));
  }
  if(webAlive() && allowedWeb(webURL())){
    let collectorOrigin='';
    try { collectorOrigin=new URL(webURL()).origin; } catch {}
    if(!origin || collectorOrigin===origin) tasks.push(applyCollectorBlocks());
  }
  await Promise.allSettled(tasks);
}
async function collectorBlockList() {
  const info=await collectorBlockInfo(),data=await harvestTsBlockData();
  return {origin:info.origin,selectors:sharedBlockSelectorsForOrigin(data,info.origin)};
}
async function collectorBlockDraftBegin(input={}) {
  ensureIdle();
  if(harvestBlockManagerKind!=='collector' && liveHarvestBlockManager()) await cancelHarvestBlockManagerDraft();
  const info=await collectorBlockInfo();
  const state=await runMainPage(harvestBlockDraftBootstrapScript(),info.backend);
  const saved=await collectorBlockList();
  if(input.showManager!==false) await showHarvestBlockManager('', 'collector');
  const popup=liveHarvestBlockManager();
  if(popup) { try { popup.setAlwaysOnTop(true,'floating'); } catch {} }
  if(info.backend==='chrome') await chromeBrowser.show().catch(()=>{});
  else if(browser && !browser.isDestroyed()) { browser.show(); browser.focus(); }
  return {...state,origin:info.origin,saved:saved.selectors};
}
async function collectorBlockDraftState() {
  const info=await collectorBlockInfo();
  const state=await runMainPage(`window.__harvestBlockDraft?.snapshot?.() || ({active:false,cancelled:false,selectors:[],count:0})`,info.backend)
    .catch(()=>({active:false,cancelled:false,selectors:[],count:0}));
  const saved=await collectorBlockList();
  return {...state,origin:info.origin,saved:saved.selectors};
}
async function collectorBlockDraftClear() {
  const info=await collectorBlockInfo();
  return runMainPage(`window.__harvestBlockDraft?.clear?.() || ({active:false,cancelled:false,selectors:[],count:0})`,info.backend);
}
async function finishCollectorBlockDraft(cancel=false) {
  if(!webAlive() || !allowedWeb(webURL())) return {active:false,cancelled:Boolean(cancel),selectors:[],count:0};
  return runMainPage(`window.__harvestBlockDraft?.finish?.(${cancel?'true':'false'}) || ({active:false,cancelled:${cancel?'true':'false'},selectors:[],count:0})`,browserMode)
    .catch(()=>({active:false,cancelled:Boolean(cancel),selectors:[],count:0}));
}
async function collectorBlockDraftCancel() {
  const state=await finishCollectorBlockDraft(true);
  return {...state,cancelled:true};
}
async function collectorBlockDraftCommit() {
  const info=await collectorBlockInfo();
  const state=await finishCollectorBlockDraft(false);
  const selectors=[...new Set((state.selectors||[]).map(String).map(x=>x.trim()).filter(x=>x&&x.length<700&&!/[{}]/.test(x)))];
  if(!selectors.length)return {saved:false,count:0,added:0,origin:info.origin,selectors:[]};
  const data=await harvestTsBlockData(),list=Array.isArray(data.rules[info.origin])?data.rules[info.origin]:[];
  const before=list.length;
  for(const selector of selectors) if(!list.includes(selector)) list.push(selector);
  data.rules[info.origin]=list.slice(-300);
  await writeHarvestJson(harvestTsBlockFile,data);
  await syncSharedBlockRules(info.origin);
  return {saved:true,origin:info.origin,added:Math.max(0,data.rules[info.origin].length-before),count:data.rules[info.origin].length,selectors:data.rules[info.origin]};
}
async function collectorBlockRemove(input={}) {
  const info=await collectorBlockInfo(),selector=String(input.selector||''),data=await harvestTsBlockData();
  const list=Array.isArray(data.rules[info.origin])?data.rules[info.origin]:[];
  data.rules[info.origin]=list.filter(x=>x!==selector);
  if(!data.rules[info.origin].length) delete data.rules[info.origin];
  await writeHarvestJson(harvestTsBlockFile,data);
  await syncSharedBlockRules(info.origin);
  return {origin:info.origin,selectors:data.rules[info.origin]||[]};
}
async function collectorBlockClear() {
  const info=await collectorBlockInfo(),data=await harvestTsBlockData();
  delete data.rules[info.origin];
  await writeHarvestJson(harvestTsBlockFile,data);
  await syncSharedBlockRules(info.origin);
  return {origin:info.origin,cleared:true,selectors:[]};
}

async function applyHarvestBlocks(tab = activeHarvestTsTab()) {
  if (!tab || tab.view.webContents.isDestroyed()) return;
  const wc = tab.view.webContents;
  if (tab.blockCssKey) {
    await wc.removeInsertedCSS(tab.blockCssKey).catch(() => {});
    tab.blockCssKey = '';
  }
  let origin = '';
  try { origin = new URL(wc.getURL() || tab.url || '').origin; } catch { return; }
  const data = await harvestTsBlockData();
  const selectors = Array.isArray(data.rules[origin]) ? data.rules[origin].filter(x => typeof x === 'string' && x.length < 700) : [];
  if (!selectors.length) return;
  const safeSelectors = await wc.executeJavaScript(`(() => {
    const selectors = ${JSON.stringify(selectors)};
    return selectors.filter(selector => {
      try {
        const count = document.querySelectorAll(selector).length;
        const precise = selector.includes('>') || selector.includes('#') || selector.includes(':nth-of-type(');
        if (count > 1) return false;
        if (count === 0 && !precise) return false;
        return true;
      } catch { return false; }
    });
  })()`, true).catch(() => selectors.filter(selector => selector.includes('>') || selector.includes('#') || selector.includes(':nth-of-type(')));
  if (!safeSelectors.length) return;
  const css = safeSelectors.map(s => `${s}{display:none!important;visibility:hidden!important}`).join('\n');
  tab.blockCssKey = await wc.insertCSS(css).catch(() => '');
}
function harvestBlockPickerScript() {
  return `new Promise(resolve => {
    let current=null, done=false;
    const esc = v => (CSS&&CSS.escape?CSS.escape(v):String(v).replace(/[^a-zA-Z0-9_-]/g,'\\\\$&'));
    const selectorFor = el => {
      if (!(el instanceof Element) || ['HTML','BODY'].includes(el.tagName)) return '';
      const unique = selector => { try { return document.querySelectorAll(selector).length === 1; } catch { return false; } };
      if (el.id) {
        const byId='#'+esc(el.id);
        if(unique(byId)) return byId;
      }
      const parts=[]; let node=el;
      while(node && node.nodeType===1 && node!==document.body && parts.length<10){
        let part=node.tagName.toLowerCase();
        const classes=[...node.classList]
          .filter(c=>c && !c.startsWith('__harvestts_') && c.length<=80)
          .slice(0,2);
        if(classes.length) part += classes.map(c=>'.'+esc(c)).join('');
        if(node.parentElement){
          const sameTag=[...node.parentElement.children].filter(x=>x.tagName===node.tagName);
          const samePart=classes.length
            ? sameTag.filter(x=>classes.every(c=>x.classList.contains(c)))
            : sameTag;
          if(samePart.length>1) part += ':nth-of-type('+(sameTag.indexOf(node)+1)+')';
        }
        parts.unshift(part);
        const candidate=parts.join(' > ');
        if(unique(candidate)) return candidate;
        node=node.parentElement;
        if(node?.id){
          const anchor='#'+esc(node.id);
          if(unique(anchor)){
            const anchored=anchor+' > '+parts.join(' > ');
            if(unique(anchored)) return anchored;
          }
        }
      }
      const absolute=[]; node=el;
      while(node && node.nodeType===1 && node!==document.body && absolute.length<24){
        let part=node.tagName.toLowerCase();
        if(node.parentElement){
          const sameTag=[...node.parentElement.children].filter(x=>x.tagName===node.tagName);
          if(sameTag.length>1) part += ':nth-of-type('+(sameTag.indexOf(node)+1)+')';
        }
        absolute.unshift(part);
        node=node.parentElement;
      }
      const fallback='body > '+absolute.join(' > ');
      return unique(fallback) ? fallback : parts.join(' > ');
    };
    const cleanup = value => {
      if(done) return; done=true; current?.classList.remove('__harvestts_pick__');
      removeEventListener('mouseover',over,true); removeEventListener('mouseout',out,true);
      removeEventListener('click',click,true); removeEventListener('keydown',key,true); resolve(value);
    };
    const over=e=>{ current?.classList.remove('__harvestts_pick__'); current=e.target; current?.classList.add('__harvestts_pick__'); };
    const out=e=>{ if(e.target===current){current.classList.remove('__harvestts_pick__');current=null;} };
    const click=e=>{ e.preventDefault();e.stopPropagation();e.stopImmediatePropagation(); cleanup(selectorFor(e.target)); };
    const key=e=>{ if(e.key==='Escape'){e.preventDefault();cleanup('');} };
    addEventListener('mouseover',over,true);addEventListener('mouseout',out,true);addEventListener('click',click,true);addEventListener('keydown',key,true);
  })`;
}
async function harvestTsBlockElement(input = {}) {
  const page = harvestTsPageInfo(harvestTsTabs.get(String(input.id || activeHarvestTsId)));
  const pickerCss = await page.wc.insertCSS('.__harvestts_pick__{outline:3px solid #a995ff!important;outline-offset:2px!important;cursor:crosshair!important}').catch(() => '');
  let selector = '';
  try { selector = String(await page.wc.executeJavaScript(harvestBlockPickerScript(), true) || '').trim(); }
  finally { if (pickerCss) await page.wc.removeInsertedCSS(pickerCss).catch(() => {}); }
  if (!selector) return { cancelled:true };
  if (selector.length > 700 || /[{}]/.test(selector)) throw new Error('Element ที่เลือกซับซ้อนเกินไป');
  const origin = new URL(page.url).origin, data = await harvestTsBlockData();
  const list = Array.isArray(data.rules[origin]) ? data.rules[origin] : [];
  if (!list.includes(selector)) list.push(selector);
  data.rules[origin] = list.slice(-200);
  await writeHarvestJson(harvestTsBlockFile, data);
  await syncSharedBlockRules(origin);
  return { blocked:true, origin, selector, count:data.rules[origin].length };
}
async function harvestTsBlockList(input = {}) {
  const page = harvestTsPageInfo(harvestTsTabs.get(String(input.id || activeHarvestTsId)));
  const origin = new URL(page.url).origin, data = await harvestTsBlockData();
  return { origin, selectors:Array.isArray(data.rules[origin]) ? data.rules[origin] : [] };
}
async function harvestTsBlockClear(input = {}) {
  const page = harvestTsPageInfo(harvestTsTabs.get(String(input.id || activeHarvestTsId)));
  const origin = new URL(page.url).origin, data = await harvestTsBlockData();
  delete data.rules[origin];
  await writeHarvestJson(harvestTsBlockFile, data);
  await syncSharedBlockRules(origin);
  return { origin, cleared:true, selectors:[] };
}

function harvestBlockDraftBootstrapScript() {
  return `(() => {
    try { window.__harvestBlockDraft?.finish?.(true); } catch {}
    document.getElementById('__harvestts_picker_root__')?.remove();
    const selected = new Set(), nodes = new Map();
    let hover = null, cancelled = false, active = true;
    const esc = v => (window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/[^a-zA-Z0-9_-]/g,'\\\\$&'));
    const selectorFor = el => {
      if (!(el instanceof Element) || ['HTML','BODY'].includes(el.tagName)) return '';
      const unique = selector => { try { return document.querySelectorAll(selector).length === 1; } catch { return false; } };
      if (el.id) {
        const byId='#'+esc(el.id);
        if(unique(byId)) return byId;
      }
      const parts=[]; let node=el;
      while(node && node.nodeType===1 && node!==document.body && parts.length<10){
        let part=node.tagName.toLowerCase();
        const classes=[...node.classList]
          .filter(c=>c && !c.startsWith('__harvestts_') && c.length<=80)
          .slice(0,2);
        if(classes.length) part += classes.map(c=>'.'+esc(c)).join('');
        if(node.parentElement){
          const sameTag=[...node.parentElement.children].filter(x=>x.tagName===node.tagName);
          const samePart=classes.length
            ? sameTag.filter(x=>classes.every(c=>x.classList.contains(c)))
            : sameTag;
          if(samePart.length>1) part += ':nth-of-type('+(sameTag.indexOf(node)+1)+')';
        }
        parts.unshift(part);
        const candidate=parts.join(' > ');
        if(unique(candidate)) return candidate;
        node=node.parentElement;
        if(node?.id){
          const anchor='#'+esc(node.id);
          if(unique(anchor)){
            const anchored=anchor+' > '+parts.join(' > ');
            if(unique(anchored)) return anchored;
          }
        }
      }
      const absolute=[]; node=el;
      while(node && node.nodeType===1 && node!==document.body && absolute.length<24){
        let part=node.tagName.toLowerCase();
        if(node.parentElement){
          const sameTag=[...node.parentElement.children].filter(x=>x.tagName===node.tagName);
          if(sameTag.length>1) part += ':nth-of-type('+(sameTag.indexOf(node)+1)+')';
        }
        absolute.unshift(part);
        node=node.parentElement;
      }
      const fallback='body > '+absolute.join(' > ');
      return unique(fallback) ? fallback : parts.join(' > ');
    };

    const root=document.createElement('div');
    root.id='__harvestts_picker_root__';
    root.setAttribute('aria-hidden','true');
    Object.assign(root.style,{
      position:'fixed',left:'0',top:'0',width:'100vw',height:'100vh',
      zIndex:'2147483647',pointerEvents:'auto',cursor:'crosshair',
      overflow:'hidden'
    });
    const dim=document.createElement('div');
    Object.assign(dim.style,{
      position:'absolute',inset:'0',background:'rgba(30,32,38,.62)',pointerEvents:'none'
    });
    const hoverLayer=document.createElement('div');
    const selectedLayer=document.createElement('div');
    for(const layer of [hoverLayer,selectedLayer]) Object.assign(layer.style,{position:'absolute',inset:'0',pointerEvents:'none'});
    root.append(dim,hoverLayer,selectedLayer);
    document.documentElement.append(root);

    const clippedRect = el => {
      if(!(el instanceof Element) || !el.isConnected) return null;
      const r=el.getBoundingClientRect();
      const left=Math.max(2,Math.min(innerWidth-2,r.left));
      const top=Math.max(2,Math.min(innerHeight-2,r.top));
      const right=Math.max(left+2,Math.min(innerWidth-2,r.right));
      const bottom=Math.max(top+2,Math.min(innerHeight-2,r.bottom));
      if(r.right<=0 || r.bottom<=0 || r.left>=innerWidth || r.top>=innerHeight) return null;
      return {
        left,top,right,bottom,width:Math.max(2,right-left),height:Math.max(2,bottom-top),
        raw:r, clipped:{left:r.left<0,top:r.top<0,right:r.right>innerWidth,bottom:r.bottom>innerHeight}
      };
    };
    const box = (el, kind, selector='') => {
      const rect=clippedRect(el); if(!rect) return null;
      const wrap=document.createElement('div');
      const selectedKind=kind==='selected';
      Object.assign(wrap.style,{
        position:'absolute',
        left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px',
        boxSizing:'border-box',
        border:selectedKind?'3px solid #829bff':'2px solid #c2c6ce',
        borderRadius:'4px',
        background:selectedKind?'rgba(205,218,255,.68)':'rgba(74,78,86,.52)',
        boxShadow:selectedKind?'0 0 0 1px rgba(62,81,190,.72), inset 0 0 0 1px rgba(255,255,255,.32)':'0 0 0 1px rgba(15,18,22,.70)',
        pointerEvents:'none'
      });
      const label=document.createElement('div');
      const raw=rect.raw;
      const clipped=rect.clipped.left||rect.clipped.top||rect.clipped.right||rect.clipped.bottom;
      label.textContent=(selector||selectorFor(el)||el.tagName.toLowerCase())+'  '+Math.round(raw.width)+'×'+Math.round(raw.height)+(clipped?'  • ขอบอยู่นอกจอ':'');
      Object.assign(label.style,{
        position:'absolute',left:'4px',top:'4px',maxWidth:'calc(100% - 8px)',
        padding:'3px 6px',borderRadius:'4px',
        background:selectedKind?'rgba(95,111,205,.94)':'rgba(48,52,61,.94)',
        color:'#fff',font:'10px/1.3 Consolas, monospace',
        whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'
      });
      wrap.append(label);
      return wrap;
    };
    const render=()=>{
      if(!active || !root.isConnected) return;
      hoverLayer.replaceChildren();
      selectedLayer.replaceChildren();
      if(hover){
        const sel=selectorFor(hover);
        if(sel && !selected.has(sel)){
          const b=box(hover,'hover',sel); if(b) hoverLayer.append(b);
        }
      }
      for(const sel of selected){
        let node=nodes.get(sel);
        if(!node?.isConnected){ try{node=document.querySelector(sel)}catch{} if(node) nodes.set(sel,node); }
        const b=box(node,'selected',sel); if(b) selectedLayer.append(b);
      }
    };
    const targetAt=(x,y)=>{
      const stack=document.elementsFromPoint(x,y);
      for(const el of stack){
        if(!(el instanceof Element) || root.contains(el) || ['HTML','BODY'].includes(el.tagName)) continue;
        return el;
      }
      return null;
    };
    const snapshot=()=>({active,cancelled,selectors:[...selected],count:selected.size});
    const clearHover=()=>{hover=null;render();};
    const move=e=>{ if(!active) return; hover=targetAt(e.clientX,e.clientY); render(); };
    const leave=()=>{ if(!active) return; hover=null; render(); };
    const click=e=>{
      if(!active) return;
      const target=targetAt(e.clientX,e.clientY); if(!target) return;
      const sel=selectorFor(target); if(!sel) return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      if(selected.has(sel)){selected.delete(sel);nodes.delete(sel);}
      else {selected.add(sel);nodes.set(sel,target);}
      hover=target; render();
    };
    const scrollableFor=el=>{
      let node=el;
      while(node && node!==document.body && node!==document.documentElement){
        const s=getComputedStyle(node);
        if(/auto|scroll/.test(s.overflowY||'') && node.scrollHeight>node.clientHeight+2) return node;
        node=node.parentElement;
      }
      return document.scrollingElement || document.documentElement;
    };
    const wheel=e=>{
      if(!active) return;
      const target=targetAt(e.clientX,e.clientY);
      const scroller=scrollableFor(target);
      if(scroller){
        e.preventDefault();
        if(scroller===document.scrollingElement || scroller===document.documentElement || scroller===document.body) window.scrollBy(e.deltaX,e.deltaY);
        else scroller.scrollBy(e.deltaX,e.deltaY);
        requestAnimationFrame(()=>{hover=targetAt(e.clientX,e.clientY);render();});
      }
    };
    const key=e=>{ if(e.key==='Escape' && active){e.preventDefault();cancelled=true;} };
    const reposition=()=>render();
    const clear=()=>{selected.clear();nodes.clear();clearHover();return snapshot();};
    const finish=(cancel=false)=>{
      if(!active) return snapshot();
      cancelled=cancelled||Boolean(cancel);
      active=false;hover=null;
      root.removeEventListener('pointermove',move,true);root.removeEventListener('pointerleave',leave,true);
      root.removeEventListener('click',click,true);root.removeEventListener('wheel',wheel,true);
      removeEventListener('keydown',key,true);
      removeEventListener('scroll',reposition,true);removeEventListener('resize',reposition,true);
      root.remove();
      return snapshot();
    };
    root.addEventListener('pointermove',move,true);root.addEventListener('pointerleave',leave,true);
    root.addEventListener('click',click,true);root.addEventListener('wheel',wheel,{capture:true,passive:false});
    addEventListener('keydown',key,true);
    addEventListener('scroll',reposition,true);addEventListener('resize',reposition,true);
    window.__harvestBlockDraft={snapshot,clear,finish,render};
    render();
    return snapshot();
  })()`;
}
async function harvestTsBlockDraftBegin(input = {}) {
  if (liveHarvestBlockManager() && harvestBlockManagerKind !== 'harvestts') await cancelHarvestBlockManagerDraft();
  const page = harvestTsPageInfo(harvestTsTabs.get(String(input.id || activeHarvestTsId)));
  if (page.tab.blockPickerCssKey) {
    await page.wc.removeInsertedCSS(page.tab.blockPickerCssKey).catch(() => {});
    page.tab.blockPickerCssKey = '';
  }
  const css = [
    'html,body{cursor:default}',
    '.__harvestts_pick_hover__{outline:2px solid #9aa0aa!important;outline-offset:2px!important;box-shadow:inset 0 0 0 9999px rgba(82,87,96,.24)!important;cursor:crosshair!important}',
    '.__harvestts_pick_selected__{outline:3px solid #8fa8ff!important;outline-offset:1px!important;box-shadow:inset 0 0 0 9999px rgba(174,196,255,.30)!important;cursor:crosshair!important}'
  ].join('\n');
  page.tab.blockPickerCssKey = await page.wc.insertCSS(css).catch(() => '');
  const state = await page.wc.executeJavaScript(harvestBlockDraftBootstrapScript(), true);
  const saved = await harvestTsBlockList({ id:page.tab.id });
  if (input.showManager !== false) await showHarvestBlockManager(page.tab.id);
  return { ...state, origin:new URL(page.url).origin, saved:saved.selectors };
}
async function harvestTsBlockDraftState(input = {}) {
  const page = harvestTsPageInfo(harvestTsTabs.get(String(input.id || activeHarvestTsId)));
  const state = await page.wc.executeJavaScript(`window.__harvestBlockDraft?.snapshot?.() || ({active:false,cancelled:false,selectors:[],count:0})`, true).catch(() => ({active:false,cancelled:false,selectors:[],count:0}));
  const saved = await harvestTsBlockList({ id:page.tab.id });
  return { ...state, origin:new URL(page.url).origin, saved:saved.selectors };
}
async function harvestTsBlockDraftClear(input = {}) {
  const page = harvestTsPageInfo(harvestTsTabs.get(String(input.id || activeHarvestTsId)));
  return page.wc.executeJavaScript(`window.__harvestBlockDraft?.clear?.() || ({active:false,cancelled:false,selectors:[],count:0})`, true);
}
async function finishHarvestBlockDraft(tab, cancel = false) {
  if (!tab || tab.view.webContents.isDestroyed()) return {active:false,cancelled:Boolean(cancel),selectors:[],count:0};
  const wc = tab.view.webContents;
  const state = await wc.executeJavaScript(`window.__harvestBlockDraft?.finish?.(${cancel ? 'true' : 'false'}) || ({active:false,cancelled:${cancel ? 'true' : 'false'},selectors:[],count:0})`, true).catch(() => ({active:false,cancelled:Boolean(cancel),selectors:[],count:0}));
  if (tab.blockPickerCssKey) {
    await wc.removeInsertedCSS(tab.blockPickerCssKey).catch(() => {});
    tab.blockPickerCssKey = '';
  }
  return state;
}
async function harvestTsBlockDraftCancel(input = {}) {
  const tab = harvestTsTabs.get(String(input.id || activeHarvestTsId));
  const state = await finishHarvestBlockDraft(tab, true);
  return { ...state, cancelled:true };
}
async function harvestTsBlockDraftCommit(input = {}) {
  const page = harvestTsPageInfo(harvestTsTabs.get(String(input.id || activeHarvestTsId)));
  const state = await finishHarvestBlockDraft(page.tab, false);
  const selectors = [...new Set((state.selectors || []).map(String).map(x=>x.trim()).filter(x=>x && x.length<700 && !/[{}]/.test(x)))];
  if (!selectors.length) return { saved:false, count:0, added:0, origin:new URL(page.url).origin, selectors:[] };
  const origin = new URL(page.url).origin, data = await harvestTsBlockData();
  const list = Array.isArray(data.rules[origin]) ? data.rules[origin] : [];
  const before = list.length;
  for (const selector of selectors) if (!list.includes(selector)) list.push(selector);
  data.rules[origin] = list.slice(-300);
  await writeHarvestJson(harvestTsBlockFile, data);
  await syncSharedBlockRules(origin);
  return { saved:true, origin, added:Math.max(0,data.rules[origin].length-before), count:data.rules[origin].length, selectors:data.rules[origin] };
}
async function harvestTsBlockRemove(input = {}) {
  const page = harvestTsPageInfo(harvestTsTabs.get(String(input.id || activeHarvestTsId)));
  const origin = new URL(page.url).origin, selector = String(input.selector || '');
  const data = await harvestTsBlockData();
  const list = Array.isArray(data.rules[origin]) ? data.rules[origin] : [];
  data.rules[origin] = list.filter(x => x !== selector);
  if (!data.rules[origin].length) delete data.rules[origin];
  await writeHarvestJson(harvestTsBlockFile, data);
  await syncSharedBlockRules(origin);
  return { origin, selectors:data.rules[origin] || [] };
}

function liveHarvestBlockManager() {
  return harvestBlockManagerWindow && !harvestBlockManagerWindow.isDestroyed() ? harvestBlockManagerWindow : null;
}
function harvestBlockManagerSender(event) {
  const win = liveHarvestBlockManager();
  if (!win || event.sender !== win.webContents) throw new Error('Unauthorized block manager IPC');
}
async function closeHarvestBlockManagerWindow() {
  const win = liveHarvestBlockManager();
  harvestBlockManagerTabId = null;
  harvestBlockManagerKind = 'harvestts';
  harvestBlockManagerCollapsed = false;
  harvestBlockManagerWindow = null;
  if (win) {
    try { win.setAlwaysOnTop(false); } catch {}
    try { win.hide(); } catch {}
    try { win.destroy(); } catch {}
  }
}
async function cancelHarvestBlockManagerDraft(message = '') {
  const kind=harvestBlockManagerKind,id=harvestBlockManagerTabId;
  if(kind==='collector') await collectorBlockDraftCancel().catch(()=>{});
  else if (id) {
    const tab = harvestTsTabs.get(id);
    await finishHarvestBlockDraft(tab, true).catch(() => {});
  }
  await closeHarvestBlockManagerWindow();
  if (message) emit(kind==='collector'?'collector-block-finished':'harvestts-block-finished',{ cancelled:true, message });
}
function defaultHarvestBlockManagerBounds(width = 350, height = 520) {
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : {x:100,y:100,width:1360,height:920};
  return {
    x: Math.round(parent.x + Math.max(12, parent.width - width - 28)),
    y: Math.round(parent.y + 118),
    width,
    height
  };
}
function createHarvestBlockManagerWindow() {
  const existing = liveHarvestBlockManager();
  if (existing) return existing;
  const bounds = defaultHarvestBlockManagerBounds();
  const win = new BrowserWindow({
    ...bounds,
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    modal: false,
    frame: false,
    transparent: false,
    show: false,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: false,
    backgroundColor: '#151821',
    webPreferences: {
      partition: 'harvest-block-ui',
      preload: path.join(__dirname, 'block-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  });
  harvestBlockManagerWindow = win;
  bindScreenshotWindow(win);
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action:'deny' }));
  win.on('closed', () => {
    if (harvestBlockManagerWindow === win) harvestBlockManagerWindow = null;
  });
  win.__harvestBlockReady = win.loadFile(path.join(__dirname,'block-manager.html'));
  return win;
}
async function showHarvestBlockManager(tabId, kind='harvestts') {
  harvestBlockManagerKind = kind === 'collector' ? 'collector' : 'harvestts';
  harvestBlockManagerTabId = harvestBlockManagerKind==='harvestts' ? String(tabId || activeHarvestTsId || '') : null;
  harvestBlockManagerCollapsed = false;
  const win = createHarvestBlockManagerWindow();
  try { await win.__harvestBlockReady; } catch (error) {
    await closeHarvestBlockManagerWindow();
    throw new Error('เปิดหน้าต่าง Block element ไม่สำเร็จ: ' + error.message);
  }
  if (win.isDestroyed()) return;
  const bounds = defaultHarvestBlockManagerBounds();
  try { win.setBounds(bounds); } catch {}
  try { win.setMinimumSize(300, 56); } catch {}
  win.show();
  win.focus();
}
function setHarvestBlockManagerCollapsed(collapsed) {
  const win = liveHarvestBlockManager();
  if (!win) return false;
  harvestBlockManagerCollapsed = Boolean(collapsed);
  const [width] = win.getSize();
  const height = harvestBlockManagerCollapsed ? 58 : 520;
  try {
    if (harvestBlockManagerCollapsed) {
      win.setSize(Math.max(300,width), height, true);
      win.setResizable(false);
    } else {
      win.setResizable(true);
      win.setSize(Math.max(300,width), height, true);
    }
  } catch {}
  return harvestBlockManagerCollapsed;
}

function harvestInternalSender(event, kind='history') {
  const tab = [...harvestTsTabs.values()].find(row => row.kind === kind && !row.view.webContents.isDestroyed() && row.view.webContents === event.sender);
  const files={history:'history.html',downloads:'downloads.html',offline:'offline.html','offline-reader':'offline-reader.html'},file=files[kind]||files.history;
  const expected = pathToFileURL(path.join(__dirname, file)).href;
  const actual=String(event.senderFrame?.url||'').split(/[?#]/)[0];
  if (!tab || actual !== expected) throw new Error('Unauthorized HarvestTS internal IPC');
  return tab;
}
function registerHarvestInternalIpc() {
  const channels=[
    'history-list','history-remove','history-clear','browser-settings','history-set-enabled','open-url',
    'downloads-list','downloads-remove','downloads-clear','downloads-open','downloads-show','downloads-cancel',
    'offline-list','offline-remove','offline-open','offline-open-source','offline-project','offline-image','offline-cover','offline-group-create','offline-group-rename','offline-group-remove','offline-library-reorder','offline-library-project-create','offline-library-project-rename','offline-library-project-group','offline-item-project','offline-export-start','offline-export-page','offline-export-finish'
  ];
  for(const name of channels) ipcMain.removeHandler(`harvest-internal:${name}`);
  ipcMain.handle('harvest-internal:history-list', async (event,input={}) => { harvestInternalSender(event,'history'); return harvestTsHistoryList(input); });
  ipcMain.handle('harvest-internal:history-remove', async (event,input={}) => { harvestInternalSender(event,'history'); return harvestTsHistoryRemove(input); });
  ipcMain.handle('harvest-internal:history-clear', async event => { harvestInternalSender(event,'history'); return harvestTsHistoryClear(); });
  ipcMain.handle('harvest-internal:browser-settings', async event => { harvestInternalSender(event,'history'); return harvestTsBrowserSettings(); });
  ipcMain.handle('harvest-internal:history-set-enabled', async (event,input={}) => {
    harvestInternalSender(event,'history');
    return harvestTsBrowserSettingsSet({historyEnabled:Boolean(input.enabled)});
  });
  ipcMain.handle('harvest-internal:open-url', async (event,input={}) => {
    harvestInternalSender(event,'history');
    return createHarvestTsTab({url:normalizeHarvestTsURL(input.url),activate:true});
  });
  ipcMain.handle('harvest-internal:downloads-list', async event => { harvestInternalSender(event,'downloads'); return harvestTsDownloadList(); });
  ipcMain.handle('harvest-internal:downloads-remove', async (event,input={}) => { harvestInternalSender(event,'downloads'); return harvestTsDownloadRemove(input); });
  ipcMain.handle('harvest-internal:downloads-clear', async event => { harvestInternalSender(event,'downloads'); return harvestTsDownloadClear(); });
  ipcMain.handle('harvest-internal:downloads-open', async (event,input={}) => { harvestInternalSender(event,'downloads'); return harvestTsDownloadOpen(input); });
  ipcMain.handle('harvest-internal:downloads-show', async (event,input={}) => { harvestInternalSender(event,'downloads'); return harvestTsDownloadShow(input); });
  ipcMain.handle('harvest-internal:downloads-cancel', async (event,input={}) => { harvestInternalSender(event,'downloads'); return harvestTsDownloadCancel(input); });
  ipcMain.handle('harvest-internal:offline-list', async event => { harvestInternalSender(event,'offline'); return harvestOfflineList(); });
  ipcMain.handle('harvest-internal:offline-cover', async (event,input={}) => { harvestInternalSender(event,'offline'); return harvestOfflineCover(input.id); });
  ipcMain.handle('harvest-internal:offline-group-create', async (event,input={}) => { harvestInternalSender(event,'offline'); return harvestOfflineGroupCreate(input); });
  ipcMain.handle('harvest-internal:offline-group-rename', async (event,input={}) => { harvestInternalSender(event,'offline'); return harvestOfflineGroupRename(input); });
  ipcMain.handle('harvest-internal:offline-group-remove', async (event,input={}) => { harvestInternalSender(event,'offline'); return harvestOfflineGroupRemove(input); });
  ipcMain.handle('harvest-internal:offline-library-reorder', async (event,input={}) => { harvestInternalSender(event,'offline'); return harvestOfflineLibraryReorder(input); });
  ipcMain.handle('harvest-internal:offline-library-project-create', async (event,input={}) => { harvestInternalSender(event,'offline'); return harvestOfflineLibraryProjectCreate(input); });
  ipcMain.handle('harvest-internal:offline-library-project-rename', async (event,input={}) => { harvestInternalSender(event,'offline'); return harvestOfflineLibraryProjectRename(input); });
  ipcMain.handle('harvest-internal:offline-library-project-group', async (event,input={}) => { harvestInternalSender(event,'offline'); return harvestOfflineLibraryProjectGroup(input); });
  ipcMain.handle('harvest-internal:offline-item-project', async (event,input={}) => { harvestInternalSender(event,'offline'); return harvestOfflineItemProject(input); });
  ipcMain.handle('harvest-internal:offline-remove', async (event,input={}) => { harvestInternalSender(event,'offline'); return harvestOfflineRemove(input.id); });
  ipcMain.handle('harvest-internal:offline-open', async (event,input={}) => { harvestInternalSender(event,'offline'); return harvestTsOpenOfflineReader(input.id); });
  ipcMain.handle('harvest-internal:offline-open-source', async (event,input={}) => { harvestInternalSender(event,'offline'); const saved=await harvestOfflineReadProject(String(input.id||'')); return createHarvestTsTab({url:saved.project.url,activate:true}); });
  ipcMain.handle('harvest-internal:offline-project', async (event,input={}) => { const tab=harvestInternalSender(event,'offline-reader'); return harvestOfflineProjectData(String(input.id||tab.projectId||'')); });
  ipcMain.handle('harvest-internal:offline-image', async (event,input={}) => {
    const tab=harvestInternalSender(event,'offline-reader'),projectId=String(input.id||tab.projectId||''),file=String(input.file||'');
    if(path.basename(file)!==file)throw Error('ชื่อไฟล์ Offline ไม่ถูกต้อง');
    const saved=await harvestOfflineReadProject(projectId),page=saved.manifest.pages.find(p=>p.file===file&&!p.error);
    if(!page)throw Error('ไม่พบภาพ Offline');
    const bytes=await fs.readFile(path.join(saved.dir,file));
    return {mime:page.mime||'application/octet-stream',bytes:new Uint8Array(bytes)};
  });
  ipcMain.handle('harvest-internal:offline-export-start', async (event,input={}) => { const tab=harvestInternalSender(event,'offline-reader'); return harvestOfflineExportStart(tab,input); });
  ipcMain.handle('harvest-internal:offline-export-page', async (event,input={}) => { const tab=harvestInternalSender(event,'offline-reader'); return harvestOfflineExportPage(tab,input); });
  ipcMain.handle('harvest-internal:offline-export-finish', async (event,input={}) => { const tab=harvestInternalSender(event,'offline-reader'); return harvestOfflineExportFinish(tab,input); });
}

function registerHarvestBlockManagerIpc() {
  const channels = ['state','clear-draft','commit','cancel','remove','clear-saved','collapse','close'];
  for (const name of channels) ipcMain.removeHandler(`harvest-block:${name}`);
  const isCollector=()=>harvestBlockManagerKind==='collector';
  const eventType=()=>isCollector()?'collector-block-finished':'harvestts-block-finished';

  ipcMain.handle('harvest-block:state', async event => {
    harvestBlockManagerSender(event);
    if(isCollector()) return collectorBlockDraftState();
    if(!harvestBlockManagerTabId) return {active:false,cancelled:false,selectors:[],saved:[],count:0,origin:''};
    return harvestTsBlockDraftState({id:harvestBlockManagerTabId});
  });
  ipcMain.handle('harvest-block:clear-draft', async event => {
    harvestBlockManagerSender(event);
    return isCollector() ? collectorBlockDraftClear() : harvestTsBlockDraftClear({id:harvestBlockManagerTabId});
  });
  ipcMain.handle('harvest-block:commit', async event => {
    harvestBlockManagerSender(event);
    const kind=harvestBlockManagerKind,id=harvestBlockManagerTabId;
    const result=kind==='collector'
      ? await collectorBlockDraftCommit()
      : await harvestTsBlockDraftCommit({id});
    const next=kind==='collector'
      ? await collectorBlockDraftBegin({showManager:false})
      : await harvestTsBlockDraftBegin({id,showManager:false});
    emit(kind==='collector'?'collector-block-finished':'harvestts-block-finished',{cancelled:false,keptOpen:true,...result});
    return {...result,keptOpen:true,next};
  });
  ipcMain.handle('harvest-block:cancel', async event => {
    harvestBlockManagerSender(event);
    const kind=harvestBlockManagerKind,id=harvestBlockManagerTabId;
    const result=kind==='collector' ? await collectorBlockDraftCancel() : await harvestTsBlockDraftCancel({id});
    await closeHarvestBlockManagerWindow();
    emit(kind==='collector'?'collector-block-finished':'harvestts-block-finished',{cancelled:true});
    return result;
  });
  ipcMain.handle('harvest-block:remove', async (event,input={}) => {
    harvestBlockManagerSender(event);
    return isCollector()
      ? collectorBlockRemove({selector:input.selector})
      : harvestTsBlockRemove({id:harvestBlockManagerTabId,selector:input.selector});
  });
  ipcMain.handle('harvest-block:clear-saved', async event => {
    harvestBlockManagerSender(event);
    return isCollector() ? collectorBlockClear() : harvestTsBlockClear({id:harvestBlockManagerTabId});
  });
  ipcMain.handle('harvest-block:collapse', async (event,input={}) => {
    harvestBlockManagerSender(event);
    return setHarvestBlockManagerCollapsed(input.collapsed);
  });
  ipcMain.handle('harvest-block:close', async event => {
    harvestBlockManagerSender(event);
    const kind=harvestBlockManagerKind,id=harvestBlockManagerTabId;
    if(kind==='collector') await collectorBlockDraftCancel().catch(()=>{});
    else if(id) await harvestTsBlockDraftCancel({id}).catch(()=>{});
    await closeHarvestBlockManagerWindow();
    emit(kind==='collector'?'collector-block-finished':'harvestts-block-finished',{cancelled:true});
    return true;
  });
}

function harvestTsState(tab) {
  if (!tab || tab.view.webContents.isDestroyed()) return null;
  const wc = tab.view.webContents,nav=wc.navigationHistory;
  const web=tab.kind==='web';
  return {
    id: tab.id,
    kind: tab.kind || 'web',
    title: wc.getTitle() || tab.title || (tab.kind === 'history' ? 'History' : tab.kind === 'downloads' ? 'Downloads' : tab.kind === 'offline' ? 'Offline' : tab.kind === 'offline-reader' ? 'Offline Reader' : 'แท็บใหม่'),
    url: wc.getURL() || tab.url || '',
    loading: wc.isLoading(),
    canGoBack:web?Boolean(nav?.canGoBack?.()):wc.canGoBack(),
    canGoForward:web?Boolean(nav?.canGoForward?.()):wc.canGoForward(),
    zoomFactor:web?normalizeHarvestZoom(tab.zoomFactor||wc.getZoomFactor?.()||1):1,
    historyLength:web?Number(nav?.length?.()||0):0,
    historyIndex:web?Number(nav?.getActiveIndex?.()||0):0
  };
}
function harvestTsSnapshot() {
  return {
    activeId: activeHarvestTsId,
    tabs: [...harvestTsTabs.values()].map(harvestTsState).filter(Boolean)
  };
}
function emitHarvestTs() {
  emit('harvestts-state', harvestTsSnapshot());
}
function applyHarvestTsView() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!harvestTsVisible || !activeHarvestTsId) {
    mainWindow.setBrowserView(null);
    return;
  }
  const tab = harvestTsTabs.get(activeHarvestTsId);
  if (!tab || tab.view.webContents.isDestroyed()) {
    mainWindow.setBrowserView(null);
    return;
  }
  mainWindow.setBrowserView(tab.view);
  tab.view.setBounds(harvestTsBounds);
  tab.view.setAutoResize({ width: true, height: true });
  // BrowserView needs native focus for physical mouse-wheel/touchpad input.
  // Without this, Chromium can scroll programmatically while Windows routes
  // wheel input to the parent renderer instead.
  setImmediate(() => {
    if (harvestTsVisible && activeHarvestTsId === tab.id && !tab.view.webContents.isDestroyed()) {
      tab.view.webContents.focus();
      require('./reader-mode.cjs').repairContinuousReaderScroll(tab.view.webContents).catch(()=>{});
    }
  });
}
function sanitizeHarvestTsBounds(input = {}) {
  const area = mainWindow?.getContentBounds?.() || { width: 1360, height: 920 };
  const x = Math.max(0, Math.min(area.width - 1, Math.round(Number(input.x) || 0)));
  const y = Math.max(0, Math.min(area.height - 1, Math.round(Number(input.y) || 0)));
  const width = Math.max(1, Math.min(area.width - x, Math.round(Number(input.width) || 1)));
  const height = Math.max(1, Math.min(area.height - y, Math.round(Number(input.height) || 1)));
  return { x, y, width, height };
}
function normalizeHarvestTsURL(raw) {
  const value = String(raw || '').trim();
  if (!value) return 'https://www.google.com/';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    return url.href;
  } catch {
    throw new Error('HarvestTS รองรับเฉพาะ http/https');
  }
}

function liveHarvestContextMenu() {
  return harvestContextMenuWindow && !harvestContextMenuWindow.isDestroyed() ? harvestContextMenuWindow : null;
}
async function closeHarvestContextMenu() {
  const win=liveHarvestContextMenu();
  harvestContextMenuWindow=null;
  harvestContextMenuTarget=null;
  harvestContextMenuModel=null;
  if(win){try{win.hide()}catch{} try{win.destroy()}catch{}}
}
function harvestContextSafeFilename(value,fallback='page') {
  const text=String(value||fallback).replace(/[<>:"/\\|?*\x00-\x1F]/g,'_').replace(/[. ]+$/,'').trim().slice(0,120);
  return text||fallback;
}
function harvestContextItems(tab,params={}) {
  const wc=tab.view.webContents, flags=params.editFlags||{}, items=[];
  const add=(id,label,shortcut='',disabled=false,extra={})=>items.push({id,label,shortcut,disabled,...extra});
  const sep=()=>{if(items.length&&items[items.length-1]?.type!=='separator')items.push({type:'separator'})};
  const section=label=>items.push({type:'section',label});
  const selection=String(params.selectionText||'').trim();
  const linkURL=/^https?:\/\//i.test(params.linkURL||'')?params.linkURL:'';
  const srcURL=/^https?:\/\//i.test(params.srcURL||'')?params.srcURL:'';
  const image=params.mediaType==='image'&&srcURL;

  if(params.isEditable){
    section('แก้ไข');
    add('undo','ย้อนกลับ','CTRL + Z',!flags.canUndo);
    add('redo','ทำซ้ำ','CTRL + Y',!flags.canRedo);
    sep();
    add('cut','ตัด','CTRL + X',!flags.canCut);
    add('copy','คัดลอก','CTRL + C',!flags.canCopy);
    add('paste','วาง','CTRL + V',!flags.canPaste);
    add('select-all','เลือกทั้งหมด','CTRL + A',!flags.canSelectAll);
    sep();
  }else if(selection){
    section('ข้อความที่เลือก');
    add('copy','คัดลอก','CTRL + C',!flags.canCopy);
    add('search-selection',`ค้นหา Google “${selection.slice(0,42)}${selection.length>42?'…':''}”`,'',false,{accent:true});
    add('translate-selection','แปลข้อความนี้เป็นไทย','',false,{accent:true});
    sep();
  }

  if(linkURL){
    section('ลิงก์');
    add('open-link-tab','เปิดลิงก์ในแท็บใหม่');
    add('download-link','ดาวน์โหลดลิงก์');
    add('copy-link','คัดลอกที่อยู่ลิงก์');
    sep();
  }

  if(image){
    section('รูปภาพ');
    add('open-image-tab','เปิดรูปภาพในแท็บใหม่');
    add('download-image','ดาวน์โหลดรูปภาพ');
    add('copy-image','คัดลอกรูปภาพ');
    add('copy-image-address','คัดลอกที่อยู่รูปภาพ');
    sep();
  }

  section('หน้าเว็บ');
  add('back','ย้อนกลับ','ALT + ←',!wc.navigationHistory?.canGoBack?.());
  add('forward','ไปข้างหน้า','ALT + →',!wc.navigationHistory?.canGoForward?.());
  add('reload','โหลดใหม่','F5');
  sep();
  add('bookmark','เพิ่มใน Bookmark…','CTRL + D',false,{accent:true});
  add('fullscreen',mainWindow?.isFullScreen?.()?'ออกจากเต็มจอ':'เต็มหน้าจอ','F11');
  sep();
  add('copy-address','คัดลอกที่อยู่หน้าเว็บ');
  add('save-page','บันทึกหน้าเว็บเป็น…','CTRL + S');
  add('save-pdf','บันทึกเป็น PDF…');
  add('print','พิมพ์…','CTRL + P');
  sep();
  add('inspect','Inspect element','CTRL + SHIFT + C');
  return items;
}
function harvestContextBounds(params,items) {
  const width=318;
  const rawHeight=14+items.reduce((sum,row)=>sum+(row.type==='separator'?13:row.type==='section'?23:35),0);
  const height=Math.max(70,Math.min(650,rawHeight));
  const content=mainWindow?.getContentBounds?.()||{x:100,y:100,width:1360,height:900};
  const point={
    x:content.x+harvestTsBounds.x+Math.max(0,Number(params.x)||0),
    y:content.y+harvestTsBounds.y+Math.max(0,Number(params.y)||0)
  };
  const display=screen.getDisplayNearestPoint(point),area=display.workArea;
  return {
    x:Math.round(Math.max(area.x+4,Math.min(point.x,area.x+area.width-width-4))),
    y:Math.round(Math.max(area.y+4,Math.min(point.y,area.y+area.height-height-4))),
    width,height
  };
}
function harvestContextSender(event) {
  const win=liveHarvestContextMenu();
  if(!win||win.webContents!==event.sender)throw new Error('Unauthorized HarvestTS context menu IPC');
  return win;
}
function createHarvestContextWindow(bounds) {
  const win=new BrowserWindow({
    ...bounds,
    parent:mainWindow&&!mainWindow.isDestroyed()?mainWindow:undefined,
    modal:false,frame:false,transparent:true,show:false,resizable:false,movable:false,
    minimizable:false,maximizable:false,fullscreenable:false,skipTaskbar:true,alwaysOnTop:false,
    backgroundColor:'#00000000',
    webPreferences:{
      partition:'harvest-context-ui',
      preload:path.join(__dirname,'context-preload.cjs'),
      contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,spellcheck:false
    }
  });
  harvestContextMenuWindow=win;
  bindScreenshotWindow(win);
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.on('blur',()=>setTimeout(()=>{if(harvestContextMenuWindow===win)closeHarvestContextMenu().catch(()=>{})},30));
  win.on('closed',()=>{if(harvestContextMenuWindow===win){harvestContextMenuWindow=null;harvestContextMenuTarget=null;harvestContextMenuModel=null}});
  win.__ready=win.loadFile(path.join(__dirname,'context-menu.html'));
  return win;
}
async function showHarvestContextMenu(tab,params={}) {
  await closeHarvestContextMenu();
  if(!tab||tab.kind!=='web'||tab.view.webContents.isDestroyed())return false;
  const items=harvestContextItems(tab,params),bounds=harvestContextBounds(params,items);
  harvestContextMenuTarget={
    tabId:tab.id,x:Number(params.x)||0,y:Number(params.y)||0,
    selectionText:String(params.selectionText||''),linkURL:String(params.linkURL||''),
    srcURL:String(params.srcURL||''),pageURL:tab.view.webContents.getURL()||tab.url||''
  };
  harvestContextMenuModel={items};
  const win=createHarvestContextWindow(bounds);
  try{await win.__ready}catch{await closeHarvestContextMenu();return false}
  if(win.isDestroyed())return false;
  win.show();win.focus();
  return true;
}
async function harvestContextSavePage(tab) {
  const wc=tab.view.webContents,title=harvestContextSafeFilename(wc.getTitle()||'page');
  const result=await dialog.showSaveDialog(mainWindow,{title:'บันทึกหน้าเว็บ',defaultPath:path.join(app.getPath('downloads'),title+'.html'),filters:[{name:'Web page',extensions:['html','htm']}]});
  if(result.canceled||!result.filePath)return false;
  await wc.savePage(result.filePath,'HTMLComplete');
  return true;
}
async function harvestContextSavePdf(tab) {
  const wc=tab.view.webContents,title=harvestContextSafeFilename(wc.getTitle()||'page');
  const result=await dialog.showSaveDialog(mainWindow,{title:'บันทึกเป็น PDF',defaultPath:path.join(app.getPath('downloads'),title+'.pdf'),filters:[{name:'PDF',extensions:['pdf']}]});
  if(result.canceled||!result.filePath)return false;
  const data=await wc.printToPDF({printBackground:true,preferCSSPageSize:true});
  await fs.writeFile(result.filePath,data);
  return true;
}
async function harvestContextCopyImage(tab,url) {
  const response=await tab.view.webContents.session.fetch(url,{referrer:tab.view.webContents.getURL()||undefined});
  if(!response.ok)throw new Error('โหลดรูปภาพสำหรับคัดลอกไม่สำเร็จ');
  const buffer=Buffer.from(await response.arrayBuffer()),image=nativeImage.createFromBuffer(buffer);
  if(image.isEmpty())throw new Error('รูปภาพนี้คัดลอกไม่ได้');
  clipboard.writeImage(image);
  return true;
}
async function executeHarvestContextAction(id) {
  const target=harvestContextMenuTarget,tab=target&&harvestTsTabs.get(target.tabId);
  if(!tab||tab.view.webContents.isDestroyed())throw new Error('แท็บต้นทางปิดไปแล้ว');
  const wc=tab.view.webContents,selection=target.selectionText.trim();
  if(id==='undo')wc.undo();
  else if(id==='redo')wc.redo();
  else if(id==='cut')wc.cut();
  else if(id==='copy')wc.copy();
  else if(id==='paste')wc.paste();
  else if(id==='select-all')wc.selectAll();
  else if(id==='search-selection'&&selection)createHarvestTsTab({url:'https://www.google.com/search?q='+encodeURIComponent(selection),activate:true});
  else if(id==='translate-selection'&&selection)createHarvestTsTab({url:'https://translate.google.com/?sl=auto&tl=th&text='+encodeURIComponent(selection)+'&op=translate',activate:true});
  else if(id==='open-link-tab'&&/^https?:\/\//i.test(target.linkURL))createHarvestTsTab({url:target.linkURL,activate:true});
  else if(id==='download-link'&&/^https?:\/\//i.test(target.linkURL))wc.downloadURL(target.linkURL);
  else if(id==='copy-link')clipboard.writeText(target.linkURL||'');
  else if(id==='open-image-tab'&&/^https?:\/\//i.test(target.srcURL))createHarvestTsTab({url:target.srcURL,activate:true});
  else if(id==='download-image'&&/^https?:\/\//i.test(target.srcURL))wc.downloadURL(target.srcURL);
  else if(id==='copy-image'&&/^https?:\/\//i.test(target.srcURL))await harvestContextCopyImage(tab,target.srcURL);
  else if(id==='copy-image-address')clipboard.writeText(target.srcURL||'');
  else if(id==='back'&&wc.navigationHistory?.canGoBack?.())wc.navigationHistory.goBack();
  else if(id==='forward'&&wc.navigationHistory?.canGoForward?.())wc.navigationHistory.goForward();
  else if(id==='reload')wc.reload();
  else if(id==='bookmark')emit('harvestts-menu-action',{action:'bookmark'});
  else if(id==='fullscreen')mainWindow.setFullScreen(!mainWindow.isFullScreen());
  else if(id==='copy-address')clipboard.writeText(wc.getURL()||tab.url||'');
  else if(id==='save-page')return harvestContextSavePage(tab);
  else if(id==='save-pdf')return harvestContextSavePdf(tab);
  else if(id==='print')wc.print({silent:false,printBackground:true});
  else if(id==='inspect'){wc.inspectElement(target.x,target.y);if(!wc.isDevToolsOpened())wc.openDevTools({mode:'detach'});}
  return true;
}
function registerHarvestContextMenuIpc() {
  for(const name of ['model','action','close'])ipcMain.removeHandler('harvest-context:'+name);
  ipcMain.handle('harvest-context:model',event=>{harvestContextSender(event);return harvestContextMenuModel||{items:[]}});
  ipcMain.handle('harvest-context:action',async(event,input={})=>{
    harvestContextSender(event);
    const id=String(input.id||''),target=harvestContextMenuTarget?{...harvestContextMenuTarget}:null;
    const tab=target&&harvestTsTabs.get(target.tabId);
    if(!tab)throw new Error('แท็บต้นทางปิดไปแล้ว');
    // Keep the target while the action runs, then close the custom menu.
    try{return {ok:true,result:await executeHarvestContextAction(id)}}finally{await closeHarvestContextMenu()}
  });
  ipcMain.handle('harvest-context:close',async event=>{harvestContextSender(event);await closeHarvestContextMenu();return true});
}

function bindHarvestTs(tab) {
  const wc = tab.view.webContents;
  let imageStoreInstalling=false;
  const ensureHarvestImageStore=()=>{
    if(tab.kind!=='web'||!tab.imageStore||tab.imageStore.installed||imageStoreInstalling)return tab.imageStoreReady;
    imageStoreInstalling=true;
    tab.imageStoreReady=tab.imageStore.install().then(()=>true).catch(()=>false).finally(()=>{imageStoreInstalling=false;});
    return tab.imageStoreReady;
  };
  let preparedReaderDocument = '';
  let readerPrepareTimer = null, offlineRestoreTimer = null, offlineRestoreAttempt = 0;
  const clearOfflineRestore = () => { if(offlineRestoreTimer) clearTimeout(offlineRestoreTimer); offlineRestoreTimer=null; offlineRestoreAttempt=0; };
  const scheduleOfflineRestore = (delayMs=520) => {
    if(tab.kind!=='web'||wc.isDestroyed())return;
    if(offlineRestoreTimer)clearTimeout(offlineRestoreTimer);
    const documentId=readerDocumentKey(wc.getURL()||tab.url||'');
    offlineRestoreTimer=setTimeout(async()=>{
      offlineRestoreTimer=null;if(wc.isDestroyed()||readerDocumentKey(wc.getURL()||'')!==documentId)return;
      const result=await restoreHarvestOfflineOverlay(tab).catch(()=>null);
      if(!tab.offlineOverlayDocument&&result&&offlineRestoreAttempt<5){offlineRestoreAttempt++;scheduleOfflineRestore(450+offlineRestoreAttempt*300);}
    },delayMs);
  };
  const scheduleContinuousReader = (url = wc.getURL()) => {
    let parsed;
    try { parsed = new URL(url || ''); } catch { return; }
    if (!['mangadex.org','www.mangadex.org'].includes(parsed.hostname) || !parsed.pathname.startsWith('/chapter/')) {
      preparedReaderDocument = '';
      return;
    }
    const documentId = readerDocumentKey(parsed.href);
    if (preparedReaderDocument === documentId) {
      require('./reader-mode.cjs').repairContinuousReaderScroll(wc).catch(()=>{});
      return;
    }
    if (readerPrepareTimer) clearTimeout(readerPrepareTimer);
    readerPrepareTimer = setTimeout(async () => {
      readerPrepareTimer = null;
      if (wc.isDestroyed()) return;
      const currentUrl = wc.getURL();
      if (readerDocumentKey(currentUrl) !== documentId) return;
      try {
        const state = await require('./reader-mode.cjs').ensureContinuousReader(wc);
        if (state?.supported && state.mode === 'Long Strip') preparedReaderDocument = documentId;
      } catch (error) {
        emit('harvestts-error', { id:tab.id, message:error.message || String(error), url:currentUrl });
      }
    }, 220);
  };
  const update = () => {
    tab.url = wc.getURL() || tab.url;
    tab.title = wc.getTitle() || tab.title;
    emitHarvestTs();
    scheduleHarvestTabsSave();
  };
  wc.on('did-start-loading', () => { ensureHarvestImageStore(); clearOfflineRestore(); tab.offlineOverlayDocument=''; update(); });
  wc.on('did-start-navigation', (details, url, isInPlace, isMainFrame) => {
    ensureHarvestImageStore();
    const target=details.url||url,mainFrame=details.isMainFrame??isMainFrame,sameDocument=details.isSameDocument??isInPlace;
    if(mainFrame===false)return;
    const translation=harvestTranslationJobFor(tab);
    if(translation?.running&&target&&(!sameDocument||!sameHarvestTranslationPage(translation.sourceUrl||wc.getURL(),target))) {
      cancelHarvestTranslationJob(tab,true).catch(()=>{});
    }
  });
  wc.on('did-stop-loading', update);
  wc.on('page-title-updated', update);
  wc.on('did-navigate', (_event, url) => {
    update();
    scheduleContinuousReader(url || wc.getURL());
  });
  wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    update();
    if (isMainFrame !== false) {
      scheduleContinuousReader(url || wc.getURL());
      if (!tab.skipNextHistory) queueHarvestHistory(url || wc.getURL(), wc.getTitle());
    }
  });
  wc.on('did-finish-load', () => {
    if(tab.kind==='web')wc.setZoomFactor(normalizeHarvestZoom(tab.zoomFactor||1));
    applyHarvestBlocks(tab).catch(() => {});
    scheduleContinuousReader(wc.getURL());
    if(tab.kind==='web')scheduleOfflineRestore(520);
    if (tab.skipNextHistory) tab.skipNextHistory = false;
    else queueHarvestHistory(wc.getURL() || tab.url, wc.getTitle() || tab.title);
    scheduleHarvestTabsSave();
  });
  wc.once('destroyed', () => { if (readerPrepareTimer) clearTimeout(readerPrepareTimer); readerPrepareTimer = null; clearOfflineRestore(); });
  wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3) emit('harvestts-error', { id: tab.id, code, message: description, url });
    update();
  });
  wc.on('before-mouse-event',(event,mouse)=>{
    if(tab.kind!=='web'||mouse?.type!=='mouseWheel')return;
    const mods=Array.isArray(mouse.modifiers)?mouse.modifiers.map(x=>String(x).toLowerCase()):[];
    if(!mods.includes('control'))return;
    const delta=Number(mouse.deltaY ?? mouse.wheelTicksY ?? 0);if(!delta)return;
    event.preventDefault();
    const now=Date.now();if(now-Number(tab.lastZoomWheelAt||0)<70)return;tab.lastZoomWheelAt=now;
    stepHarvestZoom(tab,delta<0?1:-1);
  });
  wc.on('before-input-event', (event, input) => {
    if(tab.kind==='web'&&input?.type==='mouseWheel'){
      const mods=Array.isArray(input.modifiers)?input.modifiers.map(x=>String(x).toLowerCase()):[];
      if(input.control||mods.includes('control')||mods.includes('ctrl')){
        const delta=Number(input.deltaY ?? input.wheelTicksY ?? 0);
        if(delta){event.preventDefault();const now=Date.now();if(now-Number(tab.lastZoomWheelAt||0)>=70){tab.lastZoomWheelAt=now;stepHarvestZoom(tab,delta<0?1:-1);}return;}
      }
    }
    if (screenshotInput(event, input)) return;
    const key = String(input.key || '').toLowerCase();
    if (input.control && !input.alt && ['+','=','add'].includes(key) && tab.kind==='web') {
      event.preventDefault();stepHarvestZoom(tab,1);return;
    }
    if (input.control && !input.alt && ['-','subtract'].includes(key) && tab.kind==='web') {
      event.preventDefault();stepHarvestZoom(tab,-1);return;
    }
    if (input.control && !input.alt && key==='0' && tab.kind==='web') {
      event.preventDefault();stepHarvestZoom(tab,0);return;
    }
    if (input.control && ['l','t','w'].includes(key)) {
      event.preventDefault();
      emit('harvestts-shortcut', { key });
      return;
    }
    if (input.control && key === 'r') {
      event.preventDefault();
      wc.isLoading() ? wc.stop() : wc.reload();
      return;
    }
    if (input.control && key === 'd' && tab.kind === 'web') {
      event.preventDefault();
      emit('harvestts-menu-action',{action:'bookmark'});
      return;
    }
    if (input.control && key === 's' && tab.kind === 'web') {
      event.preventDefault();
      harvestContextSavePage(tab).catch(error=>emit('harvestts-error',{id:tab.id,message:error.message,url:wc.getURL()}));
      return;
    }
    if (input.control && key === 'p' && tab.kind === 'web') {
      event.preventDefault();
      wc.print({silent:false,printBackground:true});
      return;
    }
    if (key === 'f11' && !input.control && !input.alt && !input.shift) {
      event.preventDefault();
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
      return;
    }
    if (input.control && input.shift && key === 'c' && tab.kind === 'web') {
      event.preventDefault();
      if(!wc.isDevToolsOpened()) wc.openDevTools({mode:'detach'});
      return;
    }
    if (input.alt && key === 'arrowleft' && wc.navigationHistory?.canGoBack?.()) { event.preventDefault(); wc.navigationHistory.goBack(); return; }
    if (input.alt && key === 'arrowright' && wc.navigationHistory?.canGoForward?.()) { event.preventDefault(); wc.navigationHistory.goForward(); }
  });
  wc.on('context-menu',(event,params)=>{
    if(tab.kind!=='web') return;
    event.preventDefault();
    (async()=>{
      const enriched={...params};
      if(!String(enriched.selectionText||'').trim()){
        enriched.selectionText=await wc.executeJavaScript('String(getSelection()?.toString?.()||"")').catch(()=> '');
      }
      await showHarvestContextMenu(tab,enriched);
    })().catch(()=>{});
  });
  wc.setWindowOpenHandler(({ url }) => {
    try { createHarvestTsTab({ url, activate: true }); } catch {}
    return { action: 'deny' };
  });
}
function createHarvestTsTab(input = {}) {
  const id = `harvest-${++harvestTsCounter}`;
  const kind = ['history','downloads','offline','offline-reader'].includes(input.kind) ? input.kind : 'web';
  const internalFile = kind === 'history' ? 'history.html' : kind === 'downloads' ? 'downloads.html' : kind === 'offline' ? 'offline.html' : kind === 'offline-reader' ? 'offline-reader.html' : '';
  let projectId=String(input.projectId||'');if(!projectId&&kind==='offline-reader'&&input.url){try{projectId=new URL(input.url).searchParams.get('id')||''}catch{}}
  const internalBase = internalFile ? pathToFileURL(path.join(__dirname, internalFile)).href : '';
  const url = internalFile ? (kind==='offline-reader'?internalBase+'?id='+encodeURIComponent(projectId):internalBase) : normalizeHarvestTsURL(input.url || 'https://www.google.com/');
  const internal = kind !== 'web';
  const view = new BrowserView({
    webPreferences: {
      partition: internal ? 'harvest-internal' : 'persist:harvestts',
      preload: internal ? path.join(__dirname, 'harvest-internal-preload.cjs') : path.join(__dirname, 'harvest-guest-preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  });
  const zoomFactor=normalizeHarvestZoom(input.zoomFactor),restoreEntries=kind==='web'&&Array.isArray(input.navigationHistory)?input.navigationHistory.filter(e=>e&&/^https?:\/\//i.test(e.url||'')).slice(0,120).map(e=>({url:String(e.url),title:String(e.title||e.url)})):[];
  const restoreIndex=Math.max(0,Math.min(Math.max(0,restoreEntries.length-1),Number(input.navigationIndex)||0));
  const tab = { id, kind, view, url, projectId, zoomFactor, title: kind === 'history' ? 'History' : kind === 'downloads' ? 'Downloads' : kind === 'offline' ? 'Offline' : kind === 'offline-reader' ? 'Offline Reader' : 'แท็บใหม่', skipNextHistory:input.restored === true };
  if(kind==='web'){
    tab.imageStore=new ElectronImageStore(view.webContents,path.join(app.getPath('temp'),'ImageHarvest',`harvestts-responses-${process.pid}-${id}-${Date.now()}`));
    tab.imageStoreReady=Promise.resolve(false);
  }
  harvestTsTabs.set(id, tab);
  bindHarvestTs(tab);
  if(kind==='web')view.webContents.setZoomFactor(zoomFactor);
  if (input.activate !== false || !activeHarvestTsId) activeHarvestTsId = id;
  const navigation=view.webContents.navigationHistory;
  const removeBootstrapHistory=()=>{try{const entries=navigation?.getAllEntries?.()||[];for(let i=entries.length-1;i>=0;i--)if(entries[i]?.url==='about:blank')navigation.removeEntryAtIndex(i);}catch{}};
  const loadTarget=async()=>{
    if(restoreEntries.length&&navigation?.restore){
      // navigationHistory.restore must run on a fresh WebContents; navigating
      // to a bootstrap page first collapses the restored stack to one entry.
      await navigation.restore({entries:restoreEntries,index:restoreIndex});
      return;
    }
    if(kind==='web'&&tab.imageStore){
      await view.webContents.loadURL('about:blank');
      await Promise.resolve(tab.imageStoreReady).catch(()=>false);
    }
    await view.webContents.loadURL(url);
    removeBootstrapHistory();
  };
  tab.bootstrapReady=loadTarget().catch(error=>{
    emit('harvestts-error',{id,message:(restoreEntries.length?'กู้ประวัติแท็บไม่ได้: ':'')+(error.message||String(error)),url});
    if(restoreEntries.length)return view.webContents.loadURL(url).then(removeBootstrapHistory).catch(()=>{});
  });
  applyHarvestTsView();
  if (input.skipEmit !== true) emitHarvestTs();
  if (input.skipSave !== true) scheduleHarvestTabsSave();
  return harvestTsSnapshot();
}
async function switchHarvestTsTab(input = {}) {
  const id = String(input.id || '');
  if (!harvestTsTabs.has(id)) throw new Error('ไม่พบแท็บ HarvestTS');
  if (harvestBlockManagerKind==='harvestts' && harvestBlockManagerTabId && harvestBlockManagerTabId !== id) await cancelHarvestBlockManagerDraft();
  activeHarvestTsId = id;
  applyHarvestTsView();
  emitHarvestTs();
  scheduleHarvestTabsSave();
  return harvestTsSnapshot();
}
async function closeHarvestTsTab(input = {}) {
  const id = String(input.id || '');
  const tab = harvestTsTabs.get(id);
  if (!tab) return harvestTsSnapshot();
  if (harvestBlockManagerKind==='harvestts' && harvestBlockManagerTabId === id) await cancelHarvestBlockManagerDraft();
  const ids = [...harvestTsTabs.keys()], index = ids.indexOf(id);
  await cancelHarvestTranslationJob(tab, true).catch(() => {});
  await stopHarvestScreenLens(tab).catch(() => {});
  await tab.imageStore?.close().catch(() => {});
  harvestTsTabs.delete(id);
  if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  if (activeHarvestTsId === id) {
    activeHarvestTsId = ids[index + 1] && harvestTsTabs.has(ids[index + 1]) ? ids[index + 1] : ids[Math.max(0, index - 1)] || null;
  }
  if (!activeHarvestTsId && !harvestTsTabs.size) {
    const result = createHarvestTsTab();
    scheduleHarvestTabsSave();
    return result;
  }
  applyHarvestTsView();
  emitHarvestTs();
  scheduleHarvestTabsSave();
  return harvestTsSnapshot();
}
async function navigateHarvestTs(input = {}) {
  const tab = harvestTsTabs.get(String(input.id || activeHarvestTsId));
  if (!tab) throw new Error('ไม่พบแท็บ HarvestTS');
  if (harvestBlockManagerKind==='harvestts' && harvestBlockManagerTabId === tab.id) await cancelHarvestBlockManagerDraft();
  const url = normalizeHarvestTsURL(input.url);
  tab.url = url;
  tab.view.webContents.loadURL(url).catch(error => emit('harvestts-error', { id: tab.id, message: error.message, url }));
  scheduleHarvestTabsSave();
  return harvestTsSnapshot();
}
async function harvestTsAction(input = {}) {
  const tab = harvestTsTabs.get(String(input.id || activeHarvestTsId));
  if (!tab) throw new Error('ไม่พบแท็บ HarvestTS');
  if (harvestBlockManagerKind==='harvestts' && harvestBlockManagerTabId === tab.id && ['back','forward','reload','home'].includes(input.action)) await cancelHarvestBlockManagerDraft();
  const wc = tab.view.webContents,nav=wc.navigationHistory;
  if (input.action === 'back' && (tab.kind==='web'?nav?.canGoBack?.():wc.canGoBack())) (tab.kind==='web'?nav:wc).goBack();
  else if (input.action === 'forward' && (tab.kind==='web'?nav?.canGoForward?.():wc.canGoForward())) (tab.kind==='web'?nav:wc).goForward();
  else if (input.action === 'reload') wc.isLoading() ? wc.stop() : wc.reload();
  else if (input.action === 'home') wc.loadURL('https://www.google.com/').catch(() => {});
  else if (input.action === 'zoom-in') stepHarvestZoom(tab,1);
  else if (input.action === 'zoom-out') stepHarvestZoom(tab,-1);
  else if (input.action === 'zoom-reset') stepHarvestZoom(tab,0);
  emitHarvestTs();
  scheduleHarvestTabsSave();
  return harvestTsSnapshot();
}
async function harvestTsLayout(input = {}) {
  if (input.bounds) harvestTsBounds = sanitizeHarvestTsBounds(input.bounds);
  if (typeof input.visible === 'boolean') harvestTsVisible = input.visible;
  if (harvestTsVisible && !harvestTsTabs.size) await restoreHarvestTabsIfNeeded();
  applyHarvestTsView();
  if (harvestTsVisible && !harvestTsTabs.size) return createHarvestTsTab();
  return harvestTsSnapshot();
}
async function harvestTsOpenHistory() {
  const existing = [...harvestTsTabs.values()].find(tab => tab.kind === 'history' && !tab.view.webContents.isDestroyed());
  if (existing) return switchHarvestTsTab({ id:existing.id });
  return createHarvestTsTab({ kind:'history', activate:true });
}
async function harvestTsOpenDownloads() {
  const existing = [...harvestTsTabs.values()].find(tab => tab.kind === 'downloads' && !tab.view.webContents.isDestroyed());
  if (existing) return switchHarvestTsTab({ id:existing.id });
  return createHarvestTsTab({ kind:'downloads', activate:true });
}
async function harvestTsOpenOffline() {
  const existing=[...harvestTsTabs.values()].find(tab=>tab.kind==='offline'&&!tab.view.webContents.isDestroyed());
  if(existing)return switchHarvestTsTab({id:existing.id});
  return createHarvestTsTab({kind:'offline',activate:true});
}
async function harvestTsOpenOfflineReader(id) {
  const saved=await harvestOfflineReadProject(String(id||''));
  const existing=[...harvestTsTabs.values()].find(tab=>tab.kind==='offline-reader'&&tab.projectId===saved.project.id&&!tab.view.webContents.isDestroyed());
  if(existing)return switchHarvestTsTab({id:existing.id});
  return createHarvestTsTab({kind:'offline-reader',projectId:saved.project.id,activate:true});
}
function harvestTsPopupMenu(input = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('หน้าต่างหลักไม่พร้อม');
  const tab = activeHarvestTsTab();
  const menu = Menu.buildFromTemplate([
    { label:'↶ History', click:()=>{ harvestTsOpenHistory().catch(()=>{}); } },
    { label:'↓ Downloads', click:()=>{ harvestTsOpenDownloads().catch(()=>{}); } },
    { label:'▣ Offline Library', click:()=>{ harvestTsOpenOffline().catch(()=>{}); } },
    { label:'▤ Save Offline', enabled:Boolean(tab&&tab.kind==='web'), click:()=>{ harvestOfflineSave(tab).then(row=>emit('harvestts-offline-saved',{tabId:tab.id,title:row.title,pages:row.pages})).catch(error=>emit('harvestts-error',{id:tab?.id,message:error.message,url:tab?.view?.webContents?.getURL?.()||''})); } },
    { label:'☆ Bookmark', enabled:Boolean(tab), click:()=>emit('harvestts-menu-action',{action:'bookmark'}) },
    { label:'⌘ Password', enabled:Boolean(tab), click:()=>emit('harvestts-menu-action',{action:'password'}) },
    { label:'▱ Block element', enabled:Boolean(tab), click:()=>emit('harvestts-menu-action',{action:'block-element'}) },
    { type:'separator' },
    { label:`Zoom ${Math.round(normalizeHarvestZoom(tab?.zoomFactor||1)*100)}%`, enabled:Boolean(tab&&tab.kind==='web'), submenu:[
      {label:'− Zoom out',accelerator:'CmdOrCtrl+-',click:()=>stepHarvestZoom(tab,-1)},
      {label:'100% Reset zoom',accelerator:'CmdOrCtrl+0',click:()=>stepHarvestZoom(tab,0)},
      {label:'+ Zoom in',accelerator:'CmdOrCtrl+=',click:()=>stepHarvestZoom(tab,1)}
    ]},
    { type:'separator' },
    {
      label:'บันทึกประวัติการเข้าเว็บ',
      type:'checkbox',
      checked:harvestBrowserRuntime.historyEnabled !== false,
      click:item=>{ harvestTsBrowserSettingsSet({historyEnabled:item.checked}).catch(()=>{}); }
    },
    {
      label:'เปิดแท็บเดิมเมื่อเปิดแอป',
      type:'checkbox',
      checked:harvestBrowserRuntime.restoreTabs !== false,
      click:item=>{ harvestTsBrowserSettingsSet({restoreTabs:item.checked}).catch(()=>{}); }
    },
    { type:'separator' },
    { label:'🧩 Extensions', click:()=>emit('harvestts-menu-action',{action:'extensions'}) },
    { label:'◉ DNS & Privacy', click:()=>emit('harvestts-menu-action',{action:'dns'}) }
  ]);
  const area = mainWindow.getContentBounds();
  const x = Math.max(0, Math.min(area.width - 20, Math.round(Number(input.x) || area.width - 220)));
  const y = Math.max(0, Math.min(area.height - 20, Math.round(Number(input.y) || 90)));
  menu.popup({ window:mainWindow, x, y });
  if (testMode && Number(input.autoCloseMs) > 0) setTimeout(() => menu.closePopup(mainWindow), Math.min(2000, Number(input.autoCloseMs)));
  return true;
}

function emptyWorkspaceState() {
  return {
    records: new Map(), cache: new ByteCache(), pending: new Map(), failedImages: new Map(), generation: 0,
    pageInfo: { title: '', url: '' }, canvasTempDir: '', blockedHosts: new Map(), queue: Promise.resolve(),
    requestGate: 0, excludedIds: new Set(), lastRemoval: []
  };
}
function snapshotWorkspaceState() {
  return {
    records, cache, pending, failedImages, generation, pageInfo: { ...pageInfo }, canvasTempDir, blockedHosts,
    queue, requestGate, excludedIds, lastRemoval: [...lastRemoval]
  };
}
function restoreWorkspaceState(state) {
  records = state.records; cache = state.cache; pending = state.pending; failedImages = state.failedImages;
  generation = state.generation; pageInfo = { ...state.pageInfo }; canvasTempDir = state.canvasTempDir;
  blockedHosts = state.blockedHosts; queue = state.queue; requestGate = state.requestGate;
  excludedIds = state.excludedIds; lastRemoval = [...state.lastRemoval];
}
function workspaceId(input) {
  const id = String(input?.id || '');
  if (!/^tab-[1-9][0-9]{0,3}$/.test(id)) throw new Error('รหัสแท็บไม่ถูกต้อง');
  return id;
}
async function switchWorkspace(input = {}) {
  ensureIdle();
  const id = workspaceId(input);
  if (id === activeWorkspaceId) return { id, title: pageInfo.title, url: pageInfo.url, count: records.size - excludedIds.size, browserURL: webURL() };
  if (pending.size) await withTimeout(Promise.allSettled([...pending.values()]), 4000, 'รอภาพตัวอย่างให้เสร็จก่อนสลับแท็บ');
  workspaceStates.set(activeWorkspaceId, snapshotWorkspaceState());
  activeWorkspaceId = id;
  restoreWorkspaceState(workspaceStates.get(id) || emptyWorkspaceState());
  return { id, title: pageInfo.title, url: pageInfo.url, count: records.size - excludedIds.size, browserURL: webURL() };
}
async function closeWorkspace(input = {}) {
  ensureIdle();
  const id = workspaceId(input);
  if (id === activeWorkspaceId) throw new Error('ต้องสลับไปแท็บอื่นก่อนปิดแท็บนี้');
  const state = workspaceStates.get(id);
  workspaceStates.delete(id);
  if (state?.cache) state.cache.clear();
  if (state?.canvasTempDir) await fs.rm(state.canvasTempDir, { recursive: true, force: true }).catch(() => {});
  return { closed: true, id };
}
let collector, scrollScript, canvasCaptureScript, readerProbe;
const siteProfiles = new SiteProfiles(path.join(app.getPath('userData'), 'adaptive', 'site-profiles.json'));
const electronObserver = new SiteObserver();
function observationInfo(sources = []) {
  if (browserMode === 'chrome') return chromeBrowser.observationInfo(sources);
  electronObserver.seedScripts(sources); return electronObserver.snapshot();
}
const emit = (type, data = {}) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('eiw:event', { type, ...data });
};
const chromeProfileDir = path.join(app.getPath('userData'), 'chrome-profile');
const manualChromeLogin = new ManualChromeLogin(chromeProfileDir);
const chromeBrowser = new ChromeBrowser((type, data) => {
  if (browserMode !== 'chrome' || quitting) return;
  if (type === 'protection-compatibility') emit(type, data);
  if (type === 'navigation') {
    pageInfo.url = data.url; emit(type, data);
    if (harvestBlockManagerKind==='collector' && liveHarvestBlockManager()) cancelHarvestBlockManagerDraft().catch(()=>{});
    setTimeout(()=>{ if(browserMode==='chrome') applyCollectorBlocks().catch(()=>{}); },250);
  }
  if (type === 'browser-closed') {
    if (job) { job.cancelled = true; job.abort.abort(); }
    if (captureSession) { captureSession.cancelled = true; captureSession.abort.abort(); }
    emit('error', { message: 'หน้าต่าง Chrome ปิดแล้ว กดเปิดเว็บเพื่อเริ่มเซสชันใหม่' });
  }
}, { profileDir: chromeProfileDir, adblockCacheFile:harvestAdblockCacheFile, adblockEnabled:harvestBrowserRuntime.adblockEnabled !== false });
async function getBrowserProfile() { return chromeProfileInfo(chromeProfileDir); }
async function openBrowserLogin() {
  ensureIdle();
  if (browser && !browser.isDestroyed()) browser.hide();
  await chromeBrowser.close();
  await manualChromeLogin.open('https://accounts.google.com/');
  return { ...(await getBrowserProfile()), manualMode: true };
}
async function useBrowserProfile() {
  ensureIdle();
  await manualChromeLogin.close();
  await chromeBrowser.close();
  browserMode = 'chrome';
  await saveSettings();
  return getBrowserProfile();
}
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
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (ses === browsingSession && details.webContentsId === browser?.webContents.id && details.resourceType === 'mainFrame' && allowedWeb(details.url)) electronObserver.begin(details.url);
    if (/^(file|ftp):/i.test(details.url)) { callback({cancel:true}); return; }
    if (ses === browsingSession && harvestBrowserRuntime.adblockEnabled !== false && details.resourceType !== 'mainFrame') {
      try {
        if (harvestAdblockEngine) {
          const request=fromElectronDetails(details);
          if (harvestAdblockEngine.config.guessRequestTypeFromUrl===true && request.type==='other') request.guessTypeOfRequest();
          const result=harvestAdblockEngine.match(request);
          if (result.redirect?.dataUrl) { harvestAdblockBlockedSession += 1; callback({redirectURL:result.redirect.dataUrl}); return; }
          if (result.match) { harvestAdblockBlockedSession += 1; callback({cancel:true}); return; }
        } else if (harvestAdHost(new URL(details.url).hostname)) {
          harvestAdblockBlockedSession += 1; callback({cancel:true}); return;
        }
      } catch {}
    }
    callback({});
  });
  if (ses === browsingSession) ses.webRequest.onResponseStarted(details => {
    if (!browser || browser.isDestroyed() || details.webContentsId !== browser.webContents.id) return;
    electronObserver.response({ url: details.url, type: details.resourceType, status: details.statusCode,
      headers: details.responseHeaders, fromCache: details.fromCache, mainDocument: details.resourceType === 'mainFrame' });
  });
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
  electronImageStore?.close().catch(() => {});
  electronImageStore = new ElectronImageStore(wc, path.join(app.getPath('temp'), 'ImageHarvest', `electron-responses-${process.pid}-${Date.now()}`));
  electronImageStoreReady = Promise.resolve(false);
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (event, url) => { if (!allowedWeb(url)) event.preventDefault(); });
  wc.on('will-redirect', (event, url) => { if (!allowedWeb(url)) event.preventDefault(); });
  wc.on('will-frame-navigate', event => { if (!allowedWeb(event.url) && event.url !== 'about:blank') event.preventDefault(); });
  wc.on('did-navigate', (_event, url) => {
    if (browserMode !== 'electron') return;
    pageInfo.url = url; emit('navigation', { url });
    if (harvestBlockManagerKind==='collector' && liveHarvestBlockManager()) cancelHarvestBlockManagerDraft().catch(()=>{});
    setTimeout(()=>applyCollectorBlocks().catch(()=>{}),120);
  });
  wc.on('did-navigate-in-page', (_event, url, main) => {
    if (main && browserMode === 'electron') {
      pageInfo.url = url; emit('navigation', { url });
      setTimeout(()=>applyCollectorBlocks().catch(()=>{}),80);
    }
  });
  wc.on('did-finish-load',()=>{ if(browserMode==='electron') applyCollectorBlocks().catch(()=>{}); });
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
async function runMainPage(code, backend = browserMode) {
  if (backend === 'chrome') return chromeBrowser.evaluateMain(code);
  if (!browser || browser.isDestroyed()) throw new Error('กรุณาเปิดเว็บก่อน');
  return browser.webContents.executeJavaScript(code, true);
}
function isBookWalkerViewer(url = webURL()) {
  try { return /(^|\.)viewer\.bookwalker\.jp$/i.test(new URL(url).hostname); } catch { return false; }
}
function bookWalkerControlScript(action = 'probe') {
  return `(() => {
    const counter = document.getElementById('pageSliderCounter');
    const match = String(counter?.textContent || '').match(/(\\d+)\\s*\\/\\s*(\\d+)/);
    const current = match ? Number(match[1]) : 0, total = match ? Number(match[2]) : 0;
    const root = globalThis.NFBR?.a6G?.Initializer;
    let controller = null, key = '';
    if (root && typeof root === 'object') {
      for (const [name, value] of Object.entries(root)) {
        const candidate = value?.menu?.options?.a6l || value?.menu?.a6l;
        if (candidate && typeof candidate.moveToPage === 'function') { controller = candidate; key = name; break; }
      }
    }
    const loading = [...document.querySelectorAll('.loading')].some(el => {
      const style = getComputedStyle(el), box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
    });
    if (!controller || !current || !total) return { supported:false, current, total, loading, key };
    if (${JSON.stringify(action)} === 'first') {
      if (current === 1) return { supported:true, moved:false, current, target:1, total, loading, key };
      controller.moveToPage(0);
      return { supported:true, moved:true, current, target:1, total, loading, key };
    }
    if (${JSON.stringify(action)} !== 'advance') return { supported:true, current, total, loading, key };
    if (current >= total) return { supported:true, done:true, current, total, loading, key };
    controller.moveToPage(current);
    return { supported:true, moved:true, current, target:current + 1, total, loading, key };
  })()`;
}
async function bookWalkerReader(action = 'probe') {
  if (browserMode !== 'chrome') return { supported:false };
  try { return await runMainPage(bookWalkerControlScript(action), 'chrome'); }
  catch { return { supported:false }; }
}
function bookWalkerCanvasScript(capture = false) {
  return `(() => {
    const match = String(document.getElementById('pageSliderCounter')?.textContent || '').match(/(\\d+)\\s*\\/\\s*(\\d+)/);
    const current = match ? Number(match[1]) : 0, total = match ? Number(match[2]) : 0;
    const visible = el => {
      const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
      return rect.width > 1 && rect.height > 1 && rect.bottom > 0 && rect.right > 0 &&
        rect.top < innerHeight && rect.left < innerWidth &&
        style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
    };
    const loading = [...document.querySelectorAll('.loading')].some(visible);
    const canvas = [...document.querySelectorAll('.canvasRoot canvas.default, .canvasRoot canvas')]
      .filter(el => el.width > 1 && el.height > 1 && visible(el))
      .sort((a, b) => (b.width * b.height) - (a.width * a.height))[0] || null;
    if (!current || !total || !canvas) return { supported:false, current, total, loading, canvas:false };
    const rect = canvas.getBoundingClientRect();
    let signature = '', sampled = false;
    try {
      const sample = document.createElement('canvas'); sample.width = 24; sample.height = 24;
      const ctx = sample.getContext('2d', { willReadFrequently:true });
      ctx.drawImage(canvas, 0, 0, 24, 24);
      const pixels = ctx.getImageData(0, 0, 24, 24).data;
      let hash = 2166136261 >>> 0, painted = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2], a = pixels[i + 3];
        if (a || r || g || b) painted++;
        hash ^= r; hash = Math.imul(hash, 16777619);
        hash ^= g; hash = Math.imul(hash, 16777619);
        hash ^= b; hash = Math.imul(hash, 16777619);
        hash ^= a; hash = Math.imul(hash, 16777619);
      }
      signature = canvas.width + 'x' + canvas.height + ':' + (hash >>> 0).toString(16) + ':' + painted;
      sampled = true;
    } catch {}
    const base = { supported:true, current, total, loading, canvas:true, sampled, signature,
      width:canvas.width, height:canvas.height, displayWidth:Math.round(rect.width), displayHeight:Math.round(rect.height) };
    if (!${capture ? 'true' : 'false'}) return base;
    try {
      const data = canvas.toDataURL('image/png');
      return { ...base, data };
    } catch (error) {
      return { ...base, error:error?.name === 'SecurityError' ? 'Canvas ถูก browser ป้องกันการอ่านพิกเซล' : (error?.message || 'อ่าน Canvas ไม่สำเร็จ') };
    }
  })()`;
}
async function bookWalkerCanvasState(capture = false) {
  if (browserMode !== 'chrome') return { supported:false };
  try { return await runMainPage(bookWalkerCanvasScript(capture), 'chrome'); }
  catch { return { supported:false }; }
}
async function waitForBookWalkerPageReady(targetPage, state) {
  const deadline = Date.now() + Math.max(30000, state.intervalMs * 20);
  let wanted = Number(targetPage) || 0, lastSignature = '', stable = 0, lastInfo = null;
  while (!state.cancelled && !state.abort.signal.aborted && Date.now() < deadline) {
    const info = await bookWalkerCanvasState(false);
    lastInfo = info;
    if (!wanted && info.current) wanted = info.current;
    if (info.supported && info.current === wanted && !info.loading && info.canvas && info.sampled && info.signature) {
      if (info.signature === lastSignature) stable++;
      else { lastSignature = info.signature; stable = 1; }
      if (stable >= 3) {
        state.bookWalkerReady = { current:info.current, signature:info.signature };
        return info;
      }
    } else {
      stable = 0; lastSignature = '';
    }
    await delay(160);
  }
  const page = wanted || lastInfo?.current || '?';
  throw new Error('BookWalker โหลดหน้า ' + page + ' ไม่เสร็จภายใน 30 วินาที');
}
async function waitForBookWalkerPageChange(fromPage, state) {
  const deadline = Date.now() + Math.max(30000, state.intervalMs * 20);
  let targetPage = 0, lastSignature = '', stable = 0, lastInfo = null;
  while (!state.cancelled && !state.abort.signal.aborted && Date.now() < deadline) {
    const info = await bookWalkerCanvasState(false);
    lastInfo = info;
    if (!targetPage && info.current && info.current !== fromPage) targetPage = info.current;
    if (targetPage && info.supported && info.current === targetPage && !info.loading && info.canvas && info.sampled && info.signature) {
      if (info.signature === lastSignature) stable++;
      else { lastSignature = info.signature; stable = 1; }
      if (stable >= 3) {
        state.bookWalkerReady = { current:info.current, signature:info.signature };
        return info;
      }
    } else {
      stable = 0; lastSignature = '';
    }
    await delay(160);
  }
  const page = targetPage || lastInfo?.current || fromPage + 1;
  throw new Error('BookWalker โหลดหน้า ' + page + ' ไม่เสร็จภายใน 30 วินาที');
}
function nextChapterPageSnapshot() {
  const trim = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 220);
  const links = [];
  for (const node of document.querySelectorAll('a[href], link[rel~="next"]')) {
    const href = node.href || node.getAttribute('href') || '', rel = node.getAttribute('rel') || '';
    const text = trim(node.textContent), aria = trim(node.getAttribute('aria-label')), title = trim(node.getAttribute('title'));
    const id = trim(node.id), className = trim(typeof node.className === 'string' ? node.className : '');
    const parentText = trim(node.parentElement?.textContent);
    const desc = trim([...node.querySelectorAll('svg,title,use')].map(x => [x.getAttribute('aria-label'), x.getAttribute('title'), x.textContent, x.getAttribute('href'), x.getAttribute('xlink:href'), x.getAttribute('class')].filter(Boolean).join(' ')).join(' '));
    const onclick = trim(node.getAttribute('onclick'));
    const disabled = Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true' ||
      /(?:^|\s)disabled(?:\s|$)|cursor-not-allowed|pointer-events-none/i.test(className));
    const data = Object.fromEntries([...node.attributes].filter(x => x.name.startsWith('data-')).slice(0, 20).map(x => [x.name, trim(x.value)]));
    let sibling = false;
    try {
      const current = new URL(location.href), target = new URL(href, location.href);
      if (current.hostname === target.hostname) {
        const a = decodeURIComponent(current.pathname).split('/').filter(Boolean), b = decodeURIComponent(target.pathname).split('/').filter(Boolean);
        if (a.length === b.length) {
          const changed = a.map((x,i) => x === b[i] ? -1 : i).filter(i => i >= 0);
          if (changed.length === 1) {
            const i = changed[0], x = a[i], y = b[i];
            let common = 0; while (common < x.length && common < y.length && x[common] === y[common]) common++;
            sibling = (/\d/.test(x) && /\d/.test(y) && (a.length >= 2 || common >= 12));
          }
        }
      }
    } catch {}
    const hint = [href, rel, text, aria, title, id, className, parentText, desc].join(' ');
    const chapterIconNav = /(?:chevron|arrow)[-_ ]?(?:right|left)|feather-(?:chevron|arrow)-(?:right|left)/i.test(desc) &&
      /\/chapter\//i.test(href);
    if (!sibling && !chapterIconNav && !/next|chapter|chap|episode|ตอน|ถัด|ต่อไป|次|下一|다음/i.test(hint)) continue;
    links.push({ href, rel, text, aria, title, id, className, parentText, desc, onclick, data, disabled, sibling });
    if (links.length >= 500) break;
  }
  const controls = [];
  for (const node of document.querySelectorAll('button,[role="button"]')) {
    const text = trim(node.textContent), aria = trim(node.getAttribute('aria-label')), title = trim(node.getAttribute('title'));
    const id = trim(node.id), className = trim(typeof node.className === 'string' ? node.className : '');
    const desc = trim([...node.querySelectorAll('svg,title,use')].map(x => [x.getAttribute('aria-label'), x.getAttribute('title'), x.textContent, x.getAttribute('href'), x.getAttribute('xlink:href'), x.getAttribute('class')].filter(Boolean).join(' ')).join(' '));
    const onclick = trim(node.getAttribute('onclick'));
    const disabled = Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true' ||
      /(?:^|\s)disabled(?:\s|$)|cursor-not-allowed|pointer-events-none/i.test(className));
    const data = Object.fromEntries([...node.attributes].filter(x => x.name.startsWith('data-')).slice(0, 20).map(x => [x.name, trim(x.value)]));
    const hint = [text, aria, title, id, className, desc, onclick, ...Object.values(data)].join(' ');
    if (!/next|prev|chapter|chap|episode|ตอน|ถัด|ก่อน|arrow|chevron|話|章|回|다음|이전/i.test(hint)) continue;
    controls.push({ text, aria, title, id, className, desc, onclick, data, disabled });
    const href = data['data-href'] || data['data-url'] || data['data-next'] || node.getAttribute('formaction') || '';
    if (href) links.push({ href, rel:'', text, aria, title, id, className, parentText:trim(node.parentElement?.textContent), desc, onclick, data, disabled, sibling:false });
    if (controls.length >= 200) break;
  }
  const selects = [];
  for (const select of document.querySelectorAll('select')) {
    const label = trim([select.id, select.name, select.className, select.getAttribute('aria-label'), select.getAttribute('title')].join(' '));
    const options = [...select.options].slice(0, 500).map((option, index) => ({ index, text: trim(option.textContent), value: option.value, selected: option.selected }));
    const selected = options.find(x => x.selected), strong = /chapter|chap|episode|ตอน|話|章|回|화|회/i.test(label + ' ' + options.slice(0, 20).map(x => x.text).join(' '));
    const numericSelected = /^\s*\d+(?:(?:\.|-|_)\d+)*\s*$/.test(selected?.text || '') || /^\s*\d+(?:(?:\.|-|_)\d+)*\s*$/.test(selected?.value || '');
    if (!strong && !numericSelected) continue;
    selects.push({ label, selectedIndex: select.selectedIndex, options });
    if (selects.length >= 20) break;
  }
  return { url: location.href, title: document.title || '', headings: [...document.querySelectorAll('h1,h2')].slice(0, 8).map(x => trim(x.textContent)), links, selects, controls };
}
function clickSemanticNextChapterControl() {
  const compact = value => String(value || '').replace(/\s+/g, ' ').trim();
  const nextChapter = /(?:next\s*(?:chapter|chap(?:ter)?|episode|ep\.?)|(?:chapter|episode)\s*next|ตอน(?:ถัด|ต่อ)ไป|ตอนหน้า|次の(?:話|章|回)|次話|下一(?:章|话|話|回)|다음\s*(?:화|회))/i;
  const nextPage = /(?:next\s*page|page\s*next|หน้าถัดไป|หน้าต่อไป|次のページ|下一页|下一頁)/i;
  const previous = /(?:prev(?:ious)?|ก่อนหน้า|ย้อนกลับ|上一(?:章|话|話|回)|前の(?:話|章|回)|이전)/i;
  const rows = [];
  for (const node of document.querySelectorAll('a[href],button,[role="button"]')) {
    const text = compact(node.textContent), aria = compact(node.getAttribute('aria-label')), title = compact(node.getAttribute('title'));
    const id = compact(node.id), className = compact(typeof node.className === 'string' ? node.className : '');
    const desc = compact([...node.querySelectorAll('svg,title,use')].map(x => [x.getAttribute('aria-label'),x.getAttribute('title'),x.textContent,x.getAttribute('href'),x.getAttribute('xlink:href'),x.getAttribute('class')].filter(Boolean).join(' ')).join(' '));
    const direct = compact([text,aria,title,id,className,desc].join(' '));
    const rel = compact(node.getAttribute('rel')).toLowerCase(), href = node.href || node.getAttribute('href') || '';
    const disabled = Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true' ||
      /(?:^|\s)disabled(?:\s|$)|cursor-not-allowed|pointer-events-none/i.test(className));
    if (disabled || nextPage.test(direct) || previous.test(direct) || /(?:^|[-_ ])prev(?:$|[-_ ])/i.test(direct)) continue;
    let score = 0;
    if (nextChapter.test(direct)) score += 90;
    if (/(?:^|[-_ ])(?:ch|chap|chapter)[-_ ]*next(?:$|[-_ ])|next[-_ ]*(?:ch|chap|chapter)/i.test(direct)) score += 85;
    if (/(^|\s)next(\s|$)/.test(rel) && /#\/?next\/?$/i.test(href) && /(?:ch|chap|chapter)/i.test(direct)) score += 85;
    if (/\bnext\b|ถัดไป|ต่อไป|次へ|다음/i.test(direct)) score += 10;
    if (score >= 75) rows.push({ node, score, text:text || aria || title || 'ตอนถัดไป' });
  }
  rows.sort((a,b) => b.score - a.score);
  if (!rows.length) return { clicked:false };
  rows[0].node.click();
  return { clicked:true, score:rows[0].score, text:rows[0].text };
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
    await chromeBrowser.setControlMode(chromeControl);
    return chromeBrowser.open(url, protectionCompatibilityEnabled);
  }
  const win = createBrowser();
  if (electronImageStore && !electronImageStore.installed) {
    await withTimeout(win.loadURL('about:blank'), 8000, 'เตรียม Browser capture นานเกินไป');
    electronImageStoreReady = electronImageStore.install().then(() => true).catch(() => false);
    await withTimeout(electronImageStoreReady, 8000, 'เปิด Browser capture นานเกินไป');
  }
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
  if (harvestBrowserRuntime.adblockEnabled !== false) {
    await initializeHarvestAdblockEngine().catch(()=>{});
    if (mode==='chrome') {
      await chromeBrowser.setAdblockEnabled(true).catch(()=>{});
      await chromeBrowser.reloadAdblocker().catch(()=>{});
    }
  } else if (mode==='chrome') await chromeBrowser.setAdblockEnabled(false).catch(()=>{});
  const hostname = new URL(url).hostname.toLowerCase();
  if (input?.protectionCompatibility !== undefined) protectionCompatibilityEnabled = input.protectionCompatibility === true;
  if (input?.chromeControl !== undefined) {
    if (!['minimal','standard'].includes(input.chromeControl)) throw new Error('โหมด Chrome ไม่ถูกต้อง');
    chromeControl = input.chromeControl;
  }
  // BOOK☆WALKER checks navigator.webdriver. Standard Playwright exposes automation;
  // Minimal uses a non-zero loopback debug port and preserves webdriver=false.
  if (mode === 'chrome' && (hostname === 'bookwalker.jp' || hostname.endsWith('.bookwalker.jp')) && chromeControl !== 'minimal') {
    chromeControl = 'minimal';
    emit('status', { message: 'BOOK☆WALKER • สลับเป็น Chrome Minimal อัตโนมัติเพื่อให้ Viewer เปิดได้' });
  }
  busy = 'open'; browserMode = mode;
  const cachedFallback = networkMode === 'auto' ? autoFallbackHosts.get(hostname) || '' : '';
  const attempts = networkMode === 'auto' ? autoFallbackModes(cachedFallback) : [networkMode];
  let lastError, fallbackUsed = '';
  try {
    await saveSettings();
    for (let i = 0; i < attempts.length; i++) {
      const attemptMode = attempts[i];
      if (activeNetworkMode !== attemptMode) await applyNetworkRuntime(attemptMode);
      const fallback = networkMode === 'auto' && attemptMode !== 'auto';
      emit('status', { message: fallback
        ? `Smart Auto • กำลังเปิดด้วย ${attemptMode === 'cloudflare' ? 'Cloudflare' : 'Google'} DNS…`
        : (mode === 'chrome' ? 'กำลังเปิด Google Chrome ด้วยโปรไฟล์ของ ImageHarvest…' : 'กำลังเปิดเว็บไซต์…') });
      try {
        pageInfo = await openPageAttempt(url, mode, input?.show !== false);
        if (networkMode === 'auto') {
          if (fallback) { autoFallbackHosts.set(hostname, attemptMode); fallbackUsed = attemptMode; }
          else autoFallbackHosts.delete(hostname);
        }
        if (!pageInfo.title) {
          await delay(250);
          const settledTitle = await webTitle().catch(() => '');
          if (settledTitle) pageInfo.title = settledTitle;
        }
        await applyCollectorBlocks().catch(()=>{});
        const gated = /Open in Browser|403 Forbidden|Just a moment|Access Denied|Performing security verification|Verification successful|site is currently suspended/i.test(pageInfo.title);
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
async function detectNextChapter() {
  ensureIdle();
  if (!webAlive() || !allowedWeb(webURL())) throw new Error('กรุณาเปิดตอนปัจจุบันก่อน');
  busy = 'next-chapter';
  try {
    const current = webURL();
    const snapshot = await withTimeout(runPage('(' + nextChapterPageSnapshot.toString() + ')()'), 10000, 'ตรวจหาตอนถัดไปนานเกินกำหนด');
    const result = chooseNextChapter(current, snapshot || {});
    return { ...result, currentUrl: current, ...(testMode ? { debug: snapshot } : {}) };
  } finally { busy = null; }
}
async function pageChapterSignature() {
  return withTimeout(runPage(`(() => {
    const text = value => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, 500);
    return { url:location.href, title:document.title || '',
      heading:text(document.querySelector('h1,h2,.chapter-title,.entry-title,.reader-title')?.textContent) };
  })()`), 8000, 'อ่านสถานะหน้าตอนนานเกินกำหนด');
}
function stablePageURL(value) {
  try { const url = new URL(value); url.hash = ''; return url.href; } catch { return String(value || ''); }
}
async function advanceNextChapterControl() {
  ensureIdle();
  if (!webAlive() || !allowedWeb(webURL())) throw new Error('กรุณาเปิดตอนปัจจุบันก่อน');
  busy = 'next-control';
  try {
    const before = await pageChapterSignature();
    const chapterPage = await withTimeout(runPage('(' + nextChapterPageSnapshot.toString() + ')()'), 10000, 'อ่านข้อมูลตอนปัจจุบันนานเกินกำหนด');
    const indexLink = chapterIndexLink(before.url, chapterPage || {});
    const clicked = await withTimeout(runPage('(' + clickSemanticNextChapterControl.toString() + ')()'), 8000, 'กดตัวควบคุมตอนถัดไปนานเกินกำหนด');
    if (!clicked?.clicked) throw new Error('ไม่พบตัวควบคุมตอนถัดไปที่ปลอดภัยสำหรับการกด');
    const deadline = Date.now() + (indexLink ? 5000 : 15000);
    let after = before;
    while (Date.now() < deadline) {
      await delay(250);
      after = await pageChapterSignature().catch(() => after);
      const changedURL = stablePageURL(after.url) !== stablePageURL(before.url);
      const changedTitle = after.title && before.title && after.title !== before.title;
      const changedHeading = after.heading && before.heading && after.heading !== before.heading;
      if (changedURL || changedTitle || changedHeading) {
        pageInfo = { title: after.title || await webTitle(), url: webURL() };
        return { ...after, clicked:true, controlText:clicked.text || '', changedURL, changedTitle, changedHeading };
      }
    }
    if (indexLink?.url) {
      try {
        await openPageAttempt(indexLink.url, browserMode, false);
        await delay(800);
        const listing = await withTimeout(runPage('(' + nextChapterPageSnapshot.toString() + ')()'), 10000, 'อ่านหน้ารวมตอนนานเกินกำหนด');
        const candidate = nextFromChapterListing(before.url, chapterPage || {}, listing || {});
        if (candidate?.url) {
          await openPageAttempt(candidate.url, browserMode, false);
          after = await pageChapterSignature();
          const changedURL = stablePageURL(after.url) !== stablePageURL(before.url);
          const changedTitle = after.title && before.title && after.title !== before.title;
          const changedHeading = after.heading && before.heading && after.heading !== before.heading;
          if (changedURL || changedTitle || changedHeading) {
            pageInfo = { title: after.title || await webTitle(), url: webURL() };
            return { ...after, clicked:true, controlText:clicked.text || '', changedURL, changedTitle, changedHeading,
              fallback:'chapter-index', indexUrl:indexLink.url, nextText:candidate.text || '' };
          }
        }
      } catch (error) {
        await openPageAttempt(before.url, browserMode, false).catch(() => {});
        throw new Error('ปุ่มตอนถัดไปไม่เปลี่ยนหน้า และ fallback หน้ารวมตอนล้มเหลว: ' + error.message);
      }
      await openPageAttempt(before.url, browserMode, false).catch(() => {});
    }
    throw new Error('กด “ตอนถัดไป” แล้ว แต่หน้า/หัวตอนไม่เปลี่ยน และไม่พบตอนถัดไปจากหน้ารวมตอน');
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
  if (/Open in Browser|403 Forbidden|Just a moment|Access Denied|Performing security verification|Verification successful|site is currently suspended/i.test(await webTitle())) throw new Error('เว็บไซต์ยังไม่เปิดหน้าอ่าน (หน้าแจ้ง/ตรวจสอบ/ปฏิเสธการเข้าถึง) กรุณาตรวจหน้าต่างเว็บก่อนสแกน');
  const selector = String(input.selector || '').trim().slice(0, 500);
  const maxSteps = Math.max(5, Math.min(600, Number(input.maxSteps) || 150));
  const waitMs = Math.max(350, Math.min(5000, Number(input.waitMs) || 800));
  const auto = input.autoScroll !== false;
  const options = { selector, backgrounds: Boolean(input.backgrounds), canvases: Boolean(input.canvases),
    autoScroll: auto, conservativeScroll: false, smartBackgrounds: true };
  busy = 'scan'; job = { cancelled: false, abort: new AbortController() };
  await clearCollection();
  if (options.canvases) {
    canvasTempDir = path.join(app.getPath('temp'), 'ImageHarvest', `${process.pid}-${generation}-${Date.now()}`);
    await fs.mkdir(canvasTempDir, { recursive: true });
  }
  const startURL = webURL(), found = new Map(), canvasFailures = new Set(), blobFailures = new Map();
  let truncated = false, reason = '', steps = 0, previousHeight = -1, previousFound = -1, previousVerified = -1, stable = 0, metadata = {}, canvasPositionRetries = 0;
  let adaptive = null, adaptiveResult = null, adaptiveError = '';
  try {
    adaptive = new AdaptiveSession({ store: siteProfiles, url: startURL,
      mode: browserMode === 'chrome' ? `chrome-${chromeControl}` : 'electron',
      probe: () => runPage(`(${readerProbe})(${JSON.stringify({ selector })})`),
      observation: observationInfo, notify: emit });
    await adaptive.start(options);
  } catch (error) {
    adaptiveError = error.message || String(error); adaptive = null;
  }
  const scanId = randomUUID(), workspaceId = activeWorkspaceId;
  let bookWalkerProbe = null;
  if (options.canvases && browserMode === 'chrome') {
    bookWalkerProbe = await bookWalkerReader('probe');
  }
  if (bookWalkerProbe?.supported && bookWalkerProbe.total > 0) {
    emit('scan-start', { scanId, workspaceId });
    emit('status', { message: `BOOK☆WALKER • ตรวจพบตัวอ่าน ${bookWalkerProbe.current} / ${bookWalkerProbe.total} • จะเก็บครบทุกหน้า` });
    try {
      return await scanBookWalkerAllPages({ scanId, workspaceId, startURL, waitMs });
    } finally {
      job = null; busy = null;
    }
  }
  const dirty = new Map(), published = new Map(); let lastFlush = 0;
  function flushScan(force = false) {
    if (!dirty.size || (!force && dirty.size < 12 && Date.now() - lastFlush < 90)) return;
    emit('scan-items', { scanId, workspaceId, items: [...dirty.values()], count: found.size, title: metadata.title || '', url: startURL });
    dirty.clear(); lastFlush = Date.now();
  }
  function publishRecord(item, final = false) {
    item.referrer = startURL; item.backend = browserMode;
    // During scanning, preview only bytes already preserved from the browser response.
    // This avoids replaying image URLs with a different request type while the reader is still loading.
    item.previewReady = final || Boolean(item.capturePath) || item.url.startsWith('data:');
    records.set(item.id, item);
    const value = publicItem(item), signature = JSON.stringify(value);
    if (published.get(item.id) !== signature) { published.set(item.id, signature); dirty.set(item.id, value); }
    flushScan();
  }
  emit('scan-start', { scanId, workspaceId });
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
        else if (found.size < MAX_IMAGES) found.set(key, { ...item, url, id: idFor(`${activeWorkspaceId}:${generation}:${key}`), order: found.size });
        else { truncated = true; reason = 'ถึงขีดจำกัด 5,000 ภาพแล้ว'; break; }
        const record = found.get(key);
        if (browserMode === 'chrome' && record) {
          record.nativeOnly = chromeBrowser.compatibilityInfo().applied > 0;
          await preserveChromeImage(record).catch(error => { record.responseCaptureError = error.message; });
        } else if (browserMode === 'electron' && record) {
          await preserveElectronImage(record).catch(error => { record.responseCaptureError = error.message; });
        }
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
        publishRecord(record);
      }
      flushScan(true);
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
          const id = idFor(`${activeWorkspaceId}:${generation}:${key}`), capturePath = path.join(canvasTempDir, `${id}.png`);
          await fs.writeFile(capturePath, buffer, { flag: 'wx' });
          found.set(key, { ...canvas, key, url, id, order: found.size, source: 'canvas',
            label: canvas.alt ? `Canvas — ${canvas.alt}` : `Canvas ${String(canvas.captureId).padStart(3,'0')}`,
            width: captured.width, height: captured.height, capturePath, ext: typed.ext });
          publishRecord(found.get(key));
        }
      }
      flushScan(true);
      adaptive?.update([...found.values()]);
      if (options.canvases && retryCanvasPosition && canvasPositionRetries < 2) {
        canvasPositionRetries++;
        emit('scan-progress', { scanId, workspaceId, count: found.size, step: steps, maxSteps, progress: 0 });
        await delay(waitMs);
        continue;
      }
      canvasPositionRetries = 0;
      const pos = auto ? await runPage(`(${scrollScript})('status')`) : { bottom: true, progress: 1, height: 0 };
      emit('scan-progress', { scanId, workspaceId, count: found.size, step: steps, maxSteps, progress: pos.progress });
      if (!auto || truncated) break;
      const currentVerification = verification([...found.values()]);
      stable = pos.bottom && pos.height === previousHeight && found.size === previousFound &&
        currentVerification.verified === previousVerified ? stable + 1 : 0;
      previousHeight = pos.height; previousFound = found.size; previousVerified = currentVerification.verified;
      // At the bottom, require both geometry and discovered/verified image counts to stay quiet.
      // Then let Adaptive compare the current DOM against what the collector verified.
      // It may enable a discovered lazy attribute/background strategy before accepting the plateau.
      if (stable >= 3) {
        const current = [...found.values()];
        let recovered = adaptive ? await adaptive.recover(options, current, false).catch(() => false) : false;
        if (!recovered && adaptive) {
          const v = verification(current);
          const floor = Math.max(Number(adaptive.probe?.expectedTotal) || 0, adaptive.observedCandidateCount());
          if (v.verified < v.candidates || floor > v.candidates)
            recovered = await adaptive.recover(options, current, true).catch(() => false);
        }
        if (recovered) {
          stable = 0; previousHeight = -1;
          if (options.conservativeScroll) {
            await runPage(`(${scrollScript})('restore')`).catch(() => {});
            await runPage(`(${scrollScript})('init')`);
            await delay(Math.max(waitMs, 650));
          } else await delay(Math.min(waitMs, 350));
          continue;
        }
        break;
      }
      if (step === maxSteps - 1) { truncated = true; reason = 'ถึงจำนวนรอบเลื่อนที่ตั้งไว้ เพิ่มรอบแล้วสแกนใหม่ได้'; break; }
      const v = currentVerification;
      const rapid = !options.conservativeScroll && v.candidates >= 4 && v.verified === v.candidates;
      if (!pos.bottom) {
        const readyBlobs = [...found.values()].filter(x => x.url.startsWith('blob:') && x.capturePath).map(x => x.url);
        await runPage(`(${scrollScript})(${JSON.stringify({ action: 'step', readyBlobs, conservative: options.conservativeScroll === true, factor: rapid ? 1.7 : 1 })})`);
      }
      await delay(pos.bottom ? Math.max(waitMs, 650) : options.conservativeScroll ? Math.max(waitMs, 650) : rapid ? Math.min(waitMs, 320) : waitMs);
    }
    if (browserMode === 'chrome') {
      await withTimeout(chromeBrowser.settleImages(), 10000, 'รอข้อมูลภาพจาก Chrome นานเกินไป');
      for (const item of found.values()) { if (job.cancelled) break; await preserveChromeImage(item).catch(error => { item.responseCaptureError = error.message; }); }
    } else if (browserMode === 'electron' && electronImageStore) {
      await withTimeout(electronImageStore.settle(), 10000, 'รอข้อมูลภาพจาก Browser นานเกินไป');
      for (const item of found.values()) { if (job.cancelled) break; await preserveElectronImage(item).catch(error => { item.responseCaptureError = error.message; }); }
    }
    const all = orderItems([...found.values()], 'visual');
    for (const item of all) publishRecord(item, true);
    flushScan(true);
    pageInfo = { title: metadata.title || await webTitle(), url: startURL, compatibility: browserMode === 'chrome' ? chromeBrowser.compatibilityInfo() : null };
    const cancelled = job.cancelled;
    if (adaptive) {
      try { adaptiveResult = await adaptive.finish({ items: all, cancelled, truncated,
        failures: blobFailures.size + canvasFailures.size, stopReason: reason }); }
      catch (error) { adaptiveError = error.message || String(error); }
    }
    return { scanId, items: all.map(publicItem), ...pageInfo, cancelled, truncated, reason, steps, adaptive: adaptiveResult,
      notice: [pageInfo.compatibility ? `Chrome: เก็บต้นฉบับ ${all.filter(x => x.capturedVia === 'chrome-response').length} ภาพ • ใช้กฎ ${pageInfo.compatibility.applied || 0} รายการ${pageInfo.compatibility.unknown ? ' • พบระบบที่ยังไม่รู้จัก ' + pageInfo.compatibility.unknown + ' รายการ' : ''}` : '',
        adaptiveResult ? describeAdaptive(adaptiveResult) : adaptiveError ? `Adaptive: ใช้งานไม่ได้ (${adaptiveError})` : '',
        blobFailures.size ? `เก็บภาพชั่วคราวไม่สำเร็จ ${blobFailures.size} รายการ: อาจต้องสแกนใหม่` : '', metadata.frames ? `พบ iframe ${metadata.frames} ส่วน: ยังไม่สแกนภายใน iframe` : '',
        metadata.canvases ? (options.canvases ? `พบ canvas ${metadata.canvases} ส่วน: จับเฉพาะ canvas ที่วาดเสร็จและ browser อนุญาตให้อ่าน` : `พบ canvas ${metadata.canvases} ส่วน: เปิด “รวม Canvas” หากต้องการเก็บภาพที่วาดแล้ว`) : ''].filter(Boolean).join(' • ') };
  } catch (error) {
    if (adaptive && !adaptiveResult) await adaptive.finish({ items: [...found.values()], cancelled: Boolean(job?.cancelled),
      truncated, failures: blobFailures.size + canvasFailures.size, error: true, stopReason: error.message || String(error) }).catch(() => {});
    throw error;
  } finally {
    flushScan(true);
    if (auto && webAlive() && webURL() === startURL) await runPage(`(${scrollScript})('restore')`).catch(() => {});
    job = null; busy = null;
  }
}
async function preserveElectronImage(item) {
  if (item.capturePath || !electronImageStore || !/^https?:/.test(item.url)) return;
  const data = await withTimeout(electronImageStore.read(item.url), 5000, 'รอภาพจาก Browser นานเกินไป');
  if (!data) return;
  const contentHash = snapshotHash(data.buffer), dir = await ensureCaptureTempDir();
  const capturePath = path.join(dir, `electron-${contentHash}.${data.ext}`);
  try { await fs.writeFile(capturePath, data.buffer, { flag:'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  Object.assign(item, { capturePath, ext:data.ext, contentHash, capturedVia:'electron-response' });
}
async function preserveChromeImage(item) {
  if (item.capturePath || !/^https?:/.test(item.url)) return;
  const data = await withTimeout(chromeBrowser.loadedImage(item.url), 5000, 'รอภาพจาก Chrome นานเกินไป');
  if (!data) return;
  const contentHash = snapshotHash(data.buffer), dir = await ensureCaptureTempDir();
  const capturePath = path.join(dir, `chrome-${contentHash}.${data.ext}`);
  try { await fs.writeFile(capturePath, data.buffer, { flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  Object.assign(item, { capturePath, ext: data.ext, contentHash, capturedVia: 'chrome-response' });
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
  // Page-based readers can legitimately contain identical/blank/repeated pages. For those,
  // sequenceKey is the identity and content hashes are only metadata, not a reason to drop a page.
  const sequenceKey = String(candidate.sequenceKey || '');
  if (sequenceKey && state.sequenceKeys?.has(sequenceKey)) return { duplicate: true };
  if (!sequenceKey && state.hashes.has(hash)) return { duplicate: true };
  if (records.size >= MAX_IMAGES) return { full: true };
  const id = idFor(sequenceKey ? `snapshot:${sequenceKey}:${hash}` : `snapshot:${hash}`), dir = await ensureCaptureTempDir();
  const capturePath = path.join(dir, `${id}.${data.ext}`);
  try { await fs.writeFile(capturePath, data.buffer, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (sequenceKey) state.sequenceKeys?.add(sequenceKey);
  else state.hashes.add(hash);
  const item = { ...candidate, id, order: records.size, referrer: sourceURL, backend: browserMode,
    capturePath, contentHash: hash, ext: data.ext };
  records.set(id, item);
  return { item: publicItem(item) };
}
async function captureBookWalkerVisiblePage(state) {
  const sourceURL = webURL();
  let ready = await bookWalkerCanvasState(false);
  if (!ready.supported || !ready.current || !ready.total) throw new Error('BookWalker ยังไม่พร้อมจับหน้าหนังสือ');
  if (!state.bookWalkerReady || state.bookWalkerReady.current !== ready.current ||
      !ready.signature || state.bookWalkerReady.signature !== ready.signature || ready.loading) {
    ready = await waitForBookWalkerPageReady(ready.current, state);
  }
  let captured = await withTimeout(bookWalkerCanvasState(true), 20000, 'BookWalker ใช้เวลาส่งออกหน้าปัจจุบันนานเกินไป');
  if (!captured?.supported || captured.error || !captured.data) {
    throw new Error(captured?.error || 'BookWalker ไม่ส่ง Canvas ของหน้าปัจจุบัน');
  }
  if (captured.current !== ready.current || captured.loading || captured.signature !== ready.signature) {
    ready = await waitForBookWalkerPageReady(captured.current || ready.current, state);
    captured = await withTimeout(bookWalkerCanvasState(true), 20000, 'BookWalker ใช้เวลาส่งออกหน้าปัจจุบันนานเกินไป');
    if (!captured?.data || captured.error || captured.loading || captured.current !== ready.current) {
      throw new Error(captured?.error || 'BookWalker เปลี่ยน Canvas ระหว่างกำลังจับภาพ');
    }
  }
  const comma = captured.data.indexOf(',');
  if (comma < 0) throw new Error('ข้อมูล Canvas ของ BookWalker ไม่ถูกต้อง');
  const buffer = Buffer.from(captured.data.slice(comma + 1), 'base64');
  if (!buffer.length || buffer.length > MAX_IMAGE) throw new Error('ภาพหน้า BookWalker มีขนาดไม่ถูกต้อง');
  const typed = imageType(buffer, 'image/png');
  let bookId = 'book';
  try { bookId = new URL(sourceURL).searchParams.get('cid') || bookId; } catch {}
  const page = captured.current, total = captured.total;
  const digits = Math.max(4, String(total).length);
  const candidate = {
    key: `bookwalker-page:${page}`,
    sequenceKey: `bookwalker:${bookId}:page:${page}`,
    url: `canvas-capture://bookwalker/${encodeURIComponent(bookId)}/${page}`,
    source: 'canvas', top: page - 1, left: 0,
    width: captured.width, height: captured.height,
    alt: `BookWalker page ${page} / ${total}`,
    label: `BookWalker page ${String(page).padStart(digits, '0')} / ${total}`
  };
  const stored = await storeSnapshot(candidate, { buffer, ...typed }, sourceURL, state);
  state.bookWalkerReady = { current:captured.current, signature:captured.signature };
  pageInfo = { title: await webTitle().catch(() => ''), url: sourceURL };
  return {
    items: stored.item ? [stored.item] : [],
    duplicates: stored.duplicate ? 1 : 0,
    failed: 0, title: pageInfo.title, url: sourceURL,
    reader: { current:page, total }
  };
}
async function scanBookWalkerAllPages({ scanId, workspaceId, startURL, waitMs }) {
  const state = {
    get cancelled() { return Boolean(job?.cancelled); },
    abort: job.abort, intervalMs: waitMs, canvases: true,
    hashes: new Set(), sequenceKeys: new Set(), bookWalkerReady: null
  };
  let total = 0, steps = 0, reason = '';
  const initial = await waitForBookWalkerPageReady(0, state);
  total = initial.total || 0;
  const first = await bookWalkerReader('first');
  if (!first.supported) throw new Error('BookWalker ไม่พบตัวควบคุมลำดับหน้า');
  total = first.total || total;
  if (first.moved || initial.current !== 1) {
    emit('status', { message: `BOOK☆WALKER • กำลังกลับไปหน้า 1 / ${total} เพื่อเก็บให้ครบ` });
    await waitForBookWalkerPageReady(1, state);
  }
  while (!state.cancelled && !state.abort.signal.aborted) {
    let result, lastError;
    for (let attempt = 0; attempt < 3 && !result; attempt++) {
      try { result = await captureBookWalkerVisiblePage(state); }
      catch (error) {
        lastError = error;
        state.bookWalkerReady = null;
        if (attempt < 2) { await delay(300); await waitForBookWalkerPageReady(0, state); }
      }
    }
    if (!result) throw lastError || new Error('BookWalker จับหน้าปัจจุบันไม่สำเร็จ');
    steps++;
    const current = result.reader?.current || steps;
    total = result.reader?.total || total;
    if (result.items?.length) {
      emit('scan-items', { scanId, workspaceId, items: result.items, count: records.size,
        title: result.title || '', url: startURL });
    }
    emit('scan-progress', { scanId, workspaceId, count: records.size, step: current,
      maxSteps: total || current, progress: total ? current / total : 0 });
    emit('status', { message: `BOOK☆WALKER • เก็บหน้า ${current} / ${total} • ได้แล้ว ${records.size} หน้า` });
    if (current >= total) { reason = `เก็บครบ ${total} หน้าแล้ว`; break; }
    const next = await bookWalkerReader('advance');
    if (!next.supported || next.done || !next.moved) {
      throw new Error(`BookWalker เปลี่ยนจากหน้า ${current} ไปหน้าถัดไปไม่สำเร็จ`);
    }
    await waitForBookWalkerPageChange(current, state);
  }
  const title = await webTitle().catch(() => '');
  const all = [...records.values()].sort((a, b) => a.order - b.order);
  pageInfo = { title, url:startURL, compatibility: chromeBrowser.compatibilityInfo() };
  return {
    scanId, items: all.map(publicItem), ...pageInfo,
    cancelled: state.cancelled || state.abort.signal.aborted,
    truncated: false, reason, steps,
    notice: `BOOK☆WALKER: เก็บ ${all.length}${total ? ` / ${total}` : ''} หน้าเป็นภาพจาก Canvas ตามลำดับหน้า`
  };
}
async function captureVisiblePass(state) {
  const sourceURL = webURL();
  if (state.canvases && browserMode === 'chrome' && isBookWalkerViewer(sourceURL)) return captureBookWalkerVisiblePage(state);
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
async function waitForReaderChange(state) {
  const timeout = Math.max(250, state.intervalMs);
  const code = `(async () => {
    const visible = el => {
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) return false;
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
    };
    const signature = () => {
      const imgs = [...document.images].filter(visible).map(x => x.currentSrc || x.src || '').join('\\n');
      const canvases = [...document.querySelectorAll('canvas')].filter(visible)
        .map((x,i) => i + ':' + x.width + 'x' + x.height).join('\\n');
      return location.href + '\\n' + imgs + '\\n' + canvases;
    };
    const baseline = signature();
    return await new Promise(resolve => {
      let done = false, observer;
      const cleanup = () => {
        observer?.disconnect();
        removeEventListener('hashchange', onHash, true);
        removeEventListener('popstate', onPop, true);
        document.removeEventListener('load', onLoad, true);
      };
      const finish = (changed, reason) => { if (done) return; done = true; cleanup(); resolve({ changed, reason }); };
      const check = reason => { if (signature() !== baseline) finish(true, reason); };
      const onHash = () => check('hash');
      const onPop = () => check('history');
      const onLoad = event => { if (event.target instanceof HTMLImageElement) check('image-load'); };
      observer = new MutationObserver(() => check('mutation'));
      observer.observe(document.documentElement, { subtree:true, childList:true, attributes:true,
        attributeFilter:['src','srcset','style','class','hidden'] });
      addEventListener('hashchange', onHash, true); addEventListener('popstate', onPop, true);
      document.addEventListener('load', onLoad, true);
      setTimeout(() => finish(false, 'timeout'), ${timeout});
    });
  })()`;
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); resolve({ changed:false, reason:'abort' }); };
    const cleanup = () => state.abort.signal.removeEventListener('abort', onAbort);
    if (state.abort.signal.aborted) return resolve({ changed:false, reason:'abort' });
    state.abort.signal.addEventListener('abort', onAbort, { once:true });
    withTimeout(runPage(code), timeout + 5000, 'รอการเปลี่ยนหน้าไม่ตอบสนอง')
      .then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
async function runCaptureSession(state) {
  emit('capture-start', { title: await webTitle().catch(() => ''), url: webURL() });
  let reason = '';
  try {
    if (state.autoAdvanceReader && isBookWalkerViewer()) {
      try {
        const initial = await waitForBookWalkerPageReady(0, state);
        const first = await bookWalkerReader('first');
        if (!first.supported) throw new Error('BookWalker ไม่พบตัวควบคุมลำดับหน้า');
        state.readerAutoActive = true;
        if (initial.current !== 1 || first.moved) {
          emit('status', { message: `BookWalker • กลับไปหน้า 1 / ${first.total} ก่อนเริ่มเก็บให้ครบ` });
          await waitForBookWalkerPageReady(1, state);
        }
      } catch (error) {
        if (state.cancelled || state.abort.signal.aborted) return;
        state.readerAutoDisabled = true; state.lastError = error.message || String(error);
        emit('status', { message: `${state.lastError} — ใช้โหมดเปลี่ยนหน้าเองแทน` });
      }
    }
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
      if (state.autoAdvanceReader && !state.readerAutoDisabled && isBookWalkerViewer()) {
        try {
          let step = { supported:false };
          for (let attempt = 0; attempt < 5 && !step.supported && !state.cancelled; attempt++) {
            step = await bookWalkerReader('advance');
            if (!step.supported) await delay(350);
          }
          if (step.supported) {
            state.readerAutoActive = true;
            if (step.done) { reason = `BookWalker ถึงหน้าสุดท้าย ${step.total} หน้าแล้ว`; break; }
            emit('status', { message: `BookWalker • เปลี่ยนหน้า ${step.current} → ${step.target} / ${step.total} อัตโนมัติ` });
            await waitForBookWalkerPageChange(step.current, state);
            continue;
          }
          state.readerAutoDisabled = true;
          emit('status', { message: 'BookWalker: ไม่พบตัวควบคุมเปลี่ยนหน้าอัตโนมัติ — กลับเป็นโหมดกดเปลี่ยนหน้าเอง' });
        } catch (error) {
          if (state.cancelled || state.abort.signal.aborted) break;
          state.readerAutoDisabled = true; state.lastError = error.message || String(error);
          emit('status', { message: `${state.lastError} — กลับเป็นโหมดกดเปลี่ยนหน้าเอง` });
        }
      }
      try { await waitForReaderChange(state); }
      catch (error) {
        if (state.cancelled || state.abort.signal.aborted) break;
        // A full navigation destroys the old execution context; immediately inspect the new page.
        await delay(60);
      }
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
    cancelled: false, abort: new AbortController(), hashes: new Set(), sequenceKeys: new Set(), lastError: '',
    intervalMs: Math.max(250, Math.min(5000, Number(input.intervalMs) || 900)),
    selector: String(input.selector || '').trim().slice(0, 500),
    backgrounds: Boolean(input.backgrounds), canvases: input.canvases !== false,
    autoAdvanceReader: input.autoAdvanceReader !== false, readerAutoActive: false, readerAutoDisabled: false
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
  if (signal?.aborted) throw new Error('ยกเลิกการดาวน์โหลด');
  if (item.backend === 'electron' && /^https?:/.test(item.url) && electronImageStore) {
    const data = await withTimeout(electronImageStore.read(item.url), 5000, 'รอข้อมูลภาพจาก Browser นานเกินไป');
    if (signal?.aborted) throw new Error('ยกเลิกการดาวน์โหลด');
    if (data) return data;
  }
  if (item.backend === 'chrome' && /^https?:/.test(item.url)) {
    const data = await withTimeout(chromeBrowser.loadedImage(item.url), 5000, 'รอข้อมูลภาพจาก Chrome นานเกินไป');
    if (signal?.aborted) throw new Error('ยกเลิกการดาวน์โหลด');
    if (data) return data;
    if (item.nativeOnly || chromeBrowser.compatibilityInfo().applied > 0)
      throw new Error('ยังไม่มีภาพนี้ที่ Chrome โหลดสำเร็จ — เปิดหน้าอ่านให้โหลดครบแล้วสแกนใหม่ (ไม่ยิงคำขอซ้ำ)');
  }
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
  const localRecords = records, localCache = cache, localPending = pending, localFailed = failedImages, localExcluded = excludedIds;
  const item = localRecords.get(id);
  if (!item || localExcluded.has(id)) return Promise.reject(new Error('ไม่พบภาพในผลสแกนล่าสุด'));
  const cacheKey = item.capturePath ? idFor(`snapshot:${item.id}`) : idFor(item.url), hit = localCache.get(cacheKey);
  if (item.capturePath) {
    if (hit) return Promise.resolve(hit);
    return fs.readFile(item.capturePath).then(buffer => {
      const value = { buffer, ...imageType(buffer, item.ext ? `image/${item.ext}` : '') };
      localCache.set(cacheKey, value); return value;
    }).catch(() => { throw new Error('ไฟล์ภาพชั่วคราวไม่อยู่แล้ว กรุณาสแกนหรือจับหน้าใหม่'); });
  }
  if (hit) return Promise.resolve(hit);
  if (localFailed.has(cacheKey)) return Promise.reject(new Error(localFailed.get(cacheKey)));
  if (localPending.has(cacheKey)) return localPending.get(cacheKey);
  const previousQueue = queue;
  const task = previousQueue.then(async () => {
    if (signal?.aborted) throw new Error('ยกเลิกคำขอเดิม');
    const existing = localCache.get(cacheKey); if (existing) return existing;
    const value = await acquireImage(item, signal);
    localCache.set(cacheKey, value);
    return value;
  });
  queue = task.catch(() => {});
  localPending.set(cacheKey, task);
  task.then(() => { if (localPending.get(cacheKey) === task) localPending.delete(cacheKey); }, error => {
    if (localPending.get(cacheKey) === task) localPending.delete(cacheKey);
    const message = error.message || String(error);
    // A page session can still be hydrating/challenged while streaming cards are rendered.
    // Do not make transient access/server failures permanent; UI retries remain bounded.
    const retryable = /(?:HTTP (?:403|408|425|500|502|503|504)\b|หมดเวลา|ถูกตัดก่อนครบ|ECONN|ETIMEDOUT|socket|network)/i.test(message);
    if (!signal?.aborted && !retryable) localFailed.set(cacheKey, message);
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
  await fs.writeFile(path.join(app.getPath('userData'), 'settings.json'), JSON.stringify({ outputRoot, networkMode, browserMode, chromeControl, protectionCompatibility: protectionCompatibilityEnabled, compatibilitySchema: 2 }), 'utf8');
}
async function continuousLog(input = {}) {
  const sessionId = String(input.sessionId || '').replace(/[^a-z0-9-]/gi, '').slice(0, 80) || 'unknown';
  const message = String(input.message || '').replace(/[\r\n]+/g, ' ').slice(0, 800);
  const extra = { ...input }; delete extra.sessionId; delete extra.message;
  const dir = path.join(app.getPath('userData'), 'logs');
  await fs.mkdir(dir, { recursive:true });
  const line = JSON.stringify({ at:new Date().toISOString(), sessionId, message, ...extra });
  await fs.appendFile(path.join(dir, 'continuous-session.log'), line + '\r\n', 'utf8');
  return true;
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
async function numberedFolder(root, value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 99999999) throw new Error('เลขโฟลเดอร์เริ่มต้นไม่ถูกต้อง');
  const name = String(number), folder = path.join(root, name);
  try { await fs.mkdir(folder); return { folder, number }; }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`มีโฟลเดอร์เลข ${name} อยู่แล้ว กรุณาเปลี่ยนเลขเริ่มต้นหรือย้ายโฟลเดอร์เดิมก่อน`);
    throw error;
  }
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
    compatibility: pageInfo.compatibility || null, requested: items.length, naming: 'Selected UI order, zero-padded; original image bytes', files: [] };
  let folder, saved = 0, failed = 0;
  try {
    const requestedName = String(input.name || '').trim();
    const fallbackName = `${safeName(pageInfo.title || new URL(pageInfo.url).hostname)}_${date}`;
    if (input.numbered === true) {
      const numbered = await numberedFolder(outputRoot, input.folderNumber);
      folder = numbered.folder; report.folderNumber = numbered.number; report.folderMode = 'continuous-numbered';
    } else folder = await uniqueFolder(outputRoot, requestedName ? safeName(requestedName) : fallbackName);
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
        report.files.push({ index: i + 1, filename, source: item.url.startsWith('data:') ? '[embedded image]' : item.url, status: 'saved', bytes: data.buffer.length, sha256: snapshotHash(data.buffer), capturedVia: item.capturedVia || data.via || (item.capturePath ? 'snapshot' : 'download') });
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
  readerProbe = await fs.readFile(path.join(__dirname, 'reader-probe.js'), 'utf8');
  await siteProfiles.load();
  collector = await fs.readFile(path.join(__dirname, 'collector.js'), 'utf8');
  const filterSource = await fs.readFile(path.join(__dirname, 'content-filter.js'), 'utf8');
  collector = `(options => { ${filterSource}\nreturn (${collector})(options); })`;
  scrollScript = await fs.readFile(path.join(__dirname, 'scroll.js'), 'utf8');
  canvasCaptureScript = await fs.readFile(path.join(__dirname, 'canvas-capture.js'), 'utf8');
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.rm(harvestTranslationTempRoot, { recursive:true, force:true }).catch(() => {});
  await fs.mkdir(harvestTranslationTempRoot, { recursive:true });
  try {
    const value = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'settings.json'), 'utf8'));
    if (typeof value.outputRoot === 'string') outputRoot = value.outputRoot;
    networkMode = normalizeNetworkMode(value.networkMode);
  } catch {}
  browsingSession = session.fromPartition('eiw-website'); // Memory-only login session.
  secureSession(browsingSession); secureSession(session.defaultSession);
  await applyNetworkRuntime(networkMode);
  harvestBrowserRuntime = await readHarvestBrowserSettings();
  configureHarvestTsSession();
  initializeHarvestAdblockEngine().then(() => emit('harvestts-adblock-status', harvestAdblockSnapshot())).catch(() => {});
  await loadSavedHarvestExtensions();
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };
  const handleEiwRequest = async request => {
    const url = new URL(request.url);
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    // Serve persistent Offline Library page images without exposing arbitrary local files.
    if(url.host==='offline'){
      const parts=url.pathname.split('/').filter(Boolean).map(x=>decodeURIComponent(x));
      if(parts.length!==2||!/^[0-9a-f]{24}$/.test(parts[0])||path.basename(parts[1])!==parts[1])return new Response('',{status:404});
      try{
        const saved=await harvestOfflineReadProject(parts[0]),page=saved.manifest.pages.find(p=>p.file===parts[1]&&!p.error);
        if(!page)return new Response('',{status:404});
        const buffer=await fs.readFile(path.join(saved.dir,parts[1])),ext=path.extname(parts[1]).toLowerCase();
        const mime=page.mime||({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'}[ext]||'application/octet-stream');
        return new Response(buffer,{headers:{'Content-Type':mime,'Cache-Control':'private, max-age=31536000, immutable','Access-Control-Allow-Origin':'*','X-Content-Type-Options':'nosniff'}});
      }catch{return new Response('',{status:404});}
    }
    // Serve already-acquired image bytes on the UI origin for local pixel analysis only.
    // Website sessions, CORS and Canvas origin-clean rules remain unchanged.
    if (url.host === 'app' && /^image\/[a-f0-9]{24}$/.test(name)) {
      const id = name.slice(6), owner = records;
      try {
        const data = await getImage(id);
        return new Response(data.buffer, { headers: { 'Content-Type': data.mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
      } catch (error) {
        if (owner === records) emit('image-failed', { id, message: error.message, scope: 'preview' });
        return new Response('', { status: 502 });
      }
    }
    if (url.host !== 'app' || !['index.html', 'renderer.js', 'content-filter.js', 'style.css', 'history.html', 'history.css', 'history.js'].includes(name)) return new Response('Not found', { status: 404 });
    return new Response(await fs.readFile(path.join(__dirname, name)), { headers: { 'Content-Type': types[path.extname(name)] || 'text/plain' } });
  };
  protocol.handle('eiw', handleEiwRequest);
  // Custom protocol handlers are session-scoped. Offline Reader runs in the
  // isolated harvest-internal partition, so register the same read-only image
  // handler there as well or its eiw://offline images appear broken.
  session.fromPartition('harvest-internal').protocol.handle('eiw', handleEiwRequest);
  protocol.handle('eiw-image', async request => {
    const url = new URL(request.url), id = url.pathname.slice(1);
    if (url.host !== 'cache' || !/^[a-f0-9]{24}$/.test(id)) return new Response('', { status: 404 });
    try {
      const data = await getImage(id);
      return new Response(data.buffer, { headers: { 'Content-Type': data.mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    } catch (error) {
      emit('image-failed', { id, message: error.message, scope: 'preview' });
      return new Response('', { status: 502 });
    }
  });
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({ width: 1360, height: 920, minWidth: 980, minHeight: 680,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'), backgroundColor: '#10111a', title: 'ImageHarvest', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false } });
  mainWindow.setContentProtection(false); // HarvestTS must remain capturable by normal Windows screenshot tools.
  bindScreenshotWindow(mainWindow);
  registerHarvestInternalIpc();
  registerHarvestGuestIpc();
  registerHarvestBlockManagerIpc();
  registerHarvestContextMenuIpc();
  mainWindow.on('close', () => { saveHarvestTabsSync(); });
  mainWindow.on('closed', () => {
    const popup = liveHarvestBlockManager(), contextMenu = liveHarvestContextMenu();
    harvestBlockManagerWindow = null;
    harvestBlockManagerTabId = null;
    harvestContextMenuWindow = null;
    harvestContextMenuTarget = null;
    harvestContextMenuModel = null;
    if (popup) { try { popup.destroy(); } catch {} }
    if (contextMenu) { try { contextMenu.destroy(); } catch {} }
    mainWindow = null;
    app.quit();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.once('ready-to-show', () => { if (!testMode) mainWindow.show(); });
  handle('open', openPage);
  handle('showBrowser', async () => { if (browserMode === 'chrome') return chromeBrowser.show(); if (!browser) throw new Error('กรุณาเปิดเว็บก่อน'); browser.show(); browser.focus(); return true; });
  handle('collectorBlockElement', collectorBlockDraftBegin);
  handle('browserProfile', getBrowserProfile);
  handle('openBrowserLogin', openBrowserLogin);
  handle('useBrowserProfile', useBrowserProfile);
  handle('harvestTsCreate', createHarvestTsTab);
  handle('harvestTsSwitch', switchHarvestTsTab);
  handle('harvestTsClose', closeHarvestTsTab);
  handle('harvestTsNavigate', navigateHarvestTs);
  handle('harvestTsAction', harvestTsAction);
  handle('harvestTsLayout', harvestTsLayout);
  handle('harvestTsState', harvestTsSnapshot);
  handle('harvestTsPopupMenu', harvestTsPopupMenu);
  handle('harvestTsOpenHistory', harvestTsOpenHistory);
  handle('harvestTsOpenDownloads', harvestTsOpenDownloads);
  handle('ocrLabOpen', () => ocrLab.open());
  handle('harvestTsHistoryList', harvestTsHistoryList);
  handle('harvestTsHistoryRemove', harvestTsHistoryRemove);
  handle('harvestTsHistoryClear', harvestTsHistoryClear);
  handle('harvestTsBrowserSettings', harvestTsBrowserSettings);
  handle('harvestTsBrowserSettingsSet', harvestTsBrowserSettingsSet);
  handle('harvestTsBookmarks', harvestTsBookmarks);
  handle('harvestTsBookmarkModel', harvestTsBookmarkModel);
  handle('harvestTsBookmarkStatus', harvestTsBookmarkStatus);
  handle('harvestTsBookmarkAdd', harvestTsBookmarkAdd);
  handle('harvestTsBookmarkRemove', harvestTsBookmarkRemove);
  handle('harvestTsBookmarkFolderCreate', harvestTsBookmarkFolderCreate);
  handle('harvestTsBookmarkFolderRemove', harvestTsBookmarkFolderRemove);
  handle('harvestTsPasswordList', harvestTsPasswordList);
  handle('harvestTsPasswordStatus', harvestTsPasswordStatus);
  handle('harvestTsPasswordPopupMenu', harvestTsPasswordPopupMenu);
  handle('harvestTsPasswordSavePrompt', harvestTsPasswordSavePrompt);
  handle('harvestTsPasswordDismissCandidate', harvestTsPasswordDismissCandidate);
  handle('harvestTsPasswordFillById', harvestTsPasswordFillById);
  handle('harvestTsPasswordSaveCandidate', harvestTsPasswordSaveCandidate);
  handle('harvestTsPasswordSaveCurrent', harvestTsPasswordSaveCurrent);
  handle('harvestTsPasswordRemove', harvestTsPasswordRemove);
  handle('harvestTsPasswordFillCurrent', harvestTsPasswordFillCurrent);
  handle('harvestTsAdblockStatus', harvestTsAdblockStatus);
  handle('harvestTsAdblockSet', harvestTsAdblockSet);
  handle('harvestTsAdblockUpdate', harvestTsAdblockUpdate);
  handle('harvestTsExtensionList', harvestTsExtensionList);
  handle('harvestTsExtensionInstall', harvestTsExtensionInstall);
  handle('harvestTsExtensionToggle', harvestTsExtensionToggle);
  handle('harvestTsExtensionRemove', harvestTsExtensionRemove);
  handle('harvestTsDnsSettings', harvestTsDnsSettings);
  handle('harvestTsDnsSet', harvestTsDnsSet);
  handle('harvestTsDnsActivate', harvestTsDnsActivate);
  handle('harvestTsDnsDeactivate', harvestTsDnsDeactivate);
  handle('harvestTsBlockElement', harvestTsBlockElement);
  handle('harvestTsBlockList', harvestTsBlockList);
  handle('harvestTsBlockClear', harvestTsBlockClear);
  handle('harvestTsBlockDraftBegin', harvestTsBlockDraftBegin);
  handle('harvestTsBlockDraftState', harvestTsBlockDraftState);
  handle('harvestTsBlockDraftClear', harvestTsBlockDraftClear);
  handle('harvestTsBlockDraftCancel', harvestTsBlockDraftCancel);
  handle('harvestTsBlockDraftCommit', harvestTsBlockDraftCommit);
  handle('harvestTsBlockRemove', harvestTsBlockRemove);
  handle('scan', scan);
  handle('nextChapter', detectNextChapter);
  handle('advanceNextChapter', advanceNextChapterControl);
  handle('startCapture', startCaptureSession);
  handle('stopCapture', stopCaptureSession);
  handle('networkMode', changeNetworkMode);
  handle('restartForNetwork', restartForNetwork);
  handle('removeItems', removeItems);
  handle('undoRemove', undoRemove);
  handle('clearResults', clearResults);
  handle('workspaceSwitch', switchWorkspace);
  handle('workspaceClose', closeWorkspace);
  handle('continuousLog', continuousLog);
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
  handle('settings', () => ({ outputRoot, version: app.getVersion(), browserMode, chromeControl, networkMode, activeNetworkMode, compatibilityActive, protectionCompatibility: protectionCompatibilityEnabled }));
  if (testMode) global.__eiwTest = { openPage, scan, startCaptureSession, stopCaptureSession, download, getImage, changeNetworkMode, renameImages: input => renameImages(input, true), setOutput: value => { outputRoot = value; }, setRenameFolder: value => { renameFolder = value; }, runPage, closeChrome: () => chromeBrowser.close(), chromeInfo: () => ({ profile: chromeBrowser.profile, url: chromeBrowser.url(), status: chromeBrowser.lastStatus, navigation: chromeBrowser.navigation, networkMode: chromeBrowser.networkMode, compatibility: chromeBrowser.compatibilityInfo() }), getState: () => ({ browserMode, networkMode, activeNetworkMode, autoFallbackHosts: Object.fromEntries(autoFallbackHosts), compatibilityActive, captureActive: Boolean(captureSession), busy, count: records.size - excludedIds.size, excluded: excludedIds.size, canvasTempDir, browserId: browser?.webContents.id, activeWorkspaceId, storedWorkspaces: workspaceStates.size, electronCapture: electronImageStore?.info() || null }),
    harvestTranslationStart: () => { const tab = activeHarvestTsTab(); if (!tab) throw new Error('ไม่พบแท็บ HarvestTS'); return runHarvestTsTranslationJob(tab); },
    harvestTranslationScan: () => { const tab = activeHarvestTsTab(); if (!tab) throw new Error('ไม่พบแท็บ HarvestTS'); return scanHarvestTsTranslationPages(tab,{id:'test-scan-'+Date.now(),abort:new AbortController()}); },
    harvestTranslationAcquireFirst: async () => { const tab=activeHarvestTsTab(); if(!tab)throw new Error('ไม่พบแท็บ HarvestTS'); const job={id:'test-acquire-'+Date.now(),abort:new AbortController()}; const scan=await scanHarvestTsTranslationPages(tab,job); if(!scan.pages.length)throw new Error('ไม่พบหน้าทดสอบ'); const data=await acquireHarvestTsTranslationImage(tab,{...scan.pages[0],referrer:scan.startURL},job.abort.signal); return {bytes:data.buffer.length,ext:data.ext,mime:data.mime,imageStore:tab.imageStore?.info?.()||null}; },
    harvestTranslationImageStoreInfo: () => { const tab=activeHarvestTsTab(); return tab?.imageStore?.info?.()||null; },
    harvestTranslationRetry: () => retryHarvestTsTranslation(activeHarvestTsTab()),
    harvestTranslationState: () => { const tab = activeHarvestTsTab(), state = harvestTranslationJobFor(tab); return state ? { id:state.id, running:state.running, dir:state.dir, manifest:state.manifest || null } : null; },
    ocrLabAddFiles:files => ocrLab.addFiles(files),
    translationTestEndpoint:value => {harvestTranslationClient.baseUrl=value;harvestTranslationProbeCache=null;},
    harvestTranslateSettings: () => harvestTsTranslateSettings(),
    harvestTranslateSettingsUpdate: input => updateHarvestTsTranslateSettings(input),
    harvestScreenLensToggle: enabled => { const tab = activeHarvestTsTab(); if (!tab) throw new Error('ไม่พบแท็บ HarvestTS'); return enabled ? startHarvestScreenLens(tab) : stopHarvestScreenLens(tab); },
    harvestScreenLensState: () => harvestScreenLensSnapshot(activeHarvestTsTab()),
    cancel: () => { if (job) { job.cancelled = true; job.abort.abort(); } if (captureSession) stopCaptureSession(); } };
  await mainWindow.loadURL('eiw://app/');
  if(process.argv.includes('--ocr-lab'))await ocrLab.open();
}
app.whenReady().then(main).catch(error => { dialog.showErrorBox('ImageHarvest', error.stack || error.message); app.exit(1); });
app.on('before-quit', () => {
  ocrLab.close();
  saveHarvestTabsSync();
  saveHarvestDownloadsSync();
  for (const state of harvestScreenLensStates.values()) if (state?.timer) clearTimeout(state.timer);
  harvestScreenLensStates.clear();
  harvestGoogleTranslateWeb.close();
  if (printScreenRegistered) { try { globalShortcut.unregister('PrintScreen'); } catch {} printScreenRegistered = false; }
  quitting = true; if (job) job.abort.abort();
  if (captureSession) { captureSession.cancelled = true; captureSession.abort.abort(); }
  const dirs = new Set([canvasTempDir, ...[...workspaceStates.values()].map(x => x.canvasTempDir)].filter(Boolean));
  for (const dir of dirs) fs.rm(dir, { recursive:true, force:true }).catch(()=>{});
});
app.on('before-quit', event => {
  const imageStore = electronImageStore; electronImageStore = null;
  if (chromeBrowser.context || manualChromeLogin.alive() || imageStore) {
    event.preventDefault();
    Promise.allSettled([chromeBrowser.close(), manualChromeLogin.close(), imageStore?.close()]).finally(() => app.quit());
  }
});
app.on('window-all-closed', () => app.quit());
app.on('web-contents-created', (_event, contents) => { contents.on('will-attach-webview', event => event.preventDefault()); });
