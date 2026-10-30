'use strict';
const { app } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
const {
  DEFAULT_TRANSLATION_ENDPOINT,
  HarvestTranslationClient,
} = require('../harvest-translate.cjs');
const { GoogleTranslateWebPool } = require('../google-translate-web.cjs');
const {
  OcrTranslationService,
  repairBatchTranslationProvenance,
} = require('../ocr-translation.cjs');
const { overlayPage, createTranslationOverlay } = require('../translation-overlay.cjs');
const { RegionStyleStore, regionStyleKey } = require('../region-style-store.cjs');
const {
  translationMachineKey,
  translationProfileKey,
  TranslationPerformanceStore,
} = require('../translation-performance.cjs');
const { readerDocumentKey, sameReaderDocument } = require('../reader-document.cjs');
const { createReaderInteractionLock } = require('../reader-interaction-lock.cjs');

function createTranslation({
  ocrLab: ocrLabService,
  pageAcquisition: pageAcquisitionService,
  storage: storageService,
  translationStages: translationStagesService,
  host: hostService,
}) {
  let harvestRegionStyles = null;

  const harvestRegionStyleSources = new Map();

  function regionStyles() {
    return (
      harvestRegionStyles ||
      (harvestRegionStyles = new RegionStyleStore(
        path.join(app.getPath('userData'), 'harvestts', 'region-fonts.json'),
      ))
    );
  }

  async function prepareOverlayStyles(tab, payload) {
    const scope = {
      documentUrl: payload.documentUrl,
      imageDigest: payload.imageDigest,
      regions: new Map(),
    };
    for (const r of payload.regions) {
      r.styleKey = regionStyleKey(payload, { ...r, text: r.original }, payload.targetLanguage);
      r.userStyle = await regionStyles().get(r.styleKey);
      scope.regions.set(r.id, r.styleKey);
    }
    let sources = harvestRegionStyleSources.get(tab.id);
    if (!sources) {
      sources = new Map();
      harvestRegionStyleSources.set(tab.id, sources);
    }
    sources.set(payload.id, scope);
    while (sources.size > 400) sources.delete(sources.keys().next().value);
    return payload;
  }

  const harvestTranslationClient = new HarvestTranslationClient({
    baseUrl: DEFAULT_TRANSLATION_ENDPOINT,
  });

  const harvestGoogleTranslateWeb = new GoogleTranslateWebPool({ size: 4 });

  const ocrTranslationService = new OcrTranslationService({
    google: harvestGoogleTranslateWeb,
    ai: harvestTranslationClient,
  });

  const harvestTranslationJobs = new Map();

  const harvestTranslationTempRoot = path.join(
    app.getPath('temp'),
    'ImageHarvest',
    hostService.testMode ? 'harvestts-translate-test-' + process.pid : 'harvestts-translate',
  );

  let harvestTranslationProbeCache = null;

  const harvestTranslationPerformance = new TranslationPerformanceStore(
    path.join(storageService.harvestTsDataDir, 'translation-performance.json'),
  );

  let harvestTranslationMachineKeyPromise = null;

  async function harvestTranslationMachineFingerprint() {
    if (harvestTranslationMachineKeyPromise) return harvestTranslationMachineKeyPromise;
    harvestTranslationMachineKeyPromise = (async () => {
      const gpuInfo = await app.getGPUInfo('basic').catch(() => ({ gpuDevice: [] }));
      return translationMachineKey({
        platform: process.platform,
        arch: process.arch,
        cpu: os.cpus()?.[0]?.model || '',
        memoryBytes: os.totalmem(),
        gpu: gpuInfo?.gpuDevice || [],
      });
    })();
    return harvestTranslationMachineKeyPromise;
  }

  async function harvestTranslationProfileMeta(model, nativeInfo) {
    const contextLength = Number(nativeInfo?.loaded_instances?.[0]?.config?.context_length) || 0;
    const quantization = String(nativeInfo?.quantization?.name || nativeInfo?.quantization || '');
    const machineKey = await harvestTranslationMachineFingerprint();
    const key = translationProfileKey({
      machineKey,
      model,
      quantization,
      contextLength,
    });
    return { key, machineKey, model, quantization, contextLength };
  }

  const HARVEST_TRANSLATE_DEFAULTS = {
    engine: 'ai',
    sourceLanguage: 'auto',
    targetLanguage: 'th',
    contentType: 'manga',
    fontScale: 1,
    showOriginal: false,
  };

  const harvestScreenLensStates = new Map();

  const harvestOriginalCaptureQueues = new WeakMap();

  function normalizeHarvestTranslateSettings(input = {}) {
    const engine = input.engine === 'google' ? 'google' : 'ai';
    const sourceAllowed = new Set(['auto', 'th', 'en', 'ja', 'fr', 'ko', 'zh']);
    const targetAllowed = new Set(['th', 'en', 'ja', 'fr', 'ko', 'zh']);
    const sourceLanguage = sourceAllowed.has(input.sourceLanguage) ? input.sourceLanguage : 'auto';
    const targetLanguage = targetAllowed.has(input.targetLanguage) ? input.targetLanguage : 'th';
    const contentType = input.contentType === 'novel' ? 'novel' : 'manga';
    const fontScale = Math.max(0.7, Math.min(1.8, Number(input.fontScale) || 1));
    const showOriginal = Boolean(input.showOriginal);
    return {
      engine,
      sourceLanguage,
      targetLanguage,
      contentType,
      fontScale,
      showOriginal,
    };
  }

  async function harvestTsTranslateSettings() {
    const raw = await storageService.readHarvestJson(
      storageService.harvestTsTranslateSettingsFile,
      HARVEST_TRANSLATE_DEFAULTS,
    );
    return normalizeHarvestTranslateSettings(raw);
  }

  async function updateHarvestTsTranslateSettings(input = {}) {
    const current = await harvestTsTranslateSettings();
    const next = normalizeHarvestTranslateSettings({ ...current, ...input });
    await storageService.writeHarvestJson(storageService.harvestTsTranslateSettingsFile, next);
    // Translation owns its browser queue. Settings must not navigate an active worker.
    return next;
  }

  function harvestScreenLensSnapshot(tab) {
    const state = tab ? harvestScreenLensStates.get(tab.id) : null;
    return state
      ? {
          enabled: Boolean(state.enabled),
          frames: Number(state.frames) || 0,
          lastAt: Number(state.lastAt) || 0,
          bytes: Number(state.bytes) || 0,
          width: Number(state.width) || 0,
          height: Number(state.height) || 0,
          error: state.error || '',
        }
      : {
          enabled: false,
          frames: 0,
          lastAt: 0,
          bytes: 0,
          width: 0,
          height: 0,
          error: '',
        };
  }

  function sendHarvestScreenLens(tab) {
    if (!tab || tab.view.webContents.isDestroyed()) return;
    tab.view.webContents.send('harvest-guest:screen-lens-status', harvestScreenLensSnapshot(tab));
  }

  async function stopHarvestScreenLens(tab) {
    if (!tab) return { enabled: false };
    const state = harvestScreenLensStates.get(tab.id);
    if (!state) return { enabled: false };
    state.enabled = false;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.latestBuffer = null;
    sendHarvestScreenLens(tab);
    harvestScreenLensStates.delete(tab.id);
    return { enabled: false };
  }

  async function startHarvestScreenLens(tab) {
    if (!tab || tab.view.webContents.isDestroyed())
      throw new Error('ไม่พบหน้าเว็บสำหรับ Screen Lens');
    const existing = harvestScreenLensStates.get(tab.id);
    if (existing?.enabled) return harvestScreenLensSnapshot(tab);

    const state = {
      enabled: true,
      frames: 0,
      lastAt: 0,
      bytes: 0,
      width: 0,
      height: 0,
      error: '',
      timer: null,
      latestBuffer: null,
      capturing: false,
    };
    harvestScreenLensStates.set(tab.id, state);

    const tick = async () => {
      if (!state.enabled || tab.view.webContents.isDestroyed()) return;
      if (!state.capturing) {
        state.capturing = true;
        try {
          const { image } = await ocrLabService.captureHarvestOriginal(tab.view.webContents);
          const size = image.getSize();
          const buffer = image.toJPEG(72);
          state.latestBuffer = buffer;
          state.frames += 1;
          state.lastAt = Date.now();
          state.bytes = buffer.length;
          state.width = size.width;
          state.height = size.height;
          state.error = '';
        } catch (error) {
          state.error = error.message || String(error);
        } finally {
          state.capturing = false;
          sendHarvestScreenLens(tab);
        }
      }
      if (state.enabled) state.timer = setTimeout(tick, 850);
    };

    sendHarvestScreenLens(tab);
    tick();
    return harvestScreenLensSnapshot(tab);
  }

  function sendHarvestTranslation(tab, payload = {}) {
    if (!tab || tab.view.webContents.isDestroyed()) return;
    tab.view.webContents.send('harvest-guest:translation-progress', {
      tabId: tab.id,
      ...payload,
    });
  }

  function harvestTranslationJobFor(tab) {
    return tab ? harvestTranslationJobs.get(tab.id) || null : null;
  }

  function assertHarvestTranslationRunning(job) {
    if (!job || job.abort.signal.aborted) throw new Error('ยกเลิกการเตรียมหน้าแล้ว');
  }

  async function setHarvestReaderLock(tab, job, action) {
    const wc = tab?.view?.webContents;
    if (!wc || wc.isDestroyed()) return false;
    if (action === 'acquire')
      return wc.executeJavaScript(
        `(() => {
    const lock=window.__harvestTsReaderLock||(window.__harvestTsReaderLock=(${createReaderInteractionLock.toString()})(${readerDocumentKey.toString()}));
    return lock.acquire(${JSON.stringify(job.id)});
  })()`,
        true,
      );
    return wc.executeJavaScript(
      `window.__harvestTsReaderLock?.${action}(${JSON.stringify(job.id)})`,
      true,
    );
  }

  async function cancelHarvestTranslationJob(tab, removeFiles = false) {
    const state = harvestTranslationJobFor(tab);
    if (!state) return { cancelled: false };
    if (!state.abort.signal.aborted) state.abort.abort();
    state.running = false;
    await setHarvestReaderLock(tab, state, 'release').catch(() => {});
    sendHarvestTranslation(tab, { type: 'cancelled', jobId: state.id });
    if (removeFiles && state.dir && !state.persistent)
      await fs.rm(state.dir, { recursive: true, force: true }).catch(() => {});
    if (removeFiles) harvestTranslationJobs.delete(tab.id);
    return { cancelled: true, jobId: state.id };
  }

  async function probeHarvestTranslationApi(tab, job) {
    sendHarvestTranslation(tab, {
      type: 'model',
      ok: null,
      endpoint: DEFAULT_TRANSLATION_ENDPOINT,
      message: 'กำลังเชื่อม LM Studio และตรวจโมเดล…',
    });
    assertHarvestTranslationRunning(job);
    const discovered =
      harvestTranslationProbeCache &&
      Date.now() - harvestTranslationProbeCache.checkedAt < 10 * 60 * 1000
        ? { ...harvestTranslationProbeCache }
        : await harvestTranslationClient.probe({ sample: false });
    assertHarvestTranslationRunning(job);
    sendHarvestTranslation(tab, {
      type: 'model',
      ok: null,
      endpoint: discovered.endpoint || DEFAULT_TRANSLATION_ENDPOINT,
      model: discovered.model,
      message: 'พบ ' + discovered.model + ' • กำลังโหลดและ warm-up ให้พร้อมจริง…',
    });
    const ready = await harvestTranslationClient.ensureModelReady(discovered.model, {
      signal: job.abort.signal,
      timeoutMs: 8 * 60 * 1000,
      onStatus: (status) => {
        if (!job.abort.signal.aborted)
          sendHarvestTranslation(tab, {
            type: 'model',
            ok: null,
            endpoint: discovered.endpoint || DEFAULT_TRANSLATION_ENDPOINT,
            model: discovered.model,
            message: status.message || 'กำลังเตรียมโมเดล…',
          });
      },
    });
    assertHarvestTranslationRunning(job);
    const nativeInfo = ready.native
      ? await harvestTranslationClient
          .nativeModelInfo(discovered.model, job.abort.signal, { fresh: true })
          .catch(() => null)
      : null;
    const modelSizeBytes = Math.max(0, Number(nativeInfo?.size_bytes) || 0),
      serverParallel = Math.max(1, Number(ready.parallel) || 1);
    const initialBatchPages =
      modelSizeBytes >= 14 * 1024 ** 3 ? 2 : modelSizeBytes >= 8 * 1024 ** 3 ? 3 : 4;
    let performanceMeta = null,
      performanceProfile = null,
      adaptiveParallel = 1,
      adaptiveBatchPages = initialBatchPages;
    if (ready.native && nativeInfo) {
      performanceMeta = await harvestTranslationProfileMeta(discovered.model, nativeInfo);
      performanceProfile = await harvestTranslationPerformance.get(performanceMeta.key, {
        batchPages: initialBatchPages,
      });
      adaptiveParallel = Math.min(
        serverParallel,
        Math.max(1, Number(performanceProfile.recommendedParallel) || 1),
      );
      adaptiveBatchPages = Math.max(
        1,
        Math.min(4, Number(performanceProfile.batchPages) || initialBatchPages),
      );
    }
    harvestTranslationProbeCache = {
      ...discovered,
      ...ready,
      serverParallel,
      parallel: adaptiveParallel,
      batchPages: adaptiveBatchPages,
      modelSizeBytes,
      contextLength: Number(nativeInfo?.loaded_instances?.[0]?.config?.context_length) || 0,
      quantization: String(nativeInfo?.quantization?.name || nativeInfo?.quantization || ''),
      performanceKey: performanceMeta?.key || '',
      performanceProfile,
      checkedAt: Date.now(),
    };
    const learned = Boolean(performanceProfile?.updatedAt);
    const autoNote = ready.native
      ? ` • Auto ${adaptiveParallel} task • ${adaptiveBatchPages} หน้า/ชุด${learned ? ' • ใช้โปรไฟล์เครื่องนี้' : ' • กำลังเรียนรู้เครื่องนี้'}`
      : '';
    sendHarvestTranslation(tab, {
      type: 'model',
      ok: true,
      ...harvestTranslationProbeCache,
      message: 'โมเดลพร้อมจริง • ' + discovered.model + autoNote,
    });
    return harvestTranslationProbeCache;
  }

  function sameHarvestTranslationPage(a, b) {
    return sameReaderDocument(a, b);
  }

  async function restoreHarvestTranslationJob(tab, { requireTranslations = false } = {}) {
    const url = tab.view.webContents.getURL();
    const entries = await fs
      .readdir(harvestTranslationTempRoot, { withFileTypes: true })
      .catch(() => []);
    const folders = entries
      .filter((e) => e.isDirectory() && /^harvest-/.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => Number(b.split('-').at(-1)) - Number(a.split('-').at(-1)));
    for (const folder of folders.slice(0, 40)) {
      const dir = path.join(harvestTranslationTempRoot, folder);
      try {
        const p = path.join(dir, 'manifest.json'),
          stat = await fs.stat(p);
        if (stat.size > 128 * 1024 * 1024) continue;
        const manifest = JSON.parse(await fs.readFile(p, 'utf8'));
        if (
          !sameHarvestTranslationPage(manifest.source?.url, url) ||
          !Array.isArray(manifest.pages) ||
          !manifest.settings
        )
          continue;
        if (requireTranslations) {
          const translated =
            Number(manifest.translation?.translated) ||
            manifest.pages.reduce(
              (sum, page) =>
                sum +
                (page?.ocr?.regions || []).filter(
                  (region) =>
                    region?.translationRecord?.status === 'translated' && region.translation,
                ).length,
              0,
            );
          if (!translated) continue;
        }
        const repaired = repairBatchTranslationProvenance(manifest);
        if (repaired)
          await fs.writeFile(p, JSON.stringify(manifest, null, 2), 'utf8').catch(() => {});
        const job = {
          id: manifest.jobId || randomUUID(),
          dir,
          sourceUrl: manifest.source.url,
          manifest,
          running: false,
          abort: new AbortController(),
        };
        harvestTranslationJobs.set(tab.id, job);
        return job;
      } catch {}
    }
    return null;
  }

  async function restoreHarvestTemporaryOverlay(tab) {
    if (!tab || tab.kind !== 'web' || tab.view.webContents.isDestroyed()) return null;
    const active = harvestTranslationJobFor(tab);
    if (active?.running) return null;
    const job = active || (await restoreHarvestTranslationJob(tab, { requireTranslations: true }));
    if (!job?.manifest?.pages) return null;
    if (!sameHarvestTranslationPage(job.sourceUrl, tab.view.webContents.getURL())) return null;
    const settings = job.manifest.settings || HARVEST_TRANSLATE_DEFAULTS,
      wc = tab.view.webContents;
    await wc
      .executeJavaScript(
        `window.__harvestTsTranslationOverlay||(window.__harvestTsTranslationOverlay=(${createTranslationOverlay.toString()})(${readerDocumentKey.toString()}))`,
      )
      .catch(() => {});
    let regions = 0,
      drawn = 0,
      pending = 0,
      pages = 0;
    for (const page of job.manifest.pages) {
      if (!page?.ocr?.regions?.length || page.error) continue;
      try {
        const rendered = await prepareOverlayStyles(
          tab,
          overlayPage(page, {
            documentUrl: job.sourceUrl,
            targetLanguage: settings.targetLanguage || 'th',
          }),
        );
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
    if (regions)
      sendHarvestTranslation(tab, {
        type: 'complete',
        jobId: job.id,
        total: job.manifest.pages.length,
        ready: pages,
        failed: 0,
        translatedRegions: regions,
        translationFailed: 0,
        message: drawn
          ? `กู้คำแปลเดิมแล้ว • แสดง ${drawn}/${regions} จุด`
          : `กู้คำแปลเดิมแล้ว • รอภาพหน้าอ่านแสดง ${pending || pages} หน้า`,
      });
    return { regions, drawn, pending, pages };
  }

  async function retryHarvestTsTranslation(tab) {
    const job = harvestTranslationJobFor(tab) || (await restoreHarvestTranslationJob(tab));
    if (!job?.manifest?.pages) throw Error('ไม่พบงานเดิมสำหรับลองแปลซ้ำ กรุณา Start ก่อน');
    if (job.running) throw Error('งานแปลยังทำงานอยู่');
    if (!sameHarvestTranslationPage(job.sourceUrl, tab.view.webContents.getURL()))
      throw Error('เปลี่ยนตอนแล้ว กรุณา Start ใหม่');
    const settings = job.manifest.settings;
    job.running = true;
    job.abort = new AbortController();
    try {
      await setHarvestReaderLock(tab, job, 'acquire');
      await setHarvestReaderLock(tab, job, 'freeze');
      sendHarvestTranslation(tab, {
        type: 'retry-start',
        jobId: job.id,
        message: 'ลองแปลเฉพาะส่วนที่ขาด • ใช้ OCR และภาพคลีนเดิม',
      });
      const summary = await translationStagesService.runHarvestTranslateStage(
        tab,
        job,
        job.manifest.pages,
        settings,
        job.manifest.translationApi?.model || '',
        { retryOnly: true },
      );
      job.manifest.translation = {
        ...summary,
        status: summary.failed ? 'partial' : 'translated',
      };
      await fs.writeFile(
        path.join(job.dir, 'manifest.json'),
        JSON.stringify(job.manifest, null, 2),
        'utf8',
      );
      sendHarvestTranslation(tab, {
        type: 'complete',
        jobId: job.id,
        translatedRegions: summary.translated,
        translationFailed: summary.failed,
        message:
          'แปลแล้ว ' +
          summary.translated +
          '/' +
          summary.regions +
          ' จุด' +
          (summary.failed ? ' • ยังไม่สำเร็จ ' + summary.failed + ' จุด' : '') +
          (summary.review ? ' • รอตรวจ ' + summary.review + ' จุด' : '') +
          ' • ปลดล็อกหน้าอ่านแล้ว',
      });
      return summary;
    } catch (error) {
      if (!job.abort.signal.aborted)
        sendHarvestTranslation(tab, {
          type: 'error',
          jobId: job.id,
          message: error.message,
        });
      throw error;
    } finally {
      job.running = false;
      await setHarvestReaderLock(tab, job, 'release').catch(() => {});
    }
  }

  async function runHarvestTsTranslationJob(tab) {
    const previous = harvestTranslationJobFor(tab);
    if (previous?.running) throw new Error('ระบบกำลังเตรียมหน้ามังงะอยู่');
    if (previous?.dir && !previous.persistent)
      await fs.rm(previous.dir, { recursive: true, force: true }).catch(() => {});

    const job = {
      id: randomUUID(),
      abort: new AbortController(),
      dir: path.join(harvestTranslationTempRoot, `${tab.id}-${Date.now()}`),
      startedAt: Date.now(),
      sourceUrl: tab.view.webContents.getURL() || tab.url || '',
      running: true,
    };
    harvestTranslationJobs.set(tab.id, job);
    try {
      job.readerMode = await require('../reader-mode.cjs').ensureContinuousReader(
        tab.view.webContents,
        { signal: job.abort.signal },
      );
      await setHarvestReaderLock(tab, job, 'acquire');
      await fs.mkdir(job.dir, { recursive: true });
      await tab.view.webContents
        .executeJavaScript('window.__harvestTsTranslationOverlay?.clear()')
        .catch(() => {});
      sendHarvestTranslation(tab, {
        type: 'job-start',
        jobId: job.id,
        endpoint: DEFAULT_TRANSLATION_ENDPOINT,
        message: 'ล็อกหน้าอ่าน • เริ่ม Harvest สำหรับ Manga Translate',
      });
      const settings = await harvestTsTranslateSettings();
      let provider = null;
      let probePromise = null;

      if (settings.engine === 'google') {
        provider = {
          provider: 'google',
          model: 'Google Translate',
          endpoint: 'Google Translate Web',
          connected: true,
        };
        sendHarvestTranslation(tab, {
          type: 'model',
          ok: true,
          model: 'Google Translate',
          endpoint: 'Google Translate Web • background',
        });
        probePromise = Promise.resolve(provider);
      } else {
        probePromise = probeHarvestTranslationApi(tab, job).catch((error) => {
          const value = {
            provider: 'ai',
            endpoint: DEFAULT_TRANSLATION_ENDPOINT,
            error: error.message || String(error),
          };
          sendHarvestTranslation(tab, { type: 'model', ok: false, ...value });
          return value;
        });
      }

      const scan = await pageAcquisitionService.scanHarvestTsTranslationPages(tab, job);
      job.sourceUrl = scan.startURL;
      assertHarvestTranslationRunning(job);
      await setHarvestReaderLock(tab, job, 'freeze');
      let model = null;
      const manifestPages = [];
      let failed = 0;

      for (let i = 0; i < scan.pages.length; i++) {
        assertHarvestTranslationRunning(job);
        const page = scan.pages[i];
        sendHarvestTranslation(tab, {
          type: 'page',
          index: i,
          id: page.pageId,
          progress: 0.08,
          status: 'กำลังดึงภาพต้นฉบับ',
        });
        try {
          const data = await pageAcquisitionService.acquireHarvestTsTranslationImage(
            tab,
            { ...page, referrer: scan.startURL },
            job.abort.signal,
          );
          assertHarvestTranslationRunning(job);
          const fileName = `${String(i + 1).padStart(4, '0')}.${data.ext}`;
          const filePath = path.join(job.dir, fileName);
          await fs.writeFile(filePath, data.buffer);
          manifestPages.push({
            id: page.pageId,
            index: i,
            file: fileName,
            sourceUrl: page.url,
            source: page.source,
            width: page.width || 0,
            height: page.height || 0,
            bytes: data.buffer.length,
            mime: data.mime,
            imageDigest: createHash('sha256').update(data.buffer).digest('hex'),
          });
          sendHarvestTranslation(tab, {
            type: 'page',
            index: i,
            id: page.pageId,
            progress: 0.28,
            status: 'Harvest พร้อม • เข้า OCR ต่ออัตโนมัติ',
            bytes: data.buffer.length,
          });
        } catch (error) {
          failed++;
          manifestPages.push({
            id: page.pageId,
            index: i,
            sourceUrl: page.url,
            error: error.message || String(error),
          });
          sendHarvestTranslation(tab, {
            type: 'page',
            index: i,
            id: page.pageId,
            progress: 1,
            error: true,
            status: error.message || 'ดึงภาพไม่สำเร็จ',
          });
        }
      }

      const ocr = await translationStagesService.runHarvestOcrStage(
        tab,
        job,
        manifestPages,
        settings,
      );
      assertHarvestTranslationRunning(job);

      // Model loading/warm-up runs in parallel with Harvest + OCR, but translation tasks wait here until it is truly ready.
      model = await probePromise;
      assertHarvestTranslationRunning(job);

      let translation = {
        provider: settings.engine,
        regions: ocr.regions,
        translated: 0,
        failed: 0,
        ms: 0,
        status: 'pending',
      };
      if (settings.engine === 'google' || !model?.error) {
        translation = await translationStagesService.runHarvestTranslateStage(
          tab,
          job,
          manifestPages,
          settings,
          model?.model || '',
        );
        let previousFailed = Number(translation.failed) || 0;
        let autoRetryAttempts = 0,
          staleRetryRounds = 0;
        const maxAutoRetries =
          previousFailed > 0 && Number(translation.transportFailures) >= previousFailed ? 1 : 3;
        while (previousFailed > 0 && autoRetryAttempts < maxAutoRetries) {
          autoRetryAttempts++;
          sendHarvestTranslation(tab, {
            type: 'stage',
            stage: 'translate-retry',
            progress: 0.94,
            message: `พบ ${previousFailed} จุดที่แปลไม่สำเร็จ • ส่งกลับเข้า queue อัตโนมัติ ${autoRetryAttempts}/${maxAutoRetries}`,
          });
          const retried = await translationStagesService.runHarvestTranslateStage(
            tab,
            job,
            manifestPages,
            settings,
            model?.model || '',
            { retryOnly: true },
          );
          retried.autoRetryAttempts = autoRetryAttempts;
          translation = retried;
          const nextFailed = Number(retried.failed) || 0;
          if (nextFailed <= 0) break;
          if (nextFailed < previousFailed) staleRetryRounds = 0;
          else staleRetryRounds++;
          previousFailed = nextFailed;
          // Transport-wide failures (timeout/server/model output) already receive
          // one automatic retry. Repeating the same long request three times only
          // makes a local-model failure take tens of minutes to surface.
          if (Number(retried.transportFailures) >= nextFailed && nextFailed > 0) break;
          if (staleRetryRounds >= 2) break;
        }
        translation.status = translation.failed ? 'partial' : 'translated';
      } else {
        translation.status = 'failed';
        translation.failed = ocr.regions;
        translation.error = model.error;
      }

      const manifest = {
        version: 5,
        jobId: job.id,
        createdAt: new Date().toISOString(),
        source: { url: scan.startURL, title: scan.title },
        settings: { ...settings },
        scan: { ms: scan.scanMs, fastPath: scan.fastPath, steps: scan.steps },
        ocr,
        translation,
        translationApi:
          settings.engine === 'google'
            ? {
                provider: 'google',
                endpoint: 'Google Translate Web (background)',
                model: 'Google Translate',
                connected: true,
              }
            : {
                provider: 'ai',
                endpoint: DEFAULT_TRANSLATION_ENDPOINT,
                model: model?.model || '',
                connected: !model?.error,
                sample: model?.sample || '',
                error: model?.error || '',
              },
        pages: manifestPages,
      };
      await fs.writeFile(
        path.join(job.dir, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
        'utf8',
      );
      job.running = false;
      job.completedAt = Date.now();
      job.manifest = manifest;
      const ready = manifestPages.length - failed;
      const overlayError = manifestPages.some((p) => p.overlay?.error),
        overlayPending = manifestPages.some((p) => p.overlay?.pending),
        overlayRegions = manifestPages.reduce(
          (sum, p) => sum + (Number(p.overlay?.pageTotal) || 0),
          0,
        );
      const overlayFailed =
        translation.translated > 0 && !overlayError && !overlayPending && overlayRegions === 0;
      const completeMessage =
        (settings.engine === 'ai' ? 'AI' : 'Google Translate') +
        ' แปลแล้ว ' +
        translation.translated +
        '/' +
        translation.regions +
        ' จุด' +
        (translation.failed ? ' • ไม่สำเร็จ ' + translation.failed + ' จุด' : '') +
        (translation.review ? ' • รอตรวจ ' + translation.review + ' จุด' : '') +
        (overlayError
          ? ' • บางหน้าวางคำแปลไม่ได้'
          : overlayFailed
            ? ' • แปลสำเร็จแต่ยังวางบนหน้าไม่ได้'
            : overlayPending
              ? ' • คำแปลพร้อม รอภาพบางหน้าแสดง'
              : ' • วางคำแปลแล้ว ปลดล็อกให้เลื่อนอ่านได้');
      sendHarvestTranslation(tab, {
        type: 'complete',
        jobId: job.id,
        total: manifestPages.length,
        ready,
        failed,
        model: model?.model || (settings.engine === 'google' ? 'Google Translate' : ''),
        modelConnected: !model?.error,
        provider: settings.engine,
        scanMs: scan.scanMs,
        fastPath: scan.fastPath,
        ocrPages: ocr.pages,
        ocrRegions: ocr.regions,
        ocrFailed: ocr.failed,
        translatedRegions: translation.translated || 0,
        translationFailed: translation.failed || 0,
        overlayFailed,
        overlayRegions,
        message: completeMessage,
      });
      return {
        jobId: job.id,
        total: manifestPages.length,
        ready,
        failed,
        model: model?.model || (settings.engine === 'google' ? 'Google Translate' : ''),
        modelConnected: !model?.error,
        provider: settings.engine,
        scanMs: scan.scanMs,
        fastPath: scan.fastPath,
        ocr,
        translation,
      };
    } catch (error) {
      job.running = false;
      if (!job.abort.signal.aborted)
        sendHarvestTranslation(tab, {
          type: 'error',
          jobId: job.id,
          message: error.message || String(error),
        });
      throw error;
    } finally {
      await setHarvestReaderLock(tab, job, 'release').catch(() => {});
    }
  }
  return {
    get harvestRegionStyleSources() {
      return harvestRegionStyleSources;
    },
    regionStyles,
    prepareOverlayStyles,
    get harvestTranslationClient() {
      return harvestTranslationClient;
    },
    get harvestGoogleTranslateWeb() {
      return harvestGoogleTranslateWeb;
    },
    get ocrTranslationService() {
      return ocrTranslationService;
    },
    get harvestTranslationJobs() {
      return harvestTranslationJobs;
    },
    get harvestTranslationTempRoot() {
      return harvestTranslationTempRoot;
    },
    get harvestTranslationProbeCache() {
      return harvestTranslationProbeCache;
    },
    set harvestTranslationProbeCache(value) {
      harvestTranslationProbeCache = value;
    },
    get harvestTranslationPerformance() {
      return harvestTranslationPerformance;
    },
    get HARVEST_TRANSLATE_DEFAULTS() {
      return HARVEST_TRANSLATE_DEFAULTS;
    },
    get harvestScreenLensStates() {
      return harvestScreenLensStates;
    },
    get harvestOriginalCaptureQueues() {
      return harvestOriginalCaptureQueues;
    },
    harvestTsTranslateSettings,
    updateHarvestTsTranslateSettings,
    harvestScreenLensSnapshot,
    stopHarvestScreenLens,
    startHarvestScreenLens,
    sendHarvestTranslation,
    harvestTranslationJobFor,
    assertHarvestTranslationRunning,
    cancelHarvestTranslationJob,
    sameHarvestTranslationPage,
    restoreHarvestTemporaryOverlay,
    retryHarvestTsTranslation,
    runHarvestTsTranslationJob,
  };
}
module.exports = { createTranslation };
