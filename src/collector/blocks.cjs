'use strict';

function createCollectorBlocks({
  collectorBrowser: collectorBrowserService,
  blockManager: blockManagerService,
  blocks: blocksService,
  storage: storageService,
  host: hostService,
  blockScripts: blockScriptsService,
}) {
  async function collectorBlockInfo() {
    const url = collectorBrowserService.webURL();
    if (!collectorBrowserService.webAlive() || !hostService.allowedWeb(url))
      throw new Error('กรุณาเปิดเว็บใน ImageHarvest ก่อน');
    return {
      url,
      origin: new URL(url).origin,
      backend: collectorBrowserService.browserMode,
    };
  }

  async function applyCollectorBlocks() {
    if (
      !collectorBrowserService.webAlive() ||
      !hostService.allowedWeb(collectorBrowserService.webURL())
    )
      return { applied: 0, selectors: [] };
    const info = await collectorBlockInfo();
    const data = await blocksService.harvestTsBlockData();
    const selectors = blocksService.sharedBlockSelectorsForOrigin(data, info.origin);
    return collectorBrowserService
      .runMainPage(blockScriptsService.sharedBlockStyleScript(selectors), info.backend)
      .catch(() => ({ applied: 0, selectors: [] }));
  }

  async function collectorBlockList() {
    const info = await collectorBlockInfo(),
      data = await blocksService.harvestTsBlockData();
    return {
      origin: info.origin,
      selectors: blocksService.sharedBlockSelectorsForOrigin(data, info.origin),
    };
  }

  async function collectorBlockDraftBegin(input = {}) {
    collectorBrowserService.ensureIdle();
    if (
      blockManagerService.harvestBlockManagerKind !== 'collector' &&
      blockManagerService.liveHarvestBlockManager()
    )
      await blockManagerService.cancelHarvestBlockManagerDraft();
    const info = await collectorBlockInfo();
    const state = await collectorBrowserService.runMainPage(
      blockScriptsService.harvestBlockDraftBootstrapScript(),
      info.backend,
    );
    const saved = await collectorBlockList();
    if (input.showManager !== false)
      await blockManagerService.showHarvestBlockManager('', 'collector');
    const popup = blockManagerService.liveHarvestBlockManager();
    if (popup) {
      try {
        popup.setAlwaysOnTop(true, 'floating');
      } catch {}
    }
    if (info.backend === 'chrome')
      await collectorBrowserService.chromeBrowser.show().catch(() => {});
    else if (collectorBrowserService.browser && !collectorBrowserService.browser.isDestroyed()) {
      collectorBrowserService.browser.show();
      collectorBrowserService.browser.focus();
    }
    return { ...state, origin: info.origin, saved: saved.selectors };
  }

  async function collectorBlockDraftState() {
    const info = await collectorBlockInfo();
    const state = await collectorBrowserService
      .runMainPage(
        `window.__harvestBlockDraft?.snapshot?.() || ({active:false,cancelled:false,selectors:[],count:0})`,
        info.backend,
      )
      .catch(() => ({
        active: false,
        cancelled: false,
        selectors: [],
        count: 0,
      }));
    const saved = await collectorBlockList();
    return { ...state, origin: info.origin, saved: saved.selectors };
  }

  async function collectorBlockDraftClear() {
    const info = await collectorBlockInfo();
    return collectorBrowserService.runMainPage(
      `window.__harvestBlockDraft?.clear?.() || ({active:false,cancelled:false,selectors:[],count:0})`,
      info.backend,
    );
  }

  async function finishCollectorBlockDraft(cancel = false) {
    if (
      !collectorBrowserService.webAlive() ||
      !hostService.allowedWeb(collectorBrowserService.webURL())
    )
      return {
        active: false,
        cancelled: Boolean(cancel),
        selectors: [],
        count: 0,
      };
    return collectorBrowserService
      .runMainPage(
        `window.__harvestBlockDraft?.finish?.(${cancel ? 'true' : 'false'}) || ({active:false,cancelled:${cancel ? 'true' : 'false'},selectors:[],count:0})`,
        collectorBrowserService.browserMode,
      )
      .catch(() => ({
        active: false,
        cancelled: Boolean(cancel),
        selectors: [],
        count: 0,
      }));
  }

  async function collectorBlockDraftCancel() {
    const state = await finishCollectorBlockDraft(true);
    return { ...state, cancelled: true };
  }

  async function collectorBlockDraftCommit() {
    const info = await collectorBlockInfo();
    const state = await finishCollectorBlockDraft(false);
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
        origin: info.origin,
        selectors: [],
      };
    const data = await blocksService.harvestTsBlockData(),
      list = Array.isArray(data.rules[info.origin]) ? data.rules[info.origin] : [];
    const before = list.length;
    for (const selector of selectors) if (!list.includes(selector)) list.push(selector);
    data.rules[info.origin] = list.slice(-300);
    await storageService.writeHarvestJson(storageService.harvestTsBlockFile, data);
    await blocksService.syncSharedBlockRules(info.origin);
    return {
      saved: true,
      origin: info.origin,
      added: Math.max(0, data.rules[info.origin].length - before),
      count: data.rules[info.origin].length,
      selectors: data.rules[info.origin],
    };
  }

  async function collectorBlockRemove(input = {}) {
    const info = await collectorBlockInfo(),
      selector = String(input.selector || ''),
      data = await blocksService.harvestTsBlockData();
    const list = Array.isArray(data.rules[info.origin]) ? data.rules[info.origin] : [];
    data.rules[info.origin] = list.filter((x) => x !== selector);
    if (!data.rules[info.origin].length) delete data.rules[info.origin];
    await storageService.writeHarvestJson(storageService.harvestTsBlockFile, data);
    await blocksService.syncSharedBlockRules(info.origin);
    return { origin: info.origin, selectors: data.rules[info.origin] || [] };
  }

  async function collectorBlockClear() {
    const info = await collectorBlockInfo(),
      data = await blocksService.harvestTsBlockData();
    delete data.rules[info.origin];
    await storageService.writeHarvestJson(storageService.harvestTsBlockFile, data);
    await blocksService.syncSharedBlockRules(info.origin);
    return { origin: info.origin, cleared: true, selectors: [] };
  }
  return {
    applyCollectorBlocks,
    collectorBlockDraftBegin,
    collectorBlockDraftState,
    collectorBlockDraftClear,
    collectorBlockDraftCancel,
    collectorBlockDraftCommit,
    collectorBlockRemove,
    collectorBlockClear,
  };
}
module.exports = { createCollectorBlocks };
