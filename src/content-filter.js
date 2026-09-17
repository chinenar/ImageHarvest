// Shared, deterministic metadata filters. No AI, image editing or network requests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ImageHarvestFilters = api;
})(globalThis, () => {
  'use strict';
  function classify(meta = {}) {
    let filename = '';
    try {
      const u = new URL(meta.url || '');
      if (/^https?:$/.test(u.protocol)) filename = decodeURIComponent(u.pathname.split('/').pop() || '');
    } catch {}
    const text = [filename, meta.identity || '', meta.alt || ''].join(' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    const named = /(?:^|[^a-z0-9])(?:logo(?:type|s|\d+)?|favicon|avatar(?:s|\d+)?|site[-_ ]?brand|social[-_ ]?icon|icon(?:s|\d+)?)(?=$|[^a-z0-9])/.test(text)
      || /โลโก้|รูปโปรไฟล์/.test(text);
    const kind = ['reader', 'main'].includes(meta.mainKind) ? meta.mainKind : 'unknown';
    const chrome = Boolean(named || meta.uiRegion);
    return { chrome, mainKind: kind,
      reason: named ? 'ชื่อหรือคุณสมบัติระบุว่าเป็นโลโก้/ไอคอน/รูปโปรไฟล์' :
        meta.uiRegion ? 'อยู่ในส่วนเมนู โฆษณา คอมเมนต์ หรือรูปประกอบเว็บ' :
        kind === 'reader' ? 'อยู่ในบริเวณตัวอ่าน' : kind === 'main' ? 'อยู่ในเนื้อหาหลักของหน้า' : 'ยังระบุบริเวณเนื้อหาไม่ได้' };
  }
  function mainScope(items) {
    const kinds = new Set(items.filter(x => !x.filterHints?.chrome).map(x => x.filterHints?.mainKind));
    return kinds.has('reader') ? 'reader' : kinds.has('main') ? 'main' : 'unknown';
  }
  function matches(item, options = {}) {
    const hints = item.filterHints || {};
    if (options.hideChrome && hints.chrome) return false;
    if (options.mainOnly) {
      if (hints.chrome) return false;
      if (options.mainScope && options.mainScope !== 'unknown' && hints.mainKind !== options.mainScope) return false;
    }
    if (options.source && options.source !== 'all' && item.source !== options.source) return false;
    if ((item.width || 0) < (options.minWidth || 0) || (item.height || 0) < (options.minHeight || 0)) return false;
    const text = String(options.search || '').trim().toLocaleLowerCase();
    return !text || `${item.label || ''} ${item.url || ''} ${item.alt || ''}`.toLocaleLowerCase().includes(text);
  }
  return Object.freeze({ classify, mainScope, matches });
});
