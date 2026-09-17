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
  const result = [];
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
    result.push({ key: `${state.ids.get(el)}:${layer}`, url: url.href, source: kind,
      width: Math.round(width || rect.width), height: Math.round(height || rect.height),
      top: Math.round(rect.top + scrollY + innerY), left: Math.round(rect.left + scrollX + innerX),
      dom: index, alt: (el.getAttribute('alt') || '').slice(0, 160) });
  }
  elements.forEach((el, index) => {
    const isImg = el.tagName === 'IMG';
    if (!isImg && !options.backgrounds) return;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return;
    if (isImg) {
      const lazy = ['data-src', 'data-original', 'data-lazy-src', 'data-url'].map(k => el.getAttribute(k)).find(Boolean);
      const loaded = el.complete && el.naturalWidth > 32;
      const raw = loaded ? (el.currentSrc || el.src || lazy) : (lazy || el.currentSrc || el.getAttribute('src'));
      add(el, raw, 'img', loaded ? el.naturalWidth : 0, loaded ? el.naturalHeight : 0, rect, index);
    }
    if (options.backgrounds && style.backgroundImage !== 'none') {
      const regex = /url\(\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|([^)]*))\s*\)/g;
      let match, layer = 1;
      while ((match = regex.exec(style.backgroundImage))) {
        add(el, (match[1] || match[2] || match[3] || '').trim(), 'background', 0, 0, rect, index, layer++);
      }
    }
  });
  return { items: result, title: document.title, url: location.href,
    frames: document.querySelectorAll('iframe').length,
    canvases: document.querySelectorAll('canvas').length };
})
