'use strict';
const { randomUUID } = require('node:crypto');

function createBookmarks({ storage: storageService, tabs: tabsService }) {
  async function harvestTsBookmarkData() {
    const raw = await storageService.readHarvestJson(storageService.harvestTsBookmarkFile, {
      version: 2,
      folders: [],
      items: [],
    });
    const folders = Array.isArray(raw.folders)
      ? raw.folders.filter((x) => x && x.id && typeof x.name === 'string')
      : [];
    const folderIds = new Set(folders.map((x) => x.id));
    const items = (Array.isArray(raw.items) ? raw.items : [])
      .filter((x) => x && x.id && /^https?:\/\//i.test(x.url || ''))
      .map((x) => ({
        ...x,
        folderId: folderIds.has(x.folderId) ? x.folderId : null,
      }))
      .slice(0, 2000);
    return { version: 2, folders, items };
  }

  async function writeHarvestBookmarkData(data) {
    await storageService.writeHarvestJson(storageService.harvestTsBookmarkFile, {
      version: 2,
      folders: data.folders || [],
      items: data.items || [],
    });
  }

  async function harvestTsBookmarks() {
    const data = await harvestTsBookmarkData();
    const names = new Map(data.folders.map((x) => [x.id, x.name]));
    return data.items.map((x) => ({
      ...x,
      folderName: x.folderId ? names.get(x.folderId) || '' : '',
    }));
  }

  async function harvestTsBookmarkModel() {
    const data = await harvestTsBookmarkData();
    return { folders: data.folders, items: await harvestTsBookmarks() };
  }

  async function harvestTsBookmarkStatus(input = {}) {
    const url = String(input.url || '').trim();
    const data = await harvestTsBookmarkData();
    const item = data.items.find((x) => x.url === url) || null;
    return { saved: Boolean(item), item, folders: data.folders };
  }

  async function harvestTsBookmarkAdd(input = {}) {
    const page = tabsService.harvestTsPageInfo(
      tabsService.harvestTsTabs.get(String(input.id || tabsService.activeHarvestTsId)),
    );
    const data = await harvestTsBookmarkData();
    const folderId =
      input.folderId == null || input.folderId === '' ? null : String(input.folderId);
    if (folderId && !data.folders.some((x) => x.id === folderId))
      throw new Error('ไม่พบโฟลเดอร์ Bookmark');
    const now = Date.now();
    let existing = data.items.find((x) => x.url === page.url);
    if (existing) {
      existing.title = page.title;
      existing.folderId = folderId;
      existing.updatedAt = now;
    } else {
      existing = {
        id: randomUUID(),
        title: page.title,
        url: page.url,
        folderId,
        createdAt: now,
        updatedAt: now,
      };
      data.items.unshift(existing);
    }
    await writeHarvestBookmarkData(data);
    return {
      saved: true,
      item: existing,
      folders: data.folders,
      items: await harvestTsBookmarks(),
    };
  }

  async function harvestTsBookmarkRemove(input = {}) {
    const data = await harvestTsBookmarkData(),
      id = String(input.id || '');
    data.items = data.items.filter((x) => x.id !== id);
    await writeHarvestBookmarkData(data);
    return { items: await harvestTsBookmarks(), folders: data.folders };
  }

  async function harvestTsBookmarkFolderCreate(input = {}) {
    const name = String(input.name || '')
      .trim()
      .replace(/\s+/g, ' ');
    if (!name) throw new Error('กรุณาตั้งชื่อโฟลเดอร์');
    if (name.length > 80) throw new Error('ชื่อโฟลเดอร์ยาวเกินไป');
    const data = await harvestTsBookmarkData();
    const duplicate = data.folders.find(
      (x) => x.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    );
    if (duplicate) return { folder: duplicate, folders: data.folders };
    const folder = { id: randomUUID(), name, createdAt: Date.now() };
    data.folders.push(folder);
    await writeHarvestBookmarkData(data);
    return { folder, folders: data.folders };
  }

  async function harvestTsBookmarkFolderRemove(input = {}) {
    const id = String(input.id || '');
    const data = await harvestTsBookmarkData();
    data.folders = data.folders.filter((x) => x.id !== id);
    for (const item of data.items) if (item.folderId === id) item.folderId = null;
    await writeHarvestBookmarkData(data);
    return harvestTsBookmarkModel();
  }
  return {
    harvestTsBookmarks,
    harvestTsBookmarkModel,
    harvestTsBookmarkStatus,
    harvestTsBookmarkAdd,
    harvestTsBookmarkRemove,
    harvestTsBookmarkFolderCreate,
    harvestTsBookmarkFolderRemove,
  };
}
module.exports = { createBookmarks };
