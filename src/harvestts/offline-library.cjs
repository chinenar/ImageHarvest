'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { overlayPage } = require('../translation-overlay.cjs');
const { regionStyleKey } = require('../region-style-store.cjs');
const { readerDocumentKey } = require('../reader-document.cjs');

function createOfflineLibrary({ storage: storageService, translation: translationService }) {
  const harvestTsOfflineDir = path.join(storageService.harvestTsDataDir, 'offline-library');

  const harvestTsOfflineIndexFile = path.join(harvestTsOfflineDir, 'index.json');

  const harvestOfflineExportSessions = new Map();

  let harvestOfflineWriteQueue = Promise.resolve();

  function harvestOfflineDocumentKey(url) {
    return readerDocumentKey(String(url || ''));
  }

  function harvestOfflineProjectId(url) {
    return createHash('sha256').update(harvestOfflineDocumentKey(url)).digest('hex').slice(0, 24);
  }

  async function harvestOfflineReadJson(file, fallback) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return fallback;
      throw error;
    }
  }

  async function harvestOfflineWriteJson(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
      for (let n = 0; ; n++) {
        try {
          await fs.rename(temp, file);
          break;
        } catch (error) {
          if (n >= 4 || !['EPERM', 'EBUSY', 'EACCES', 'EEXIST'].includes(error.code)) throw error;
          await fs.rm(file, { force: true }).catch(() => {});
          await new Promise((r) => setTimeout(r, 45 * (n + 1)));
        }
      }
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }

  function harvestOfflineQueued(task) {
    const next = harvestOfflineWriteQueue.then(task);
    harvestOfflineWriteQueue = next.catch(() => {});
    return next;
  }

  function harvestOfflineSeriesInfo(url, title = '') {
    let display = String(title || '')
      .trim()
      .replace(/^\s*\d+\s*\|\s*/, '')
      .replace(/^\s*Manga:\s*/i, '');
    display = display.replace(/\s*[-|]\s*MangaDex\s*$/i, '').trim();
    const prefix = display.match(/^(?:Chapter|Ch\.?)[\s#:_-]*\d+(?:\.\d+)*(?:\s*[-–—|:]\s*)(.+)$/i);
    if (prefix) display = prefix[1].trim();
    display = display.replace(/\s+(?:Chapter|Ch\.?)[\s#:_-]*\d+(?:\.\d+)*\b.*$/i, '').trim();
    display = display.replace(/\s*[-–—|:]\s*$/, '').trim();
    let sourceKey = '';
    try {
      const u = new URL(url),
        decoded = decodeURIComponent(u.pathname);
      const m = decoded.match(/^(.*?)(?:[-_/](?:chapter|chap|ch)[-_ ]?\d+(?:\.\d+)?\b)/i);
      if (m && m[1].length > 1) sourceKey = u.hostname.toLowerCase() + m[1].toLowerCase();
    } catch {}
    if (!display) {
      try {
        display = new URL(url).hostname.replace(/^www\./, '');
      } catch {
        display = 'Offline Project';
      }
    }
    const normalized = display
      .toLowerCase()
      .replace(/[\s\u00a0]+/g, ' ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
    const key = sourceKey || normalized || harvestOfflineDocumentKey(url);
    return {
      id: 'series-' + createHash('sha256').update(key).digest('hex').slice(0, 16),
      title: display,
    };
  }

  async function harvestOfflineIndex() {
    const value = await harvestOfflineReadJson(harvestTsOfflineIndexFile, {
      version: 2,
      items: [],
      projects: [],
      groups: [],
    });
    const items = Array.isArray(value.items)
      ? value.items.filter(Boolean).map((row) => ({ ...row }))
      : [];
    const groups = Array.isArray(value.groups)
      ? value.groups.filter((x) => x && x.id && x.title).map((x) => ({ ...x }))
      : [];
    const projects = Array.isArray(value.projects)
      ? value.projects.filter((x) => x && x.id && x.title).map((x) => ({ ...x }))
      : [];
    const byId = new Map(projects.map((x) => [x.id, x]));
    for (const row of items) {
      if (!row.projectId) {
        const info = harvestOfflineSeriesInfo(row.url, row.title);
        row.projectId = info.id;
        if (!byId.has(info.id)) {
          const project = {
            id: info.id,
            title: info.title,
            groupId: '',
            manual: false,
            createdAt: Number(row.createdAt) || Date.now(),
            updatedAt: Number(row.updatedAt) || Date.now(),
          };
          projects.push(project);
          byId.set(project.id, project);
        }
      } else if (!byId.has(row.projectId)) {
        const info = harvestOfflineSeriesInfo(row.url, row.title),
          project = {
            id: row.projectId,
            title: info.title,
            groupId: '',
            manual: false,
            createdAt: Number(row.createdAt) || Date.now(),
            updatedAt: Number(row.updatedAt) || Date.now(),
          };
        projects.push(project);
        byId.set(project.id, project);
      }
    }
    return { version: 2, items, projects, groups };
  }

  async function harvestOfflineWriteIndex(index) {
    await harvestOfflineWriteJson(harvestTsOfflineIndexFile, {
      version: 2,
      items: index.items || [],
      projects: index.projects || [],
      groups: index.groups || [],
    });
  }

  function harvestOfflineSafeTitle(value, fallback = 'โปรเจกต์') {
    const title = String(value || '')
      .replace(/[\x00-\x1f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    if (!title) throw Error('กรุณาใส่ชื่อ' + fallback);
    return title;
  }

  function harvestOfflineChapterNumber(row) {
    const text = String(row?.title || '') + ' ' + String(row?.url || '');
    const m = text.match(/(?:chapter|chap|ch)[\s_/#-]*(\d+(?:\.\d+)?)/i);
    return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
  }

  function harvestOfflineNextHomeOrder(index) {
    const values = [
      ...index.groups.map((x) => Number(x.homeOrder)),
      ...index.projects.filter((x) => !x.groupId).map((x) => Number(x.homeOrder)),
    ].filter(Number.isFinite);
    return values.length ? Math.max(...values) + 1 : 0;
  }

  function harvestOfflineNextGroupOrder(index, groupId) {
    const values = index.projects
      .filter((x) => x.groupId === groupId)
      .map((x) => Number(x.groupOrder))
      .filter(Number.isFinite);
    return values.length ? Math.max(...values) + 1 : 0;
  }

  async function harvestOfflineLibraryList() {
    const index = await harvestOfflineIndex(),
      items = [...index.items];
    for (const row of items) {
      if (row.coverFile) continue;
      try {
        const saved = await harvestOfflineReadProject(row.id),
          page = (saved.manifest.pages || []).find((p) => p?.file && !p.error);
        if (page) {
          row.coverFile = page.file;
          row.coverMime = page.mime || '';
        }
      } catch {}
    }
    let fallbackHome =
      Math.max(
        -1,
        ...index.groups.map((x) => Number(x.homeOrder)).filter(Number.isFinite),
        ...index.projects.map((x) => Number(x.homeOrder)).filter(Number.isFinite),
      ) + 1;
    const stories = index.projects
      .map((story, storyIndex) => {
        const chapters = items
          .filter((x) => x.projectId === story.id)
          .sort(
            (a, b) =>
              harvestOfflineChapterNumber(a) - harvestOfflineChapterNumber(b) ||
              Number(a.createdAt || 0) - Number(b.createdAt || 0),
          );
        if (!chapters.length) return null;
        const latest = [...chapters].sort(
          (a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0),
        )[0];
        const homeOrder = Number.isFinite(Number(story.homeOrder))
          ? Number(story.homeOrder)
          : fallbackHome++;
        const groupOrder = Number.isFinite(Number(story.groupOrder))
          ? Number(story.groupOrder)
          : storyIndex;
        return {
          ...story,
          homeOrder,
          groupOrder,
          chapterCount: chapters.length,
          pageCount: chapters.reduce((n, x) => n + (Number(x.pages) || 0), 0),
          sizeBytes: chapters.reduce((n, x) => n + (Number(x.sizeBytes) || 0), 0),
          updatedAt: Math.max(
            Number(story.updatedAt) || 0,
            ...chapters.map((x) => Number(x.updatedAt) || 0),
          ),
          coverItemId: latest?.id || '',
          coverFile: latest?.coverFile || '',
          chapters,
        };
      })
      .filter(Boolean);
    const groups = index.groups.map((group, groupIndex) => {
      const members = stories
        .filter((x) => x.groupId === group.id)
        .sort(
          (a, b) => Number(a.groupOrder) - Number(b.groupOrder) || a.title.localeCompare(b.title),
        );
      const homeOrder = Number.isFinite(Number(group.homeOrder))
        ? Number(group.homeOrder)
        : fallbackHome++;
      return {
        ...group,
        homeOrder,
        storyCount: members.length,
        pageCount: members.reduce((n, x) => n + x.pageCount, 0),
        sizeBytes: members.reduce((n, x) => n + x.sizeBytes, 0),
        stories: members,
        updatedAt: Math.max(
          Number(group.updatedAt) || 0,
          ...members.map((x) => Number(x.updatedAt) || 0),
        ),
      };
    });
    const home = [
      ...groups.map((x) => ({ type: 'group', id: x.id, order: x.homeOrder })),
      ...stories
        .filter((x) => !x.groupId)
        .map((x) => ({ type: 'story', id: x.id, order: x.homeOrder })),
    ].sort((a, b) => Number(a.order) - Number(b.order) || a.id.localeCompare(b.id));
    return { version: 3, groups, stories, items, home };
  }

  async function harvestOfflineGroupCreate(input = {}) {
    const title = harvestOfflineSafeTitle(input.title, 'กลุ่ม');
    return harvestOfflineQueued(async () => {
      const index = await harvestOfflineIndex(),
        group = {
          id: 'group-' + randomUUID(),
          title,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          homeOrder: harvestOfflineNextHomeOrder(index),
        };
      index.groups.push(group);
      await harvestOfflineWriteIndex(index);
      return group;
    });
  }

  async function harvestOfflineGroupRename(input = {}) {
    const id = String(input.id || ''),
      title = harvestOfflineSafeTitle(input.title, 'กลุ่ม');
    return harvestOfflineQueued(async () => {
      const index = await harvestOfflineIndex(),
        group = index.groups.find((x) => x.id === id);
      if (!group) throw Error('ไม่พบกลุ่ม');
      group.title = title;
      group.updatedAt = Date.now();
      await harvestOfflineWriteIndex(index);
      return group;
    });
  }

  async function harvestOfflineGroupRemove(input = {}) {
    const id = String(input.id || '');
    return harvestOfflineQueued(async () => {
      const index = await harvestOfflineIndex();
      index.groups = index.groups.filter((x) => x.id !== id);
      let order = harvestOfflineNextHomeOrder(index);
      for (const p of index.projects
        .filter((x) => x.groupId === id)
        .sort((a, b) => Number(a.groupOrder || 0) - Number(b.groupOrder || 0))) {
        p.groupId = '';
        p.groupOrder = 0;
        p.homeOrder = order++;
        p.updatedAt = Date.now();
      }
      await harvestOfflineWriteIndex(index);
      return true;
    });
  }

  async function harvestOfflineLibraryReorder(input = {}) {
    const scope = String(input.scope || ''),
      ids = Array.isArray(input.ids) ? input.ids.map(String) : [];
    return harvestOfflineQueued(async () => {
      const index = await harvestOfflineIndex();
      if (scope === 'home') {
        const valid = new Map();
        for (const g of index.groups) valid.set('group:' + g.id, g);
        for (const story of index.projects.filter((x) => !x.groupId))
          valid.set('story:' + story.id, story);
        let order = 0;
        const seen = new Set();
        for (const key of ids) {
          const row = valid.get(key);
          if (!row || seen.has(key)) continue;
          row.homeOrder = order++;
          seen.add(key);
        }
        const rest = [...valid.entries()]
          .filter(([key]) => !seen.has(key))
          .sort((a, b) => Number(a[1].homeOrder || 1e9) - Number(b[1].homeOrder || 1e9));
        for (const [, row] of rest) row.homeOrder = order++;
      } else if (scope === 'group') {
        const groupId = String(input.groupId || '');
        if (!index.groups.some((x) => x.id === groupId)) throw Error('ไม่พบกลุ่ม');
        const valid = new Map(
          index.projects.filter((x) => x.groupId === groupId).map((x) => [x.id, x]),
        );
        let order = 0;
        const seen = new Set();
        for (const id of ids) {
          const row = valid.get(id);
          if (!row || seen.has(id)) continue;
          row.groupOrder = order++;
          seen.add(id);
        }
        const rest = [...valid.entries()]
          .filter(([id]) => !seen.has(id))
          .sort((a, b) => Number(a[1].groupOrder || 1e9) - Number(b[1].groupOrder || 1e9));
        for (const [, row] of rest) row.groupOrder = order++;
      } else throw Error('รูปแบบการเรียงไม่ถูกต้อง');
      await harvestOfflineWriteIndex(index);
      return true;
    });
  }

  async function harvestOfflineLibraryProjectCreate(input = {}) {
    const title = harvestOfflineSafeTitle(input.title, 'โปรเจกต์'),
      groupId = String(input.groupId || '');
    return harvestOfflineQueued(async () => {
      const index = await harvestOfflineIndex();
      if (groupId && !index.groups.some((x) => x.id === groupId)) throw Error('ไม่พบกลุ่มที่เลือก');
      const project = {
        id: 'series-' + randomUUID(),
        title,
        groupId,
        manual: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      index.projects.push(project);
      await harvestOfflineWriteIndex(index);
      return project;
    });
  }

  async function harvestOfflineLibraryProjectRename(input = {}) {
    const id = String(input.id || ''),
      title = harvestOfflineSafeTitle(input.title, 'โปรเจกต์');
    return harvestOfflineQueued(async () => {
      const index = await harvestOfflineIndex(),
        project = index.projects.find((x) => x.id === id);
      if (!project) throw Error('ไม่พบโปรเจกต์');
      project.title = title;
      project.updatedAt = Date.now();
      await harvestOfflineWriteIndex(index);
      return project;
    });
  }

  async function harvestOfflineLibraryProjectGroup(input = {}) {
    const id = String(input.id || ''),
      groupId = String(input.groupId || '');
    return harvestOfflineQueued(async () => {
      const index = await harvestOfflineIndex(),
        story = index.projects.find((x) => x.id === id);
      if (!story) throw Error('ไม่พบเรื่อง');
      if (groupId && !index.groups.some((x) => x.id === groupId)) throw Error('ไม่พบกลุ่มที่เลือก');
      if (story.groupId === groupId) return story;
      story.groupId = groupId;
      story.updatedAt = Date.now();
      if (groupId) {
        story.groupOrder = harvestOfflineNextGroupOrder(index, groupId);
      } else {
        story.homeOrder = harvestOfflineNextHomeOrder(index);
        story.groupOrder = 0;
      }
      await harvestOfflineWriteIndex(index);
      return story;
    });
  }

  async function harvestOfflineItemProject(input = {}) {
    const id = String(input.id || ''),
      projectId = String(input.projectId || '');
    return harvestOfflineQueued(async () => {
      const index = await harvestOfflineIndex(),
        item = index.items.find((x) => x.id === id),
        project = index.projects.find((x) => x.id === projectId);
      if (!item) throw Error('ไม่พบตอนที่บันทึกไว้');
      if (!project) throw Error('ไม่พบโปรเจกต์');
      item.projectId = projectId;
      item.updatedAt = Date.now();
      project.updatedAt = item.updatedAt;
      await harvestOfflineWriteIndex(index);
      return true;
    });
  }

  async function harvestOfflineCover(itemId) {
    const saved = await harvestOfflineReadProject(String(itemId || '')),
      page = (saved.manifest.pages || []).find((p) => p?.file && !p.error);
    if (!page) throw Error('ไม่พบภาพปก');
    const bytes = await fs.readFile(path.join(saved.dir, page.file));
    return {
      mime: page.mime || 'application/octet-stream',
      bytes: new Uint8Array(bytes),
      file: page.file,
    };
  }

  function harvestOfflineProjectDir(id) {
    if (!/^[0-9a-f]{24}$/.test(String(id || ''))) throw Error('Offline project ID ไม่ถูกต้อง');
    return path.join(harvestTsOfflineDir, String(id));
  }

  async function harvestOfflineReadProject(id) {
    const dir = harvestOfflineProjectDir(id);
    const [project, manifest] = await Promise.all([
      harvestOfflineReadJson(path.join(dir, 'project.json'), null),
      harvestOfflineReadJson(path.join(dir, 'manifest.json'), null),
    ]);
    if (!project || !manifest || project.id !== id || !Array.isArray(manifest.pages))
      throw Error('ไม่พบงาน Offline นี้');
    return { dir, project, manifest };
  }

  async function harvestOfflineFindByUrl(url) {
    const key = harvestOfflineDocumentKey(url),
      index = await harvestOfflineIndex();
    return index.items.find((row) => row.documentKey === key) || null;
  }

  async function harvestOfflineList() {
    return harvestOfflineLibraryList();
  }

  async function harvestOfflineSave(tab) {
    if (!tab || tab.kind !== 'web' || tab.view.webContents.isDestroyed())
      throw Error('เปิดหน้าเว็บที่แปลแล้วก่อนบันทึก Offline');
    const currentUrl = tab.view.webContents.getURL() || tab.url || '';
    let job = translationService.harvestTranslationJobFor(tab);
    if (job?.running) throw Error('รอ Harvest Translate ทำงานให้เสร็จก่อน');
    if (!job?.manifest?.pages) {
      const existing = await harvestOfflineFindByUrl(currentUrl);
      if (existing) return existing;
      throw Error('ยังไม่มีงาน Harvest Translate สำหรับหน้านี้');
    }
    if (
      !translationService.sameHarvestTranslationPage(
        job.sourceUrl || job.manifest.source?.url,
        currentUrl,
      )
    )
      throw Error('งานแปลปัจจุบันไม่ได้เป็นของหน้าเว็บนี้');
    const documentUrl = job.manifest.source?.url || job.sourceUrl || currentUrl,
      documentKey = harvestOfflineDocumentKey(documentUrl),
      id = harvestOfflineProjectId(documentUrl);
    return harvestOfflineQueued(async () => {
      const index = await harvestOfflineIndex(),
        old = index.items.find((row) => row.id === id),
        createdAt = old?.createdAt || Date.now(),
        updatedAt = Date.now();
      const series = harvestOfflineSeriesInfo(
          documentUrl,
          job.manifest.source?.title || tab.view.webContents.getTitle() || '',
        ),
        projectId = old?.projectId || series.id;
      let libraryProject = index.projects.find((x) => x.id === projectId);
      if (!libraryProject) {
        libraryProject = {
          id: projectId,
          title: series.title,
          groupId: '',
          manual: false,
          createdAt,
          updatedAt,
          homeOrder: harvestOfflineNextHomeOrder(index),
          groupOrder: 0,
        };
        index.projects.push(libraryProject);
      } else libraryProject.updatedAt = updatedAt;
      const target = harvestOfflineProjectDir(id),
        temp = target + '.tmp-' + randomUUID();
      await fs.mkdir(temp, { recursive: true });
      let sizeBytes = 0;
      const pages = job.manifest.pages.filter((p) => p?.file && !p.error);
      try {
        for (const page of pages) {
          const name = path.basename(String(page.file || ''));
          if (name !== page.file) throw Error('ชื่อไฟล์หน้า Offline ไม่ถูกต้อง');
          const from = path.join(job.dir, name),
            to = path.join(temp, name),
            stat = await fs.stat(from);
          if (!stat.isFile()) throw Error('ไม่พบภาพ ' + name);
          await fs.copyFile(from, to);
          sizeBytes += stat.size;
        }
        const styles = {};
        const targetLanguage = job.manifest.settings?.targetLanguage || 'th';
        for (const page of job.manifest.pages) {
          let rendered;
          try {
            rendered = overlayPage(page, { documentUrl, targetLanguage });
          } catch {
            continue;
          }
          const pageStyles = {};
          for (const region of rendered.regions || []) {
            const key = regionStyleKey(
                rendered,
                { ...region, text: region.original },
                targetLanguage,
              ),
              style = await translationService.regionStyles().get(key);
            if (style) pageStyles[String(region.id)] = style;
          }
          if (Object.keys(pageStyles).length) styles[String(page.id)] = pageStyles;
        }
        const manifest = JSON.parse(JSON.stringify(job.manifest));
        const project = {
          version: 1,
          id,
          documentKey,
          url: documentUrl,
          title: manifest.source?.title || tab.view.webContents.getTitle() || 'Offline',
          createdAt,
          updatedAt,
          pages: pages.length,
          sizeBytes,
          targetLanguage,
          styles,
        };
        await fs.writeFile(
          path.join(temp, 'manifest.json'),
          JSON.stringify(manifest, null, 2),
          'utf8',
        );
        await fs.writeFile(
          path.join(temp, 'project.json'),
          JSON.stringify(project, null, 2),
          'utf8',
        );
        await fs.rm(target, { recursive: true, force: true });
        await fs.rename(temp, target);
        const coverPage = pages[0] || null;
        const row = {
          id,
          documentKey,
          url: documentUrl,
          title: project.title,
          createdAt,
          updatedAt,
          pages: project.pages,
          sizeBytes,
          targetLanguage,
          projectId,
          coverFile: coverPage?.file || '',
          coverMime: coverPage?.mime || '',
        };
        index.items = [row, ...index.items.filter((x) => x.id !== id)];
        await harvestOfflineWriteIndex(index);
        job = { ...job, dir: target, persistent: true, manifest };
        translationService.harvestTranslationJobs.set(tab.id, job);
        tab.offlineProjectId = id;
        return row;
      } finally {
        await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
      }
    });
  }

  async function harvestOfflineRemove(id) {
    return harvestOfflineQueued(async () => {
      const index = await harvestOfflineIndex(),
        row = index.items.find((x) => x.id === String(id || ''));
      if (!row) return { removed: false };
      await fs.rm(harvestOfflineProjectDir(row.id), {
        recursive: true,
        force: true,
      });
      index.items = index.items.filter((x) => x.id !== row.id);
      await harvestOfflineWriteIndex(index);
      return { removed: true, id: row.id };
    });
  }

  async function harvestOfflineUpdateStyle(documentUrl, pageId, regionId, style) {
    const key = harvestOfflineDocumentKey(documentUrl);
    return harvestOfflineQueued(async () => {
      const index = await harvestOfflineIndex(),
        row = index.items.find((x) => x.documentKey === key);
      if (!row) return false;
      const file = path.join(harvestOfflineProjectDir(row.id), 'project.json'),
        project = await harvestOfflineReadJson(file, null);
      if (!project) return false;
      project.styles = project.styles && typeof project.styles === 'object' ? project.styles : {};
      const pageKey = String(pageId),
        regionKey = String(regionId),
        pageStyles = { ...(project.styles[pageKey] || {}) };
      if (style) pageStyles[regionKey] = style;
      else delete pageStyles[regionKey];
      if (Object.keys(pageStyles).length) project.styles[pageKey] = pageStyles;
      else delete project.styles[pageKey];
      project.updatedAt = Date.now();
      await harvestOfflineWriteJson(file, project);
      row.updatedAt = project.updatedAt;
      await harvestOfflineWriteIndex(index);
      return true;
    });
  }
  return {
    get harvestOfflineExportSessions() {
      return harvestOfflineExportSessions;
    },
    harvestOfflineDocumentKey,
    harvestOfflineGroupCreate,
    harvestOfflineGroupRename,
    harvestOfflineGroupRemove,
    harvestOfflineLibraryReorder,
    harvestOfflineLibraryProjectCreate,
    harvestOfflineLibraryProjectRename,
    harvestOfflineLibraryProjectGroup,
    harvestOfflineItemProject,
    harvestOfflineCover,
    harvestOfflineReadProject,
    harvestOfflineFindByUrl,
    harvestOfflineList,
    harvestOfflineSave,
    harvestOfflineRemove,
    harvestOfflineUpdateStyle,
  };
}
module.exports = { createOfflineLibrary };
