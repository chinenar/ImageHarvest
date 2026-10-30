'use strict';
const { app } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { SiteObserver } = require('../site-observer.cjs');
const { SiteProfiles, verification } = require('../adaptive-core.cjs');
const { AdaptiveSession, describeAdaptive } = require('../adaptive-session.cjs');
const {
  imageURL,
  imageType,
  publicItem,
  orderItems,
  idFor,
  delay,
  ByteCache,
} = require('../core.cjs');

function createCollectorCollection({
  collectorBrowser: collectorBrowserService,
  collectorCapture: collectorCaptureService,
  collectorFiles: collectorFilesService,
  collectorNavigation: collectorNavigationService,
  collectorWorkspaces: collectorWorkspacesService,
  host: hostService,
}) {
  let records = new Map();

  let cache = new ByteCache();

  let pending = new Map();

  let failedImages = new Map();

  let generation = 0;

  let pageInfo = { title: '', url: '' };

  let lastFolder = '';

  let outputRoot = '';

  let renameFolder = '';

  let canvasTempDir = '';

  let blockedHosts = new Map();

  let queue = Promise.resolve();

  let requestGate = 0;

  let excludedIds = new Set();

  let lastRemoval = [];

  let collector;

  let scrollScript;

  let canvasCaptureScript;

  let readerProbe;

  const siteProfiles = new SiteProfiles(
    path.join(app.getPath('userData'), 'adaptive', 'site-profiles.json'),
  );

  const electronObserver = new SiteObserver();

  function observationInfo(sources = []) {
    if (collectorBrowserService.browserMode === 'chrome')
      return collectorBrowserService.chromeBrowser.observationInfo(sources);
    electronObserver.seedScripts(sources);
    return electronObserver.snapshot();
  }

  async function clearCollection() {
    excludedIds.clear();
    lastRemoval = [];
    const oldCanvasDir = canvasTempDir;
    canvasTempDir = '';
    generation++;
    records = new Map();
    cache.clear();
    failedImages.clear();
    pending.clear();
    blockedHosts.clear();
    if (oldCanvasDir) await fs.rm(oldCanvasDir, { recursive: true, force: true }).catch(() => {});
  }

  function removeItems(input) {
    collectorBrowserService.ensureIdle();
    const items = collectorFilesService.selectedItems(input);
    if (!items.length) throw new Error('ยังไม่ได้เลือกภาพ');
    lastRemoval = items.map((x) => x.id);
    lastRemoval.forEach((id) => excludedIds.add(id));
    return {
      removed: lastRemoval.length,
      count: records.size - excludedIds.size,
    };
  }

  function undoRemove() {
    collectorBrowserService.ensureIdle();
    const ids = lastRemoval.filter((id) => records.has(id) && excludedIds.has(id));
    ids.forEach((id) => excludedIds.delete(id));
    lastRemoval = [];
    return { ids };
  }

  async function clearResults() {
    collectorBrowserService.ensureIdle();
    collectorBrowserService.busy = 'clear';
    try {
      await clearCollection();
      pageInfo = { title: '', url: collectorBrowserService.webURL() };
      return { cleared: true };
    } finally {
      collectorBrowserService.busy = null;
    }
  }

  async function scan(input = {}) {
    collectorBrowserService.ensureIdle();
    if (
      !collectorBrowserService.webAlive() ||
      !hostService.allowedWeb(collectorBrowserService.webURL())
    )
      throw new Error('กรุณาเปิดเว็บไซต์ก่อนสแกน');
    if (
      /Open in Browser|403 Forbidden|Just a moment|Access Denied|Performing security verification|Verification successful|site is currently suspended/i.test(
        await collectorBrowserService.webTitle(),
      )
    )
      throw new Error(
        'เว็บไซต์ยังไม่เปิดหน้าอ่าน (หน้าแจ้ง/ตรวจสอบ/ปฏิเสธการเข้าถึง) กรุณาตรวจหน้าต่างเว็บก่อนสแกน',
      );
    const selector = String(input.selector || '')
      .trim()
      .slice(0, 500);
    const maxSteps = Math.max(5, Math.min(600, Number(input.maxSteps) || 150));
    const waitMs = Math.max(350, Math.min(5000, Number(input.waitMs) || 800));
    const auto = input.autoScroll !== false;
    const options = {
      selector,
      backgrounds: Boolean(input.backgrounds),
      canvases: Boolean(input.canvases),
      autoScroll: auto,
      conservativeScroll: false,
      smartBackgrounds: true,
    };
    collectorBrowserService.busy = 'scan';
    collectorBrowserService.job = {
      cancelled: false,
      abort: new AbortController(),
    };
    await clearCollection();
    if (options.canvases) {
      canvasTempDir = path.join(
        app.getPath('temp'),
        'ImageHarvest',
        `${process.pid}-${generation}-${Date.now()}`,
      );
      await fs.mkdir(canvasTempDir, { recursive: true });
    }
    const startURL = collectorBrowserService.webURL(),
      found = new Map(),
      canvasFailures = new Set(),
      blobFailures = new Map();
    let truncated = false,
      reason = '',
      steps = 0,
      previousHeight = -1,
      previousFound = -1,
      previousVerified = -1,
      stable = 0,
      metadata = {},
      canvasPositionRetries = 0;
    let adaptive = null,
      adaptiveResult = null,
      adaptiveError = '';
    try {
      adaptive = new AdaptiveSession({
        store: siteProfiles,
        url: startURL,
        mode:
          collectorBrowserService.browserMode === 'chrome'
            ? `chrome-${hostService.chromeControl}`
            : 'electron',
        probe: () =>
          collectorBrowserService.runPage(`(${readerProbe})(${JSON.stringify({ selector })})`),
        observation: observationInfo,
        notify: hostService.emit,
      });
      await adaptive.start(options);
    } catch (error) {
      adaptiveError = error.message || String(error);
      adaptive = null;
    }
    const scanId = randomUUID(),
      workspaceId = collectorWorkspacesService.activeWorkspaceId;
    let bookWalkerProbe = null;
    if (options.canvases && collectorBrowserService.browserMode === 'chrome') {
      bookWalkerProbe = await collectorNavigationService.bookWalkerReader('probe');
    }
    if (bookWalkerProbe?.supported && bookWalkerProbe.total > 0) {
      hostService.emit('scan-start', { scanId, workspaceId });
      hostService.emit('status', {
        message: `BOOK☆WALKER • ตรวจพบตัวอ่าน ${bookWalkerProbe.current} / ${bookWalkerProbe.total} • จะเก็บครบทุกหน้า`,
      });
      try {
        return await collectorCaptureService.scanBookWalkerAllPages({
          scanId,
          workspaceId,
          startURL,
          waitMs,
        });
      } finally {
        collectorBrowserService.job = null;
        collectorBrowserService.busy = null;
      }
    }
    const dirty = new Map(),
      published = new Map();
    let lastFlush = 0;
    function flushScan(force = false) {
      if (!dirty.size || (!force && dirty.size < 12 && Date.now() - lastFlush < 90)) return;
      hostService.emit('scan-items', {
        scanId,
        workspaceId,
        items: [...dirty.values()],
        count: found.size,
        title: metadata.title || '',
        url: startURL,
      });
      dirty.clear();
      lastFlush = Date.now();
    }
    function publishRecord(item, final = false) {
      item.referrer = startURL;
      item.backend = collectorBrowserService.browserMode;
      // During scanning, preview only bytes already preserved from the browser response.
      // This avoids replaying image URLs with a different request type while the reader is still loading.
      item.previewReady = final || Boolean(item.capturePath) || item.url.startsWith('data:');
      records.set(item.id, item);
      const value = publicItem(item),
        signature = JSON.stringify(value);
      if (published.get(item.id) !== signature) {
        published.set(item.id, signature);
        dirty.set(item.id, value);
      }
      flushScan();
    }
    hostService.emit('scan-start', { scanId, workspaceId });
    try {
      if (auto) {
        await collectorBrowserService.runPage(`(${scrollScript})('init')`);
        await delay(waitMs);
      }
      for (let step = 0; step < (auto ? maxSteps : 1); step++) {
        steps = step + 1;
        if (collectorBrowserService.job.cancelled) break;
        if (collectorBrowserService.webURL() !== startURL) {
          reason = 'หน้าเว็บเปลี่ยนระหว่างสแกน ผลลัพธ์อาจไม่ครบ';
          truncated = true;
          break;
        }
        const snap = await hostService.withTimeout(
          collectorBrowserService.runPage(`(${collector})(${JSON.stringify(options)})`),
          15000,
          'หน้าเว็บไม่ตอบสนองต่อการสแกน',
        );
        metadata = snap;
        for (const item of snap.items) {
          const url = imageURL(item.url, startURL);
          if (!url) continue;
          const key = `${item.key}|${url}`,
            existing = found.get(key);
          if (existing)
            Object.assign(existing, item, {
              order: existing.order,
              id: existing.id,
            });
          else if (found.size < hostService.MAX_IMAGES)
            found.set(key, {
              ...item,
              url,
              id: idFor(`${collectorWorkspacesService.activeWorkspaceId}:${generation}:${key}`),
              order: found.size,
            });
          else {
            truncated = true;
            reason = 'ถึงขีดจำกัด 5,000 ภาพแล้ว';
            break;
          }
          const record = found.get(key);
          if (collectorBrowserService.browserMode === 'chrome' && record) {
            record.nativeOnly =
              collectorBrowserService.chromeBrowser.compatibilityInfo().applied > 0;
            await preserveChromeImage(record).catch((error) => {
              record.responseCaptureError = error.message;
            });
          } else if (collectorBrowserService.browserMode === 'electron' && record) {
            await preserveElectronImage(record).catch((error) => {
              record.responseCaptureError = error.message;
            });
          }
          // Blob URLs can be revoked by lazy readers before a full scan finishes.
          // Preserve original bytes now; a failed attempt must remain retryable.
          if (url.startsWith('blob:') && record && !record.capturePath) {
            try {
              const data = await collectorFilesService.acquireImage(
                {
                  ...record,
                  referrer: startURL,
                  backend: collectorBrowserService.browserMode,
                },
                collectorBrowserService.job.abort.signal,
              );
              if (collectorBrowserService.job.cancelled) break;
              const dir = await ensureCaptureTempDir(),
                capturePath = path.join(dir, `${record.id}.${data.ext}`);
              await fs.writeFile(capturePath, data.buffer);
              Object.assign(record, {
                capturePath,
                ext: data.ext,
                contentHash: snapshotHash(data.buffer),
              });
              blobFailures.delete(key);
            } catch (error) {
              if (collectorBrowserService.job.cancelled) break;
              blobFailures.set(key, error.message || String(error));
            }
          }
          publishRecord(record);
        }
        flushScan(true);
        let retryCanvasPosition = false;
        if (options.canvases && !truncated) {
          for (const canvas of snap.canvasItems || []) {
            const key = `canvas:${canvas.captureId}`;
            if (found.has(key) || canvasFailures.has(key) || found.size >= hostService.MAX_IMAGES)
              continue;
            const captured = await hostService.withTimeout(
              collectorBrowserService.runPage(
                `(${canvasCaptureScript})(${JSON.stringify(canvas.captureId)})`,
              ),
              15000,
              'Canvas ใช้เวลาส่งออกนานเกินไป',
            );
            if (!captured || captured.error) {
              if (captured?.retry) retryCanvasPosition = true;
              else canvasFailures.add(key);
              continue;
            }
            const comma = captured.data.indexOf(','),
              buffer = Buffer.from(captured.data.slice(comma + 1), 'base64');
            if (!buffer.length || buffer.length > hostService.MAX_IMAGE) {
              canvasFailures.add(key);
              continue;
            }
            const typed = imageType(buffer, 'image/png'),
              url = `canvas-capture://${generation}/${canvas.captureId}`;
            const id = idFor(
                `${collectorWorkspacesService.activeWorkspaceId}:${generation}:${key}`,
              ),
              capturePath = path.join(canvasTempDir, `${id}.png`);
            await fs.writeFile(capturePath, buffer, { flag: 'wx' });
            found.set(key, {
              ...canvas,
              key,
              url,
              id,
              order: found.size,
              source: 'canvas',
              label: canvas.alt
                ? `Canvas — ${canvas.alt}`
                : `Canvas ${String(canvas.captureId).padStart(3, '0')}`,
              width: captured.width,
              height: captured.height,
              capturePath,
              ext: typed.ext,
            });
            publishRecord(found.get(key));
          }
        }
        flushScan(true);
        adaptive?.update([...found.values()]);
        if (options.canvases && retryCanvasPosition && canvasPositionRetries < 2) {
          canvasPositionRetries++;
          hostService.emit('scan-progress', {
            scanId,
            workspaceId,
            count: found.size,
            step: steps,
            maxSteps,
            progress: 0,
          });
          await delay(waitMs);
          continue;
        }
        canvasPositionRetries = 0;
        const pos = auto
          ? await collectorBrowserService.runPage(`(${scrollScript})('status')`)
          : { bottom: true, progress: 1, height: 0 };
        hostService.emit('scan-progress', {
          scanId,
          workspaceId,
          count: found.size,
          step: steps,
          maxSteps,
          progress: pos.progress,
        });
        if (!auto || truncated) break;
        const currentVerification = verification([...found.values()]);
        stable =
          pos.bottom &&
          pos.height === previousHeight &&
          found.size === previousFound &&
          currentVerification.verified === previousVerified
            ? stable + 1
            : 0;
        previousHeight = pos.height;
        previousFound = found.size;
        previousVerified = currentVerification.verified;
        // At the bottom, require both geometry and discovered/verified image counts to stay quiet.
        // Then let Adaptive compare the current DOM against what the collector verified.
        // It may enable a discovered lazy attribute/background strategy before accepting the plateau.
        if (stable >= 3) {
          const current = [...found.values()];
          let recovered = adaptive
            ? await adaptive.recover(options, current, false).catch(() => false)
            : false;
          if (!recovered && adaptive) {
            const v = verification(current);
            const floor = Math.max(
              Number(adaptive.probe?.expectedTotal) || 0,
              adaptive.observedCandidateCount(),
            );
            if (v.verified < v.candidates || floor > v.candidates)
              recovered = await adaptive.recover(options, current, true).catch(() => false);
          }
          if (recovered) {
            stable = 0;
            previousHeight = -1;
            if (options.conservativeScroll) {
              await collectorBrowserService.runPage(`(${scrollScript})('restore')`).catch(() => {});
              await collectorBrowserService.runPage(`(${scrollScript})('init')`);
              await delay(Math.max(waitMs, 650));
            } else await delay(Math.min(waitMs, 350));
            continue;
          }
          break;
        }
        if (step === maxSteps - 1) {
          truncated = true;
          reason = 'ถึงจำนวนรอบเลื่อนที่ตั้งไว้ เพิ่มรอบแล้วสแกนใหม่ได้';
          break;
        }
        const v = currentVerification;
        const rapid =
          !options.conservativeScroll && v.candidates >= 4 && v.verified === v.candidates;
        if (!pos.bottom) {
          const readyBlobs = [...found.values()]
            .filter((x) => x.url.startsWith('blob:') && x.capturePath)
            .map((x) => x.url);
          await collectorBrowserService.runPage(
            `(${scrollScript})(${JSON.stringify({ action: 'step', readyBlobs, conservative: options.conservativeScroll === true, factor: rapid ? 1.7 : 1 })})`,
          );
        }
        await delay(
          pos.bottom
            ? Math.max(waitMs, 650)
            : options.conservativeScroll
              ? Math.max(waitMs, 650)
              : rapid
                ? Math.min(waitMs, 320)
                : waitMs,
        );
      }
      if (collectorBrowserService.browserMode === 'chrome') {
        await hostService.withTimeout(
          collectorBrowserService.chromeBrowser.settleImages(),
          10000,
          'รอข้อมูลภาพจาก Chrome นานเกินไป',
        );
        for (const item of found.values()) {
          if (collectorBrowserService.job.cancelled) break;
          await preserveChromeImage(item).catch((error) => {
            item.responseCaptureError = error.message;
          });
        }
      } else if (
        collectorBrowserService.browserMode === 'electron' &&
        collectorBrowserService.electronImageStore
      ) {
        await hostService.withTimeout(
          collectorBrowserService.electronImageStore.settle(),
          10000,
          'รอข้อมูลภาพจาก Browser นานเกินไป',
        );
        for (const item of found.values()) {
          if (collectorBrowserService.job.cancelled) break;
          await preserveElectronImage(item).catch((error) => {
            item.responseCaptureError = error.message;
          });
        }
      }
      const all = orderItems([...found.values()], 'visual');
      for (const item of all) publishRecord(item, true);
      flushScan(true);
      pageInfo = {
        title: metadata.title || (await collectorBrowserService.webTitle()),
        url: startURL,
        compatibility:
          collectorBrowserService.browserMode === 'chrome'
            ? collectorBrowserService.chromeBrowser.compatibilityInfo()
            : null,
      };
      const cancelled = collectorBrowserService.job.cancelled;
      if (adaptive) {
        try {
          adaptiveResult = await adaptive.finish({
            items: all,
            cancelled,
            truncated,
            failures: blobFailures.size + canvasFailures.size,
            stopReason: reason,
          });
        } catch (error) {
          adaptiveError = error.message || String(error);
        }
      }
      return {
        scanId,
        items: all.map(publicItem),
        ...pageInfo,
        cancelled,
        truncated,
        reason,
        steps,
        adaptive: adaptiveResult,
        notice: [
          pageInfo.compatibility
            ? `Chrome: เก็บต้นฉบับ ${all.filter((x) => x.capturedVia === 'chrome-response').length} ภาพ • ใช้กฎ ${pageInfo.compatibility.applied || 0} รายการ${pageInfo.compatibility.unknown ? ' • พบระบบที่ยังไม่รู้จัก ' + pageInfo.compatibility.unknown + ' รายการ' : ''}`
            : '',
          adaptiveResult
            ? describeAdaptive(adaptiveResult)
            : adaptiveError
              ? `Adaptive: ใช้งานไม่ได้ (${adaptiveError})`
              : '',
          blobFailures.size
            ? `เก็บภาพชั่วคราวไม่สำเร็จ ${blobFailures.size} รายการ: อาจต้องสแกนใหม่`
            : '',
          metadata.frames ? `พบ iframe ${metadata.frames} ส่วน: ยังไม่สแกนภายใน iframe` : '',
          metadata.canvases
            ? options.canvases
              ? `พบ canvas ${metadata.canvases} ส่วน: จับเฉพาะ canvas ที่วาดเสร็จและ browser อนุญาตให้อ่าน`
              : `พบ canvas ${metadata.canvases} ส่วน: เปิด “รวม Canvas” หากต้องการเก็บภาพที่วาดแล้ว`
            : '',
        ]
          .filter(Boolean)
          .join(' • '),
      };
    } catch (error) {
      if (adaptive && !adaptiveResult)
        await adaptive
          .finish({
            items: [...found.values()],
            cancelled: Boolean(collectorBrowserService.job?.cancelled),
            truncated,
            failures: blobFailures.size + canvasFailures.size,
            error: true,
            stopReason: error.message || String(error),
          })
          .catch(() => {});
      throw error;
    } finally {
      flushScan(true);
      if (
        auto &&
        collectorBrowserService.webAlive() &&
        collectorBrowserService.webURL() === startURL
      )
        await collectorBrowserService.runPage(`(${scrollScript})('restore')`).catch(() => {});
      collectorBrowserService.job = null;
      collectorBrowserService.busy = null;
    }
  }

  async function preserveElectronImage(item) {
    if (
      item.capturePath ||
      !collectorBrowserService.electronImageStore ||
      !/^https?:/.test(item.url)
    )
      return;
    const data = await hostService.withTimeout(
      collectorBrowserService.electronImageStore.read(item.url),
      5000,
      'รอภาพจาก Browser นานเกินไป',
    );
    if (!data) return;
    const contentHash = snapshotHash(data.buffer),
      dir = await ensureCaptureTempDir();
    const capturePath = path.join(dir, `electron-${contentHash}.${data.ext}`);
    try {
      await fs.writeFile(capturePath, data.buffer, { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    Object.assign(item, {
      capturePath,
      ext: data.ext,
      contentHash,
      capturedVia: 'electron-response',
    });
  }

  async function preserveChromeImage(item) {
    if (item.capturePath || !/^https?:/.test(item.url)) return;
    const data = await hostService.withTimeout(
      collectorBrowserService.chromeBrowser.loadedImage(item.url),
      5000,
      'รอภาพจาก Chrome นานเกินไป',
    );
    if (!data) return;
    const contentHash = snapshotHash(data.buffer),
      dir = await ensureCaptureTempDir();
    const capturePath = path.join(dir, `chrome-${contentHash}.${data.ext}`);
    try {
      await fs.writeFile(capturePath, data.buffer, { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    Object.assign(item, {
      capturePath,
      ext: data.ext,
      contentHash,
      capturedVia: 'chrome-response',
    });
  }

  async function ensureCaptureTempDir() {
    if (!canvasTempDir) {
      canvasTempDir = path.join(
        app.getPath('temp'),
        'ImageHarvest',
        `${process.pid}-${generation}-${Date.now()}`,
      );
      await fs.mkdir(canvasTempDir, { recursive: true });
    }
    return canvasTempDir;
  }

  function snapshotHash(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
  }

  async function storeSnapshot(candidate, data, sourceURL, state) {
    const hash = snapshotHash(data.buffer);
    // Page-based readers can legitimately contain identical/blank/repeated pages. For those,
    // sequenceKey is the identity and content hashes are only metadata, not a reason to drop a page.
    const sequenceKey = String(candidate.sequenceKey || '');
    if (sequenceKey && state.sequenceKeys?.has(sequenceKey)) return { duplicate: true };
    if (!sequenceKey && state.hashes.has(hash)) return { duplicate: true };
    if (records.size >= hostService.MAX_IMAGES) return { full: true };
    const id = idFor(sequenceKey ? `snapshot:${sequenceKey}:${hash}` : `snapshot:${hash}`),
      dir = await ensureCaptureTempDir();
    const capturePath = path.join(dir, `${id}.${data.ext}`);
    try {
      await fs.writeFile(capturePath, data.buffer, { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    if (sequenceKey) state.sequenceKeys?.add(sequenceKey);
    else state.hashes.add(hash);
    const item = {
      ...candidate,
      id,
      order: records.size,
      referrer: sourceURL,
      backend: collectorBrowserService.browserMode,
      capturePath,
      contentHash: hash,
      ext: data.ext,
    };
    records.set(id, item);
    return { item: publicItem(item) };
  }
  return {
    get records() {
      return records;
    },
    set records(value) {
      records = value;
    },
    get cache() {
      return cache;
    },
    set cache(value) {
      cache = value;
    },
    get pending() {
      return pending;
    },
    set pending(value) {
      pending = value;
    },
    get failedImages() {
      return failedImages;
    },
    set failedImages(value) {
      failedImages = value;
    },
    get generation() {
      return generation;
    },
    set generation(value) {
      generation = value;
    },
    get pageInfo() {
      return pageInfo;
    },
    set pageInfo(value) {
      pageInfo = value;
    },
    get lastFolder() {
      return lastFolder;
    },
    set lastFolder(value) {
      lastFolder = value;
    },
    get outputRoot() {
      return outputRoot;
    },
    set outputRoot(value) {
      outputRoot = value;
    },
    get renameFolder() {
      return renameFolder;
    },
    set renameFolder(value) {
      renameFolder = value;
    },
    get canvasTempDir() {
      return canvasTempDir;
    },
    set canvasTempDir(value) {
      canvasTempDir = value;
    },
    get blockedHosts() {
      return blockedHosts;
    },
    set blockedHosts(value) {
      blockedHosts = value;
    },
    get queue() {
      return queue;
    },
    set queue(value) {
      queue = value;
    },
    get requestGate() {
      return requestGate;
    },
    set requestGate(value) {
      requestGate = value;
    },
    get excludedIds() {
      return excludedIds;
    },
    set excludedIds(value) {
      excludedIds = value;
    },
    get lastRemoval() {
      return lastRemoval;
    },
    set lastRemoval(value) {
      lastRemoval = value;
    },
    get collector() {
      return collector;
    },
    set collector(value) {
      collector = value;
    },
    get scrollScript() {
      return scrollScript;
    },
    set scrollScript(value) {
      scrollScript = value;
    },
    get canvasCaptureScript() {
      return canvasCaptureScript;
    },
    set canvasCaptureScript(value) {
      canvasCaptureScript = value;
    },
    get readerProbe() {
      return readerProbe;
    },
    set readerProbe(value) {
      readerProbe = value;
    },
    get siteProfiles() {
      return siteProfiles;
    },
    get electronObserver() {
      return electronObserver;
    },
    clearCollection,
    removeItems,
    undoRemove,
    clearResults,
    scan,
    ensureCaptureTempDir,
    snapshotHash,
    storeSnapshot,
  };
}
module.exports = { createCollectorCollection };
