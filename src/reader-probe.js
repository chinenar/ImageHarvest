// Read-only structural summary; intentionally does not inspect or change site protections.
(options => {
  const roots = options.selector ? [...document.querySelectorAll(options.selector)] : [document.documentElement];
  const nodes = [], queue = roots.slice(), visited = new Set();
  while (queue.length && nodes.length < 2000) {
    const root = queue.shift();
    if (!root || visited.has(root)) continue;
    visited.add(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = root instanceof Element ? root : walker.nextNode();
    while (node && nodes.length < 2000) {
      nodes.push(node);
      if (node.shadowRoot) queue.push(node.shadowRoot);
      node = walker.nextNode();
    }
  }
  const attrs = new Set(), topology = new Set();
  let images = 0, decoded = 0, canvases = 0, backgrounds = 0, expectedTotal = 0;
  for (const el of nodes) {
    if (el.closest('nav,aside,footer,header,[role="navigation"],.ads,.advertisement,[data-ad-slot],.toolbar')) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 240 || rect.height < 240) continue;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
    if (el.tagName === 'IMG') {
      images++; if (el.complete && el.naturalWidth > 32 && el.naturalHeight > 32) decoded++;
      for (const attr of [...el.attributes].slice(0, 40)) {
        if (!/^data-[a-z][a-z0-9-]{0,50}$/.test(attr.name) || !/(src|original|image|lazy|url|echo)/.test(attr.name)) continue;
        try {
          const url = new URL(attr.value, document.baseURI);
          if (attr.value.trim() && ['http:', 'https:', 'blob:'].includes(url.protocol)) attrs.add(attr.name);
        } catch {}
      }
    } else if (el.tagName === 'CANVAS') canvases++;
    else if (/url\(/i.test(style.backgroundImage)) backgrounds++;
    if (el.tagName === 'IMG' || el.tagName === 'CANVAS')
      topology.add([el.tagName, el.parentElement?.tagName || '', el.parentElement?.parentElement?.tagName || ''].join('/'));
    for (const name of ['data-page-count', 'data-total-pages']) {
      const value = el.getAttribute(name);
      if (/^[1-9][0-9]{0,3}$/.test(value || '')) expectedTotal = Math.max(expectedTotal, Number(value));
    }
  }
  const kinds = [images ? 'img' : '', canvases ? 'canvas' : '', backgrounds ? 'background' : ''].filter(Boolean);
  return { family: kinds.length > 1 ? 'mixed' : kinds[0] || 'unknown', images, decoded, canvases, backgrounds,
    expectedTotal, lazyAttributes: [...attrs].sort().slice(0, 16), topology: [...topology].sort().slice(0, 20),
    scriptSources: [...document.scripts].filter(el => el.src).map(el => el.src).slice(0, 256),
    limited: nodes.length >= 2000, frames: document.querySelectorAll('iframe').length };
})
