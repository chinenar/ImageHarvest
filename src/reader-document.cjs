'use strict';
// Share this exact function between main and the injected reader overlay.
// Only a verified reader route can ignore its page-position suffix. Do not
// strip arbitrary numeric paths or queries: these can identify other chapters.
function readerDocumentKey(value) {
  try {
    const u = new URL(value);
    const chapter = /^(?:www\.)?mangadex\.org$/i.test(u.hostname)
      && u.pathname.match(/^\/chapter\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/\d+)?\/?$/i);
    if (chapter) return u.origin + '/chapter/' + chapter[1].toLowerCase() + u.search;
    return u.origin + u.pathname + u.search + u.hash;
  } catch { return String(value || ''); }
}
function sameReaderDocument(a, b) { return readerDocumentKey(a) === readerDocumentKey(b); }
module.exports = { readerDocumentKey, sameReaderDocument };
