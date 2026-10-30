'use strict';
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { loadFavicon } = require('./favicon.cjs');

function createHistory({ session: sessionService, storage: storageService, host: hostService }) {
  let harvestHistoryWrite = Promise.resolve();
  function historyTask(task) {
    const result = harvestHistoryWrite.then(task);
    harvestHistoryWrite = result.then(() => {}).catch(() => {});
    return result;
  }
  const faviconFile = path.join(storageService.harvestTsDataDir, 'history-favicons.json');
  let favicons = {},
    faviconReady,
    faviconWrite = Promise.resolve();
  const pendingFavicons = new Map();
  const originOf = (url) => {
    try {
      const parsed = new URL(url);
      return /^https?:$/.test(parsed.protocol) ? parsed.origin : '';
    } catch {
      return '';
    }
  };
  function readFavicons() {
    return (faviconReady ||= storageService
      .readHarvestJson(faviconFile, { icons: {} })
      .then((data) => {
        favicons = data.icons || {};
      }));
  }
  function saveFavicons() {
    faviconWrite = faviconWrite
      .then(() => storageService.writeHarvestJson(faviconFile, { version: 1, icons: favicons }))
      .catch(() => {});
    return faviconWrite;
  }
  async function rememberHistoryFavicon(url, favicon) {
    const origin = originOf(url);
    if (!origin || !/^data:image\/png;base64,/.test(favicon || '') || favicon.length > 350000)
      return;
    await readFavicons();
    favicons[origin] = { data: favicon, checkedAt: Date.now() };
    await saveFavicons();
  }
  async function resolveHistoryFavicon(origin) {
    await readFavicons();
    const cached = favicons[origin];
    if (cached?.data || Date.now() - (cached?.checkedAt || 0) < 86400000) return cached?.data || '';
    if (pendingFavicons.has(origin)) return pendingFavicons.get(origin);
    const pending = (async () => {
      const request = new AbortController(),
        timer = setTimeout(() => request.abort(), 6000);
      try {
        const data = await loadFavicon(
          sessionService.harvestTsSession(),
          [origin + '/favicon.ico', origin + '/favicon.png', origin + '/favicon.svg'],
          request.signal,
        );
        // A visited page may have supplied its real icon while the legacy lookup was running.
        if (!favicons[origin]?.data) {
          favicons[origin] = { data, checkedAt: Date.now() };
          await saveFavicons();
        }
        return favicons[origin]?.data || '';
      } finally {
        clearTimeout(timer);
        pendingFavicons.delete(origin);
      }
    })();
    pendingFavicons.set(origin, pending);
    return pending;
  }
  async function harvestTsHistoryFavicons(input = {}) {
    const history = await harvestTsHistoryList({ limit: 3000 });
    const allowed = new Set(history.items.map((item) => originOf(item.url)));
    const origins = [
      ...new Set((Array.isArray(input.urls) ? input.urls : []).slice(0, 16).map(originOf)),
    ].filter((origin) => origin && allowed.has(origin));
    const icons = {};
    let index = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, origins.length) }, async () => {
        while (index < origins.length) {
          const origin = origins[index++];
          icons[origin] = await resolveHistoryFavicon(origin).catch(() => '');
        }
      }),
    );
    return { icons };
  }

  async function harvestTsHistoryList(input = {}) {
    return historyTask(async () => {
      await readFavicons();
      const data = await storageService.readHarvestJson(storageService.harvestTsHistoryFile, {
        version: 1,
        items: [],
      });
      let items = Array.isArray(data.items) ? data.items : [];
      items = items.filter((x) => x && /^https?:\/\//i.test(x.url || ''));
      const limit = Math.max(1, Math.min(3000, Number(input.limit) || 1000));
      return {
        enabled: sessionService.harvestBrowserRuntime.historyEnabled !== false,
        items: items
          .slice(0, limit)
          .map((item) => ({ ...item, favicon: favicons[originOf(item.url)]?.data || '' })),
      };
    });
  }

  async function writeHarvestHistory(items) {
    await storageService.writeHarvestJson(storageService.harvestTsHistoryFile, {
      version: 1,
      items: items.slice(0, 3000),
    });
  }

  function queueHarvestHistory(url, title = '') {
    if (
      sessionService.harvestBrowserRuntime.historyEnabled === false ||
      !/^https?:\/\//i.test(String(url || ''))
    )
      return;
    const visitedAt = Date.now();
    harvestHistoryWrite = harvestHistoryWrite
      .then(async () => {
        const data = await storageService.readHarvestJson(storageService.harvestTsHistoryFile, {
          version: 1,
          items: [],
        });
        const items = Array.isArray(data.items) ? data.items : [];
        const first = items[0];
        if (first && first.url === url && visitedAt - Number(first.visitedAt || 0) < 5000) {
          first.title = String(title || first.title || url);
          first.visitedAt = visitedAt;
        } else {
          items.unshift({
            id: randomUUID(),
            title: String(title || url),
            url: String(url),
            visitedAt,
          });
        }
        await writeHarvestHistory(items);
      })
      .catch(() => {});
  }

  async function harvestTsHistoryRemove(input = {}) {
    await historyTask(async () => {
      const data = await storageService.readHarvestJson(storageService.harvestTsHistoryFile, {
        version: 1,
        items: [],
      });
      const id = String(input.id || '');
      const items = (Array.isArray(data.items) ? data.items : []).filter((x) => x?.id !== id);
      await writeHarvestHistory(items);
    });
    return harvestTsHistoryList(input);
  }

  async function harvestTsHistoryClear() {
    await historyTask(() => writeHarvestHistory([]));
    return {
      enabled: sessionService.harvestBrowserRuntime.historyEnabled !== false,
      items: [],
    };
  }

  async function harvestTsBrowserSettings() {
    return { ...sessionService.harvestBrowserRuntime };
  }

  async function harvestTsBrowserSettingsSet(input = {}) {
    const next = { ...sessionService.harvestBrowserRuntime };
    if (typeof input.historyEnabled === 'boolean') next.historyEnabled = input.historyEnabled;
    if (typeof input.restoreTabs === 'boolean') next.restoreTabs = input.restoreTabs;
    await sessionService.saveHarvestBrowserSettings(next);
    hostService.emit('harvestts-browser-settings', {
      ...sessionService.harvestBrowserRuntime,
    });
    return { ...sessionService.harvestBrowserRuntime };
  }
  return {
    harvestTsHistoryList,
    harvestTsHistoryFavicons,
    rememberHistoryFavicon,
    queueHarvestHistory,
    harvestTsHistoryRemove,
    harvestTsHistoryClear,
    harvestTsBrowserSettings,
    harvestTsBrowserSettingsSet,
  };
}
module.exports = { createHistory };
