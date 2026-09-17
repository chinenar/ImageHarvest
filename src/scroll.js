// Scroll only the document and large reader-like panels; never click pagination.
(action => {
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
    state.saved = state.targets.map(el => ({ el, top: el.scrollTop, behavior: el.style.scrollBehavior }));
    for (const el of state.targets) { el.style.scrollBehavior = 'auto'; el.scrollTop = 0; }
  }
  if (action === 'step') {
    for (const el of state.targets) el.scrollTop += Math.max(200, Math.floor(el.clientHeight * 0.8));
  }
  if (action === 'restore') {
    for (const item of state.saved) { item.el.scrollTop = item.top; item.el.style.scrollBehavior = item.behavior; }
    state.targets = []; state.saved = [];
    return true;
  }
  const height = state.targets.reduce((sum, el) => sum + el.scrollHeight, 0);
  const top = state.targets.reduce((sum, el) => sum + el.scrollTop + el.clientHeight, 0);
  return { height, progress: height ? Math.min(1, top / height) : 1,
    bottom: state.targets.every(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 4) };
})
