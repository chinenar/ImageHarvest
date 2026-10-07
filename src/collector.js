// Runs in an isolated, sandboxed browser world. No Node.js APIs are present.
(options => {
  const state = globalThis.__eiwCollector ||= { ids: new WeakMap(), next: 1 };
  const roots = options.selector ? [...document.querySelectorAll(options.selector)] : [document.documentElement];
  if (options.selector && !roots.length) throw new Error('ไม่พบส่วนของหน้าเว็บตาม CSS selector ที่ระบุ');
  const elements = [], visited = new Set();
  function walk(root) {
    if (!root || visited.has(root)) return;
    visited.add(root);
    if (root instanceof Element) elements.push(root);
    for (const el of root.querySelectorAll('*')) {
      if (!visited.has(el)) { visited.add(el); elements.push(el); }
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  }
  roots.forEach(walk);
  const result = [], canvasItems = [];
  const readerSelector = '.reading-strip,.reader-content,.reading-content,#readerarea,.chapter-content,.chapter-images,.manga-pages,.manga-reader,[data-reader-content],.reader-images,.reader-pages,.t-c-preview-slider__scroll,.preview-pages,.sample-pages,[data-preview-pages]';
  const mainSelector = 'main,article,[role="main"]';
  const uiSelector = 'nav,aside,footer,[role="navigation"],[role="complementary"],.comments,#comments,.comment-list,#disqus_thread,.sidebar,.recommendations,.related-posts,.related-manga,.related-items,.ads,.advertisement,.ad-container,[data-ad-slot],.toolbar,.reader-controls,.site-header,.site-footer,.site-logo,.site-brand,.avatar,.social-share,#reader-comments,[role="menu"],[role="toolbar"]';
  const contexts = new WeakMap();
  function hints(el, raw) {
    let meta = contexts.get(el);
    if (!meta) {
      const ancestors = [];
      for (let node = el; node && ancestors.length < 32; node = node.parentElement || node.getRootNode()?.host) ancestors.push(node);
      const mainKind = ancestors.some(x => x.matches(readerSelector)) ? 'reader' : ancestors.some(x => x.matches(mainSelector)) ? 'main' : 'unknown';
      const link = ancestors.find(x => x.tagName === 'A' && x.hasAttribute('href'));
      let externalLink = false;
      try { const target = new URL(link?.getAttribute('href') || '', document.baseURI); externalLink = /^https?:$/.test(target.protocol) && target.hostname !== location.hostname; } catch {}
      const rect = el.getBoundingClientRect();
      meta = { mainKind, externalLink, sponsored: Boolean(link?.rel.split(/\s+/).includes('sponsored')),
        control: ancestors.some(x => x.matches('button,[role="button"],input,select')),
        adRegion: ancestors.some(x => /(?:^|[-_\s])(?:ads?|advertisements?|sponsored)(?:$|[-_\s])/i.test((x.id || '') + ' ' + (x.getAttribute('class') || ''))),
        displayWidth: rect.width, displayHeight: rect.height, width: el.naturalWidth || el.width, height: el.naturalHeight || el.height,
        uiRegion: ancestors.some(x => x.matches(uiSelector)) || (mainKind === 'unknown' && ancestors.some(x => x.tagName === 'HEADER')),
        identity: [el.id, el.getAttribute('class'), el.getAttribute('role')].filter(Boolean).join(' ').slice(0, 500),
        context: ancestors.slice(0, 10).map(x => [x.id, typeof x.className === 'string' ? x.className : '', x.getAttribute?.('role'), x.getAttribute?.('aria-label'), x.getAttribute?.('title')].filter(Boolean).join(' ')).join(' ').slice(0, 1200),
        linkText: (link?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240),
        alt: (el.getAttribute('alt') || el.getAttribute('aria-label') || el.getAttribute('title') || '').slice(0, 200) };
      contexts.set(el, meta);
    }
    return globalThis.ImageHarvestFilters.classify({ ...meta, url: raw });
  }
  function add(el, raw, kind, width, height, rect, index, layer = 0) {
    if (!raw || !rect.width || !rect.height) return;
    let url;
    try { url = new URL(raw, document.baseURI); } catch { return; }
    if (!['http:', 'https:', 'data:', 'blob:'].includes(url.protocol)) return;
    if (url.protocol === 'data:' && !url.href.startsWith('data:image/')) return;
    if (url.href.length > 48 * 1024 * 1024) return;
    if (!state.ids.has(el)) state.ids.set(el, state.next++);
    let innerY = 0, innerX = 0;
    // Account for nested scrolling readers, not just window.scrollY.
    for (let parent = el.parentElement; parent && parent !== document.body && parent !== document.documentElement; parent = parent.parentElement) {
      innerY += parent.scrollTop; innerX += parent.scrollLeft;
    }
    result.push({ key: `${state.ids.get(el)}:${layer}`, url: url.href, source: kind, filterHints: hints(el, url.href),
      width: Math.round(width || rect.width), height: Math.round(height || rect.height),
      top: Math.round(rect.top + scrollY + innerY), left: Math.round(rect.left + scrollX + innerX),
      dom: index, decoded: kind === 'img' && el.complete && el.naturalWidth > 32 && el.naturalHeight > 32 && (el.currentSrc || el.src) === url.href,
      alt: (el.getAttribute('alt') || '').slice(0, 160) });
  }
  elements.forEach((el, index) => {
    const isImg = el.tagName === 'IMG', isCanvas = el.tagName === 'CANVAS';
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    if (options.visibleOnly && (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth)) return;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return;
    const backgroundStyle = style.backgroundImage || '';
    const hasBackground = backgroundStyle !== 'none' && backgroundStyle.includes('url(');
    // Even when "include backgrounds" is off, keep inspecting CSS image candidates.
    // Many comic sites render covers/pages as DIV background-image rather than IMG.
    if (!isImg && !isCanvas && !options.backgrounds && !hasBackground) return;
    if (isCanvas && options.canvases && el.width > 1 && el.height > 1) {
      if (!state.ids.has(el)) state.ids.set(el, state.next++);
      let innerY = 0, innerX = 0;
      for (let parent = el.parentElement; parent && parent !== document.body && parent !== document.documentElement; parent = parent.parentElement) { innerY += parent.scrollTop; innerX += parent.scrollLeft; }
      canvasItems.push({ filterHints: hints(el, ''), captureId: state.ids.get(el), width: el.width, height: el.height,
        top: Math.round(rect.top + scrollY + innerY), left: Math.round(rect.left + scrollX + innerX), dom: index,
        alt: (el.getAttribute('aria-label') || el.getAttribute('title') || el.parentElement?.dataset?.page || '').slice(0,160) });
    }
    if (isImg) {
      const attributes = [...(options.lazyAttributes || []).filter(k => /^data-[a-z][a-z0-9-]{0,50}$/.test(k)).slice(0, 16), 'data-src', 'data-original', 'data-lazy-src', 'data-url'];
      const lazy = attributes.map(k => el.getAttribute(k)).find(Boolean);
      const loaded = el.complete && el.naturalWidth > 32;
      const raw = loaded ? (el.currentSrc || el.src || lazy) : (lazy || el.currentSrc || el.getAttribute('src'));
      add(el, raw, 'img', loaded ? el.naturalWidth : 0, loaded ? el.naturalHeight : 0, rect, index);
    }
    if (hasBackground) {
      const regex = /url\(\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|([^)]*))\s*\)/g;
      let match, layer = 1;
      while ((match = regex.exec(backgroundStyle))) {
        const raw = (match[1] || match[2] || match[3] || '').trim();
        if (!raw) continue;
        if (!options.backgrounds) {
          // Smart CSS-image pickup: covers/pages are commonly portrait DIV backgrounds.
          // Keep this conservative so decorative hero/backdrop images do not flood Normal/Manga scans.
          const aspect = rect.width / rect.height;
          const looksLikeImageFile = /\.(?:avif|gif|jpe?g|png|webp)(?:[?#]|$)/i.test(raw);
          const hugeSurface = rect.width >= innerWidth * 0.85 && rect.height >= innerHeight * 0.75;
          const blurredDecoration = /blur\(/i.test(style.filter || '');
          const candidateHints = hints(el, raw);
          const smart = options.smartBackgrounds !== false &&
            rect.width >= 96 && rect.height >= 96 &&
            aspect >= 0.28 && aspect <= 2.35 &&
            looksLikeImageFile && !hugeSurface && !blurredDecoration && !candidateHints.chrome;
          if (!smart) continue;
        } else if (options.adaptiveBackgrounds) {
          // Adaptive discovery must stay as conservative as Smart pickup. It may
          // enable CSS-background probing automatically, but must not promote
          // wide hero/backdrop decoration into harvested content.
          const aspect = rect.width / rect.height;
          const looksLikeImageFile = /\.(?:avif|gif|jpe?g|png|webp)(?:[?#]|$)/i.test(raw);
          const hugeSurface = rect.width >= innerWidth * 0.85 && rect.height >= innerHeight * 0.75;
          const blurredDecoration = /blur\(/i.test(style.filter || '');
          const candidateHints = hints(el, raw);
          const smart = rect.width >= 96 && rect.height >= 96 &&
            aspect >= 0.28 && aspect <= 2.35 &&
            looksLikeImageFile && !hugeSurface && !blurredDecoration && !candidateHints.chrome;
          if (!smart) continue;
        }
        add(el, raw, 'background', 0, 0, rect, index, layer++);
      }
    }
  });
  return { items: result, canvasItems, title: document.title, url: location.href,
    frames: document.querySelectorAll('iframe').length,
    canvases: document.querySelectorAll('canvas').length };
})
