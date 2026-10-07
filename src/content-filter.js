// Shared, deterministic, reversible filters. No hostname rules or AI classification.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ImageHarvestFilters = api;
})(globalThis, () => {
  'use strict';
  const words = text => String(text || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  const token = (text, pattern) => new RegExp('(?:^|[^a-z0-9])(?:' + pattern + ')(?=$|[^a-z0-9])').test(text);
  const clamp = value => Math.max(0, Math.min(100, Math.round(value || 0)));
  function classify(meta = {}) {
    let filename = '', pathname = '';
    try {
      const u = new URL(meta.url || '');
      if (/^https?:$/.test(u.protocol)) {
        pathname = decodeURIComponent(u.pathname).toLowerCase();
        filename = decodeURIComponent(u.pathname.split('/').pop() || '');
      }
    } catch {}
    const name = words(filename), identity = words(meta.identity), alt = words(meta.alt);
    const context = words(meta.context), linkText = words(meta.linkText);
    const text = [name, identity, alt, context, linkText].join(' ');
    const small = meta.displayWidth > 0 && meta.displayHeight > 0 && meta.displayWidth <= 96 && meta.displayHeight <= 96;
    const svg = /\.svg$/i.test(filename);
    const kind = ['reader', 'main'].includes(meta.mainKind) ? meta.mainKind : 'unknown';
    let chromeScore = 0, contentScore = kind === 'reader' ? 92 : kind === 'main' ? 68 : 18;
    const signals = [];
    const addChrome = (score, signal) => {
      if (score > chromeScore) chromeScore = score;
      if (signal && !signals.includes(signal)) signals.push(signal);
    };
    const named = token(text, 'logo(?:type|s|\\d+)?|wordmark|favicon|avatar(?:s|\\d+)?|site[-_ ]?brand|social[-_ ]?icon|icon(?:s|\\d+)?') || /โลโก้|รูปโปรไฟล์/.test(text);
    const service = /^(?:google|facebook|apple|line|discord|twitter|visa|mastercard|amex|paypal|american[-_ ]express)(?:$|[._ -])/.test(name)
      || /^(?:google|facebook|apple|line|discord|visa|mastercard|amex|paypal|american express)(?:$| (?:auth|login|sign|pay))/.test(alt);
    const uiAsset = /\/(?:icons?|sns|payment(?:s)?|social)\//.test(pathname);
    const serviceIcon = service && (small || (svg && (uiAsset || meta.control)));
    const badge = token(name, '(?:label|badge)[-_](?:benefit|bonus|exclusive|sale|new)') && (svg || small);
    const controlIcon = meta.control && small && Math.max(meta.displayWidth, meta.displayHeight) <= 64;
    const placeholder = /^(?:(?:img|image)[-_])?(?:loading[-_]dummy|placeholder|spacer|spinner)(?:[._-]|$)/.test(name)
      || (/^(?:transparent|blank)\.(?:gif|png)$/.test(name) && (meta.width <= 2 || meta.height <= 2))
      || /^(?:preview|sample)[-_]end(?:[._-]|$)/.test(name);
    const adWords = token(text, 'banners?|advertisements?|advert(?:s)?|sponsor(?:ed)?|promo(?:tion)?');
    const advertising = Boolean(meta.adRegion || meta.sponsored || (meta.externalLink && adWords));
    const supportCta = token(text, 'support(?:[-_ ]?(?:us|me|site|creator|project))?|donat(?:e|ion|ions)?|tip[-_ ]?(?:jar|us|me)?|patreon|ko[-_ ]?fi|buy[-_ ]?me[-_ ]?a[-_ ]?coffee|membership|supporter');
    const commerceCta = token(text, 'subscribe[-_ ]?now|join[-_ ]?now|become[-_ ]?(?:a[-_ ]?)?(?:member|supporter)|shop[-_ ]?now');

    if (placeholder) addChrome(100, 'placeholder');
    if (advertising) addChrome(100, 'advertising');
    if (named) addChrome(96, 'brand-or-icon');
    if (serviceIcon) addChrome(94, 'service-icon');
    if (badge) addChrome(88, 'badge');
    if (controlIcon) addChrome(92, 'control-icon');
    if (meta.uiRegion) addChrome(86, 'ui-region');
    if ((supportCta || commerceCta) && kind !== 'reader') addChrome(meta.externalLink ? 92 : 80, supportCta ? 'support-cta' : 'commerce-cta');
    if (adWords && kind !== 'reader') addChrome(meta.externalLink ? 90 : 55, 'promo-asset');
    if (kind === 'reader') contentScore = Math.max(contentScore, 92);
    if (kind === 'main' && !meta.uiRegion) contentScore = Math.max(contentScore, 68);
    chromeScore = clamp(chromeScore);
    contentScore = clamp(contentScore);
    const chrome = chromeScore >= 70;
    const promo = !advertising && !placeholder && (supportCta || commerceCta || (adWords && kind !== 'reader'));
    const category = placeholder ? 'placeholder' : advertising ? 'ad' : promo && chrome ? 'promo' :
      (named || serviceIcon || badge || controlIcon) && chrome ? 'icon' : meta.uiRegion && chrome ? 'ui' : 'content';
    const reasonBase = category === 'placeholder' ? 'ชื่อไฟล์หรือบริบทระบุภาพรอโหลด/ตัวคั่น/หน้าปิดตัวอย่าง' :
      category === 'ad' ? 'บริเวณโฆษณา สปอนเซอร์ หรือแบนเนอร์โปรโมต' :
      category === 'promo' ? 'ชื่อไฟล์/บริบทสื่อถึงภาพสนับสนุน บริจาค สมัครสมาชิก หรือ CTA ของเว็บไซต์' :
      category === 'icon' ? 'โลโก้/ไอคอนบริการ/ป้าย หรือรูปเล็กในปุ่มควบคุม' :
      category === 'ui' ? 'อยู่ในส่วนเมนู คอมเมนต์ แถบเครื่องมือ หรือส่วนประกอบเว็บ' :
      kind === 'reader' ? 'อยู่ในบริเวณตัวอ่าน/กลุ่มภาพตัวอย่างหนังสือ' : kind === 'main' ? 'อยู่ในเนื้อหาหลักของหน้า' : 'ยังระบุบริเวณเนื้อหาไม่ได้';
    const reason = chrome ? `${reasonBase} • คะแนนคัดออก ${chromeScore}/100` : reasonBase;
    return { chrome, placeholder, category, mainKind: kind, reason, chromeScore, contentScore, signals };
  }
  function mainScope(items) {
    const kinds = new Set(items.filter(x => !x.filterHints?.chrome).map(x => x.filterHints?.mainKind));
    return kinds.has('reader') ? 'reader' : kinds.has('main') ? 'main' : 'unknown';
  }
  function matches(item, options = {}) {
    const hints = item.filterHints || {};
    if (options.hideChrome && hints.chrome) return false;
    if (options.hideBlank && item.pixelHints?.blank === true) return false;
    if (options.mainOnly) {
      if (hints.chrome) return false;
      if (options.mainScope && options.mainScope !== 'unknown' && hints.mainKind !== options.mainScope) return false;
    }
    if (options.source && options.source !== 'all' && item.source !== options.source) return false;
    if ((item.width || 0) < (options.minWidth || 0) || (item.height || 0) < (options.minHeight || 0)) return false;
    const text = String(options.search || '').trim().toLocaleLowerCase();
    return !text || `${item.label || ''} ${item.url || ''} ${item.alt || ''}`.toLocaleLowerCase().includes(text);
  }
  // Conservative sampled-pixel check; any appreciable mark keeps the image.
  // A real blank book page is still content, so this is a separate opt-in filter.
  function inspectPixels(rgba) {
    if (!rgba || rgba.length < 16 || rgba.length % 4) return { checked: true, blank: false, unknown: true };
    const lo = [255,255,255], hi = [0,0,0];
    for (let i=0; i<rgba.length; i+=4) {
      const alpha = rgba[i+3] / 255;
      for (let c=0; c<3; c++) {
        const v = Math.round(rgba[i+c]*alpha + 255*(1-alpha));
        lo[c] = Math.min(lo[c],v); hi[c] = Math.max(hi[c],v);
      }
      if (hi.some((v,c)=>v-lo[c]>2)) return {checked:true,blank:false};
    }
    return {checked:true,blank:true,reason:'พิกเซลตัวอย่างเป็นสีล้วน/โปร่งใส — อาจเป็นหน้าว่างของหนังสือ'};
  }
  return Object.freeze({ classify, mainScope, matches, inspectPixels });
});
