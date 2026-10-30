'use strict';
const { app, shell } = require('electron');
const fsSync = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function createDownloads({ storage: storageService, tabs: tabsService, host: hostService }) {
  let harvestDownloadsLoaded = false;

  let harvestDownloadWriteTimer = null;

  const harvestDownloadRecords = new Map();

  const harvestLiveDownloads = new Map();

  function harvestDownloadDirectory() {
    return hostService.testMode
      ? path.join(app.getPath('userData'), 'Downloads')
      : app.getPath('downloads');
  }

  function harvestDownloadFilename(raw = 'download') {
    const base = path
      .basename(String(raw || 'download'))
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .replace(/[. ]+$/, '')
      .slice(0, 180);
    return base || 'download';
  }

  function uniqueHarvestDownloadPath(filename) {
    const dir = harvestDownloadDirectory(),
      parsed = path.parse(harvestDownloadFilename(filename));
    let candidate = path.join(dir, parsed.base),
      n = 1;
    while (fsSync.existsSync(candidate) && n < 10000) {
      candidate = path.join(dir, `${parsed.name || 'download'} (${n++})${parsed.ext}`);
    }
    return candidate;
  }

  async function loadHarvestDownloads() {
    if (harvestDownloadsLoaded) return;
    const data = await storageService.readHarvestJson(storageService.harvestTsDownloadsFile, {
      version: 1,
      items: [],
    });
    for (const row of Array.isArray(data.items) ? data.items : []) {
      if (!row?.id) continue;
      const record = { ...row };
      if (record.state === 'progressing') record.state = 'interrupted';
      harvestDownloadRecords.set(record.id, record);
    }
    harvestDownloadsLoaded = true;
  }

  function publicHarvestDownload(record) {
    if (!record) return null;
    return {
      id: record.id,
      filename: record.filename || 'download',
      url: record.url || '',
      mimeType: record.mimeType || '',
      state: record.state || 'interrupted',
      receivedBytes: Number(record.receivedBytes) || 0,
      totalBytes: Number(record.totalBytes) || 0,
      startedAt: Number(record.startedAt) || 0,
      updatedAt: Number(record.updatedAt) || 0,
      exists: Boolean(record.savePath && fsSync.existsSync(record.savePath)),
      active: harvestLiveDownloads.has(record.id),
    };
  }

  async function persistHarvestDownloadsNow() {
    clearTimeout(harvestDownloadWriteTimer);
    harvestDownloadWriteTimer = null;
    const items = [...harvestDownloadRecords.values()]
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
      .slice(0, 1000);
    await storageService.writeHarvestJson(storageService.harvestTsDownloadsFile, {
      version: 1,
      items,
    });
  }

  function saveHarvestDownloadsSync() {
    if (!harvestDownloadsLoaded && !harvestDownloadRecords.size) return;
    try {
      fsSync.mkdirSync(storageService.harvestTsDataDir, { recursive: true });
      const items = [...harvestDownloadRecords.values()]
        .map((row) => ({
          ...row,
          state: harvestLiveDownloads.has(row.id) ? 'interrupted' : row.state,
          updatedAt: harvestLiveDownloads.has(row.id) ? Date.now() : row.updatedAt,
        }))
        .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
        .slice(0, 1000);
      fsSync.writeFileSync(
        storageService.harvestTsDownloadsFile,
        JSON.stringify({ version: 1, items }, null, 2),
        'utf8',
      );
    } catch {}
  }

  function scheduleHarvestDownloadWrite(delay = 160) {
    clearTimeout(harvestDownloadWriteTimer);
    harvestDownloadWriteTimer = setTimeout(
      () => persistHarvestDownloadsNow().catch(() => {}),
      delay,
    );
  }

  function emitHarvestDownloadsChanged() {
    const payload = {
      items: [...harvestDownloadRecords.values()]
        .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
        .map(publicHarvestDownload),
    };
    for (const tab of tabsService.harvestTsTabs.values()) {
      if (tab?.kind === 'downloads' && !tab.view.webContents.isDestroyed()) {
        try {
          tab.view.webContents.send('harvest-internal:downloads-changed', payload);
        } catch {}
      }
    }
  }

  async function harvestTsDownloadList() {
    await loadHarvestDownloads();
    return {
      items: [...harvestDownloadRecords.values()]
        .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
        .map(publicHarvestDownload),
    };
  }

  async function harvestTsDownloadRemove(input = {}) {
    await loadHarvestDownloads();
    const id = String(input.id || ''),
      live = harvestLiveDownloads.get(id);
    if (live) {
      try {
        live.cancel();
      } catch {}
      harvestLiveDownloads.delete(id);
    }
    harvestDownloadRecords.delete(id);
    await persistHarvestDownloadsNow();
    emitHarvestDownloadsChanged();
    return harvestTsDownloadList();
  }

  async function harvestTsDownloadClear() {
    await loadHarvestDownloads();
    for (const [id, record] of [...harvestDownloadRecords]) {
      if (!harvestLiveDownloads.has(id) && record.state !== 'progressing')
        harvestDownloadRecords.delete(id);
    }
    await persistHarvestDownloadsNow();
    emitHarvestDownloadsChanged();
    return harvestTsDownloadList();
  }

  async function harvestTsDownloadOpen(input = {}) {
    await loadHarvestDownloads();
    const record = harvestDownloadRecords.get(String(input.id || ''));
    if (!record?.savePath || !fsSync.existsSync(record.savePath))
      throw new Error('ไม่พบไฟล์ดาวน์โหลดแล้ว');
    const error = await shell.openPath(record.savePath);
    if (error) throw new Error(error);
    return true;
  }

  async function harvestTsDownloadShow(input = {}) {
    await loadHarvestDownloads();
    const record = harvestDownloadRecords.get(String(input.id || ''));
    if (!record?.savePath || !fsSync.existsSync(record.savePath))
      throw new Error('ไม่พบไฟล์ดาวน์โหลดแล้ว');
    shell.showItemInFolder(record.savePath);
    return true;
  }

  async function harvestTsDownloadCancel(input = {}) {
    await loadHarvestDownloads();
    const id = String(input.id || ''),
      item = harvestLiveDownloads.get(id);
    if (!item) return { cancelled: false };
    try {
      item.cancel();
    } catch {}
    return { cancelled: true };
  }

  function configureHarvestDownloads(ses) {
    ses.on('will-download', (_event, item) => {
      const id = randomUUID(),
        now = Date.now(),
        savePath = uniqueHarvestDownloadPath(item.getFilename());
      try {
        fsSync.mkdirSync(path.dirname(savePath), { recursive: true });
      } catch {}
      try {
        item.setSavePath(savePath);
      } catch {}
      const record = {
        id,
        filename: path.basename(savePath),
        url: item.getURL() || '',
        mimeType: item.getMimeType?.() || '',
        savePath,
        state: 'progressing',
        receivedBytes: Number(item.getReceivedBytes?.()) || 0,
        totalBytes: Number(item.getTotalBytes?.()) || 0,
        startedAt: now,
        updatedAt: now,
      };
      harvestDownloadRecords.set(id, record);
      harvestLiveDownloads.set(id, item);
      loadHarvestDownloads()
        .then(() => {
          harvestDownloadRecords.set(id, record);
          scheduleHarvestDownloadWrite(0);
          emitHarvestDownloadsChanged();
        })
        .catch(() => {});
      item.on('updated', (_e, state) => {
        record.state = state === 'interrupted' ? 'interrupted' : 'progressing';
        record.receivedBytes = Number(item.getReceivedBytes?.()) || record.receivedBytes || 0;
        record.totalBytes = Number(item.getTotalBytes?.()) || record.totalBytes || 0;
        record.updatedAt = Date.now();
        emitHarvestDownloadsChanged();
      });
      item.once('done', (_e, state) => {
        record.state = state || 'interrupted';
        record.receivedBytes = Number(item.getReceivedBytes?.()) || record.receivedBytes || 0;
        record.totalBytes = Number(item.getTotalBytes?.()) || record.totalBytes || 0;
        record.updatedAt = Date.now();
        harvestLiveDownloads.delete(id);
        loadHarvestDownloads()
          .then(() => {
            harvestDownloadRecords.set(id, record);
            scheduleHarvestDownloadWrite(0);
            emitHarvestDownloadsChanged();
          })
          .catch(() => {});
      });
    });
  }
  return {
    saveHarvestDownloadsSync,
    harvestTsDownloadList,
    harvestTsDownloadRemove,
    harvestTsDownloadClear,
    harvestTsDownloadOpen,
    harvestTsDownloadShow,
    harvestTsDownloadCancel,
    configureHarvestDownloads,
  };
}
module.exports = { createDownloads };
