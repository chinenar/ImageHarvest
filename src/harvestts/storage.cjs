'use strict';
const { app } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

function createStorage() {
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

  const harvestAdblockCacheFile = path.join(harvestTsDataDir, 'harvest-adblock-engine.bin');

  const harvestAdblockMetaFile = path.join(harvestTsDataDir, 'harvest-adblock-meta.json');

  async function readHarvestJson(file, fallback) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      return structuredClone(fallback);
    }
  }

  async function writeHarvestJson(file, value) {
    await fs.mkdir(harvestTsDataDir, { recursive: true });
    await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
  }
  return {
    get harvestTsDataDir() {
      return harvestTsDataDir;
    },
    get harvestTsBookmarkFile() {
      return harvestTsBookmarkFile;
    },
    get harvestTsPasswordFile() {
      return harvestTsPasswordFile;
    },
    get harvestTsBlockFile() {
      return harvestTsBlockFile;
    },
    get harvestTsHistoryFile() {
      return harvestTsHistoryFile;
    },
    get harvestTsTabsFile() {
      return harvestTsTabsFile;
    },
    get harvestTsExtensionFile() {
      return harvestTsExtensionFile;
    },
    get harvestTsBrowserSettingsFile() {
      return harvestTsBrowserSettingsFile;
    },
    get harvestTsDownloadsFile() {
      return harvestTsDownloadsFile;
    },
    get harvestTsTranslateSettingsFile() {
      return harvestTsTranslateSettingsFile;
    },
    get harvestAdblockCacheFile() {
      return harvestAdblockCacheFile;
    },
    get harvestAdblockMetaFile() {
      return harvestAdblockMetaFile;
    },
    readHarvestJson,
    writeHarvestJson,
  };
}
module.exports = { createStorage };
