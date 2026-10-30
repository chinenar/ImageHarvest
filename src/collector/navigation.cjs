'use strict';
const {
  chooseNextChapter,
  chapterIndexLink,
  nextFromChapterListing,
  delay,
} = require('../core.cjs');

function createCollectorNavigation({
  collectorBrowser: collectorBrowserService,
  collectorCollection: collectorCollectionService,
  host: hostService,
}) {
  function isBookWalkerViewer(url = collectorBrowserService.webURL()) {
    try {
      return /(^|\.)viewer\.bookwalker\.jp$/i.test(new URL(url).hostname);
    } catch {
      return false;
    }
  }

  function bookWalkerControlScript(action = 'probe') {
    return `(() => {
    const counter = document.getElementById('pageSliderCounter');
    const match = String(counter?.textContent || '').match(/(\\d+)\\s*\\/\\s*(\\d+)/);
    const current = match ? Number(match[1]) : 0, total = match ? Number(match[2]) : 0;
    const root = globalThis.NFBR?.a6G?.Initializer;
    let controller = null, key = '';
    if (root && typeof root === 'object') {
      for (const [name, value] of Object.entries(root)) {
        const candidate = value?.menu?.options?.a6l || value?.menu?.a6l;
        if (candidate && typeof candidate.moveToPage === 'function') { controller = candidate; key = name; break; }
      }
    }
    const loading = [...document.querySelectorAll('.loading')].some(el => {
      const style = getComputedStyle(el), box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
    });
    if (!controller || !current || !total) return { supported:false, current, total, loading, key };
    if (${JSON.stringify(action)} === 'first') {
      if (current === 1) return { supported:true, moved:false, current, target:1, total, loading, key };
      controller.moveToPage(0);
      return { supported:true, moved:true, current, target:1, total, loading, key };
    }
    if (${JSON.stringify(action)} !== 'advance') return { supported:true, current, total, loading, key };
    if (current >= total) return { supported:true, done:true, current, total, loading, key };
    controller.moveToPage(current);
    return { supported:true, moved:true, current, target:current + 1, total, loading, key };
  })()`;
  }

  async function bookWalkerReader(action = 'probe') {
    if (collectorBrowserService.browserMode !== 'chrome') return { supported: false };
    try {
      return await collectorBrowserService.runMainPage(bookWalkerControlScript(action), 'chrome');
    } catch {
      return { supported: false };
    }
  }

  function bookWalkerCanvasScript(capture = false) {
    return `(() => {
    const match = String(document.getElementById('pageSliderCounter')?.textContent || '').match(/(\\d+)\\s*\\/\\s*(\\d+)/);
    const current = match ? Number(match[1]) : 0, total = match ? Number(match[2]) : 0;
    const visible = el => {
      const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
      return rect.width > 1 && rect.height > 1 && rect.bottom > 0 && rect.right > 0 &&
        rect.top < innerHeight && rect.left < innerWidth &&
        style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
    };
    const loading = [...document.querySelectorAll('.loading')].some(visible);
    const canvas = [...document.querySelectorAll('.canvasRoot canvas.default, .canvasRoot canvas')]
      .filter(el => el.width > 1 && el.height > 1 && visible(el))
      .sort((a, b) => (b.width * b.height) - (a.width * a.height))[0] || null;
    if (!current || !total || !canvas) return { supported:false, current, total, loading, canvas:false };
    const rect = canvas.getBoundingClientRect();
    let signature = '', sampled = false;
    try {
      const sample = document.createElement('canvas'); sample.width = 24; sample.height = 24;
      const ctx = sample.getContext('2d', { willReadFrequently:true });
      ctx.drawImage(canvas, 0, 0, 24, 24);
      const pixels = ctx.getImageData(0, 0, 24, 24).data;
      let hash = 2166136261 >>> 0, painted = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2], a = pixels[i + 3];
        if (a || r || g || b) painted++;
        hash ^= r; hash = Math.imul(hash, 16777619);
        hash ^= g; hash = Math.imul(hash, 16777619);
        hash ^= b; hash = Math.imul(hash, 16777619);
        hash ^= a; hash = Math.imul(hash, 16777619);
      }
      signature = canvas.width + 'x' + canvas.height + ':' + (hash >>> 0).toString(16) + ':' + painted;
      sampled = true;
    } catch {}
    const base = { supported:true, current, total, loading, canvas:true, sampled, signature,
      width:canvas.width, height:canvas.height, displayWidth:Math.round(rect.width), displayHeight:Math.round(rect.height) };
    if (!${capture ? 'true' : 'false'}) return base;
    try {
      const data = canvas.toDataURL('image/png');
      return { ...base, data };
    } catch (error) {
      return { ...base, error:error?.name === 'SecurityError' ? 'Canvas ถูก browser ป้องกันการอ่านพิกเซล' : (error?.message || 'อ่าน Canvas ไม่สำเร็จ') };
    }
  })()`;
  }

  async function bookWalkerCanvasState(capture = false) {
    if (collectorBrowserService.browserMode !== 'chrome') return { supported: false };
    try {
      return await collectorBrowserService.runMainPage(bookWalkerCanvasScript(capture), 'chrome');
    } catch {
      return { supported: false };
    }
  }

  async function waitForBookWalkerPageReady(targetPage, state) {
    const deadline = Date.now() + Math.max(30000, state.intervalMs * 20);
    let wanted = Number(targetPage) || 0,
      lastSignature = '',
      stable = 0,
      lastInfo = null;
    while (!state.cancelled && !state.abort.signal.aborted && Date.now() < deadline) {
      const info = await bookWalkerCanvasState(false);
      lastInfo = info;
      if (!wanted && info.current) wanted = info.current;
      if (
        info.supported &&
        info.current === wanted &&
        !info.loading &&
        info.canvas &&
        info.sampled &&
        info.signature
      ) {
        if (info.signature === lastSignature) stable++;
        else {
          lastSignature = info.signature;
          stable = 1;
        }
        if (stable >= 3) {
          state.bookWalkerReady = {
            current: info.current,
            signature: info.signature,
          };
          return info;
        }
      } else {
        stable = 0;
        lastSignature = '';
      }
      await delay(160);
    }
    const page = wanted || lastInfo?.current || '?';
    throw new Error('BookWalker โหลดหน้า ' + page + ' ไม่เสร็จภายใน 30 วินาที');
  }

  async function waitForBookWalkerPageChange(fromPage, state) {
    const deadline = Date.now() + Math.max(30000, state.intervalMs * 20);
    let targetPage = 0,
      lastSignature = '',
      stable = 0,
      lastInfo = null;
    while (!state.cancelled && !state.abort.signal.aborted && Date.now() < deadline) {
      const info = await bookWalkerCanvasState(false);
      lastInfo = info;
      if (!targetPage && info.current && info.current !== fromPage) targetPage = info.current;
      if (
        targetPage &&
        info.supported &&
        info.current === targetPage &&
        !info.loading &&
        info.canvas &&
        info.sampled &&
        info.signature
      ) {
        if (info.signature === lastSignature) stable++;
        else {
          lastSignature = info.signature;
          stable = 1;
        }
        if (stable >= 3) {
          state.bookWalkerReady = {
            current: info.current,
            signature: info.signature,
          };
          return info;
        }
      } else {
        stable = 0;
        lastSignature = '';
      }
      await delay(160);
    }
    const page = targetPage || lastInfo?.current || fromPage + 1;
    throw new Error('BookWalker โหลดหน้า ' + page + ' ไม่เสร็จภายใน 30 วินาที');
  }

  function nextChapterPageSnapshot() {
    const trim = (value) =>
      String(value || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 220);
    const links = [];
    for (const node of document.querySelectorAll('a[href], link[rel~="next"]')) {
      const href = node.href || node.getAttribute('href') || '',
        rel = node.getAttribute('rel') || '';
      const text = trim(node.textContent),
        aria = trim(node.getAttribute('aria-label')),
        title = trim(node.getAttribute('title'));
      const id = trim(node.id),
        className = trim(typeof node.className === 'string' ? node.className : '');
      const parentText = trim(node.parentElement?.textContent);
      const desc = trim(
        [...node.querySelectorAll('svg,title,use')]
          .map((x) =>
            [
              x.getAttribute('aria-label'),
              x.getAttribute('title'),
              x.textContent,
              x.getAttribute('href'),
              x.getAttribute('xlink:href'),
              x.getAttribute('class'),
            ]
              .filter(Boolean)
              .join(' '),
          )
          .join(' '),
      );
      const onclick = trim(node.getAttribute('onclick'));
      const disabled = Boolean(
        node.disabled ||
        node.getAttribute('aria-disabled') === 'true' ||
        /(?:^|\s)disabled(?:\s|$)|cursor-not-allowed|pointer-events-none/i.test(className),
      );
      const data = Object.fromEntries(
        [...node.attributes]
          .filter((x) => x.name.startsWith('data-'))
          .slice(0, 20)
          .map((x) => [x.name, trim(x.value)]),
      );
      let sibling = false;
      try {
        const current = new URL(location.href),
          target = new URL(href, location.href);
        if (current.hostname === target.hostname) {
          const a = decodeURIComponent(current.pathname).split('/').filter(Boolean),
            b = decodeURIComponent(target.pathname).split('/').filter(Boolean);
          if (a.length === b.length) {
            const changed = a.map((x, i) => (x === b[i] ? -1 : i)).filter((i) => i >= 0);
            if (changed.length === 1) {
              const i = changed[0],
                x = a[i],
                y = b[i];
              let common = 0;
              while (common < x.length && common < y.length && x[common] === y[common]) common++;
              sibling = /\d/.test(x) && /\d/.test(y) && (a.length >= 2 || common >= 12);
            }
          }
        }
      } catch {}
      const hint = [href, rel, text, aria, title, id, className, parentText, desc].join(' ');
      const chapterIconNav =
        /(?:chevron|arrow)[-_ ]?(?:right|left)|feather-(?:chevron|arrow)-(?:right|left)/i.test(
          desc,
        ) && /\/chapter\//i.test(href);
      if (
        !sibling &&
        !chapterIconNav &&
        !/next|chapter|chap|episode|ตอน|ถัด|ต่อไป|次|下一|다음/i.test(hint)
      )
        continue;
      links.push({
        href,
        rel,
        text,
        aria,
        title,
        id,
        className,
        parentText,
        desc,
        onclick,
        data,
        disabled,
        sibling,
      });
      if (links.length >= 500) break;
    }
    const controls = [];
    for (const node of document.querySelectorAll('button,[role="button"]')) {
      const text = trim(node.textContent),
        aria = trim(node.getAttribute('aria-label')),
        title = trim(node.getAttribute('title'));
      const id = trim(node.id),
        className = trim(typeof node.className === 'string' ? node.className : '');
      const desc = trim(
        [...node.querySelectorAll('svg,title,use')]
          .map((x) =>
            [
              x.getAttribute('aria-label'),
              x.getAttribute('title'),
              x.textContent,
              x.getAttribute('href'),
              x.getAttribute('xlink:href'),
              x.getAttribute('class'),
            ]
              .filter(Boolean)
              .join(' '),
          )
          .join(' '),
      );
      const onclick = trim(node.getAttribute('onclick'));
      const disabled = Boolean(
        node.disabled ||
        node.getAttribute('aria-disabled') === 'true' ||
        /(?:^|\s)disabled(?:\s|$)|cursor-not-allowed|pointer-events-none/i.test(className),
      );
      const data = Object.fromEntries(
        [...node.attributes]
          .filter((x) => x.name.startsWith('data-'))
          .slice(0, 20)
          .map((x) => [x.name, trim(x.value)]),
      );
      const hint = [text, aria, title, id, className, desc, onclick, ...Object.values(data)].join(
        ' ',
      );
      if (
        !/next|prev|chapter|chap|episode|ตอน|ถัด|ก่อน|arrow|chevron|話|章|回|다음|이전/i.test(hint)
      )
        continue;
      controls.push({
        text,
        aria,
        title,
        id,
        className,
        desc,
        onclick,
        data,
        disabled,
      });
      const href =
        data['data-href'] ||
        data['data-url'] ||
        data['data-next'] ||
        node.getAttribute('formaction') ||
        '';
      if (href)
        links.push({
          href,
          rel: '',
          text,
          aria,
          title,
          id,
          className,
          parentText: trim(node.parentElement?.textContent),
          desc,
          onclick,
          data,
          disabled,
          sibling: false,
        });
      if (controls.length >= 200) break;
    }
    const selects = [];
    for (const select of document.querySelectorAll('select')) {
      const label = trim(
        [
          select.id,
          select.name,
          select.className,
          select.getAttribute('aria-label'),
          select.getAttribute('title'),
        ].join(' '),
      );
      const options = [...select.options].slice(0, 500).map((option, index) => ({
        index,
        text: trim(option.textContent),
        value: option.value,
        selected: option.selected,
      }));
      const selected = options.find((x) => x.selected),
        strong = /chapter|chap|episode|ตอน|話|章|回|화|회/i.test(
          label +
            ' ' +
            options
              .slice(0, 20)
              .map((x) => x.text)
              .join(' '),
        );
      const numericSelected =
        /^\s*\d+(?:(?:\.|-|_)\d+)*\s*$/.test(selected?.text || '') ||
        /^\s*\d+(?:(?:\.|-|_)\d+)*\s*$/.test(selected?.value || '');
      if (!strong && !numericSelected) continue;
      selects.push({ label, selectedIndex: select.selectedIndex, options });
      if (selects.length >= 20) break;
    }
    return {
      url: location.href,
      title: document.title || '',
      headings: [...document.querySelectorAll('h1,h2')].slice(0, 8).map((x) => trim(x.textContent)),
      links,
      selects,
      controls,
    };
  }

  function clickSemanticNextChapterControl() {
    const compact = (value) =>
      String(value || '')
        .replace(/\s+/g, ' ')
        .trim();
    const nextChapter =
      /(?:next\s*(?:chapter|chap(?:ter)?|episode|ep\.?)|(?:chapter|episode)\s*next|ตอน(?:ถัด|ต่อ)ไป|ตอนหน้า|次の(?:話|章|回)|次話|下一(?:章|话|話|回)|다음\s*(?:화|회))/i;
    const nextPage = /(?:next\s*page|page\s*next|หน้าถัดไป|หน้าต่อไป|次のページ|下一页|下一頁)/i;
    const previous =
      /(?:prev(?:ious)?|ก่อนหน้า|ย้อนกลับ|上一(?:章|话|話|回)|前の(?:話|章|回)|이전)/i;
    const rows = [];
    for (const node of document.querySelectorAll('a[href],button,[role="button"]')) {
      const text = compact(node.textContent),
        aria = compact(node.getAttribute('aria-label')),
        title = compact(node.getAttribute('title'));
      const id = compact(node.id),
        className = compact(typeof node.className === 'string' ? node.className : '');
      const desc = compact(
        [...node.querySelectorAll('svg,title,use')]
          .map((x) =>
            [
              x.getAttribute('aria-label'),
              x.getAttribute('title'),
              x.textContent,
              x.getAttribute('href'),
              x.getAttribute('xlink:href'),
              x.getAttribute('class'),
            ]
              .filter(Boolean)
              .join(' '),
          )
          .join(' '),
      );
      const direct = compact([text, aria, title, id, className, desc].join(' '));
      const rel = compact(node.getAttribute('rel')).toLowerCase(),
        href = node.href || node.getAttribute('href') || '';
      const disabled = Boolean(
        node.disabled ||
        node.getAttribute('aria-disabled') === 'true' ||
        /(?:^|\s)disabled(?:\s|$)|cursor-not-allowed|pointer-events-none/i.test(className),
      );
      if (
        disabled ||
        nextPage.test(direct) ||
        previous.test(direct) ||
        /(?:^|[-_ ])prev(?:$|[-_ ])/i.test(direct)
      )
        continue;
      let score = 0;
      if (nextChapter.test(direct)) score += 90;
      if (
        /(?:^|[-_ ])(?:ch|chap|chapter)[-_ ]*next(?:$|[-_ ])|next[-_ ]*(?:ch|chap|chapter)/i.test(
          direct,
        )
      )
        score += 85;
      if (
        /(^|\s)next(\s|$)/.test(rel) &&
        /#\/?next\/?$/i.test(href) &&
        /(?:ch|chap|chapter)/i.test(direct)
      )
        score += 85;
      if (/\bnext\b|ถัดไป|ต่อไป|次へ|다음/i.test(direct)) score += 10;
      if (score >= 75) rows.push({ node, score, text: text || aria || title || 'ตอนถัดไป' });
    }
    rows.sort((a, b) => b.score - a.score);
    if (!rows.length) return { clicked: false };
    rows[0].node.click();
    return { clicked: true, score: rows[0].score, text: rows[0].text };
  }

  async function detectNextChapter() {
    collectorBrowserService.ensureIdle();
    if (
      !collectorBrowserService.webAlive() ||
      !hostService.allowedWeb(collectorBrowserService.webURL())
    )
      throw new Error('กรุณาเปิดตอนปัจจุบันก่อน');
    collectorBrowserService.busy = 'next-chapter';
    try {
      const current = collectorBrowserService.webURL();
      const snapshot = await hostService.withTimeout(
        collectorBrowserService.runPage('(' + nextChapterPageSnapshot.toString() + ')()'),
        10000,
        'ตรวจหาตอนถัดไปนานเกินกำหนด',
      );
      const result = chooseNextChapter(current, snapshot || {});
      return {
        ...result,
        currentUrl: current,
        ...(hostService.testMode ? { debug: snapshot } : {}),
      };
    } finally {
      collectorBrowserService.busy = null;
    }
  }

  async function pageChapterSignature() {
    return hostService.withTimeout(
      collectorBrowserService.runPage(`(() => {
    const text = value => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, 500);
    return { url:location.href, title:document.title || '',
      heading:text(document.querySelector('h1,h2,.chapter-title,.entry-title,.reader-title')?.textContent) };
  })()`),
      8000,
      'อ่านสถานะหน้าตอนนานเกินกำหนด',
    );
  }

  function stablePageURL(value) {
    try {
      const url = new URL(value);
      url.hash = '';
      return url.href;
    } catch {
      return String(value || '');
    }
  }

  async function advanceNextChapterControl() {
    collectorBrowserService.ensureIdle();
    if (
      !collectorBrowserService.webAlive() ||
      !hostService.allowedWeb(collectorBrowserService.webURL())
    )
      throw new Error('กรุณาเปิดตอนปัจจุบันก่อน');
    collectorBrowserService.busy = 'next-control';
    try {
      const before = await pageChapterSignature();
      const chapterPage = await hostService.withTimeout(
        collectorBrowserService.runPage('(' + nextChapterPageSnapshot.toString() + ')()'),
        10000,
        'อ่านข้อมูลตอนปัจจุบันนานเกินกำหนด',
      );
      const indexLink = chapterIndexLink(before.url, chapterPage || {});
      const clicked = await hostService.withTimeout(
        collectorBrowserService.runPage('(' + clickSemanticNextChapterControl.toString() + ')()'),
        8000,
        'กดตัวควบคุมตอนถัดไปนานเกินกำหนด',
      );
      if (!clicked?.clicked) throw new Error('ไม่พบตัวควบคุมตอนถัดไปที่ปลอดภัยสำหรับการกด');
      const deadline = Date.now() + (indexLink ? 5000 : 15000);
      let after = before;
      while (Date.now() < deadline) {
        await delay(250);
        after = await pageChapterSignature().catch(() => after);
        const changedURL = stablePageURL(after.url) !== stablePageURL(before.url);
        const changedTitle = after.title && before.title && after.title !== before.title;
        const changedHeading = after.heading && before.heading && after.heading !== before.heading;
        if (changedURL || changedTitle || changedHeading) {
          collectorCollectionService.pageInfo = {
            title: after.title || (await collectorBrowserService.webTitle()),
            url: collectorBrowserService.webURL(),
          };
          return {
            ...after,
            clicked: true,
            controlText: clicked.text || '',
            changedURL,
            changedTitle,
            changedHeading,
          };
        }
      }
      if (indexLink?.url) {
        try {
          await collectorBrowserService.openPageAttempt(
            indexLink.url,
            collectorBrowserService.browserMode,
            false,
          );
          await delay(800);
          const listing = await hostService.withTimeout(
            collectorBrowserService.runPage('(' + nextChapterPageSnapshot.toString() + ')()'),
            10000,
            'อ่านหน้ารวมตอนนานเกินกำหนด',
          );
          const candidate = nextFromChapterListing(before.url, chapterPage || {}, listing || {});
          if (candidate?.url) {
            await collectorBrowserService.openPageAttempt(
              candidate.url,
              collectorBrowserService.browserMode,
              false,
            );
            after = await pageChapterSignature();
            const changedURL = stablePageURL(after.url) !== stablePageURL(before.url);
            const changedTitle = after.title && before.title && after.title !== before.title;
            const changedHeading =
              after.heading && before.heading && after.heading !== before.heading;
            if (changedURL || changedTitle || changedHeading) {
              collectorCollectionService.pageInfo = {
                title: after.title || (await collectorBrowserService.webTitle()),
                url: collectorBrowserService.webURL(),
              };
              return {
                ...after,
                clicked: true,
                controlText: clicked.text || '',
                changedURL,
                changedTitle,
                changedHeading,
                fallback: 'chapter-index',
                indexUrl: indexLink.url,
                nextText: candidate.text || '',
              };
            }
          }
        } catch (error) {
          await collectorBrowserService
            .openPageAttempt(before.url, collectorBrowserService.browserMode, false)
            .catch(() => {});
          throw new Error(
            'ปุ่มตอนถัดไปไม่เปลี่ยนหน้า และ fallback หน้ารวมตอนล้มเหลว: ' + error.message,
          );
        }
        await collectorBrowserService
          .openPageAttempt(before.url, collectorBrowserService.browserMode, false)
          .catch(() => {});
      }
      throw new Error('กด “ตอนถัดไป” แล้ว แต่หน้า/หัวตอนไม่เปลี่ยน และไม่พบตอนถัดไปจากหน้ารวมตอน');
    } finally {
      collectorBrowserService.busy = null;
    }
  }
  return {
    isBookWalkerViewer,
    bookWalkerReader,
    bookWalkerCanvasState,
    waitForBookWalkerPageReady,
    waitForBookWalkerPageChange,
    detectNextChapter,
    advanceNextChapterControl,
  };
}
module.exports = { createCollectorNavigation };
