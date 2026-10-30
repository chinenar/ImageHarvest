'use strict';

function createBlocks({
  collectorBlocks: collectorBlocksService,
  collectorBrowser: collectorBrowserService,
  blockManager: blockManagerService,
  storage: storageService,
  tabs: tabsService,
  host: hostService,
  blockScripts: blockScriptsService,
}) {
  async function harvestTsBlockData() {
    const data = await storageService.readHarvestJson(storageService.harvestTsBlockFile, {
      version: 1,
      rules: {},
    });
    return {
      version: 1,
      rules: data && typeof data.rules === 'object' && data.rules ? data.rules : {},
    };
  }

  function sharedBlockSelectorsForOrigin(data, origin) {
    return Array.isArray(data?.rules?.[origin])
      ? data.rules[origin].filter((x) => typeof x === 'string' && x.length < 700)
      : [];
  }

  async function syncSharedBlockRules(origin = '') {
    const tasks = [];
    for (const tab of tabsService.harvestTsTabs.values()) {
      if (!tab || tab.kind === 'history' || tab.view.webContents.isDestroyed()) continue;
      let tabOrigin = '';
      try {
        tabOrigin = new URL(tab.view.webContents.getURL() || tab.url || '').origin;
      } catch {}
      if (!origin || tabOrigin === origin) tasks.push(applyHarvestBlocks(tab));
    }
    if (
      collectorBrowserService.webAlive() &&
      hostService.allowedWeb(collectorBrowserService.webURL())
    ) {
      let collectorOrigin = '';
      try {
        collectorOrigin = new URL(collectorBrowserService.webURL()).origin;
      } catch {}
      if (!origin || collectorOrigin === origin)
        tasks.push(collectorBlocksService.applyCollectorBlocks());
    }
    await Promise.allSettled(tasks);
  }

  async function applyHarvestBlocks(tab = tabsService.activeHarvestTsTab()) {
    if (!tab || tab.view.webContents.isDestroyed()) return;
    const wc = tab.view.webContents;
    if (tab.blockCssKey) {
      await wc.removeInsertedCSS(tab.blockCssKey).catch(() => {});
      tab.blockCssKey = '';
    }
    let origin = '';
    try {
      origin = new URL(wc.getURL() || tab.url || '').origin;
    } catch {
      return;
    }
    const data = await harvestTsBlockData();
    const selectors = Array.isArray(data.rules[origin])
      ? data.rules[origin].filter((x) => typeof x === 'string' && x.length < 700)
      : [];
    if (!selectors.length) return;
    const safeSelectors = await wc
      .executeJavaScript(
        `(() => {
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
  })()`,
        true,
      )
      .catch(() =>
        selectors.filter(
          (selector) =>
            selector.includes('>') || selector.includes('#') || selector.includes(':nth-of-type('),
        ),
      );
    if (!safeSelectors.length) return;
    const css = safeSelectors
      .map((s) => `${s}{display:none!important;visibility:hidden!important}`)
      .join('\n');
    tab.blockCssKey = await wc.insertCSS(css).catch(() => '');
  }

  async function harvestTsBlockElement(input = {}) {
    const page = tabsService.harvestTsPageInfo(
      tabsService.harvestTsTabs.get(String(input.id || tabsService.activeHarvestTsId)),
    );
    const pickerCss = await page.wc
      .insertCSS(
        '.__harvestts_pick__{outline:3px solid #a995ff!important;outline-offset:2px!important;cursor:crosshair!important}',
      )
      .catch(() => '');
    let selector = '';
    try {
      selector = String(
        (await page.wc.executeJavaScript(blockScriptsService.harvestBlockPickerScript(), true)) ||
          '',
      ).trim();
    } finally {
      if (pickerCss) await page.wc.removeInsertedCSS(pickerCss).catch(() => {});
    }
    if (!selector) return { cancelled: true };
    if (selector.length > 700 || /[{}]/.test(selector))
      throw new Error('Element ที่เลือกซับซ้อนเกินไป');
    const origin = new URL(page.url).origin,
      data = await harvestTsBlockData();
    const list = Array.isArray(data.rules[origin]) ? data.rules[origin] : [];
    if (!list.includes(selector)) list.push(selector);
    data.rules[origin] = list.slice(-200);
    await storageService.writeHarvestJson(storageService.harvestTsBlockFile, data);
    await syncSharedBlockRules(origin);
    return {
      blocked: true,
      origin,
      selector,
      count: data.rules[origin].length,
    };
  }

  async function harvestTsBlockList(input = {}) {
    const page = tabsService.harvestTsPageInfo(
      tabsService.harvestTsTabs.get(String(input.id || tabsService.activeHarvestTsId)),
    );
    const origin = new URL(page.url).origin,
      data = await harvestTsBlockData();
    return {
      origin,
      selectors: Array.isArray(data.rules[origin]) ? data.rules[origin] : [],
    };
  }

  async function harvestTsBlockClear(input = {}) {
    const page = tabsService.harvestTsPageInfo(
      tabsService.harvestTsTabs.get(String(input.id || tabsService.activeHarvestTsId)),
    );
    const origin = new URL(page.url).origin,
      data = await harvestTsBlockData();
    delete data.rules[origin];
    await storageService.writeHarvestJson(storageService.harvestTsBlockFile, data);
    await syncSharedBlockRules(origin);
    return { origin, cleared: true, selectors: [] };
  }

  async function harvestTsBlockDraftBegin(input = {}) {
    if (
      blockManagerService.liveHarvestBlockManager() &&
      blockManagerService.harvestBlockManagerKind !== 'harvestts'
    )
      await blockManagerService.cancelHarvestBlockManagerDraft();
    const page = tabsService.harvestTsPageInfo(
      tabsService.harvestTsTabs.get(String(input.id || tabsService.activeHarvestTsId)),
    );
    if (page.tab.blockPickerCssKey) {
      await page.wc.removeInsertedCSS(page.tab.blockPickerCssKey).catch(() => {});
      page.tab.blockPickerCssKey = '';
    }
    const css = [
      'html,body{cursor:default}',
      '.__harvestts_pick_hover__{outline:2px solid #9aa0aa!important;outline-offset:2px!important;box-shadow:inset 0 0 0 9999px rgba(82,87,96,.24)!important;cursor:crosshair!important}',
      '.__harvestts_pick_selected__{outline:3px solid #8fa8ff!important;outline-offset:1px!important;box-shadow:inset 0 0 0 9999px rgba(174,196,255,.30)!important;cursor:crosshair!important}',
    ].join('\n');
    page.tab.blockPickerCssKey = await page.wc.insertCSS(css).catch(() => '');
    const state = await page.wc.executeJavaScript(
      blockScriptsService.harvestBlockDraftBootstrapScript(),
      true,
    );
    const saved = await harvestTsBlockList({ id: page.tab.id });
    if (input.showManager !== false) await blockManagerService.showHarvestBlockManager(page.tab.id);
    return {
      ...state,
      origin: new URL(page.url).origin,
      saved: saved.selectors,
    };
  }

  async function harvestTsBlockDraftState(input = {}) {
    const page = tabsService.harvestTsPageInfo(
      tabsService.harvestTsTabs.get(String(input.id || tabsService.activeHarvestTsId)),
    );
    const state = await page.wc
      .executeJavaScript(
        `window.__harvestBlockDraft?.snapshot?.() || ({active:false,cancelled:false,selectors:[],count:0})`,
        true,
      )
      .catch(() => ({
        active: false,
        cancelled: false,
        selectors: [],
        count: 0,
      }));
    const saved = await harvestTsBlockList({ id: page.tab.id });
    return {
      ...state,
      origin: new URL(page.url).origin,
      saved: saved.selectors,
    };
  }

  async function harvestTsBlockDraftClear(input = {}) {
    const page = tabsService.harvestTsPageInfo(
      tabsService.harvestTsTabs.get(String(input.id || tabsService.activeHarvestTsId)),
    );
    return page.wc.executeJavaScript(
      `window.__harvestBlockDraft?.clear?.() || ({active:false,cancelled:false,selectors:[],count:0})`,
      true,
    );
  }

  async function finishHarvestBlockDraft(tab, cancel = false) {
    if (!tab || tab.view.webContents.isDestroyed())
      return {
        active: false,
        cancelled: Boolean(cancel),
        selectors: [],
        count: 0,
      };
    const wc = tab.view.webContents;
    const state = await wc
      .executeJavaScript(
        `window.__harvestBlockDraft?.finish?.(${cancel ? 'true' : 'false'}) || ({active:false,cancelled:${cancel ? 'true' : 'false'},selectors:[],count:0})`,
        true,
      )
      .catch(() => ({
        active: false,
        cancelled: Boolean(cancel),
        selectors: [],
        count: 0,
      }));
    if (tab.blockPickerCssKey) {
      await wc.removeInsertedCSS(tab.blockPickerCssKey).catch(() => {});
      tab.blockPickerCssKey = '';
    }
    return state;
  }

  async function harvestTsBlockDraftCancel(input = {}) {
    const tab = tabsService.harvestTsTabs.get(String(input.id || tabsService.activeHarvestTsId));
    const state = await finishHarvestBlockDraft(tab, true);
    return { ...state, cancelled: true };
  }

  async function harvestTsBlockDraftCommit(input = {}) {
    const page = tabsService.harvestTsPageInfo(
      tabsService.harvestTsTabs.get(String(input.id || tabsService.activeHarvestTsId)),
    );
    const state = await finishHarvestBlockDraft(page.tab, false);
    const selectors = [
      ...new Set(
        (state.selectors || [])
          .map(String)
          .map((x) => x.trim())
          .filter((x) => x && x.length < 700 && !/[{}]/.test(x)),
      ),
    ];
    if (!selectors.length)
      return {
        saved: false,
        count: 0,
        added: 0,
        origin: new URL(page.url).origin,
        selectors: [],
      };
    const origin = new URL(page.url).origin,
      data = await harvestTsBlockData();
    const list = Array.isArray(data.rules[origin]) ? data.rules[origin] : [];
    const before = list.length;
    for (const selector of selectors) if (!list.includes(selector)) list.push(selector);
    data.rules[origin] = list.slice(-300);
    await storageService.writeHarvestJson(storageService.harvestTsBlockFile, data);
    await syncSharedBlockRules(origin);
    return {
      saved: true,
      origin,
      added: Math.max(0, data.rules[origin].length - before),
      count: data.rules[origin].length,
      selectors: data.rules[origin],
    };
  }

  async function harvestTsBlockRemove(input = {}) {
    const page = tabsService.harvestTsPageInfo(
      tabsService.harvestTsTabs.get(String(input.id || tabsService.activeHarvestTsId)),
    );
    const origin = new URL(page.url).origin,
      selector = String(input.selector || '');
    const data = await harvestTsBlockData();
    const list = Array.isArray(data.rules[origin]) ? data.rules[origin] : [];
    data.rules[origin] = list.filter((x) => x !== selector);
    if (!data.rules[origin].length) delete data.rules[origin];
    await storageService.writeHarvestJson(storageService.harvestTsBlockFile, data);
    await syncSharedBlockRules(origin);
    return { origin, selectors: data.rules[origin] || [] };
  }
  return {
    harvestTsBlockData,
    sharedBlockSelectorsForOrigin,
    syncSharedBlockRules,
    applyHarvestBlocks,
    harvestTsBlockElement,
    harvestTsBlockList,
    harvestTsBlockClear,
    harvestTsBlockDraftBegin,
    harvestTsBlockDraftState,
    harvestTsBlockDraftClear,
    finishHarvestBlockDraft,
    harvestTsBlockDraftCancel,
    harvestTsBlockDraftCommit,
    harvestTsBlockRemove,
  };
}
module.exports = { createBlocks };
