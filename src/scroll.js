// Scroll only the document and large reader-like panels; never click pagination.
(input => {
  const action = typeof input === 'string' ? input : input.action;
  const readyBlobs = new Set(typeof input === 'object' ? input.readyBlobs || [] : []);
  const state = globalThis.__eiwScroll ||= { targets: [], saved: [] };
  if (action === 'init') {
    const doc = document.scrollingElement;
    const nested = [...document.querySelectorAll('*')].filter(el => {
      if (el === doc || el === document.body) return false;
      const r = el.getBoundingClientRect();
      return r.width > 250 && r.height > 250 && el.scrollHeight > el.clientHeight + 100 &&
        /(auto|scroll)/.test(getComputedStyle(el).overflowY);
    }).slice(0, 4);
    state.targets = [doc, ...nested].filter(Boolean);
    state.saved = state.targets.map(el => ({ el, top: el.scrollTop, left: el.scrollLeft }));
    for (const el of state.targets) { el.scrollTo({ top: 0, left: el.scrollLeft, behavior: 'instant' }); }
  }
  if (action === 'step') {
    for (const el of state.targets) {
      const doc = el === document.scrollingElement;
      const box = doc ? { top: 0, width: innerWidth } : el.getBoundingClientRect();
      const viewportTop = box.top + (doc ? 0 : el.clientTop), height = el.clientHeight;
      let amount = Math.max(200, Math.floor(height * 0.8));
      // Jump only within one fully loaded, wide image, retaining viewport overlap.
      // Blob images must already have a disk snapshot before jumping past them.
      for (const img of el.querySelectorAll('img')) {
        const src = img.currentSrc || img.src;
        if (!img.complete || !img.naturalWidth || (src.startsWith('blob:') && !readyBlobs.has(src))) continue;
        const r = img.getBoundingClientRect();
        if (r.width < box.width * 0.6 || r.height < height * 1.5 || r.top > viewportTop + height * 0.25 || r.bottom <= viewportTop + height) continue;
        const style = getComputedStyle(img);
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        amount = Math.max(amount, Math.floor(r.bottom - viewportTop - height * 0.8));
      }
      el.scrollBy({ top: amount, behavior: 'instant' });
    }
  }
  if (action === 'restore') {
    for (const item of state.saved) { item.el.scrollTo({ top: item.top, left: item.left, behavior: 'instant' }); }
    state.targets = []; state.saved = [];
    return true;
  }
  const height = state.targets.reduce((sum, el) => sum + el.scrollHeight, 0);
  const top = state.targets.reduce((sum, el) => sum + el.scrollTop + el.clientHeight, 0);
  return { height, progress: height ? Math.min(1, top / height) : 1,
    bottom: state.targets.every(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 4) };
})
