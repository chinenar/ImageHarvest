'use strict';
const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');
const { ChromeBrowser } = require('../chrome-browser.cjs');
const { ManualChromeLogin } = require('../manual-chrome-login.cjs');
const { chromeProfileInfo } = require('../browser-profile.cjs');
const { ElectronImageStore } = require('../electron-image-store.cjs');
const {
  normalizeNetworkMode,
  electronResolverOptions,
  isCompatibility,
  isRetryableNetworkError,
  autoFallbackModes,
} = require('../network.cjs');
const { pageURL, delay } = require('../core.cjs');
const { fromElectronDetails } = require('@ghostery/adblocker-electron');

function createCollectorBrowser({
  collectorBlocks: collectorBlocksService,
  collectorCapture: collectorCaptureService,
  collectorCollection: collectorCollectionService,
  collectorFiles: collectorFilesService,
  blockManager: blockManagerService,
  session: sessionService,
  storage: storageService,
  host: hostService,
}) {
  let browser;

  let browsingSession;

  let busy = null;

  let job = null;

  let electronImageStore = null;

  let electronImageStoreReady = Promise.resolve(false);

  let browserMode = hostService.startupBrowserMode;

  let networkMode = hostService.startupNetworkMode;

  let activeNetworkMode = hostService.startupNetworkMode;

  const autoFallbackHosts = new Map();

  const compatibilityActive = isCompatibility(hostService.startupNetworkMode);

  const chromeProfileDir = path.join(app.getPath('userData'), 'chrome-profile');

  const manualChromeLogin = new ManualChromeLogin(chromeProfileDir);

  const chromeBrowser = new ChromeBrowser(
    (type, data) => {
      if (browserMode !== 'chrome' || hostService.quitting) return;
      if (type === 'protection-compatibility') hostService.emit(type, data);
      if (type === 'navigation') {
        collectorCollectionService.pageInfo.url = data.url;
        hostService.emit(type, data);
        if (
          blockManagerService.harvestBlockManagerKind === 'collector' &&
          blockManagerService.liveHarvestBlockManager()
        )
          blockManagerService.cancelHarvestBlockManagerDraft().catch(() => {});
        setTimeout(() => {
          if (browserMode === 'chrome')
            collectorBlocksService.applyCollectorBlocks().catch(() => {});
        }, 250);
      }
      if (type === 'browser-closed') {
        if (job) {
          job.cancelled = true;
          job.abort.abort();
        }
        if (collectorCaptureService.captureSession) {
          collectorCaptureService.captureSession.cancelled = true;
          collectorCaptureService.captureSession.abort.abort();
        }
        hostService.emit('error', {
          message: 'หน้าต่าง Chrome ปิดแล้ว กดเปิดเว็บเพื่อเริ่มเซสชันใหม่',
        });
      }
    },
    {
      profileDir: chromeProfileDir,
      adblockCacheFile: storageService.harvestAdblockCacheFile,
      adblockEnabled: sessionService.harvestBrowserRuntime.adblockEnabled !== false,
    },
  );

  async function getBrowserProfile() {
    return chromeProfileInfo(chromeProfileDir);
  }

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
    await collectorFilesService.saveSettings();
    return getBrowserProfile();
  }

  function ensureIdle() {
    if (busy || collectorCaptureService.captureSession)
      throw new Error('มีงานกำลังทำอยู่ กรุณาหยุดงานปัจจุบันก่อน');
  }

  function secureSession(ses) {
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on('will-download', (event) => event.preventDefault());
    ses.webRequest.onBeforeRequest((details, callback) => {
      if (
        ses === browsingSession &&
        details.webContentsId === browser?.webContents.id &&
        details.resourceType === 'mainFrame' &&
        hostService.allowedWeb(details.url)
      )
        collectorCollectionService.electronObserver.begin(details.url);
      if (/^(file|ftp):/i.test(details.url)) {
        callback({ cancel: true });
        return;
      }
      if (
        ses === browsingSession &&
        sessionService.harvestBrowserRuntime.adblockEnabled !== false &&
        details.resourceType !== 'mainFrame'
      ) {
        try {
          if (sessionService.harvestAdblockEngine) {
            const request = fromElectronDetails(details);
            if (
              sessionService.harvestAdblockEngine.config.guessRequestTypeFromUrl === true &&
              request.type === 'other'
            )
              request.guessTypeOfRequest();
            const result = sessionService.harvestAdblockEngine.match(request);
            if (result.redirect?.dataUrl) {
              sessionService.harvestAdblockBlockedSession += 1;
              callback({ redirectURL: result.redirect.dataUrl });
              return;
            }
            if (result.match) {
              sessionService.harvestAdblockBlockedSession += 1;
              callback({ cancel: true });
              return;
            }
          } else if (sessionService.harvestAdHost(new URL(details.url).hostname)) {
            sessionService.harvestAdblockBlockedSession += 1;
            callback({ cancel: true });
            return;
          }
        } catch {}
      }
      callback({});
    });
    if (ses === browsingSession)
      ses.webRequest.onResponseStarted((details) => {
        if (!browser || browser.isDestroyed() || details.webContentsId !== browser.webContents.id)
          return;
        collectorCollectionService.electronObserver.response({
          url: details.url,
          type: details.resourceType,
          status: details.statusCode,
          headers: details.responseHeaders,
          fromCache: details.fromCache,
          mainDocument: details.resourceType === 'mainFrame',
        });
      });
  }

  function createBrowser() {
    if (browser && !browser.isDestroyed()) return browser;
    browser = new BrowserWindow({
      width: 1060,
      height: 850,
      show: false,
      title: 'Website — ImageHarvest',
      autoHideMenuBar: true,
      webPreferences: {
        session: browsingSession,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    browser.setMenu(null);
    const wc = browser.webContents;
    electronImageStore?.close().catch(() => {});
    electronImageStore = new ElectronImageStore(
      wc,
      path.join(
        app.getPath('temp'),
        'ImageHarvest',
        `electron-responses-${process.pid}-${Date.now()}`,
      ),
    );
    electronImageStoreReady = Promise.resolve(false);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (event, url) => {
      if (!hostService.allowedWeb(url)) event.preventDefault();
    });
    wc.on('will-redirect', (event, url) => {
      if (!hostService.allowedWeb(url)) event.preventDefault();
    });
    wc.on('will-frame-navigate', (event) => {
      if (!hostService.allowedWeb(event.url) && event.url !== 'about:blank') event.preventDefault();
    });
    wc.on('did-navigate', (_event, url) => {
      if (browserMode !== 'electron') return;
      collectorCollectionService.pageInfo.url = url;
      hostService.emit('navigation', { url });
      if (
        blockManagerService.harvestBlockManagerKind === 'collector' &&
        blockManagerService.liveHarvestBlockManager()
      )
        blockManagerService.cancelHarvestBlockManagerDraft().catch(() => {});
      setTimeout(() => collectorBlocksService.applyCollectorBlocks().catch(() => {}), 120);
    });
    wc.on('did-navigate-in-page', (_event, url, main) => {
      if (main && browserMode === 'electron') {
        collectorCollectionService.pageInfo.url = url;
        hostService.emit('navigation', { url });
        setTimeout(() => collectorBlocksService.applyCollectorBlocks().catch(() => {}), 80);
      }
    });
    wc.on('did-finish-load', () => {
      if (browserMode === 'electron') collectorBlocksService.applyCollectorBlocks().catch(() => {});
    });
    wc.on('page-title-updated', (_event, title) => {
      if (browserMode === 'electron') collectorCollectionService.pageInfo.title = title;
    });
    wc.on('render-process-gone', () => {
      if (job) {
        job.cancelled = true;
        job.abort.abort();
      }
      if (collectorCaptureService.captureSession) {
        collectorCaptureService.captureSession.cancelled = true;
        collectorCaptureService.captureSession.abort.abort();
      }
      hostService.emit('error', {
        message: 'หน้าต่างเว็บหยุดทำงาน กรุณาเปิดเว็บใหม่',
      });
    });
    browser.on('close', (event) => {
      if (!hostService.quitting) {
        event.preventDefault();
        browser.hide();
      }
    });
    return browser;
  }

  function webAlive() {
    return browserMode === 'chrome'
      ? chromeBrowser.alive()
      : Boolean(browser && !browser.isDestroyed());
  }

  function webURL() {
    return browserMode === 'chrome'
      ? chromeBrowser.url()
      : browser && !browser.isDestroyed()
        ? browser.webContents.getURL()
        : '';
  }

  async function webTitle() {
    return browserMode === 'chrome'
      ? chromeBrowser.title()
      : browser && !browser.isDestroyed()
        ? browser.webContents.getTitle()
        : '';
  }

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
    await collectorFilesService.saveSettings();
    const restartRequired = isCompatibility(networkMode) !== compatibilityActive;
    if (!restartRequired) await applyNetworkRuntime(networkMode);
    return {
      mode: networkMode,
      activeMode: activeNetworkMode,
      restartRequired,
      compatibilityActive,
    };
  }

  function restartForNetwork() {
    app.relaunch();
    app.exit(0);
    return true;
  }

  async function openPageAttempt(url, mode, show = true) {
    if (mode === 'chrome') {
      if (browser && !browser.isDestroyed()) browser.hide();
      await chromeBrowser.setControlMode(hostService.chromeControl);
      return chromeBrowser.open(url, hostService.protectionCompatibilityEnabled);
    }
    const win = createBrowser();
    if (electronImageStore && !electronImageStore.installed) {
      await hostService.withTimeout(
        win.loadURL('about:blank'),
        8000,
        'เตรียม Browser capture นานเกินไป',
      );
      electronImageStoreReady = electronImageStore
        .install()
        .then(() => true)
        .catch(() => false);
      await hostService.withTimeout(
        electronImageStoreReady,
        8000,
        'เปิด Browser capture นานเกินไป',
      );
    }
    if (show !== false) win.show();
    await hostService.withTimeout(
      win.loadURL(url),
      45000,
      'เปิดเว็บนานเกินกำหนด ลองเปิดหน้าต่างเว็บเพื่อตรวจสอบ',
    );
    return {
      url: win.webContents.getURL(),
      title: win.webContents.getTitle(),
      backend: mode,
    };
  }

  function networkErrorMessage(error) {
    const raw = error?.message || String(error);
    let hint = '';
    if (/ERR_HTTP2_PROTOCOL_ERROR|HTTP2/i.test(raw))
      hint = ' • ลองเครือข่าย Compatibility แล้วรีสตาร์ตแอป';
    else if (isRetryableNetworkError(error))
      hint = ' • Auto ลอง DNS สำรองแล้ว; ลองเลือก Cloudflare หรือ Google เองได้จากเมนูเครือข่าย';
    return `เปิดเว็บไม่สำเร็จ: ${raw}${hint}`;
  }

  async function openPage(input) {
    ensureIdle();
    const url = pageURL(input?.url),
      mode = input?.backend || browserMode;
    if (!['electron', 'chrome'].includes(mode)) throw new Error('ชนิดเบราว์เซอร์ไม่ถูกต้อง');
    if (sessionService.harvestBrowserRuntime.adblockEnabled !== false) {
      await sessionService.initializeHarvestAdblockEngine().catch(() => {});
      if (mode === 'chrome') {
        await chromeBrowser.setAdblockEnabled(true).catch(() => {});
        await chromeBrowser.reloadAdblocker().catch(() => {});
      }
    } else if (mode === 'chrome') await chromeBrowser.setAdblockEnabled(false).catch(() => {});
    const hostname = new URL(url).hostname.toLowerCase();
    if (input?.protectionCompatibility !== undefined)
      hostService.protectionCompatibilityEnabled = input.protectionCompatibility === true;
    if (input?.chromeControl !== undefined) {
      if (!['minimal', 'standard'].includes(input.chromeControl))
        throw new Error('โหมด Chrome ไม่ถูกต้อง');
      hostService.chromeControl = input.chromeControl;
    }
    // BOOK☆WALKER checks navigator.webdriver. Standard Playwright exposes automation;
    // Minimal uses a non-zero loopback debug port and preserves webdriver=false.
    if (
      mode === 'chrome' &&
      (hostname === 'bookwalker.jp' || hostname.endsWith('.bookwalker.jp')) &&
      hostService.chromeControl !== 'minimal'
    ) {
      hostService.chromeControl = 'minimal';
      hostService.emit('status', {
        message: 'BOOK☆WALKER • สลับเป็น Chrome Minimal อัตโนมัติเพื่อให้ Viewer เปิดได้',
      });
    }
    busy = 'open';
    browserMode = mode;
    const cachedFallback = networkMode === 'auto' ? autoFallbackHosts.get(hostname) || '' : '';
    const attempts = networkMode === 'auto' ? autoFallbackModes(cachedFallback) : [networkMode];
    let lastError,
      fallbackUsed = '';
    try {
      await collectorFilesService.saveSettings();
      for (let i = 0; i < attempts.length; i++) {
        const attemptMode = attempts[i];
        if (activeNetworkMode !== attemptMode) await applyNetworkRuntime(attemptMode);
        const fallback = networkMode === 'auto' && attemptMode !== 'auto';
        hostService.emit('status', {
          message: fallback
            ? `Smart Auto • กำลังเปิดด้วย ${attemptMode === 'cloudflare' ? 'Cloudflare' : 'Google'} DNS…`
            : mode === 'chrome'
              ? 'กำลังเปิด Google Chrome ด้วยโปรไฟล์ของ ImageHarvest…'
              : 'กำลังเปิดเว็บไซต์…',
        });
        try {
          collectorCollectionService.pageInfo = await openPageAttempt(
            url,
            mode,
            input?.show !== false,
          );
          if (networkMode === 'auto') {
            if (fallback) {
              autoFallbackHosts.set(hostname, attemptMode);
              fallbackUsed = attemptMode;
            } else autoFallbackHosts.delete(hostname);
          }
          if (!collectorCollectionService.pageInfo.title) {
            await delay(250);
            const settledTitle = await webTitle().catch(() => '');
            if (settledTitle) collectorCollectionService.pageInfo.title = settledTitle;
          }
          await collectorBlocksService.applyCollectorBlocks().catch(() => {});
          const gated =
            /Open in Browser|403 Forbidden|Just a moment|Access Denied|Performing security verification|Verification successful|site is currently suspended/i.test(
              collectorCollectionService.pageInfo.title,
            );
          const fallbackText = fallbackUsed
            ? ` • Smart Auto: ${fallbackUsed === 'cloudflare' ? 'Cloudflare' : 'Google'} DNS`
            : '';
          const message = gated
            ? `เว็บไซต์ตอบกลับแล้ว แต่ยังอยู่ที่หน้าแจ้ง/ตรวจสอบการเข้าถึง${fallbackText}`
            : `เปิดเว็บแล้ว กดสแกนเพื่อรวบรวมภาพ${fallbackText}`;
          hostService.emit('status', { message });
          return {
            ...collectorCollectionService.pageInfo,
            gated,
            networkFallback: fallbackUsed,
            activeNetworkMode,
          };
        } catch (error) {
          lastError = error;
          if (mode === 'electron' && browser && !browser.isDestroyed()) browser.webContents.stop();
          const canRetry =
            networkMode === 'auto' && i + 1 < attempts.length && isRetryableNetworkError(error);
          if (!canRetry) throw new Error(networkErrorMessage(error));
        }
      }
      throw new Error(networkErrorMessage(lastError || new Error('ไม่สามารถเชื่อมต่อได้')));
    } finally {
      busy = null;
    }
  }
  return {
    get browser() {
      return browser;
    },
    get browsingSession() {
      return browsingSession;
    },
    set browsingSession(value) {
      browsingSession = value;
    },
    get busy() {
      return busy;
    },
    set busy(value) {
      busy = value;
    },
    get job() {
      return job;
    },
    set job(value) {
      job = value;
    },
    get electronImageStore() {
      return electronImageStore;
    },
    set electronImageStore(value) {
      electronImageStore = value;
    },
    get browserMode() {
      return browserMode;
    },
    get networkMode() {
      return networkMode;
    },
    set networkMode(value) {
      networkMode = value;
    },
    get activeNetworkMode() {
      return activeNetworkMode;
    },
    get autoFallbackHosts() {
      return autoFallbackHosts;
    },
    get compatibilityActive() {
      return compatibilityActive;
    },
    get manualChromeLogin() {
      return manualChromeLogin;
    },
    get chromeBrowser() {
      return chromeBrowser;
    },
    getBrowserProfile,
    openBrowserLogin,
    useBrowserProfile,
    ensureIdle,
    secureSession,
    webAlive,
    webURL,
    webTitle,
    runPage,
    runMainPage,
    applyNetworkRuntime,
    changeNetworkMode,
    restartForNetwork,
    openPageAttempt,
    openPage,
  };
}
module.exports = { createCollectorBrowser };
