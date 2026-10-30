'use strict';
const { createStorage } = require('../harvestts/storage.cjs');
const { createSession } = require('../harvestts/session.cjs');
const { createTranslation } = require('../harvestts/translation.cjs');
const { createCollectorBrowser } = require('../collector/browser.cjs');
const { createBlockManager } = require('../harvestts/block-manager.cjs');
const { createContextMenu } = require('../harvestts/context-menu.cjs');
const { createCollectorCapture } = require('../collector/capture.cjs');
const { createCollectorCollection } = require('../collector/collection.cjs');
const { createCollectorWorkspaces } = require('../collector/workspaces.cjs');
const { createTabs } = require('../harvestts/tabs.cjs');
const { createOfflineLibrary } = require('../harvestts/offline-library.cjs');
const { createDownloads } = require('../harvestts/downloads.cjs');
const { createOcrLab } = require('../harvestts/ocr-lab.cjs');
const { createHistory } = require('../harvestts/history.cjs');
const { createExtensions } = require('../harvestts/extensions.cjs');
const { createBookmarks } = require('../harvestts/bookmarks.cjs');
const { createCredentials } = require('../harvestts/credentials.cjs');
const { createPageAcquisition } = require('../harvestts/page-acquisition.cjs');
const { createTranslationStages } = require('../harvestts/translation-stages.cjs');
const { createOfflineReader } = require('../harvestts/offline-reader.cjs');
const { createIpc } = require('../harvestts/ipc.cjs');
const { createBlocks } = require('../harvestts/blocks.cjs');
const { createBlockScripts } = require('../shared/block-scripts.cjs');
const { createCollectorBlocks } = require('../collector/blocks.cjs');
const { createCollectorNavigation } = require('../collector/navigation.cjs');
const { createCollectorFiles } = require('../collector/files.cjs');

const { createCollector } = require('../collector/index.cjs');
const { createHarvestTS } = require('../harvestts/index.cjs');

// Stable service references keep callbacks live when a feature replaces its state.
function createFeatures(host) {
  // Initialize settings before the Collector browser reads them. Other cross-feature
  // calls run through callbacks after all service interfaces have been connected.
  const factories = {
    storage: createStorage,
    session: createSession,
    translation: createTranslation,
    collectorBrowser: createCollectorBrowser,
    blockManager: createBlockManager,
    contextMenu: createContextMenu,
    collectorCapture: createCollectorCapture,
    collectorCollection: createCollectorCollection,
    collectorWorkspaces: createCollectorWorkspaces,
    tabs: createTabs,
    offlineLibrary: createOfflineLibrary,
    downloads: createDownloads,
    ocrLab: createOcrLab,
    history: createHistory,
    extensions: createExtensions,
    bookmarks: createBookmarks,
    credentials: createCredentials,
    pageAcquisition: createPageAcquisition,
    translationStages: createTranslationStages,
    offlineReader: createOfflineReader,
    ipc: createIpc,
    blocks: createBlocks,
    blockScripts: createBlockScripts,
    collectorBlocks: createCollectorBlocks,
    collectorNavigation: createCollectorNavigation,
    collectorFiles: createCollectorFiles,
  };
  const services = { host };
  for (const name of Object.keys(factories)) services[name] = {};
  for (const [name, factory] of Object.entries(factories)) {
    Object.defineProperties(services[name], Object.getOwnPropertyDescriptors(factory(services)));
  }
  services.collector = createCollector(services);
  services.harvestTS = createHarvestTS(services);
  return services;
}
module.exports = { createFeatures };
