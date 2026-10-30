'use strict';
const { dialog } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function createExtensions({ session: sessionService, storage: storageService, host: hostService }) {
  async function harvestTsExtensionData() {
    const data = await storageService.readHarvestJson(storageService.harvestTsExtensionFile, {
      version: 1,
      items: [],
    });
    return { version: 1, items: Array.isArray(data.items) ? data.items : [] };
  }

  async function writeHarvestExtensions(data) {
    await storageService.writeHarvestJson(storageService.harvestTsExtensionFile, data);
  }

  async function loadSavedHarvestExtensions() {
    const ses = sessionService.configureHarvestTsSession(),
      data = await harvestTsExtensionData();
    let changed = false;
    for (const item of data.items) {
      item.error = '';
      if (item.enabled === false || !item.path) continue;
      try {
        const ext = await ses.loadExtension(item.path, {
          allowFileAccess: true,
        });
        item.id = ext.id;
        item.name = ext.name || item.name;
        item.version = ext.version || item.version;
      } catch (error) {
        item.error = error.message;
        changed = true;
      }
    }
    if (changed) await writeHarvestExtensions(data);
    return data.items;
  }

  async function harvestTsExtensionList() {
    const data = await harvestTsExtensionData();
    const loaded = new Set(
      sessionService
        .configureHarvestTsSession()
        .getAllExtensions()
        .map((x) => x.id),
    );
    return data.items.map((item) => ({
      ...item,
      loaded: loaded.has(item.id),
      path: undefined,
    }));
  }

  async function harvestTsExtensionInstall(input = {}) {
    let source = '';
    if (hostService.testMode && typeof input.sourcePath === 'string')
      source = path.resolve(input.sourcePath);
    else {
      const result = await dialog.showOpenDialog(hostService.mainWindow, {
        title: 'ติดตั้ง Extension แบบ unpacked',
        properties: ['openDirectory'],
      });
      if (result.canceled || !result.filePaths[0]) return { cancelled: true };
      source = result.filePaths[0];
    }
    const manifestPath = path.join(source, 'manifest.json');
    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    } catch {
      throw new Error('โฟลเดอร์นี้ไม่มี manifest.json ที่ถูกต้อง');
    }
    if (![2, 3].includes(Number(manifest.manifest_version)))
      throw new Error('รองรับ Chrome Extension Manifest V2/V3 เท่านั้น');
    const installRoot = path.join(storageService.harvestTsDataDir, 'extensions');
    await fs.mkdir(installRoot, { recursive: true });
    const dest = path.join(installRoot, randomUUID());
    await fs.cp(source, dest, { recursive: true, errorOnExist: true });
    const ses = sessionService.configureHarvestTsSession();
    try {
      const ext = await ses.loadExtension(dest, { allowFileAccess: true });
      const data = await harvestTsExtensionData();
      data.items.push({
        id: ext.id,
        name: ext.name || manifest.name || 'Extension',
        version: ext.version || manifest.version || '',
        path: dest,
        enabled: true,
        installedAt: Date.now(),
        error: '',
      });
      await writeHarvestExtensions(data);
      return {
        cancelled: false,
        item: {
          id: ext.id,
          name: ext.name || manifest.name || 'Extension',
          version: ext.version || manifest.version || '',
          enabled: true,
          loaded: true,
        },
      };
    } catch (error) {
      await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async function harvestTsExtensionToggle(input = {}) {
    const data = await harvestTsExtensionData(),
      item = data.items.find((x) => x.id === String(input.id || ''));
    if (!item) throw new Error('ไม่พบ Extension');
    const ses = sessionService.configureHarvestTsSession(),
      enabled = input.enabled !== false;
    if (!enabled) {
      if (item.id) ses.removeExtension(item.id);
      item.enabled = false;
      item.error = '';
    } else {
      try {
        const ext = await ses.loadExtension(item.path, {
          allowFileAccess: true,
        });
        item.id = ext.id;
        item.name = ext.name || item.name;
        item.version = ext.version || item.version;
        item.enabled = true;
        item.error = '';
      } catch (error) {
        item.enabled = false;
        item.error = error.message;
      }
    }
    await writeHarvestExtensions(data);
    return harvestTsExtensionList();
  }

  async function harvestTsExtensionRemove(input = {}) {
    const data = await harvestTsExtensionData(),
      index = data.items.findIndex((x) => x.id === String(input.id || ''));
    if (index < 0) throw new Error('ไม่พบ Extension');
    const [item] = data.items.splice(index, 1);
    if (item.id) sessionService.configureHarvestTsSession().removeExtension(item.id);
    if (item.path) await fs.rm(item.path, { recursive: true, force: true }).catch(() => {});
    await writeHarvestExtensions(data);
    return harvestTsExtensionList();
  }
  return {
    loadSavedHarvestExtensions,
    harvestTsExtensionList,
    harvestTsExtensionInstall,
    harvestTsExtensionToggle,
    harvestTsExtensionRemove,
  };
}
module.exports = { createExtensions };
