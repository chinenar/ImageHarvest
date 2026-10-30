'use strict';
const { dialog, shell } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { imageURL, delay } = require('../core.cjs');
const { selectMangaPages } = require('../harvest-translate.cjs');
const { overlayPage, createTranslationOverlay } = require('../translation-overlay.cjs');
const { readerDocumentKey } = require('../reader-document.cjs');

function createOfflineReader({
  collectorCollection: collectorCollectionService,
  offlineLibrary: offlineLibraryService,
  translation: translationService,
  host: hostService,
}) {
  async function harvestOfflineProjectData(id) {
    const { project, manifest } = await offlineLibraryService.harvestOfflineReadProject(
        String(id || ''),
      ),
      targetLanguage = manifest.settings?.targetLanguage || project.targetLanguage || 'th',
      pages = [];
    for (const page of manifest.pages || []) {
      if (!page.file || page.error) continue;
      let overlay;
      try {
        overlay = overlayPage(page, {
          documentUrl: 'offline://' + project.id,
          targetLanguage,
        });
      } catch {
        overlay = { regions: [], reviewCount: 0 };
      }
      for (const region of overlay.regions || [])
        region.userStyle = project.styles?.[String(page.id)]?.[String(region.id)] || null;
      pages.push({
        id: String(page.id),
        index: Number(page.index) || 0,
        file: page.file,
        width: Number(page.width) || 0,
        height: Number(page.height) || 0,
        mime: page.mime || '',
        imageUrl: `eiw://offline/${project.id}/${encodeURIComponent(page.file)}`,
        regions: overlay.regions || [],
      });
    }
    return {
      project: {
        id: project.id,
        title: project.title,
        url: project.url,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        targetLanguage,
      },
      pages,
    };
  }

  async function harvestOfflineLiveReaderPages(wc, documentUrl, expectedCount = 0) {
    const options = {
      selector: '',
      backgrounds: true,
      canvases: false,
      smartBackgrounds: true,
      adaptiveBackgrounds: true,
    };
    let best = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      if (wc.isDestroyed()) break;
      const snap = await hostService
        .withTimeout(
          wc.executeJavaScript(
            `(${collectorCollectionService.collector})(${JSON.stringify(options)})`,
            true,
          ),
          12000,
          'หน้าเว็บไม่ตอบสนองระหว่างกู้งานแปล',
        )
        .catch(() => null);
      const rows = [];
      for (const raw of snap?.items || []) {
        const url = imageURL(raw.url, documentUrl);
        if (url) rows.push({ ...raw, url });
      }
      const pages = selectMangaPages(rows);
      if (pages.length > best.length) best = pages;
      if (best.length && (expectedCount <= 0 || best.length >= expectedCount)) break;
      await delay(180 * (attempt + 1));
    }
    if (!best.length) return best;
    try {
      const urls = best.map((x) => x.url);
      const digests = await wc
        .executeJavaScript(
          `(async()=>{const urls=${JSON.stringify(urls)},out={};for(let i=0;i<urls.length;i+=4){await Promise.all(urls.slice(i,i+4).map(async url=>{try{const r=await fetch(url);const b=await r.arrayBuffer();const h=await crypto.subtle.digest('SHA-256',b);out[url]=Array.from(new Uint8Array(h),x=>x.toString(16).padStart(2,'0')).join('');}catch{}}));}return out;})()`,
          true,
        )
        .catch(() => null);
      if (digests) best = best.map((x) => ({ ...x, imageDigest: digests[x.url] || '' }));
    } catch {}
    return best;
  }

  function harvestOfflineMatchLivePages(savedPages, livePages) {
    const used = new Set(),
      result = [];
    const size = (item) => ({
      w: Math.max(Number(item?.width) || 0, Number(item?.filterHints?.displayWidth) || 0),
      h: Math.max(Number(item?.height) || 0, Number(item?.filterHints?.displayHeight) || 0),
    });
    for (let i = 0; i < savedPages.length; i++) {
      const page = savedPages[i];
      let match = -1;
      if (page.imageDigest)
        match = livePages.findIndex(
          (x, j) => !used.has(j) && x.imageDigest && x.imageDigest === page.imageDigest,
        );
      if (match < 0)
        match = livePages.findIndex(
          (x, j) => !used.has(j) && String(x.url || '') === String(page.sourceUrl || ''),
        );
      if (match < 0 && livePages.length === savedPages.length && !used.has(i)) match = i;
      if (match < 0) {
        const target = size(page),
          targetAspect = target.w && target.h ? target.w / target.h : 0;
        let best = Infinity;
        for (let j = 0; j < livePages.length; j++) {
          if (used.has(j)) continue;
          const cur = size(livePages[j]),
            aspect = cur.w && cur.h ? cur.w / cur.h : 0;
          const aspectCost =
            targetAspect && aspect ? Math.abs(Math.log(aspect / targetAspect)) * 30 : 0;
          const widthCost = target.w && cur.w ? Math.abs(Math.log(cur.w / target.w)) * 4 : 0;
          const heightCost = target.h && cur.h ? Math.abs(Math.log(cur.h / target.h)) * 4 : 0;
          const orderCost = Math.abs(j - (Number(page.index) || i)) * 1.5,
            score = aspectCost + widthCost + heightCost + orderCost;
          if (score < best) {
            best = score;
            match = j;
          }
        }
      }
      if (match >= 0) {
        used.add(match);
        result.push(livePages[match]);
      } else result.push(null);
    }
    return result;
  }

  async function restoreHarvestOfflineOverlay(tab) {
    if (!tab || tab.kind !== 'web' || tab.view.webContents.isDestroyed()) return null;
    const wc = tab.view.webContents,
      url = wc.getURL() || tab.url || '',
      documentKey = offlineLibraryService.harvestOfflineDocumentKey(url);
    if (!/^https?:/i.test(url) || tab.offlineOverlayDocument === documentKey) return null;
    const active = translationService.harvestTranslationJobFor(tab);
    if (active?.running) return null;
    const row = await offlineLibraryService.harvestOfflineFindByUrl(url);
    if (!row) return null;
    const saved = await offlineLibraryService.harvestOfflineReadProject(row.id),
      manifest = saved.manifest,
      settings = manifest.settings || translationService.HARVEST_TRANSLATE_DEFAULTS;
    if (!translationService.sameHarvestTranslationPage(manifest.source?.url || row.url, url))
      return null;
    translationService.sendHarvestTranslation(tab, {
      type: 'restore-start',
      message: 'พบคำแปลที่บันทึกไว้ • กำลังวางกลับบนหน้าเดิม…',
    });
    await require('../reader-mode.cjs')
      .ensureContinuousReader(wc)
      .catch(() => {});
    if (wc.isDestroyed() || !translationService.sameHarvestTranslationPage(url, wc.getURL()))
      return null;
    const savedPages = (manifest.pages || []).filter(
      (page) => page?.ocr?.regions?.length && !page.error,
    );
    const livePages = await harvestOfflineLiveReaderPages(wc, url, savedPages.length);
    const matches = harvestOfflineMatchLivePages(savedPages, livePages);
    const job = {
      id: manifest.jobId || 'offline-' + row.id,
      dir: saved.dir,
      sourceUrl: manifest.source?.url || row.url,
      manifest,
      running: false,
      persistent: true,
      abort: new AbortController(),
    };
    translationService.harvestTranslationJobs.set(tab.id, job);
    await wc
      .executeJavaScript(
        `window.__harvestTsTranslationOverlay||(window.__harvestTsTranslationOverlay=(${createTranslationOverlay.toString()})(${readerDocumentKey.toString()}))`,
      )
      .catch(() => {});
    let regions = 0,
      pages = 0,
      drawn = 0,
      mapped = 0,
      pending = 0;
    for (let i = 0; i < savedPages.length; i++) {
      const page = savedPages[i],
        live = matches[i];
      try {
        const overlaySource = live
          ? { ...page, sourceUrl: live.url, source: live.source || page.source }
          : page;
        if (live) mapped++;
        const rendered = await translationService.prepareOverlayStyles(
          tab,
          overlayPage(overlaySource, {
            documentUrl: job.sourceUrl,
            targetLanguage: settings.targetLanguage || 'th',
          }),
        );
        for (const region of rendered.regions || [])
          region.userStyle =
            saved.project.styles?.[String(page.id)]?.[String(region.id)] ||
            region.userStyle ||
            null;
        if (!rendered.regions.length) continue;
        const state = await wc.executeJavaScript(
          `window.__harvestTsTranslationOverlay?.apply(${JSON.stringify(rendered)},${JSON.stringify({ fontScale: settings.fontScale || 1, visible: !settings.showOriginal })})`,
        );
        regions += rendered.regions.length;
        pages++;
        drawn += Number(state?.pageDrawn) || 0;
        if (state?.pending) pending++;
      } catch {}
    }
    tab.offlineProjectId = row.id;
    if ((savedPages.length > 0 && mapped >= savedPages.length) || (!livePages.length && drawn > 0))
      tab.offlineOverlayDocument = documentKey;
    if (regions) {
      const message = drawn
        ? `โหลดคำแปลเดิมแล้ว • ${pages} หน้า • แสดง ${drawn} จุด`
        : mapped
          ? `โหลดคำแปลเดิมแล้ว • รอภาพหน้าอ่านแสดง ${pending || pages} หน้า`
          : 'พบคำแปลเดิมแล้ว • กำลังรอหน้าอ่านโหลดภาพ';
      translationService.sendHarvestTranslation(tab, {
        type: 'complete',
        jobId: job.id,
        total: manifest.pages.length,
        ready: pages,
        failed: 0,
        translatedRegions: regions,
        translationFailed: 0,
        message,
      });
    }
    return {
      id: row.id,
      pages,
      regions,
      drawn,
      mapped,
      livePages: livePages.length,
      pending,
    };
  }

  async function harvestOfflineExportStart(tab, input = {}) {
    const projectId = String(input.id || tab.projectId || ''),
      data = await harvestOfflineProjectData(projectId),
      mode = ['original', 'clean', 'translated'].includes(input.mode) ? input.mode : 'translated';
    const pick = await dialog.showOpenDialog(hostService.mainWindow, {
      title: 'เลือกโฟลเดอร์สำหรับ Export',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (pick.canceled || !pick.filePaths?.[0]) return { cancelled: true };
    const cleanName =
      String(data.project.title || 'ImageHarvest')
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80) || 'ImageHarvest';
    const suffix = mode === 'translated' ? 'translated' : mode === 'clean' ? 'clean' : 'original',
      folder = path.join(pick.filePaths[0], cleanName + ' - ' + suffix);
    await fs.mkdir(folder, { recursive: true });
    const token = randomUUID();
    offlineLibraryService.harvestOfflineExportSessions.set(token, {
      tabId: tab.id,
      projectId: data.project.id,
      folder,
      mode,
      total: data.pages.length,
      written: 0,
      createdAt: Date.now(),
    });
    return { cancelled: false, token, total: data.pages.length, mode };
  }

  async function harvestOfflineExportPage(tab, input = {}) {
    const session = offlineLibraryService.harvestOfflineExportSessions.get(
      String(input.token || ''),
    );
    if (!session || session.tabId !== tab.id) throw Error('Export session หมดอายุ');
    const index = Number(input.index);
    if (!Number.isInteger(index) || index < 0 || index >= session.total)
      throw Error('ลำดับหน้า Export ไม่ถูกต้อง');
    const bytes = input.bytes;
    let buffer = null;
    if (bytes instanceof ArrayBuffer) buffer = Buffer.from(bytes);
    else if (ArrayBuffer.isView(bytes))
      buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (!buffer || !buffer.length || buffer.length > 64 * 1024 * 1024)
      throw Error('ข้อมูลภาพ Export ไม่ถูกต้อง');
    await fs.writeFile(
      path.join(session.folder, String(index + 1).padStart(4, '0') + '.png'),
      buffer,
    );
    session.written++;
    return { written: session.written, total: session.total };
  }

  async function harvestOfflineExportFinish(tab, input = {}) {
    const token = String(input.token || ''),
      session = offlineLibraryService.harvestOfflineExportSessions.get(token);
    if (!session || session.tabId !== tab.id) throw Error('Export session หมดอายุ');
    offlineLibraryService.harvestOfflineExportSessions.delete(token);
    const first = path.join(session.folder, '0001.png');
    if (session.written && fsSync.existsSync(first)) shell.showItemInFolder(first);
    return {
      folder: session.folder,
      written: session.written,
      total: session.total,
    };
  }
  return {
    harvestOfflineProjectData,
    restoreHarvestOfflineOverlay,
    harvestOfflineExportStart,
    harvestOfflineExportPage,
    harvestOfflineExportFinish,
  };
}
module.exports = { createOfflineReader };
