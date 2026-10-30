'use strict';
const { fetchManual } = require('../http.cjs');
const { imageURL, imageType, delay } = require('../core.cjs');
const { selectMangaPages } = require('../harvest-translate.cjs');

function createPageAcquisition({
  collectorCollection: collectorCollectionService,
  collectorFiles: collectorFilesService,
  translation: translationService,
  host: hostService,
}) {
  async function scanHarvestTsTranslationPages(tab, job) {
    const scanStartedAt = Date.now();
    const wc = tab.view.webContents;
    const startURL = wc.getURL() || tab.url || '';
    if (!/^https?:\/\//i.test(startURL)) throw new Error('เปิดหน้ามังงะใน HarvestTS ก่อนกด Start');

    // Translation scan is intentionally faster than the general collector:
    // first inspect the whole DOM once, then scroll only when the reader really needs it.
    const maxSteps = 180,
      waitMs = 140,
      found = new Map();
    let previousHeight = -1,
      previousCount = -1,
      stableSince = 0,
      steps = 0,
      lastMeta = {},
      fastPath = false;
    const options = {
      selector: '',
      backgrounds: true,
      canvases: false,
      smartBackgrounds: true,
      adaptiveBackgrounds: true,
    };

    const mergeSnapshot = (snap) => {
      lastMeta = snap || {};
      for (const raw of snap?.items || []) {
        const url = imageURL(raw.url, startURL);
        if (!url) continue;
        const key = `${raw.key || raw.dom || found.size}|${url}`;
        const existing = found.get(key);
        if (existing) Object.assign(existing, raw, { url, order: existing.order });
        else if (found.size < hostService.MAX_IMAGES)
          found.set(key, { ...raw, url, order: found.size });
      }
    };
    const candidatePages = () => selectMangaPages([...found.values()]);

    translationService.sendHarvestTranslation(tab, {
      type: 'scan',
      progress: 0,
      found: 0,
      message: 'กำลังให้ Harvest ตรวจหน้า reader…',
    });
    await wc.executeJavaScript(`(${collectorCollectionService.scrollScript})('init')`, true);
    await delay(40);

    try {
      translationService.assertHarvestTranslationRunning(job);
      const first = await hostService.withTimeout(
        wc.executeJavaScript(
          `(${collectorCollectionService.collector})(${JSON.stringify(options)})`,
          true,
        ),
        15000,
        'หน้าเว็บไม่ตอบสนองต่อ Harvest',
      );
      mergeSnapshot(first);
      steps = 1;

      const structure = await wc
        .executeJavaScript(
          `(${collectorCollectionService.readerProbe})(${JSON.stringify({ selector: '' })})`,
          true,
        )
        .catch(() => ({}));
      const expectedTotal = Math.max(0, Number(structure?.expectedTotal) || 0);
      const geometry = await wc.executeJavaScript(
        `(() => ({
      height: Math.max(document.scrollingElement?.scrollHeight || 0, document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0),
      viewport: innerHeight
    }))()`,
        true,
      );
      const initialPages = candidatePages();
      const lastBottom = initialPages.reduce((max, item) => {
        const displayHeight = Number(item.filterHints?.displayHeight) || Number(item.height) || 0;
        return Math.max(max, (Number(item.top) || 0) + displayHeight);
      }, 0);
      const coverage = Number(geometry?.height) > 0 ? lastBottom / Number(geometry.height) : 0;
      const decoded = initialPages.filter(
        (item) => item.source !== 'img' || item.decoded === true,
      ).length;
      const decodedRatio = initialPages.length ? decoded / initialPages.length : 0;

      // Do not use a magic page-count threshold. A reader with 4, 10, 20 or 40
      // initially visible pages can still lazy-load more. Any DOM-complete candidate
      // must survive a bottom verification window before we trust the fast path.
      fastPath =
        initialPages.length >= 2 &&
        coverage >= 0.78 &&
        coverage <= 1.15 &&
        decodedRatio >= 0.75 &&
        (!expectedTotal || initialPages.length >= expectedTotal);

      if (fastPath) {
        const beforeCount = initialPages.length,
          beforeHeight = Number(geometry?.height) || 0;
        let verifyCount = beforeCount,
          verifyHeight = beforeHeight,
          quietRounds = 0;
        // Without an explicit total, give slow lazy loaders a real settle window.
        // Readers with a trustworthy data-page-count can finish sooner once that
        // count is already present.
        const requiredQuietRounds = expectedTotal > 0 ? 3 : 13;
        for (let verify = 0; verify < 16; verify++) {
          // Actually touch the current end on every round. Lazy readers often
          // extend scrollHeight only after the viewport reaches the old end.
          await wc.executeJavaScript(`(${collectorCollectionService.scrollScript})('end')`, true);
          await delay(320);
          const probe = await hostService.withTimeout(
            wc.executeJavaScript(
              `(${collectorCollectionService.collector})(${JSON.stringify(options)})`,
              true,
            ),
            15000,
            'หน้าเว็บไม่ตอบสนองต่อ Harvest',
          );
          mergeSnapshot(probe);
          steps++;
          const probePos = await wc.executeJavaScript(
            `(${collectorCollectionService.scrollScript})('status')`,
            true,
          );
          const nextCount = candidatePages().length,
            nextHeight = Number(probePos?.height) || 0;
          const expectedMissing = expectedTotal > 0 && nextCount < expectedTotal;
          if (nextCount > verifyCount || nextHeight > verifyHeight * 1.01 || expectedMissing) {
            fastPath = false;
            verifyCount = nextCount;
            verifyHeight = Math.max(verifyHeight, nextHeight);
            break;
          }
          verifyCount = nextCount;
          verifyHeight = Math.max(verifyHeight, nextHeight);
          quietRounds++;
          if (quietRounds >= requiredQuietRounds) break;
        }
      }

      if (fastPath) {
        translationService.sendHarvestTranslation(tab, {
          type: 'scan',
          progress: 1,
          found: candidatePages().length,
          step: steps,
          fast: true,
          message: `ตรวจปลายหน้าแล้ว • พบหน้ามังงะครบ ${candidatePages().length} หน้า • ข้ามการเลื่อนต่อ`,
        });
      } else {
        // A failed fast-path probe may already be sitting at the end. Rewind to
        // the scan start without overwriting the user's saved scroll position,
        // then walk the whole reader so virtual/lazy middle pages are not skipped.
        await wc.executeJavaScript(`(${collectorCollectionService.scrollScript})('start')`, true);
        await delay(80);
        let currentCount = candidatePages().length;
        const initialPos = await wc.executeJavaScript(
          `(${collectorCollectionService.scrollScript})('status')`,
          true,
        );
        previousHeight = Number(initialPos?.height) || 0;
        previousCount = currentCount;

        for (let step = 0; step < maxSteps; step++) {
          translationService.assertHarvestTranslationRunning(job);
          const currentURL = wc.getURL() || tab.url || '';
          if (!translationService.sameHarvestTranslationPage(startURL, currentURL))
            throw new Error('หน้าเว็บเปลี่ยนระหว่าง Harvest กรุณากด Start ใหม่');

          await wc.executeJavaScript(
            `(${collectorCollectionService.scrollScript})({action:'step',conservative:false,factor:1.55})`,
            true,
          );
          await delay(waitMs);

          const snap = await hostService.withTimeout(
            wc.executeJavaScript(
              `(${collectorCollectionService.collector})(${JSON.stringify(options)})`,
              true,
            ),
            15000,
            'หน้าเว็บไม่ตอบสนองต่อ Harvest',
          );
          mergeSnapshot(snap);
          steps = step + 2;

          const pos = await wc.executeJavaScript(
            `(${collectorCollectionService.scrollScript})('status')`,
            true,
          );
          currentCount = candidatePages().length;
          const height = Number(pos?.height) || 0;
          const unchanged = currentCount === previousCount;
          const stableAtBottom = Boolean(pos?.bottom && height === previousHeight && unchanged);
          if (stableAtBottom) {
            if (!stableSince) stableSince = Date.now();
          } else stableSince = 0;
          previousHeight = height;
          previousCount = currentCount;

          translationService.sendHarvestTranslation(tab, {
            type: 'scan',
            progress: Math.max(0, Math.min(1, Number(pos?.progress) || 0)),
            found: currentCount,
            step: steps,
            message: `สแกนแบบเร็ว • พบหน้ามังงะ ${currentCount} หน้า`,
          });

          if (stableSince && Date.now() - stableSince >= 4200) break;
          if (pos?.bottom) await delay(260);
        }
      }
    } finally {
      if (
        !wc.isDestroyed() &&
        translationService.sameHarvestTranslationPage(startURL, wc.getURL() || '')
      ) {
        await wc
          .executeJavaScript(`(${collectorCollectionService.scrollScript})('restore')`, true)
          .catch(() => {});
      }
    }

    const pages = candidatePages().map((item, index) => ({
      ...item,
      pageId: `${job.id}-p${String(index + 1).padStart(4, '0')}`,
      pageIndex: index,
    }));
    if (!pages.length) {
      const canvasNote =
        Number(lastMeta?.canvases || 0) > 0
          ? ' หน้านี้มี Canvas ซึ่งตัวเชื่อมรอบแรกยังไม่ดึงเข้า pipeline แปล'
          : '';
      throw new Error('Harvest ไม่พบภาพที่เข้าเกณฑ์หน้ามังงะในหน้านี้' + canvasNote);
    }

    const scanMs = Date.now() - scanStartedAt;
    translationService.sendHarvestTranslation(tab, {
      type: 'pages',
      pages: pages.map((x) => ({
        id: x.pageId,
        index: x.pageIndex,
        width: x.width || 0,
        height: x.height || 0,
        label: x.alt || x.url.split('/').pop() || `หน้า ${x.pageIndex + 1}`,
      })),
      total: pages.length,
      scanMs,
      fastPath,
      message: `พบหน้ามังงะ ${pages.length} หน้าใน ${(scanMs / 1000).toFixed(1)} วิ • กำลังเตรียมไฟล์ให้ระบบแปล`,
    });
    return {
      startURL,
      title: lastMeta?.title || wc.getTitle() || tab.title || '',
      pages,
      steps,
      scanMs,
      fastPath,
    };
  }

  async function acquireHarvestTsTranslationImage(tab, item, signal) {
    if (signal?.aborted) throw new Error('ยกเลิกการเตรียมหน้าแล้ว');
    // Prefer the exact image bytes Chromium already loaded for this reader.
    // This preserves the page's real session/cookies and avoids a second hotlink
    // request that some CDNs intentionally answer with 403.
    if (/^https?:/i.test(item.url) && tab?.imageStore) {
      await Promise.resolve(tab.imageStoreReady).catch(() => false);
      await tab.imageStore.settle().catch(() => {});
      const loaded = await tab.imageStore.read(item.url).catch(() => null);
      if (loaded?.buffer?.length)
        return { buffer: loaded.buffer, ext: loaded.ext, mime: loaded.mime };
    }
    let buffer,
      contentType = '';
    if (item.url.startsWith('data:')) {
      const comma = item.url.indexOf(','),
        meta = item.url.slice(0, comma);
      if (comma < 0 || item.url.length > hostService.MAX_IMAGE * 1.5)
        throw new Error('Embedded image ไม่ถูกต้องหรือใหญ่เกินไป');
      buffer = /;base64/i.test(meta)
        ? Buffer.from(item.url.slice(comma + 1), 'base64')
        : Buffer.from(decodeURIComponent(item.url.slice(comma + 1)));
      contentType = meta.slice(5).split(';')[0];
    } else if (item.url.startsWith('blob:')) {
      const payload = await hostService.withTimeout(
        tab.view.webContents.executeJavaScript(
          `(async()=>{const r=await fetch(${JSON.stringify(item.url)});const b=await r.blob();if(b.size>${hostService.MAX_IMAGE})throw new Error('too large');return await new Promise((resolve,reject)=>{const f=new FileReader();f.onload=()=>resolve(f.result);f.onerror=reject;f.readAsDataURL(b)})})()`,
          true,
        ),
        25000,
        'อ่านภาพ blob ไม่สำเร็จ',
      );
      if (typeof payload !== 'string' || payload.length > hostService.MAX_IMAGE * 1.5)
        throw new Error('ข้อมูล blob ไม่ถูกต้อง');
      const comma = payload.indexOf(',');
      contentType = payload.slice(5, payload.indexOf(';'));
      buffer = Buffer.from(payload.slice(comma + 1), 'base64');
    } else {
      let target = item.url,
        response = null;
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, 30000);
      try {
        for (let hop = 0; hop <= 5; hop++) {
          translationService.assertHarvestTranslationRunning({
            abort: { signal: controller.signal },
          });
          response = await fetchManual(
            target,
            {
              credentials: 'include',
              redirect: 'manual',
              referrer: item.referrer || tab.view.webContents.getURL() || tab.url || '',
              referrerPolicy: 'strict-origin-when-cross-origin',
              headers: {
                Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
              },
              signal: controller.signal,
            },
            tab.view.webContents.session,
            hostService.MAX_IMAGE,
          );
          if (![301, 302, 303, 307, 308].includes(response.status)) break;
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location || hop === 5) throw new Error('ภาพ redirect มากเกินไป');
          const next = new URL(location, target);
          if (!hostService.allowedWeb(next.href) || next.username || next.password)
            throw new Error('ปลายทางภาพไม่ปลอดภัย');
          target = next.href;
        }
        if (!response?.ok) {
          await response?.body?.cancel();
          throw new Error(`HTTP ${response?.status || 0}`);
        }
        buffer = await collectorFilesService.readLimited(response, controller.signal);
        contentType = response.headers.get('content-type') || '';
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    }
    if (!buffer?.length || buffer.length > hostService.MAX_IMAGE)
      throw new Error('ข้อมูลภาพไม่ถูกต้องหรือใหญ่เกิน 32 MB');
    return { buffer, ...imageType(buffer, contentType) };
  }
  return {
    scanHarvestTsTranslationPages,
    acquireHarvestTsTranslationImage,
  };
}
module.exports = { createPageAcquisition };
