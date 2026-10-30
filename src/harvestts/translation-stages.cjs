'use strict';
const fsSync = require('node:fs');
const path = require('node:path');
const { scopeTranslationItemsToPage } = require('../ocr-translation.cjs');
const { MangaOcrPool } = require('../manga-ocr.cjs');
const { EnhancedMangaOcrPool } = require('../enhanced-manga-ocr.cjs');
const { LocalOcrBackend, runtimeRoot } = require('../ocr-backend.cjs');
const { overlayPage, createTranslationOverlay } = require('../translation-overlay.cjs');
const { TextPlacementPlanner } = require('../text-placement.cjs');
const { runPageTaskGroups } = require('../page-task-pool.cjs');
const {
  summarizeProviderMetrics,
  recordTranslationWave,
  recommendTranslationParallel,
} = require('../translation-performance.cjs');
const { readerDocumentKey } = require('../reader-document.cjs');
const sourceDir = require('node:path').resolve(__dirname, '..');

function createTranslationStages({ translation: translationService }) {
  async function runHarvestOcrStage(tab, job, manifestPages, settings = {}) {
    const candidates = manifestPages
      .map((row, index) =>
        row?.file && !row.error
          ? {
              manifestIndex: index,
              pageIndex: Number.isInteger(row.index) ? row.index : index,
              filePath: path.join(job.dir, row.file),
              width: row.width,
              height: row.height,
              id: row.id,
            }
          : null,
      )
      .filter(Boolean);

    if (!candidates.length) return { pages: 0, regions: 0, failed: 0, ms: 0 };

    const startedAt = Date.now();
    let completed = 0,
      failed = 0,
      regions = 0;
    translationService.sendHarvestTranslation(tab, {
      type: 'stage',
      stage: 'ocr',
      progress: 0.32,
      message: `กำลัง OCR ${candidates.length} หน้า…`,
    });

    const enhanced = fsSync.existsSync(path.join(runtimeRoot(), 'Scripts', 'python.exe'));
    const backend = new LocalOcrBackend();
    const languages = [
      { en: 'eng', ja: 'jpn', th: 'tha', fr: 'fra' }[settings.sourceLanguage],
    ].filter(Boolean);
    if (!languages.length) languages.push('eng', 'fra', 'jpn', 'tha');
    const Pool = enhanced ? EnhancedMangaOcrPool : MangaOcrPool;
    const pool = new Pool({
      langPath: path.join(sourceDir, '..', 'assets', 'tessdata'),
      languages,
      backend,
      recognitionLanguage: settings.sourceLanguage,
      concurrency: Math.min(4, Math.max(1, candidates.length)),
      detailDetection: true,
      ...(enhanced ? { discovery: true } : {}),
    });
    const placementPlanner = new TextPlacementPlanner({ backend });
    const placementSummary = {
      pages: 0,
      bubble: 0,
      scene: 0,
      reviewRequired: 0,
      requiresInpaint: 0,
      failed: 0,
      ms: 0,
    };

    try {
      const results = await pool.recognizePages(candidates, {
        signal: job.abort.signal,
        onStart: (page) => {
          const row = manifestPages[page.manifestIndex];
          if (!row) return;
          translationService.sendHarvestTranslation(tab, {
            type: 'page',
            index: page.manifestIndex,
            id: row.id,
            progress: 0.38,
            status: 'กำลัง OCR หา text region…',
          });
        },
        onDone: (page, result) => {
          const row = manifestPages[page.manifestIndex];
          if (!row) return;
          completed++;
          if (result.error) failed++;
          regions += result.regions?.length || 0;
          row.ocr = {
            engine: result.engine || 'comic-text-detector+tesseract.js',
            languages,
            performance: result.performance,
            ms: result.ms || 0,
            text: result.text || '',
            regions: require('../ocr-content-role.cjs').annotateContent(result.regions || []),
            passes: result.passes || [],
            error: result.error || '',
          };
          translationService.sendHarvestTranslation(tab, {
            type: 'page',
            index: page.manifestIndex,
            id: row.id,
            progress: result.error ? 1 : 0.72,
            error: Boolean(result.error),
            status: result.error
              ? `OCR ไม่สำเร็จ • ${result.error}`
              : `OCR พบ ${result.regions?.length || 0} จุด • กำลังสร้างพื้นที่ข้อความ`,
          });
          translationService.sendHarvestTranslation(tab, {
            type: 'stage',
            stage: 'ocr',
            progress: 0.32 + 0.36 * (completed / candidates.length),
            message: `OCR ${completed}/${candidates.length} หน้า • พบข้อความ ${regions} จุด`,
          });
        },
      });

      for (let i = 0; i < candidates.length; i++) {
        const page = candidates[i],
          result = results[i];
        const row = manifestPages[page.manifestIndex];
        if (row && result && !row.ocr) {
          row.ocr = {
            engine: 'tesseract.js',
            languages: ['eng', 'fra', 'jpn', 'tha'],
            ms: result.ms || 0,
            text: result.text || '',
            regions: result.regions || [],
            error: result.error || '',
          };
        }
      }

      const layoutStartedAt = Date.now();
      translationService.sendHarvestTranslation(tab, {
        type: 'stage',
        stage: 'layout',
        progress: 0.69,
        message: `กำลังสร้างพื้นที่วางคำแปล ${candidates.length} หน้า…`,
      });
      for (let i = 0; i < candidates.length; i++) {
        translationService.assertHarvestTranslationRunning(job);
        const page = candidates[i],
          row = manifestPages[page.manifestIndex];
        if (!row?.ocr || row.ocr.error) continue;
        translationService.sendHarvestTranslation(tab, {
          type: 'page',
          index: page.manifestIndex,
          id: row.id,
          progress: 0.71,
          status: 'กำลังจับขอบกล่องคำพูด / พื้นที่ข้อความ…',
        });
        const planned = await placementPlanner.planPage(page.filePath, row.ocr.regions || [], {
          signal: job.abort.signal,
          refineText: true,
          sourceLanguage: settings.sourceLanguage,
          onRefine: ({ reason }) =>
            translationService.sendHarvestTranslation(tab, {
              type: 'page',
              index: page.manifestIndex,
              id: row.id,
              progress: 0.71,
              status:
                reason === 'paragraph-recovery'
                  ? 'กำลังรวมข้อความที่ OCR อ่านซ้อนกัน…'
                  : 'กำลังแยกข้อความของบับเบิลคู่…',
            }),
        });
        row.width = planned.width || row.width;
        row.height = planned.height || row.height;
        row.ocr.observations = row.ocr.regions;
        row.ocr.unitChanges = planned.changes || [];
        row.ocr.regions = require('../ocr-content-role.cjs').annotateContent(planned.regions);
        for (const region of row.ocr.regions)
          if (region.contentRole.excluded && region.placement)
            region.placement = {
              ...region.placement,
              paintMode: 'none',
              translationExcluded: true,
            };
        row.placement = {
          engine: planned.engine || 'opencv-surface-v1',
          ms: planned.ms || 0,
          error: planned.error || '',
          ...planned.stats,
        };
        placementSummary.pages++;
        placementSummary.bubble += planned.stats.bubble || 0;
        placementSummary.scene += planned.stats.scene || 0;
        placementSummary.reviewRequired += planned.stats.reviewRequired || 0;
        placementSummary.requiresInpaint += planned.stats.requiresInpaint || 0;
        if (planned.error) placementSummary.failed++;
        translationService.sendHarvestTranslation(tab, {
          type: 'page',
          index: page.manifestIndex,
          id: row.id,
          progress: 0.73,
          status: `พื้นที่พร้อม • bubble ${planned.stats.bubble || 0} • ฉาก ${planned.stats.scene || 0} • รอแปล`,
        });
        translationService.sendHarvestTranslation(tab, {
          type: 'stage',
          stage: 'layout',
          progress: 0.69 + 0.04 * ((i + 1) / candidates.length),
          message: `พื้นที่ข้อความ ${i + 1}/${candidates.length} หน้า • bubble ${placementSummary.bubble} • ฉาก ${placementSummary.scene}`,
        });
      }
      placementSummary.ms = Date.now() - layoutStartedAt;
    } finally {
      await pool.close().catch(() => {});
      placementPlanner.close();
      backend.close();
    }

    return {
      pages: candidates.length,
      observationRegions: regions,
      regions: manifestPages.reduce((sum, p) => sum + (p.ocr?.regions?.length || 0), 0),
      failed,
      placement: placementSummary,
      ms: Date.now() - startedAt,
    };
  }

  async function runHarvestTranslateStage(
    tab,
    job,
    manifestPages,
    settings,
    model = '',
    { retryOnly = false } = {},
  ) {
    const summary = {
      provider: settings.engine,
      sourceLanguage: settings.sourceLanguage,
      targetLanguage: settings.targetLanguage,
      regions: 0,
      translated: 0,
      failed: 0,
      transportFailures: 0,
      review: 0,
      skipped: 0,
      ms: 0,
      tasks: 0,
      taskSize: 4,
    };
    const started = Date.now(),
      reusable = require('../google-web-result.cjs').reusableTranslation;
    const pages = manifestPages.filter((page) =>
      (page?.ocr?.regions || []).some((r) => r.text?.trim()),
    );
    if (!pages.length) {
      summary.ms = Date.now() - started;
      return summary;
    }

    await tab.view.webContents
      .executeJavaScript(
        `window.__harvestTsTranslationOverlay||(window.__harvestTsTranslationOverlay=(${createTranslationOverlay.toString()})(${readerDocumentKey.toString()}))`,
      )
      .catch(() => {});

    const taskCount = Math.min(4, Math.ceil(pages.length / 4));
    summary.tasks = taskCount;
    translationService.sendHarvestTranslation(tab, {
      type: 'stage',
      stage: 'translate-parallel',
      progress: 0.73,
      message: `${settings.engine === 'ai' ? 'AI' : 'Google'} แปลพร้อมกัน ${taskCount} task • ชุดละไม่เกิน 4 หน้า`,
    });

    let finishedPages = 0;
    const processPage = async (page, taskId) => {
      translationService.assertHarvestTranslationRunning(job);
      const pageStarted = Date.now(),
        regions = (page?.ocr?.regions || []).filter((r) => r.text?.trim());
      if (!regions.length) {
        finishedPages++;
        return {
          regions: 0,
          translated: 0,
          failed: 0,
          transportFailures: 0,
          providerMetrics: [],
          wallMs: Date.now() - pageStarted,
        };
      }
      for (let i = 0; i < regions.length; i++)
        if (!regions[i].id) regions[i].id = page.id + '-r' + (i + 1);
      try {
        const retryOptions = {
          provider: settings.engine,
          sourceLanguage: settings.sourceLanguage,
          targetLanguage: settings.targetLanguage,
          imageDigest: page.imageDigest || '',
        };
        const pending = retryOnly ? regions.filter((r) => !reusable(r, retryOptions)) : regions;
        if (retryOnly && pending.length)
          translationService.sendHarvestTranslation(tab, {
            type: 'page',
            index: page.index,
            id: page.id,
            progress: 0.78,
            error: false,
            status:
              'Task ' + taskId + ' • ส่ง ' + pending.length + ' จุดที่พลาดกลับเข้า queue แปลใหม่…',
          });
        let result = await translationService.ocrTranslationService.translate(pending, {
          provider: settings.engine,
          sourceLanguage: settings.sourceLanguage,
          targetLanguage: settings.targetLanguage,
          model,
          imageDigest: page.imageDigest || '',
          signal: job.abort.signal,
          context:
            'Translate the supplied manga dialogue in reading order. Page ' +
            (Number(page.index) + 1) +
            '.',
          onProgress: ({ done, total }) =>
            translationService.sendHarvestTranslation(tab, {
              type: 'page',
              index: page.index,
              id: page.id,
              progress: 0.73 + (0.2 * done) / Math.max(1, total),
              status:
                (settings.engine === 'ai' ? 'AI' : 'Google') +
                ' Task ' +
                taskId +
                ' • ' +
                done +
                '/' +
                total +
                ' จุด',
            }),
        });
        translationService.assertHarvestTranslationRunning(job);
        if (
          result.failed > 0 &&
          result.translated === 0 &&
          result.transportFailures === result.failed
        ) {
          const failure = result.items.find((r) => r.providerTransportFailure);
          const error = new Error(failure?.error || 'Translation provider failed for this page');
          error.providerTransportFailure = true;
          throw error;
        }
        if (retryOnly) {
          const retained = regions
            .filter((r) => !pending.includes(r))
            .map((r) => r.translationRecord)
            .filter(Boolean);
          result = { ...result, items: [...retained, ...result.items] };
          result.total = result.items.length;
          result.translated = result.items.filter((r) => r.status === 'translated').length;
          result.failed = result.items.filter((r) => r.status === 'failed').length;
          result.transportFailures = result.items.filter((r) => r.providerTransportFailure).length;
        }
        const byId = new Map(result.items.map((r) => [r.id, r]));
        for (const r of regions) {
          const t = byId.get(r.id);
          if (t) {
            r.translation = t.translation;
            r.translationProvider = result.provider;
            r.translationRecord = t;
          }
        }
        for (const skipped of result.skipped || []) {
          const r = regions.find((r) => r.id === skipped.id);
          if (r) {
            r.contentRole = { ...skipped };
            delete r.translation;
            delete r.translationRecord;
          }
        }
        page.translation = result;
        summary.regions += result.total;
        summary.translated += result.translated;
        summary.failed += result.failed;
        summary.transportFailures += Number(result.transportFailures) || 0;
        summary.skipped += (result.skipped || []).length;
        summary.review += (result.skipped || []).filter((r) => r.role === 'uncertain').length;
        try {
          const rendered = await translationService.prepareOverlayStyles(
            tab,
            overlayPage(page, {
              documentUrl: job.sourceUrl,
              targetLanguage: settings.targetLanguage,
            }),
          );
          translationService.assertHarvestTranslationRunning(job);
          if (
            !translationService.sameHarvestTranslationPage(
              job.sourceUrl,
              tab.view.webContents.getURL(),
            )
          )
            throw Error('หน้าเว็บเปลี่ยน กรุณาเริ่มแปลใหม่');
          page.overlay = await tab.view.webContents.executeJavaScript(
            `(() => {const overlay=window.__harvestTsTranslationOverlay;const state=overlay.apply(${JSON.stringify(rendered)},${JSON.stringify({ fontScale: settings.fontScale, visible: !settings.showOriginal })});return state.error?state:overlay.whenReady(${JSON.stringify(rendered.id)});})()`,
          );
        } catch (error) {
          translationService.assertHarvestTranslationRunning(job);
          page.overlay = { error: error.message };
        }
        const failReason =
          result.translated === 0 && result.failed
            ? result.items.find((r) => r.status === 'failed')?.error
            : '';
        translationService.sendHarvestTranslation(tab, {
          type: 'page',
          index: page.index,
          id: page.id,
          progress: 1,
          error: Boolean(page.overlay.error || result.failed),
          status:
            'Task ' +
            taskId +
            ' • แปลแล้ว ' +
            result.translated +
            '/' +
            result.total +
            ' จุด' +
            (result.failed ? ' • ไม่สำเร็จ ' + result.failed + ' จุด' : '') +
            ((result.skipped || []).some((r) => r.role === 'uncertain')
              ? ' • รอตรวจ ' + result.skipped.filter((r) => r.role === 'uncertain').length + ' จุด'
              : '') +
            ' • ' +
            (failReason
              ? String(failReason).slice(0, 120)
              : page.overlay.error
                ? 'วางไม่ได้: ' + page.overlay.error
                : page.overlay.pending
                  ? 'คำแปลพร้อม • รอภาพนี้แสดงบนเว็บ'
                  : page.overlay.pageDrawn > 0
                    ? 'วางแล้ว ' + page.overlay.pageDrawn + ' จุด'
                    : 'พร้อม'),
        });
        return {
          regions: result.total,
          translated: result.translated,
          failed: result.failed,
          transportFailures: Number(result.transportFailures) || 0,
          providerMetrics: result.providerMetrics || [],
          wallMs: Date.now() - pageStarted,
        };
      } catch (error) {
        translationService.assertHarvestTranslationRunning(job);
        summary.regions += regions.length;
        summary.failed += regions.length;
        if (error.providerTransportFailure) summary.transportFailures += regions.length;
        page.translation = {
          provider: settings.engine,
          error: error.message,
          providerTransportFailure: Boolean(error.providerTransportFailure),
        };
        translationService.sendHarvestTranslation(tab, {
          type: 'page',
          index: page.index,
          id: page.id,
          progress: 0.9,
          error: true,
          status: 'Task ' + taskId + ' • แปลไม่สำเร็จ: ' + error.message,
        });
        return {
          regions: regions.length,
          translated: 0,
          failed: regions.length,
          transportFailures: error.providerTransportFailure ? regions.length : 0,
          providerMetrics: [],
          wallMs: Date.now() - pageStarted,
        };
      } finally {
        finishedPages++;
        translationService.sendHarvestTranslation(tab, {
          type: 'stage',
          stage: 'translate-parallel',
          progress: 0.73 + 0.22 * (finishedPages / Math.max(1, pages.length)),
          message: `${settings.engine === 'ai' ? 'AI' : 'Google'} • เสร็จ ${finishedPages}/${pages.length} หน้า`,
        });
      }
    };

    if (settings.engine === 'ai' && !retryOnly) {
      const batchPages = Math.max(
          1,
          Math.min(4, Number(translationService.harvestTranslationProbeCache?.batchPages) || 2),
        ),
        groups = [];
      for (let i = 0; i < pages.length; i += batchPages)
        groups.push(pages.slice(i, i + batchPages));
      const serverParallel = Math.max(
          1,
          Math.min(4, Number(translationService.harvestTranslationProbeCache?.serverParallel) || 1),
        ),
        performanceKey = String(
          translationService.harvestTranslationProbeCache?.performanceKey || '',
        );
      let performanceProfile =
        translationService.harvestTranslationProbeCache?.performanceProfile || null;
      if (performanceKey && !performanceProfile)
        performanceProfile = await translationService.harvestTranslationPerformance.get(
          performanceKey,
          { batchPages },
        );
      let parallel = Math.min(
        serverParallel,
        groups.length,
        Math.max(1, Number(translationService.harvestTranslationProbeCache?.parallel) || 1),
      );
      summary.tasks = groups.length;
      summary.taskSize = batchPages;
      summary.adaptive = {
        profileKey: performanceKey,
        initialParallel: parallel,
        maxParallel: serverParallel,
        batchPages,
      };
      translationService.sendHarvestTranslation(tab, {
        type: 'stage',
        stage: 'translate-parallel',
        progress: 0.73,
        message: `AI Auto • ${groups.length} ชุด • เริ่ม ${parallel} task • ${batchPages} หน้า/ชุด${performanceProfile?.updatedAt ? ' • ใช้ค่าที่เรียนรู้ไว้' : ' • กำลังเรียนรู้เครื่องนี้'}`,
      });
      const processGroup = async (group, taskId) => {
        translationService.assertHarvestTranslationRunning(job);
        const groupStarted = Date.now(),
          all = [];
        for (const page of group) {
          const regions = (page?.ocr?.regions || []).filter((r) => r.text?.trim());
          for (let i = 0; i < regions.length; i++)
            if (!regions[i].id) regions[i].id = page.id + '-r' + (i + 1);
          all.push(...regions);
          translationService.sendHarvestTranslation(tab, {
            type: 'page',
            index: page.index,
            id: page.id,
            progress: 0.74,
            status: `AI Task ${taskId} • รวม ${group.length} หน้า • กำลังแปลเป็นชุดเดียว`,
          });
        }
        if (!all.length) {
          finishedPages += group.length;
          return {
            regions: 0,
            translated: 0,
            failed: 0,
            transportFailures: 0,
            providerMetrics: [],
            wallMs: Date.now() - groupStarted,
          };
        }
        const first = Number(group[0]?.index) + 1,
          last = Number(group[group.length - 1]?.index) + 1;
        let result;
        try {
          result = await translationService.ocrTranslationService.translate(all, {
            provider: 'ai',
            sourceLanguage: settings.sourceLanguage,
            targetLanguage: settings.targetLanguage,
            model,
            imageDigest: 'batch:' + group.map((p) => p.imageDigest || '').join('|'),
            signal: job.abort.signal,
            context: `Translate the supplied manga dialogue in reading order across pages ${first}-${last}. Preserve every item id exactly.`,
            onProgress: ({ done, total }) => {
              const progress = 0.74 + (0.18 * done) / Math.max(1, total);
              for (const page of group)
                translationService.sendHarvestTranslation(tab, {
                  type: 'page',
                  index: page.index,
                  id: page.id,
                  progress,
                  status: `AI Task ${taskId} • ${done}/${total} จุด • หน้า ${first}-${last}`,
                });
            },
          });
          if (
            result.failed > 0 &&
            result.translated === 0 &&
            result.transportFailures === result.failed
          ) {
            const failure = result.items.find((r) => r.providerTransportFailure);
            const transport = new Error(failure?.error || 'AI batch failed');
            transport.providerTransportFailure = true;
            throw transport;
          }
        } catch (error) {
          translationService.assertHarvestTranslationRunning(job);
          for (const page of group)
            translationService.sendHarvestTranslation(tab, {
              type: 'page',
              index: page.index,
              id: page.id,
              progress: 0.82,
              status: `Task ${taskId} • batch ตอบไม่ครบ กำลัง fallback แปลทีละหน้า…`,
            });
          const samples = [];
          for (const page of group) samples.push(await processPage(page, taskId));
          const batchTransportFailures = error.providerTransportFailure ? all.length : 0;
          return {
            regions: samples.reduce((n, x) => n + (x?.regions || 0), 0),
            translated: samples.reduce((n, x) => n + (x?.translated || 0), 0),
            failed: samples.reduce((n, x) => n + (x?.failed || 0), 0),
            transportFailures:
              batchTransportFailures + samples.reduce((n, x) => n + (x?.transportFailures || 0), 0),
            providerMetrics: samples.flatMap((x) => x?.providerMetrics || []),
            wallMs: Date.now() - groupStarted,
          };
        }
        const skipById = new Map((result.skipped || []).map((r) => [r.id, r]));
        for (const page of group) {
          const regions = (page?.ocr?.regions || []).filter((r) => r.text?.trim()),
            ids = new Set(regions.map((r) => r.id));
          const items = scopeTranslationItemsToPage(result.items, page),
            itemById = new Map(items.map((r) => [r.id, r])),
            skipped = (result.skipped || []).filter((r) => ids.has(r.id));
          for (const region of regions) {
            const t = itemById.get(region.id);
            if (t) {
              region.translation = t.translation;
              region.translationProvider = result.provider;
              region.translationRecord = t;
            }
            const sk = skipById.get(region.id);
            if (sk) {
              region.contentRole = { ...sk };
              delete region.translation;
              delete region.translationRecord;
            }
          }
          const pageResult = {
            ...result,
            imageDigest: page.imageDigest,
            items,
            skipped,
            total: items.length,
            translated: items.filter((r) => r.status === 'translated').length,
            failed: items.filter((r) => r.status === 'failed').length,
            transportFailures: items.filter((r) => r.providerTransportFailure).length,
          };
          page.translation = pageResult;
          summary.regions += pageResult.total;
          summary.translated += pageResult.translated;
          summary.failed += pageResult.failed;
          summary.transportFailures += pageResult.transportFailures;
          summary.skipped += skipped.length;
          summary.review += skipped.filter((r) => r.role === 'uncertain').length;
          try {
            const rendered = await translationService.prepareOverlayStyles(
              tab,
              overlayPage(page, {
                documentUrl: job.sourceUrl,
                targetLanguage: settings.targetLanguage,
              }),
            );
            if (
              !translationService.sameHarvestTranslationPage(
                job.sourceUrl,
                tab.view.webContents.getURL(),
              )
            )
              throw Error('หน้าเว็บเปลี่ยน กรุณาเริ่มแปลใหม่');
            page.overlay = await tab.view.webContents.executeJavaScript(
              `(() => {const overlay=window.__harvestTsTranslationOverlay;const state=overlay.apply(${JSON.stringify(rendered)},${JSON.stringify({ fontScale: settings.fontScale, visible: !settings.showOriginal })});return state.error?state:overlay.whenReady(${JSON.stringify(rendered.id)});})()`,
            );
          } catch (error) {
            page.overlay = { error: error.message };
          }
          const failReason =
            pageResult.translated === 0 && pageResult.failed
              ? pageResult.items.find((r) => r.status === 'failed')?.error
              : '';
          translationService.sendHarvestTranslation(tab, {
            type: 'page',
            index: page.index,
            id: page.id,
            progress: 1,
            error: Boolean(page.overlay.error || pageResult.failed),
            status: `Task ${taskId} • แปลแล้ว ${pageResult.translated}/${pageResult.total} จุด${pageResult.failed ? ' • ไม่สำเร็จ ' + pageResult.failed + ' จุด' : ''}${skipped.some((r) => r.role === 'uncertain') ? ' • รอตรวจ ' + skipped.filter((r) => r.role === 'uncertain').length + ' จุด' : ''} • ${failReason ? String(failReason).slice(0, 120) : page.overlay.error ? 'วางไม่ได้: ' + page.overlay.error : page.overlay.pending ? 'คำแปลพร้อม • รอภาพนี้แสดงบนเว็บ' : page.overlay.pageDrawn > 0 ? 'วางแล้ว ' + page.overlay.pageDrawn + ' จุด' : 'พร้อม'}`,
          });
        }
        finishedPages += group.length;
        return {
          regions: result.total,
          translated: result.translated,
          failed: result.failed,
          transportFailures: Number(result.transportFailures) || 0,
          providerMetrics: result.providerMetrics || [],
          wallMs: Date.now() - groupStarted,
        };
      };
      let cursor = 0,
        taskSequence = 0;
      while (cursor < groups.length) {
        translationService.assertHarvestTranslationRunning(job);
        const active = Math.max(1, Math.min(parallel, serverParallel, groups.length - cursor)),
          wave = groups.slice(cursor, cursor + active),
          waveStarted = Date.now();
        translationService.sendHarvestTranslation(tab, {
          type: 'stage',
          stage: 'translate-parallel',
          progress: 0.73 + 0.2 * (cursor / Math.max(1, groups.length)),
          message: `AI Auto • ${active} task พร้อมกัน • ชุด ${cursor + 1}-${cursor + wave.length}/${groups.length}`,
        });
        const samples = await Promise.all(wave.map((group) => processGroup(group, ++taskSequence)));
        cursor += wave.length;
        const sample = {
          parallel: active,
          batchPages,
          regions: samples.reduce((n, x) => n + (x?.regions || 0), 0),
          translated: samples.reduce((n, x) => n + (x?.translated || 0), 0),
          failed: samples.reduce((n, x) => n + (x?.failed || 0), 0),
          transportFailures: samples.reduce((n, x) => n + (x?.transportFailures || 0), 0),
          providerMetrics: samples.flatMap((x) => x?.providerMetrics || []),
          wallMs: Date.now() - waveStarted,
        };
        if (performanceKey && performanceProfile) {
          performanceProfile = recordTranslationWave(performanceProfile, sample, {
            maxParallel: serverParallel,
          });
          await translationService.harvestTranslationPerformance
            .set(performanceKey, performanceProfile)
            .catch(() => {});
          translationService.harvestTranslationProbeCache.performanceProfile = performanceProfile;
          translationService.harvestTranslationProbeCache.batchPages =
            performanceProfile.batchPages;
          translationService.harvestTranslationProbeCache.parallel =
            performanceProfile.recommendedParallel;
          let nextParallel;
          if (performanceProfile.recommendedParallel < active)
            nextParallel = Math.max(1, performanceProfile.recommendedParallel);
          else
            nextParallel = recommendTranslationParallel(performanceProfile, {
              currentParallel: active,
              maxParallel: serverParallel,
              remainingGroups: groups.length - cursor,
              providerMetrics: sample.providerMetrics,
              wallMs: sample.wallMs,
            });
          nextParallel = Math.max(1, Math.min(serverParallel, nextParallel));
          const metrics = summarizeProviderMetrics(sample.providerMetrics),
            metricText =
              (metrics.tps ? ` • ${metrics.tps.toFixed(1)} tok/s` : '') +
              (metrics.ttftMs ? ` • TTFT ${(metrics.ttftMs / 1000).toFixed(1)}s` : '');
          if (nextParallel !== active)
            translationService.sendHarvestTranslation(tab, {
              type: 'stage',
              stage: 'translate-parallel',
              progress: 0.73 + 0.2 * (cursor / Math.max(1, groups.length)),
              message: `Auto tune ${active} → ${nextParallel} task${metricText} • จำค่านี้สำหรับเครื่อง+โมเดลนี้แล้ว`,
            });
          else
            translationService.sendHarvestTranslation(tab, {
              type: 'stage',
              stage: 'translate-parallel',
              progress: 0.73 + 0.2 * (cursor / Math.max(1, groups.length)),
              message: `Auto tune คง ${active} task${metricText} • จำผลไว้แล้ว`,
            });
          parallel = nextParallel;
        }
      }
      summary.adaptive.finalParallel = parallel;
      summary.adaptive.profile = performanceProfile || null;
    } else {
      const pageParallel =
        settings.engine === 'ai'
          ? Math.max(
              1,
              Math.min(4, Number(translationService.harvestTranslationProbeCache?.parallel) || 1),
            )
          : 4;
      await runPageTaskGroups(pages, {
        taskSize: 4,
        concurrency: pageParallel,
        signal: job.abort.signal,
        handlePage: (page, { taskId }) => processPage(page, taskId),
      });
    }
    summary.ms = Date.now() - started;
    return summary;
  }
  return {
    runHarvestOcrStage,
    runHarvestTranslateStage,
  };
}
module.exports = { createTranslationStages };
