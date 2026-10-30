'use strict';
const { app, dialog } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fetchManual } = require('../http.cjs');
const { safeName, imageType, isImageFilename, renamePlan, idFor, delay } = require('../core.cjs');

function createCollectorFiles({
  collectorBrowser: collectorBrowserService,
  collectorCollection: collectorCollectionService,
  host: hostService,
}) {
  async function readLimited(response, signal) {
    const announced = Number(response.headers.get('content-length') || 0);
    if (announced > hostService.MAX_IMAGE) {
      await response.body?.cancel();
      throw new Error('ภาพมีขนาดเกิน 32 MB');
    }
    if (!response.body) throw new Error('ไม่ได้รับข้อมูลภาพ');
    const reader = response.body.getReader(),
      chunks = [];
    let size = 0;
    try {
      while (true) {
        if (signal?.aborted) throw new Error('ยกเลิกการดาวน์โหลด');
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > hostService.MAX_IMAGE) throw new Error('ภาพมีขนาดเกิน 32 MB');
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    }
    return Buffer.concat(chunks, size);
  }

  async function acquireImage(item, signal) {
    if (signal?.aborted) throw new Error('ยกเลิกการดาวน์โหลด');
    if (
      item.backend === 'electron' &&
      /^https?:/.test(item.url) &&
      collectorBrowserService.electronImageStore
    ) {
      const data = await hostService.withTimeout(
        collectorBrowserService.electronImageStore.read(item.url),
        5000,
        'รอข้อมูลภาพจาก Browser นานเกินไป',
      );
      if (signal?.aborted) throw new Error('ยกเลิกการดาวน์โหลด');
      if (data) return data;
    }
    if (item.backend === 'chrome' && /^https?:/.test(item.url)) {
      const data = await hostService.withTimeout(
        collectorBrowserService.chromeBrowser.loadedImage(item.url),
        5000,
        'รอข้อมูลภาพจาก Chrome นานเกินไป',
      );
      if (signal?.aborted) throw new Error('ยกเลิกการดาวน์โหลด');
      if (data) return data;
      if (item.nativeOnly || collectorBrowserService.chromeBrowser.compatibilityInfo().applied > 0)
        throw new Error(
          'ยังไม่มีภาพนี้ที่ Chrome โหลดสำเร็จ — เปิดหน้าอ่านให้โหลดครบแล้วสแกนใหม่ (ไม่ยิงคำขอซ้ำ)',
        );
    }
    let buffer,
      contentType = '';
    if (item.url.startsWith('data:')) {
      const comma = item.url.indexOf(','),
        meta = item.url.slice(0, comma);
      if (item.url.length > hostService.MAX_IMAGE * 1.5) throw new Error('ภาพมีขนาดเกิน 32 MB');
      buffer = /;base64/i.test(meta)
        ? Buffer.from(item.url.slice(comma + 1), 'base64')
        : Buffer.from(decodeURIComponent(item.url.slice(comma + 1)));
      contentType = meta.slice(5).split(';')[0];
    } else if (item.url.startsWith('blob:')) {
      const originURL =
        item.backend === 'chrome'
          ? collectorBrowserService.chromeBrowser.url()
          : collectorBrowserService.browser && !collectorBrowserService.browser.isDestroyed()
            ? collectorBrowserService.browser.webContents.getURL()
            : '';
      if (!originURL || new URL(originURL).origin !== new URL(item.referrer).origin)
        throw new Error('ภาพ blob ต้องเปิดหน้าเว็บต้นทางค้างไว้');
      const payload = await hostService.withTimeout(
        collectorBrowserService.runPage(
          `(async () => {
      const r = await fetch(${JSON.stringify(item.url)}); const b = await r.blob();
      if (b.size > ${hostService.MAX_IMAGE}) throw new Error('ภาพมีขนาดเกิน 32 MB');
      return await new Promise((resolve,reject) => { const f = new FileReader(); f.onload = () => resolve(f.result); f.onerror = reject; f.readAsDataURL(b); });
    })()`,
          item.backend,
        ),
        20000,
        'อ่านภาพ blob ไม่สำเร็จ',
      );
      if (typeof payload !== 'string' || payload.length > hostService.MAX_IMAGE * 1.5)
        throw new Error('ข้อมูล blob ไม่ถูกต้อง');
      buffer = Buffer.from(payload.slice(payload.indexOf(',') + 1), 'base64');
      contentType = payload.slice(5, payload.indexOf(';'));
    } else {
      const host = new URL(item.url).host;
      if (collectorCollectionService.blockedHosts.has(host))
        throw new Error(collectorCollectionService.blockedHosts.get(host));
      await delay(Math.max(0, collectorCollectionService.requestGate - Date.now()));
      collectorCollectionService.requestGate = Date.now() + 400;
      if (signal?.aborted) throw new Error('ยกเลิกการดาวน์โหลด');
      const controller = new AbortController(),
        abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, 25000);
      try {
        // Use the isolated website session's cookies/cache. Never borrow Chrome cookies.
        let target = item.url,
          r;
        for (let hop = 0; hop <= 5; hop++) {
          const targetHost = new URL(target).host;
          if (collectorCollectionService.blockedHosts.has(targetHost))
            throw new Error(collectorCollectionService.blockedHosts.get(targetHost));
          const requestOptions = {
            credentials: 'include',
            redirect: 'manual',
            referrer: item.referrer,
            referrerPolicy: 'strict-origin-when-cross-origin',
            signal: controller.signal,
          };
          r =
            item.backend === 'chrome'
              ? await collectorBrowserService.chromeBrowser.fetchManual(
                  target,
                  requestOptions,
                  hostService.MAX_IMAGE,
                )
              : await fetchManual(
                  target,
                  requestOptions,
                  collectorBrowserService.browsingSession,
                  hostService.MAX_IMAGE,
                );
          if (![301, 302, 303, 307, 308].includes(r.status)) break;
          const location = r.headers.get('location');
          await r.body?.cancel();
          if (!location || hop === 5)
            throw new Error('เว็บ redirect มากเกินไปหรือไม่ได้ส่งปลายทาง');
          const next = new URL(location, target);
          if (!hostService.allowedWeb(next.href) || next.username || next.password)
            throw new Error('ปลายทาง redirect ไม่ปลอดภัย');
          target = next.href;
          await delay(400);
        }
        if (!r.ok) {
          await r.body?.cancel();
          if (r.status === 429) {
            const message = 'เว็บจำกัดคำขอ (429) หยุดโหลดจากโฮสต์นี้แล้ว กรุณาลองใหม่ภายหลัง';
            collectorCollectionService.blockedHosts.set(host, message);
            hostService.emit('rate-limit', { message });
            throw new Error(message);
          }
          throw new Error(
            `HTTP ${r.status}${r.status === 403 ? ' — เว็บปฏิเสธการเข้าถึง ไม่มีการข้ามข้อจำกัด' : ''}`,
          );
        }
        buffer = await readLimited(r, controller.signal);
        contentType = r.headers.get('content-type') || '';
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    }
    if (buffer.length > hostService.MAX_IMAGE) throw new Error('ภาพมีขนาดเกิน 32 MB');
    return { buffer, ...imageType(buffer, contentType) };
  }

  function getImage(id, signal) {
    const localRecords = collectorCollectionService.records,
      localCache = collectorCollectionService.cache,
      localPending = collectorCollectionService.pending,
      localFailed = collectorCollectionService.failedImages,
      localExcluded = collectorCollectionService.excludedIds;
    const item = localRecords.get(id);
    if (!item || localExcluded.has(id)) return Promise.reject(new Error('ไม่พบภาพในผลสแกนล่าสุด'));
    const cacheKey = item.capturePath ? idFor(`snapshot:${item.id}`) : idFor(item.url),
      hit = localCache.get(cacheKey);
    if (item.capturePath) {
      if (hit) return Promise.resolve(hit);
      return fs
        .readFile(item.capturePath)
        .then((buffer) => {
          const value = {
            buffer,
            ...imageType(buffer, item.ext ? `image/${item.ext}` : ''),
          };
          localCache.set(cacheKey, value);
          return value;
        })
        .catch(() => {
          throw new Error('ไฟล์ภาพชั่วคราวไม่อยู่แล้ว กรุณาสแกนหรือจับหน้าใหม่');
        });
    }
    if (hit) return Promise.resolve(hit);
    if (localFailed.has(cacheKey)) return Promise.reject(new Error(localFailed.get(cacheKey)));
    if (localPending.has(cacheKey)) return localPending.get(cacheKey);
    const previousQueue = collectorCollectionService.queue;
    const task = previousQueue.then(async () => {
      if (signal?.aborted) throw new Error('ยกเลิกคำขอเดิม');
      const existing = localCache.get(cacheKey);
      if (existing) return existing;
      const value = await acquireImage(item, signal);
      localCache.set(cacheKey, value);
      return value;
    });
    collectorCollectionService.queue = task.catch(() => {});
    localPending.set(cacheKey, task);
    task.then(
      () => {
        if (localPending.get(cacheKey) === task) localPending.delete(cacheKey);
      },
      (error) => {
        if (localPending.get(cacheKey) === task) localPending.delete(cacheKey);
        const message = error.message || String(error);
        // A page session can still be hydrating/challenged while streaming cards are rendered.
        // Do not make transient access/server failures permanent; UI retries remain bounded.
        const retryable =
          /(?:HTTP (?:403|408|425|500|502|503|504)\b|หมดเวลา|ถูกตัดก่อนครบ|ECONN|ETIMEDOUT|socket|network)/i.test(
            message,
          );
        if (!signal?.aborted && !retryable) localFailed.set(cacheKey, message);
      },
    );
    return task;
  }

  function selectedItems(input) {
    if (!Array.isArray(input?.ids) || input.ids.length > hostService.MAX_IMAGES)
      throw new Error('รายการภาพไม่ถูกต้อง');
    const seen = new Set();
    return input.ids.map((id) => {
      if (
        typeof id !== 'string' ||
        !collectorCollectionService.records.has(id) ||
        collectorCollectionService.excludedIds.has(id) ||
        seen.has(id)
      )
        throw new Error('รายการภาพเปลี่ยนไป กรุณาสแกนใหม่');
      seen.add(id);
      return collectorCollectionService.records.get(id);
    });
  }

  async function chooseFolder() {
    const result = await dialog.showOpenDialog(hostService.mainWindow, {
      title: 'เลือกโฟลเดอร์เก็บรูป',
      defaultPath: collectorCollectionService.outputRoot || app.getPath('pictures'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (!result.canceled) {
      collectorCollectionService.outputRoot = result.filePaths[0];
      await saveSettings();
    }
    return collectorCollectionService.outputRoot;
  }

  async function saveSettings() {
    await fs.writeFile(
      path.join(app.getPath('userData'), 'settings.json'),
      JSON.stringify({
        outputRoot: collectorCollectionService.outputRoot,
        networkMode: collectorBrowserService.networkMode,
        browserMode: collectorBrowserService.browserMode,
        chromeControl: hostService.chromeControl,
        protectionCompatibility: hostService.protectionCompatibilityEnabled,
        compatibilitySchema: 2,
      }),
      'utf8',
    );
  }

  async function continuousLog(input = {}) {
    const sessionId =
      String(input.sessionId || '')
        .replace(/[^a-z0-9-]/gi, '')
        .slice(0, 80) || 'unknown';
    const message = String(input.message || '')
      .replace(/[\r\n]+/g, ' ')
      .slice(0, 800);
    const extra = { ...input };
    delete extra.sessionId;
    delete extra.message;
    const dir = path.join(app.getPath('userData'), 'logs');
    await fs.mkdir(dir, { recursive: true });
    const line = JSON.stringify({
      at: new Date().toISOString(),
      sessionId,
      message,
      ...extra,
    });
    await fs.appendFile(path.join(dir, 'continuous-session.log'), line + '\r\n', 'utf8');
    return true;
  }

  async function readRenameFolder() {
    if (!collectorCollectionService.renameFolder) throw new Error('กรุณาเลือกโฟลเดอร์รูปก่อน');
    const entries = await fs.readdir(collectorCollectionService.renameFolder, {
      withFileTypes: true,
    });
    return entries.filter((e) => e.isFile() && isImageFilename(e.name)).map((e) => e.name);
  }

  async function chooseRenameFolder() {
    collectorBrowserService.ensureIdle();
    const result = await dialog.showOpenDialog(hostService.mainWindow, {
      title: 'เลือกโฟลเดอร์รูปที่จะตั้งเลขหน้า',
      properties: ['openDirectory'],
    });
    if (result.canceled) return null;
    collectorCollectionService.renameFolder = path.resolve(result.filePaths[0]);
    const files = await readRenameFolder();
    return { folder: collectorCollectionService.renameFolder, files };
  }

  async function previewRename(input = {}) {
    const files = await readRenameFolder(),
      plan = renamePlan(files, input);
    return {
      folder: collectorCollectionService.renameFolder,
      count: plan.length,
      plan,
    };
  }

  async function uniqueFolder(root, base) {
    for (let i = 0; i < 1000; i++) {
      const folder = path.join(root, `${base}${i ? `-${i + 1}` : ''}`);
      try {
        await fs.mkdir(folder);
        return folder;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    }
    throw new Error('สร้างโฟลเดอร์ใหม่ไม่สำเร็จ');
  }

  async function numberedFolder(root, value) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0 || number > 99999999)
      throw new Error('เลขโฟลเดอร์เริ่มต้นไม่ถูกต้อง');
    const name = String(number),
      folder = path.join(root, name);
    try {
      await fs.mkdir(folder);
      return { folder, number };
    } catch (error) {
      if (error.code === 'EEXIST')
        throw new Error(
          `มีโฟลเดอร์เลข ${name} อยู่แล้ว กรุณาเปลี่ยนเลขเริ่มต้นหรือย้ายโฟลเดอร์เดิมก่อน`,
        );
      throw error;
    }
  }

  async function renameImages(input = {}, skipConfirm = false) {
    collectorBrowserService.ensureIdle();
    const files = await readRenameFolder(),
      plan = renamePlan(files, input);
    if (!plan.length) throw new Error('ไม่พบไฟล์ภาพที่รองรับในโฟลเดอร์นี้');
    const current = new Set(files.map((x) => x.toLowerCase()));
    const targets = new Set();
    for (const row of plan) {
      const key = row.to.toLowerCase();
      if (targets.has(key)) throw new Error('ชื่อปลายทางซ้ำกัน กรุณาปรับเลขเริ่มต้น');
      targets.add(key);
    }
    const entries = await fs.readdir(collectorCollectionService.renameFolder, {
      withFileTypes: true,
    });
    const foreign = new Set(
      entries.filter((e) => !current.has(e.name.toLowerCase())).map((e) => e.name.toLowerCase()),
    );
    if (plan.some((row) => foreign.has(row.to.toLowerCase())))
      throw new Error('มีไฟล์หรือโฟลเดอร์ชื่อปลายทางอยู่แล้ว');
    const changed = plan.filter((row) => row.from !== row.to);
    if (!changed.length)
      return {
        folder: collectorCollectionService.renameFolder,
        renamed: 0,
        plan,
      };
    const sample = plan
      .slice(0, 3)
      .map((x) => `${x.from}  →  ${x.to}`)
      .join('\n');
    if (!skipConfirm) {
      const answer = await dialog.showMessageBox(hostService.mainWindow, {
        type: 'warning',
        title: 'ยืนยันการตั้งเลขหน้า',
        message: `จะเปลี่ยนชื่อรูป ${plan.length} ภาพ${input.reverse ? ' แบบย้อนกลับ' : ''}`,
        detail: `${sample}${plan.length > 3 ? '\n…' : ''}\n\nระบบจะเปลี่ยนชื่อไฟล์จริงในโฟลเดอร์นี้`,
        buttons: ['ยกเลิก', 'เปลี่ยนชื่อ'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (answer.response !== 1)
        return {
          folder: collectorCollectionService.renameFolder,
          cancelled: true,
          renamed: 0,
          plan,
        };
    }
    collectorBrowserService.busy = 'rename';
    const moved = plan.map((row, i) => ({
      ...row,
      tmp: `.__imageharvest_${randomUUID()}_${i}${path.extname(row.from)}`,
      state: 'original',
    }));
    try {
      for (const row of moved) {
        await fs.rename(
          path.join(collectorCollectionService.renameFolder, row.from),
          path.join(collectorCollectionService.renameFolder, row.tmp),
        );
        row.state = 'temp';
      }
      for (const row of moved) {
        await fs.rename(
          path.join(collectorCollectionService.renameFolder, row.tmp),
          path.join(collectorCollectionService.renameFolder, row.to),
        );
        row.state = 'target';
      }
      return {
        folder: collectorCollectionService.renameFolder,
        renamed: changed.length,
        plan,
      };
    } catch (error) {
      for (const row of moved.filter((x) => x.state === 'target').reverse()) {
        try {
          await fs.rename(
            path.join(collectorCollectionService.renameFolder, row.to),
            path.join(collectorCollectionService.renameFolder, row.tmp),
          );
          row.state = 'temp';
        } catch {}
      }
      for (const row of moved.filter((x) => x.state === 'temp').reverse()) {
        try {
          await fs.rename(
            path.join(collectorCollectionService.renameFolder, row.tmp),
            path.join(collectorCollectionService.renameFolder, row.from),
          );
          row.state = 'original';
        } catch {}
      }
      throw new Error(`เปลี่ยนชื่อไม่สำเร็จและพยายามคืนชื่อเดิมแล้ว: ${error.message}`);
    } finally {
      collectorBrowserService.busy = null;
    }
  }

  async function download(input) {
    collectorBrowserService.ensureIdle();
    const items = selectedItems(input);
    if (!items.length) throw new Error('ยังไม่ได้เลือกภาพ');
    if (!collectorCollectionService.outputRoot && !(await chooseFolder()))
      return { cancelled: true };
    collectorBrowserService.busy = 'download';
    collectorBrowserService.job = {
      cancelled: false,
      abort: new AbortController(),
    };
    const date = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const report = {
      source: collectorCollectionService.pageInfo.url,
      title: collectorCollectionService.pageInfo.title,
      createdAt: new Date().toISOString(),
      compatibility: collectorCollectionService.pageInfo.compatibility || null,
      requested: items.length,
      naming: 'Selected UI order, zero-padded; original image bytes',
      files: [],
    };
    let folder,
      saved = 0,
      failed = 0;
    try {
      const requestedName = String(input.name || '').trim();
      const fallbackName = `${safeName(collectorCollectionService.pageInfo.title || new URL(collectorCollectionService.pageInfo.url).hostname)}_${date}`;
      if (input.numbered === true) {
        const numbered = await numberedFolder(
          collectorCollectionService.outputRoot,
          input.folderNumber,
        );
        folder = numbered.folder;
        report.folderNumber = numbered.number;
        report.folderMode = 'continuous-numbered';
      } else
        folder = await uniqueFolder(
          collectorCollectionService.outputRoot,
          requestedName ? safeName(requestedName) : fallbackName,
        );
      collectorCollectionService.lastFolder = folder;
      for (let i = 0; i < items.length; i++) {
        if (collectorBrowserService.job.cancelled) break;
        const item = items[i];
        hostService.emit('download-progress', {
          index: i + 1,
          total: items.length,
          saved,
          failed,
        });
        try {
          const data = await getImage(item.id, collectorBrowserService.job.abort.signal);
          if (collectorBrowserService.job.cancelled) break;
          const filename = `${String(i + 1).padStart(4, '0')}.${data.ext}`;
          await fs.writeFile(path.join(folder, filename), data.buffer, {
            flag: 'wx',
          });
          report.files.push({
            index: i + 1,
            filename,
            source: item.url.startsWith('data:') ? '[embedded image]' : item.url,
            status: 'saved',
            bytes: data.buffer.length,
            sha256: collectorCollectionService.snapshotHash(data.buffer),
            capturedVia:
              item.capturedVia || data.via || (item.capturePath ? 'snapshot' : 'download'),
          });
          saved++;
          hostService.emit('image-saved', { id: item.id, filename });
        } catch (error) {
          if (collectorBrowserService.job.cancelled) break;
          failed++;
          report.files.push({
            index: i + 1,
            source: item.url.startsWith('data:') ? '[embedded image]' : item.url,
            status: 'failed',
            error: error.message,
          });
          hostService.emit('image-failed', {
            id: item.id,
            message: error.message,
          });
        }
      }
      report.saved = saved;
      report.failed = failed;
      report.cancelled = collectorBrowserService.job.cancelled;
      report.notAttempted = items.length - saved - failed;
      await fs.writeFile(path.join(folder, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
      return {
        folder,
        saved,
        failed,
        cancelled: report.cancelled,
        notAttempted: report.notAttempted,
      };
    } finally {
      collectorBrowserService.job = null;
      collectorBrowserService.busy = null;
    }
  }

  async function exportLinks(input) {
    const items = selectedItems(input);
    const result = await dialog.showSaveDialog(hostService.mainWindow, {
      title: 'บันทึกลิงก์ตามลำดับ',
      defaultPath: `${safeName(collectorCollectionService.pageInfo.title)}-links.txt`,
      filters: [{ name: 'Text', extensions: ['txt'] }],
    });
    if (result.canceled) return false;
    await fs.writeFile(
      result.filePath,
      items
        .map(
          (item, i) =>
            `${String(i + 1).padStart(4, '0')}\t${item.url.startsWith('data:') ? '[embedded image]' : item.url}`,
        )
        .join('\r\n'),
      'utf8',
    );
    return true;
  }
  return {
    readLimited,
    acquireImage,
    getImage,
    selectedItems,
    chooseFolder,
    saveSettings,
    continuousLog,
    chooseRenameFolder,
    previewRename,
    renameImages,
    download,
    exportLinks,
  };
}
module.exports = { createCollectorFiles };
