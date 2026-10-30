'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { overlayPage, createTranslationOverlay } = require('../translation-overlay.cjs');
const { TextPlacementPlanner } = require('../text-placement.cjs');
const { readerDocumentKey } = require('../reader-document.cjs');
const { createOcrLab: createOcrLabWindow } = require('../ocr-lab-main.cjs');

function createOcrLab({
  collectorCollection: collectorCollectionService,
  collectorFiles: collectorFilesService,
  tabs: tabsService,
  translation: translationService,
  host: hostService,
}) {
  async function captureHarvestOriginal(wc) {
    const pending = translationService.harvestOriginalCaptureQueues.get(wc) || Promise.resolve();
    const task = pending
      .catch(() => {})
      .then(async () => {
        const source = await wc.executeJavaScript(`(() => {
      const hidden=['__harvestts_manga_translate__','__harvestts_translation_overlay__','__harvestts_reader_lock__'].map(id=>document.getElementById(id)).filter(Boolean).map(host=>{const previous=host.style.display;host.style.display='none';return {id:host.id,previous};});
      return {type:'screenshot',url:location.href,scrollX,scrollY,viewportWidth:innerWidth,viewportHeight:innerHeight,devicePixelRatio,hidden};
    })()`);
        try {
          const image = await wc.capturePage(),
            after = await wc.executeJavaScript('({url:location.href,scrollX,scrollY})');
          if (
            after.url !== source.url ||
            after.scrollX !== source.scrollX ||
            after.scrollY !== source.scrollY
          )
            throw Error('หน้าเว็บเปลี่ยนระหว่างจับภาพ กรุณาจับใหม่');
          const { hidden, ...metadata } = source;
          return { image, source: metadata };
        } finally {
          if (!wc.isDestroyed())
            await wc
              .executeJavaScript(
                `(${JSON.stringify(source.hidden)}).forEach(row=>{const host=document.getElementById(row.id);if(host)host.style.display=row.previous;})`,
              )
              .catch(() => {});
        }
      });
    translationService.harvestOriginalCaptureQueues.set(wc, task);
    try {
      return await task;
    } finally {
      if (translationService.harvestOriginalCaptureQueues.get(wc) === task)
        translationService.harvestOriginalCaptureQueues.delete(wc);
    }
  }

  const ocrLab = createOcrLabWindow({
    parent: () => hostService.mainWindow,
    translate: (regions, options) =>
      translationService.ocrTranslationService.translate(regions, options),
    translationModels: () => translationService.ocrTranslationService.models(),
    overlay: async (image, regions, { targetLanguage = 'th' } = {}) => {
      const source = image.source || {},
        tab = tabsService.harvestTsTabs.get(source.tabId) || tabsService.activeHarvestTsTab();
      if (
        !tab ||
        tab.kind !== 'web' ||
        !translationService.sameHarvestTranslationPage(source.url, tab.view.webContents.getURL())
      )
        throw Error('เปิดแท็บเว็บต้นทางเดิมก่อนวางคำแปล');
      if (!['screenshot', 'harvest'].includes(source.type))
        throw Error('ภาพนี้ไม่มีตำแหน่งเว็บต้นทาง กรุณานำเข้าจาก HarvestTS');
      const planner = new TextPlacementPlanner();
      let planned;
      try {
        planned = await planner.planPage(image.buffer, regions);
      } finally {
        planner.close();
      }
      const page = {
        id: source.pageId || image.id,
        source: source.type === 'screenshot' ? 'screenshot' : 'img',
        sourceUrl: source.imageUrl,
        capture: source,
        width: image.width,
        height: image.height,
        imageDigest: image.digest,
        ocr: { regions: planned.regions },
      };
      const settings = await translationService.harvestTsTranslateSettings(),
        payload = await translationService.prepareOverlayStyles(
          tab,
          overlayPage(page, { documentUrl: source.url, targetLanguage }),
        );
      if (!payload.regions.length) throw Error('ไม่มีคำแปลที่ยังตรงกับภาพและต้นฉบับ กรุณาแปลก่อน');
      return tab.view.webContents.executeJavaScript(
        `(() => {const overlay=window.__harvestTsTranslationOverlay||(window.__harvestTsTranslationOverlay=(${createTranslationOverlay.toString()})(${readerDocumentKey.toString()}));return overlay.apply(${JSON.stringify(payload)},${JSON.stringify({ fontScale: settings.fontScale, visible: !settings.showOriginal })});})()`,
      );
    },
    capture: async () => {
      const tab = tabsService.activeHarvestTsTab();
      if (!tab || tab.kind !== 'web' || tab.view.webContents.isDestroyed())
        throw new Error('เปิดแท็บเว็บ HarvestTS ก่อนจับภาพ');
      const { image, source } = await captureHarvestOriginal(tab.view.webContents);
      return {
        buffer: image.toPNG(),
        source: {
          ...source,
          tabId: tab.id,
          capturedAt: new Date().toISOString(),
        },
      };
    },
    harvest: async () => {
      const tab = tabsService.activeHarvestTsTab(),
        state = translationService.harvestTranslationJobFor(tab),
        rows = [];
      if (state?.running) throw new Error('รอ Harvest และ OCR รอบปัจจุบันเสร็จก่อน');
      if (state?.manifest)
        for (const p of state.manifest.pages || []) {
          if (!p.file || p.error) continue;
          rows.push({
            buffer: await fs.readFile(path.join(state.dir, p.file)),
            name: p.file,
            source: {
              type: 'harvest',
              tabId: tab.id,
              url: state.manifest.source?.url,
              imageUrl: p.sourceUrl,
              pageId: p.id,
            },
            regions: p.ocr?.regions || [],
          });
        }
      if (!rows.length)
        for (const [id, item] of collectorCollectionService.records) {
          if (collectorCollectionService.excludedIds.has(id)) continue;
          const data = await collectorFilesService.getImage(id);
          rows.push({
            buffer: data.buffer,
            name: item.name || `image-${rows.length + 1}`,
            source: {
              type: 'collector',
              url: collectorCollectionService.pageInfo.url,
              imageUrl: item.url,
              imageId: id,
            },
          });
        }
      if (!rows.length)
        throw new Error('ยังไม่มีผล Harvest หรือภาพที่รวบรวม กรุณานำเข้าภาพหรือแคปแท็บ');
      return rows;
    },
  });
  return {
    captureHarvestOriginal,
    get ocrLab() {
      return ocrLab;
    },
  };
}
module.exports = { createOcrLab };
