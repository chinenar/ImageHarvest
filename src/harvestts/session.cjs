'use strict';
const { app, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { electronResolverOptions } = require('../network.cjs');
const { ElectronBlocker, Request } = require('@ghostery/adblocker-electron');

function createSession({
  collectorBrowser: collectorBrowserService,
  downloads: downloadsService,
  storage: storageService,
  host: hostService,
}) {
  const HARVEST_BROWSER_DEFAULTS = {
    adblockEnabled: true,
    dnsMode: 'inherit',
    customDoh: '',
    historyEnabled: true,
    restoreTabs: true,
  };

  let harvestBrowserRuntime = { ...HARVEST_BROWSER_DEFAULTS };

  let harvestSessionConfigured = false;

  const HARVEST_AD_HOSTS = [
    'doubleclick.net',
    'googlesyndication.com',
    'googleadservices.com',
    'adservice.google.com',
    'adnxs.com',
    'adsrvr.org',
    'rubiconproject.com',
    'pubmatic.com',
    'openx.net',
    'criteo.com',
    'criteo.net',
    'amazon-adsystem.com',
    'taboola.com',
    'outbrain.com',
    'scorecardresearch.com',
    'quantserve.com',
    'popads.net',
    'popcash.net',
    'propellerads.com',
    'adsterra.com',
    'clickadu.com',
    'exoclick.com',
    'hilltopads.net',
    'monetag.com',
    'trafficstars.com',
    'juicyads.com',
    'mgid.com',
    'revcontent.com',
    'media.net',
    'smartadserver.com',
    'yieldmo.com',
    'zedo.com',
    'advertising.com',
    'casalemedia.com',
    'lijit.com',
    'bidswitch.net',
    'contextweb.com',
    '33across.com',
    'sharethrough.com',
    'teads.tv',
    'twinrengine.com',
  ];

  function harvestTsSession() {
    return session.fromPartition('persist:harvestts');
  }

  function harvestAdHost(hostname) {
    const host = String(hostname || '')
      .toLowerCase()
      .replace(/\.$/, '');
    return HARVEST_AD_HOSTS.some((base) => host === base || host.endsWith('.' + base));
  }

  const HARVEST_ADBLOCK_ENGINE_VERSION = '2.1';

  function harvestAdUrl(url, sourceUrl = '') {
    try {
      if (harvestAdHost(new URL(url).hostname)) return true;
      return Boolean(
        harvestAdblockEngine &&
        ['other', 'mainFrame'].some(
          (type) =>
            harvestAdblockEngine.match(Request.fromRawDetails({ url, sourceUrl, type })).match,
        ),
      );
    } catch {
      return false;
    }
  }

  function recordBlockedHarvestPopup() {
    harvestAdblockBlockedSession += 1;
    hostService.emit('harvestts-adblock-status', harvestAdblockSnapshot());
  }

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
      name: 'Harvest Adblock',
      version: HARVEST_ADBLOCK_ENGINE_VERSION,
      builtin: true,
      engine: harvestAdblockEngine ? 'Ghostery Engine' : 'Fallback',
      ready: Boolean(harvestAdblockEngine),
      loading: Boolean(harvestAdblockLoading),
      source: harvestAdblockSource,
      error: harvestAdblockError,
      updatedAt: harvestAdblockUpdatedAt || 0,
      blockedSession: harvestAdblockBlockedSession,
      networkFilters: harvestAdblockNetworkFilters,
      cosmeticFilters: harvestAdblockCosmeticFilters,
      sharedWithImageHarvest: true,
      collectorElectronActive: Boolean(
        collectorBrowserService.browsingSession &&
        collectorElectronAdblocker?.isBlockingEnabled?.(collectorBrowserService.browsingSession),
      ),
      features: {
        network: true,
        cosmetic: Boolean(harvestAdblockEngine),
        scriptlets: Boolean(harvestAdblockEngine),
        tracking: Boolean(harvestAdblockEngine),
        popups: true,
      },
    };
  }

  function harvestAdblockFetch(input, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    return globalThis
      .fetch(input, { ...init, signal: controller.signal })
      .finally(() => clearTimeout(timer));
  }

  async function readHarvestAdblockMeta() {
    return storageService.readHarvestJson(storageService.harvestAdblockMetaFile, {
      updatedAt: 0,
      version: HARVEST_ADBLOCK_ENGINE_VERSION,
    });
  }

  async function writeHarvestAdblockMeta(updatedAt = Date.now()) {
    harvestAdblockUpdatedAt = updatedAt;
    await storageService.writeHarvestJson(storageService.harvestAdblockMetaFile, {
      updatedAt,
      version: HARVEST_ADBLOCK_ENGINE_VERSION,
      source: 'Ghostery Ads + Tracking prebuilt',
    });
  }

  function attachHarvestAdblockEvents(blocker) {
    blocker.on('request-blocked', () => {
      harvestAdblockBlockedSession += 1;
    });
    blocker.on('request-redirected', () => {
      harvestAdblockBlockedSession += 1;
    });
  }

  function installHarvestFallbackAdblockListener(ses = harvestTsSession()) {
    ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      let cancel = false;
      if (harvestBrowserRuntime.adblockEnabled && details.resourceType !== 'mainFrame') {
        try {
          cancel = harvestAdHost(new URL(details.url).hostname);
        } catch {}
      }
      if (cancel) harvestAdblockBlockedSession += 1;
      callback({ cancel });
    });
  }

  async function syncCollectorElectronAdblocker(force = false) {
    if (!collectorBrowserService.browsingSession) return false;
    if (collectorElectronAdblocker?.isBlockingEnabled(collectorBrowserService.browsingSession)) {
      if (force || harvestBrowserRuntime.adblockEnabled === false) {
        try {
          collectorElectronAdblocker.disableBlockingInSession(
            collectorBrowserService.browsingSession,
          );
        } catch {}
      }
    }
    if (harvestBrowserRuntime.adblockEnabled === false) return false;
    if (!harvestAdblockEngine) await initializeHarvestAdblockEngine().catch(() => {});
    if (!harvestAdblockEngine) {
      installHarvestFallbackAdblockListener(collectorBrowserService.browsingSession);
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
    if (
      collectorElectronAdblocker &&
      !collectorElectronAdblocker.isBlockingEnabled(collectorBrowserService.browsingSession)
    ) {
      collectorElectronAdblocker.enableBlockingInSession(collectorBrowserService.browsingSession);
      return true;
    }
    return Boolean(collectorElectronAdblocker);
  }

  async function syncCollectorAdblock(force = false) {
    await syncCollectorElectronAdblocker(force).catch(() => {});
    if (typeof collectorBrowserService.chromeBrowser !== 'undefined') {
      if (harvestBrowserRuntime.adblockEnabled === false) {
        await collectorBrowserService.chromeBrowser.setAdblockEnabled(false).catch(() => {});
      } else {
        await collectorBrowserService.chromeBrowser.setAdblockEnabled(true).catch(() => {});
        if (force) await collectorBrowserService.chromeBrowser.reloadAdblocker().catch(() => {});
      }
    }
  }

  async function attachHarvestAdblockEngine(blocker, source = 'fresh') {
    const ses = harvestTsSession();
    const previous = harvestAdblockEngine;
    if (previous && previous !== blocker && previous.isBlockingEnabled(ses)) {
      try {
        previous.disableBlockingInSession(ses);
      } catch {}
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
    if (collectorBrowserService.browsingSession)
      setTimeout(() => syncCollectorAdblock(true).catch(() => {}), 0);
    return blocker;
  }

  async function loadHarvestAdblockCache() {
    const bytes = await fs.readFile(storageService.harvestAdblockCacheFile);
    const blocker = ElectronBlocker.deserialize(bytes);
    const meta = await readHarvestAdblockMeta();
    harvestAdblockUpdatedAt = Number(meta.updatedAt) || 0;
    await attachHarvestAdblockEngine(blocker, 'cache');
    return blocker;
  }

  async function fetchFreshHarvestAdblock() {
    if (typeof globalThis.fetch !== 'function')
      throw new Error('Fetch API ไม่พร้อมสำหรับอัปเดต Adblock');
    const blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(harvestAdblockFetch);
    await fs.mkdir(storageService.harvestTsDataDir, { recursive: true });
    await fs.writeFile(storageService.harvestAdblockCacheFile, blocker.serialize());
    await writeHarvestAdblockMeta(Date.now());
    await attachHarvestAdblockEngine(blocker, 'fresh');
    return blocker;
  }

  async function refreshHarvestAdblockEngine() {
    const old = harvestAdblockEngine;
    try {
      const blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(harvestAdblockFetch);
      await fs.mkdir(storageService.harvestTsDataDir, { recursive: true });
      await fs.writeFile(storageService.harvestAdblockCacheFile, blocker.serialize());
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
      try {
        blocker = await loadHarvestAdblockCache();
      } catch {}
      if (blocker) {
        const stale =
          !harvestAdblockUpdatedAt ||
          Date.now() - harvestAdblockUpdatedAt > HARVEST_ADBLOCK_REFRESH_MS;
        if (stale) setTimeout(() => refreshHarvestAdblockEngine().catch(() => {}), 400);
        return blocker;
      }
      try {
        return await fetchFreshHarvestAdblock();
      } catch (error) {
        harvestAdblockError = error.message || String(error);
        harvestAdblockSource = 'fallback';
        installHarvestFallbackAdblockListener();
        return null;
      }
    })();
    try {
      return await harvestAdblockLoading;
    } finally {
      harvestAdblockLoading = null;
    }
  }

  async function readHarvestBrowserSettings() {
    const data = await storageService.readHarvestJson(
      storageService.harvestTsBrowserSettingsFile,
      HARVEST_BROWSER_DEFAULTS,
    );
    const mode = [
      'inherit',
      'cloudflare',
      'google',
      'adguard',
      'quad9',
      'mullvad',
      'custom',
    ].includes(data.dnsMode)
      ? data.dnsMode
      : 'inherit';
    return {
      adblockEnabled: data.adblockEnabled !== false,
      dnsMode: mode,
      customDoh: typeof data.customDoh === 'string' ? data.customDoh : '',
      historyEnabled: data.historyEnabled !== false,
      restoreTabs: data.restoreTabs !== false,
    };
  }

  async function saveHarvestBrowserSettings(next) {
    harvestBrowserRuntime = { ...HARVEST_BROWSER_DEFAULTS, ...next };
    await storageService.writeHarvestJson(
      storageService.harvestTsBrowserSettingsFile,
      harvestBrowserRuntime,
    );
    return { ...harvestBrowserRuntime };
  }

  function harvestDnsOptions(settings = harvestBrowserRuntime) {
    const templates = {
      cloudflare: 'https://cloudflare-dns.com/dns-query',
      google: 'https://dns.google/dns-query',
      adguard: 'https://dns.adguard-dns.com/dns-query',
      quad9: 'https://dns.quad9.net/dns-query',
      mullvad: 'https://doh.mullvad.net/dns-query',
    };
    if (settings.dnsMode === 'inherit')
      return electronResolverOptions(collectorBrowserService.networkMode);
    const secure =
      settings.dnsMode === 'custom'
        ? String(settings.customDoh || '').trim()
        : templates[settings.dnsMode];
    if (!secure) return electronResolverOptions(collectorBrowserService.networkMode);
    return {
      enableBuiltInResolver: true,
      enableHappyEyeballs: true,
      secureDnsMode: 'secure',
      secureDnsServers: [secure],
    };
  }

  function validateCustomDoh(raw) {
    const value = String(raw || '').trim();
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error('Custom DNS ต้องเป็น DoH URL ที่ถูกต้อง');
    }
    if (url.protocol !== 'https:' || url.username || url.password || value.length > 500)
      throw new Error('Custom DNS ต้องเป็น https:// DoH URL');
    return url.href;
  }

  async function applyHarvestDns() {
    app.configureHostResolver(harvestDnsOptions());
    const ses = harvestTsSession();
    await ses.clearHostResolverCache().catch(() => {});
    await ses.closeAllConnections().catch(() => {});
  }

  async function harvestTsDnsSettings() {
    return { ...harvestBrowserRuntime };
  }

  async function harvestTsDnsSet(input = {}) {
    const mode = String(input.mode || 'inherit');
    if (
      !['inherit', 'cloudflare', 'google', 'adguard', 'quad9', 'mullvad', 'custom'].includes(mode)
    )
      throw new Error('DNS mode ไม่ถูกต้อง');
    const customDoh = mode === 'custom' ? validateCustomDoh(input.customDoh) : '';
    const next = await saveHarvestBrowserSettings({
      ...harvestBrowserRuntime,
      dnsMode: mode,
      customDoh,
    });
    await applyHarvestDns();
    return next;
  }

  async function harvestTsDnsActivate() {
    await applyHarvestDns();
    return { ...harvestBrowserRuntime };
  }

  async function harvestTsDnsDeactivate() {
    app.configureHostResolver(electronResolverOptions(collectorBrowserService.networkMode));
    const ses = harvestTsSession();
    await ses.clearHostResolverCache().catch(() => {});
    await ses.closeAllConnections().catch(() => {});
    return true;
  }

  function configureHarvestTsSession() {
    if (harvestSessionConfigured) return harvestTsSession();
    const ses = harvestTsSession();
    ses.registerPreloadScript({
      type: 'frame',
      filePath: path.join(__dirname, '..', 'harvest-input-preload.cjs'),
    });
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    installHarvestFallbackAdblockListener(ses);
    downloadsService.configureHarvestDownloads(ses);
    harvestSessionConfigured = true;
    return ses;
  }

  async function harvestTsAdblockSet(input = {}) {
    const enabled = input.enabled !== false;
    await saveHarvestBrowserSettings({
      ...harvestBrowserRuntime,
      adblockEnabled: enabled,
    });
    const ses = configureHarvestTsSession();
    if (!enabled) {
      if (harvestAdblockEngine?.isBlockingEnabled(ses)) {
        try {
          harvestAdblockEngine.disableBlockingInSession(ses);
        } catch {}
      }
    } else {
      if (!harvestAdblockEngine) await initializeHarvestAdblockEngine();
      if (harvestAdblockEngine && !harvestAdblockEngine.isBlockingEnabled(ses)) {
        harvestAdblockEngine.enableBlockingInSession(ses);
      } else if (!harvestAdblockEngine) {
        installHarvestFallbackAdblockListener(ses);
      }
    }
    await syncCollectorAdblock(true).catch(() => {});
    if (!enabled && collectorBrowserService.webAlive()) {
      await collectorBrowserService
        .runMainPage(
          `document.getElementById('__imageharvest_adblock_cosmetic__')?.remove();true`,
          collectorBrowserService.browserMode,
        )
        .catch(() => {});
    }
    hostService.emit('harvestts-adblock-status', harvestAdblockSnapshot());
    return harvestAdblockSnapshot();
  }

  async function harvestTsAdblockStatus() {
    if (!harvestAdblockEngine && !harvestAdblockLoading)
      initializeHarvestAdblockEngine()
        .then(() => hostService.emit('harvestts-adblock-status', harvestAdblockSnapshot()))
        .catch(() => {});
    return harvestAdblockSnapshot();
  }

  async function harvestTsAdblockUpdate() {
    if (harvestAdblockLoading) await harvestAdblockLoading.catch(() => {});
    harvestAdblockLoading = refreshHarvestAdblockEngine();
    try {
      await harvestAdblockLoading;
    } finally {
      harvestAdblockLoading = null;
    }
    await syncCollectorAdblock(true).catch(() => {});
    hostService.emit('harvestts-adblock-status', harvestAdblockSnapshot());
    return harvestAdblockSnapshot();
  }
  return {
    get harvestBrowserRuntime() {
      return harvestBrowserRuntime;
    },
    set harvestBrowserRuntime(value) {
      harvestBrowserRuntime = value;
    },
    harvestAdHost,
    harvestTsSession,
    harvestAdUrl,
    recordBlockedHarvestPopup,
    get harvestAdblockEngine() {
      return harvestAdblockEngine;
    },
    get harvestAdblockBlockedSession() {
      return harvestAdblockBlockedSession;
    },
    set harvestAdblockBlockedSession(value) {
      harvestAdblockBlockedSession = value;
    },
    harvestAdblockSnapshot,
    initializeHarvestAdblockEngine,
    readHarvestBrowserSettings,
    saveHarvestBrowserSettings,
    harvestTsDnsSettings,
    harvestTsDnsSet,
    harvestTsDnsActivate,
    harvestTsDnsDeactivate,
    configureHarvestTsSession,
    harvestTsAdblockSet,
    harvestTsAdblockStatus,
    harvestTsAdblockUpdate,
  };
}
module.exports = { createSession };
