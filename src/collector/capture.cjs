'use strict';
const { imageURL, imageType, publicItem, delay } = require('../core.cjs');

function createCollectorCapture({
  collectorBrowser: collectorBrowserService,
  collectorCollection: collectorCollectionService,
  collectorFiles: collectorFilesService,
  collectorNavigation: collectorNavigationService,
  host: hostService,
}) {
  let captureSession = null;

  async function captureBookWalkerVisiblePage(state) {
    const sourceURL = collectorBrowserService.webURL();
    let ready = await collectorNavigationService.bookWalkerCanvasState(false);
    if (!ready.supported || !ready.current || !ready.total)
      throw new Error('BookWalker ยังไม่พร้อมจับหน้าหนังสือ');
    if (
      !state.bookWalkerReady ||
      state.bookWalkerReady.current !== ready.current ||
      !ready.signature ||
      state.bookWalkerReady.signature !== ready.signature ||
      ready.loading
    ) {
      ready = await collectorNavigationService.waitForBookWalkerPageReady(ready.current, state);
    }
    let captured = await hostService.withTimeout(
      collectorNavigationService.bookWalkerCanvasState(true),
      20000,
      'BookWalker ใช้เวลาส่งออกหน้าปัจจุบันนานเกินไป',
    );
    if (!captured?.supported || captured.error || !captured.data) {
      throw new Error(captured?.error || 'BookWalker ไม่ส่ง Canvas ของหน้าปัจจุบัน');
    }
    if (
      captured.current !== ready.current ||
      captured.loading ||
      captured.signature !== ready.signature
    ) {
      ready = await collectorNavigationService.waitForBookWalkerPageReady(
        captured.current || ready.current,
        state,
      );
      captured = await hostService.withTimeout(
        collectorNavigationService.bookWalkerCanvasState(true),
        20000,
        'BookWalker ใช้เวลาส่งออกหน้าปัจจุบันนานเกินไป',
      );
      if (
        !captured?.data ||
        captured.error ||
        captured.loading ||
        captured.current !== ready.current
      ) {
        throw new Error(captured?.error || 'BookWalker เปลี่ยน Canvas ระหว่างกำลังจับภาพ');
      }
    }
    const comma = captured.data.indexOf(',');
    if (comma < 0) throw new Error('ข้อมูล Canvas ของ BookWalker ไม่ถูกต้อง');
    const buffer = Buffer.from(captured.data.slice(comma + 1), 'base64');
    if (!buffer.length || buffer.length > hostService.MAX_IMAGE)
      throw new Error('ภาพหน้า BookWalker มีขนาดไม่ถูกต้อง');
    const typed = imageType(buffer, 'image/png');
    let bookId = 'book';
    try {
      bookId = new URL(sourceURL).searchParams.get('cid') || bookId;
    } catch {}
    const page = captured.current,
      total = captured.total;
    const digits = Math.max(4, String(total).length);
    const candidate = {
      key: `bookwalker-page:${page}`,
      sequenceKey: `bookwalker:${bookId}:page:${page}`,
      url: `canvas-capture://bookwalker/${encodeURIComponent(bookId)}/${page}`,
      source: 'canvas',
      top: page - 1,
      left: 0,
      width: captured.width,
      height: captured.height,
      alt: `BookWalker page ${page} / ${total}`,
      label: `BookWalker page ${String(page).padStart(digits, '0')} / ${total}`,
    };
    const stored = await collectorCollectionService.storeSnapshot(
      candidate,
      { buffer, ...typed },
      sourceURL,
      state,
    );
    state.bookWalkerReady = {
      current: captured.current,
      signature: captured.signature,
    };
    collectorCollectionService.pageInfo = {
      title: await collectorBrowserService.webTitle().catch(() => ''),
      url: sourceURL,
    };
    return {
      items: stored.item ? [stored.item] : [],
      duplicates: stored.duplicate ? 1 : 0,
      failed: 0,
      title: collectorCollectionService.pageInfo.title,
      url: sourceURL,
      reader: { current: page, total },
    };
  }

  async function scanBookWalkerAllPages({ scanId, workspaceId, startURL, waitMs }) {
    const state = {
      get cancelled() {
        return Boolean(collectorBrowserService.job?.cancelled);
      },
      abort: collectorBrowserService.job.abort,
      intervalMs: waitMs,
      canvases: true,
      hashes: new Set(),
      sequenceKeys: new Set(),
      bookWalkerReady: null,
    };
    let total = 0,
      steps = 0,
      reason = '';
    const initial = await collectorNavigationService.waitForBookWalkerPageReady(0, state);
    total = initial.total || 0;
    const first = await collectorNavigationService.bookWalkerReader('first');
    if (!first.supported) throw new Error('BookWalker ไม่พบตัวควบคุมลำดับหน้า');
    total = first.total || total;
    if (first.moved || initial.current !== 1) {
      hostService.emit('status', {
        message: `BOOK☆WALKER • กำลังกลับไปหน้า 1 / ${total} เพื่อเก็บให้ครบ`,
      });
      await collectorNavigationService.waitForBookWalkerPageReady(1, state);
    }
    while (!state.cancelled && !state.abort.signal.aborted) {
      let result, lastError;
      for (let attempt = 0; attempt < 3 && !result; attempt++) {
        try {
          result = await captureBookWalkerVisiblePage(state);
        } catch (error) {
          lastError = error;
          state.bookWalkerReady = null;
          if (attempt < 2) {
            await delay(300);
            await collectorNavigationService.waitForBookWalkerPageReady(0, state);
          }
        }
      }
      if (!result) throw lastError || new Error('BookWalker จับหน้าปัจจุบันไม่สำเร็จ');
      steps++;
      const current = result.reader?.current || steps;
      total = result.reader?.total || total;
      if (result.items?.length) {
        hostService.emit('scan-items', {
          scanId,
          workspaceId,
          items: result.items,
          count: collectorCollectionService.records.size,
          title: result.title || '',
          url: startURL,
        });
      }
      hostService.emit('scan-progress', {
        scanId,
        workspaceId,
        count: collectorCollectionService.records.size,
        step: current,
        maxSteps: total || current,
        progress: total ? current / total : 0,
      });
      hostService.emit('status', {
        message: `BOOK☆WALKER • เก็บหน้า ${current} / ${total} • ได้แล้ว ${collectorCollectionService.records.size} หน้า`,
      });
      if (current >= total) {
        reason = `เก็บครบ ${total} หน้าแล้ว`;
        break;
      }
      const next = await collectorNavigationService.bookWalkerReader('advance');
      if (!next.supported || next.done || !next.moved) {
        throw new Error(`BookWalker เปลี่ยนจากหน้า ${current} ไปหน้าถัดไปไม่สำเร็จ`);
      }
      await collectorNavigationService.waitForBookWalkerPageChange(current, state);
    }
    const title = await collectorBrowserService.webTitle().catch(() => '');
    const all = [...collectorCollectionService.records.values()].sort((a, b) => a.order - b.order);
    collectorCollectionService.pageInfo = {
      title,
      url: startURL,
      compatibility: collectorBrowserService.chromeBrowser.compatibilityInfo(),
    };
    return {
      scanId,
      items: all.map(publicItem),
      ...collectorCollectionService.pageInfo,
      cancelled: state.cancelled || state.abort.signal.aborted,
      truncated: false,
      reason,
      steps,
      notice: `BOOK☆WALKER: เก็บ ${all.length}${total ? ` / ${total}` : ''} หน้าเป็นภาพจาก Canvas ตามลำดับหน้า`,
    };
  }

  async function captureVisiblePass(state) {
    const sourceURL = collectorBrowserService.webURL();
    if (
      state.canvases &&
      collectorBrowserService.browserMode === 'chrome' &&
      collectorNavigationService.isBookWalkerViewer(sourceURL)
    )
      return captureBookWalkerVisiblePage(state);
    if (!hostService.allowedWeb(sourceURL))
      throw new Error('หน้าต่างเว็บยังไม่อยู่บนหน้า http/https');
    const options = {
      selector: state.selector,
      backgrounds: state.backgrounds,
      canvases: state.canvases,
      visibleOnly: true,
    };
    const snap = await hostService.withTimeout(
      collectorBrowserService.runPage(
        `(${collectorCollectionService.collector})(${JSON.stringify(options)})`,
      ),
      15000,
      'หน้าเว็บไม่ตอบสนองต่อการจับภาพ',
    );
    const added = [],
      attempted = new Set();
    let duplicates = 0,
      failed = 0;
    for (const raw of snap.items || []) {
      if (
        state.cancelled ||
        state.abort.signal.aborted ||
        collectorCollectionService.records.size >= hostService.MAX_IMAGES
      )
        break;
      const url = imageURL(raw.url, sourceURL);
      if (!url) continue;
      const attemptKey = `${raw.source}|${url}`;
      if (attempted.has(attemptKey)) continue;
      attempted.add(attemptKey);
      const candidate = {
        ...raw,
        url,
        referrer: sourceURL,
        backend: collectorBrowserService.browserMode,
      };
      try {
        const data = await collectorFilesService.acquireImage(candidate, state.abort.signal);
        const stored = await collectorCollectionService.storeSnapshot(
          candidate,
          data,
          sourceURL,
          state,
        );
        if (stored.item) added.push(stored.item);
        else if (stored.duplicate) duplicates++;
        if (stored.full) break;
      } catch (error) {
        if (state.cancelled || state.abort.signal.aborted) break;
        failed++;
        state.lastError = error.message || String(error);
      }
    }
    for (const canvas of snap.canvasItems || []) {
      if (
        state.cancelled ||
        state.abort.signal.aborted ||
        collectorCollectionService.records.size >= hostService.MAX_IMAGES
      )
        break;
      try {
        const captured = await hostService.withTimeout(
          collectorBrowserService.runPage(
            `(${collectorCollectionService.canvasCaptureScript})(${JSON.stringify(canvas.captureId)})`,
          ),
          15000,
          'Canvas ใช้เวลาส่งออกนานเกินไป',
        );
        if (!captured || captured.error) {
          failed++;
          state.lastError = captured?.error || 'อ่าน Canvas ไม่สำเร็จ';
          continue;
        }
        const comma = captured.data.indexOf(','),
          buffer = Buffer.from(captured.data.slice(comma + 1), 'base64');
        if (!buffer.length || buffer.length > hostService.MAX_IMAGE) {
          failed++;
          continue;
        }
        const typed = imageType(buffer, 'image/png');
        const candidate = {
          ...canvas,
          key: `canvas:${canvas.captureId}`,
          url: `canvas-capture://${collectorCollectionService.generation}/${canvas.captureId}`,
          source: 'canvas',
          label: canvas.alt
            ? `Canvas — ${canvas.alt}`
            : `Canvas ${String(canvas.captureId).padStart(3, '0')}`,
          width: captured.width,
          height: captured.height,
        };
        const stored = await collectorCollectionService.storeSnapshot(
          candidate,
          { buffer, ...typed },
          sourceURL,
          state,
        );
        if (stored.item) added.push(stored.item);
        else if (stored.duplicate) duplicates++;
        if (stored.full) break;
      } catch (error) {
        if (state.cancelled || state.abort.signal.aborted) break;
        failed++;
        state.lastError = error.message || String(error);
      }
    }
    collectorCollectionService.pageInfo = {
      title: snap.title || (await collectorBrowserService.webTitle()),
      url: sourceURL,
    };
    return {
      items: added,
      duplicates,
      failed,
      title: collectorCollectionService.pageInfo.title,
      url: sourceURL,
    };
  }

  async function waitForReaderChange(state) {
    const timeout = Math.max(250, state.intervalMs);
    const code = `(async () => {
    const visible = el => {
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) return false;
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
    };
    const signature = () => {
      const imgs = [...document.images].filter(visible).map(x => x.currentSrc || x.src || '').join('\\n');
      const canvases = [...document.querySelectorAll('canvas')].filter(visible)
        .map((x,i) => i + ':' + x.width + 'x' + x.height).join('\\n');
      return location.href + '\\n' + imgs + '\\n' + canvases;
    };
    const baseline = signature();
    return await new Promise(resolve => {
      let done = false, observer;
      const cleanup = () => {
        observer?.disconnect();
        removeEventListener('hashchange', onHash, true);
        removeEventListener('popstate', onPop, true);
        document.removeEventListener('load', onLoad, true);
      };
      const finish = (changed, reason) => { if (done) return; done = true; cleanup(); resolve({ changed, reason }); };
      const check = reason => { if (signature() !== baseline) finish(true, reason); };
      const onHash = () => check('hash');
      const onPop = () => check('history');
      const onLoad = event => { if (event.target instanceof HTMLImageElement) check('image-load'); };
      observer = new MutationObserver(() => check('mutation'));
      observer.observe(document.documentElement, { subtree:true, childList:true, attributes:true,
        attributeFilter:['src','srcset','style','class','hidden'] });
      addEventListener('hashchange', onHash, true); addEventListener('popstate', onPop, true);
      document.addEventListener('load', onLoad, true);
      setTimeout(() => finish(false, 'timeout'), ${timeout});
    });
  })()`;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        resolve({ changed: false, reason: 'abort' });
      };
      const cleanup = () => state.abort.signal.removeEventListener('abort', onAbort);
      if (state.abort.signal.aborted) return resolve({ changed: false, reason: 'abort' });
      state.abort.signal.addEventListener('abort', onAbort, { once: true });
      hostService
        .withTimeout(
          collectorBrowserService.runPage(code),
          timeout + 5000,
          'รอการเปลี่ยนหน้าไม่ตอบสนอง',
        )
        .then(
          (value) => {
            cleanup();
            resolve(value);
          },
          (error) => {
            cleanup();
            reject(error);
          },
        );
    });
  }

  async function runCaptureSession(state) {
    hostService.emit('capture-start', {
      title: await collectorBrowserService.webTitle().catch(() => ''),
      url: collectorBrowserService.webURL(),
    });
    let reason = '';
    try {
      if (state.autoAdvanceReader && collectorNavigationService.isBookWalkerViewer()) {
        try {
          const initial = await collectorNavigationService.waitForBookWalkerPageReady(0, state);
          const first = await collectorNavigationService.bookWalkerReader('first');
          if (!first.supported) throw new Error('BookWalker ไม่พบตัวควบคุมลำดับหน้า');
          state.readerAutoActive = true;
          if (initial.current !== 1 || first.moved) {
            hostService.emit('status', {
              message: `BookWalker • กลับไปหน้า 1 / ${first.total} ก่อนเริ่มเก็บให้ครบ`,
            });
            await collectorNavigationService.waitForBookWalkerPageReady(1, state);
          }
        } catch (error) {
          if (state.cancelled || state.abort.signal.aborted) return;
          state.readerAutoDisabled = true;
          state.lastError = error.message || String(error);
          hostService.emit('status', {
            message: `${state.lastError} — ใช้โหมดเปลี่ยนหน้าเองแทน`,
          });
        }
      }
      while (!state.cancelled) {
        if (!collectorBrowserService.webAlive()) {
          reason = 'หน้าต่างเว็บถูกปิด';
          break;
        }
        try {
          const result = await captureVisiblePass(state);
          hostService.emit('capture-progress', {
            ...result,
            count: collectorCollectionService.records.size,
            lastError: state.lastError || '',
          });
          state.lastError = '';
        } catch (error) {
          if (state.cancelled || state.abort.signal.aborted) break;
          state.lastError = error.message || String(error);
          hostService.emit('capture-progress', {
            items: [],
            duplicates: 0,
            failed: 1,
            count: collectorCollectionService.records.size,
            lastError: state.lastError,
          });
        }
        if (collectorCollectionService.records.size >= hostService.MAX_IMAGES) {
          reason = 'ถึงขีดจำกัด 5,000 ภาพแล้ว';
          break;
        }
        if (
          state.autoAdvanceReader &&
          !state.readerAutoDisabled &&
          collectorNavigationService.isBookWalkerViewer()
        ) {
          try {
            let step = { supported: false };
            for (let attempt = 0; attempt < 5 && !step.supported && !state.cancelled; attempt++) {
              step = await collectorNavigationService.bookWalkerReader('advance');
              if (!step.supported) await delay(350);
            }
            if (step.supported) {
              state.readerAutoActive = true;
              if (step.done) {
                reason = `BookWalker ถึงหน้าสุดท้าย ${step.total} หน้าแล้ว`;
                break;
              }
              hostService.emit('status', {
                message: `BookWalker • เปลี่ยนหน้า ${step.current} → ${step.target} / ${step.total} อัตโนมัติ`,
              });
              await collectorNavigationService.waitForBookWalkerPageChange(step.current, state);
              continue;
            }
            state.readerAutoDisabled = true;
            hostService.emit('status', {
              message:
                'BookWalker: ไม่พบตัวควบคุมเปลี่ยนหน้าอัตโนมัติ — กลับเป็นโหมดกดเปลี่ยนหน้าเอง',
            });
          } catch (error) {
            if (state.cancelled || state.abort.signal.aborted) break;
            state.readerAutoDisabled = true;
            state.lastError = error.message || String(error);
            hostService.emit('status', {
              message: `${state.lastError} — กลับเป็นโหมดกดเปลี่ยนหน้าเอง`,
            });
          }
        }
        try {
          await waitForReaderChange(state);
        } catch (error) {
          if (state.cancelled || state.abort.signal.aborted) break;
          // A full navigation destroys the old execution context; immediately inspect the new page.
          await delay(60);
        }
      }
    } finally {
      if (captureSession === state) captureSession = null;
      hostService.emit('capture-stop', {
        count: collectorCollectionService.records.size,
        reason,
        cancelled: state.cancelled,
      });
    }
  }

  async function startCaptureSession(input = {}) {
    collectorBrowserService.ensureIdle();
    if (
      !collectorBrowserService.webAlive() ||
      !hostService.allowedWeb(collectorBrowserService.webURL())
    )
      throw new Error('กรุณาเปิดเว็บไซต์ก่อนเริ่มจับทีละหน้า');
    await collectorCollectionService.clearCollection();
    await collectorCollectionService.ensureCaptureTempDir();
    const state = {
      cancelled: false,
      abort: new AbortController(),
      hashes: new Set(),
      sequenceKeys: new Set(),
      lastError: '',
      intervalMs: Math.max(250, Math.min(5000, Number(input.intervalMs) || 900)),
      selector: String(input.selector || '')
        .trim()
        .slice(0, 500),
      backgrounds: Boolean(input.backgrounds),
      canvases: input.canvases !== false,
      autoAdvanceReader: input.autoAdvanceReader !== false,
      readerAutoActive: false,
      readerAutoDisabled: false,
    };
    captureSession = state;
    runCaptureSession(state).catch((error) => {
      if (captureSession === state) captureSession = null;
      hostService.emit('capture-stop', {
        count: collectorCollectionService.records.size,
        reason: error.message || String(error),
        cancelled: true,
      });
    });
    return { started: true, intervalMs: state.intervalMs };
  }

  function stopCaptureSession() {
    const state = captureSession;
    if (!state) return { stopped: false, count: collectorCollectionService.records.size };
    state.cancelled = true;
    state.abort.abort();
    return { stopped: true, count: collectorCollectionService.records.size };
  }
  return {
    get captureSession() {
      return captureSession;
    },
    scanBookWalkerAllPages,
    startCaptureSession,
    stopCaptureSession,
  };
}
module.exports = { createCollectorCapture };
