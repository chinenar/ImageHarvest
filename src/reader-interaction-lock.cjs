'use strict';
// Runs in the reader renderer. It blocks user input without changing page
// width/overflow (which would reflow images and invalidate OCR coordinates).
// The collector can still scroll programmatically during the scan phase.
function createReaderInteractionLock(documentKey) {
  const ID = '__harvestts_reader_lock__';
  const ownIds = new Set(['__harvestts_manga_translate__']);
  let token = '', host = null, frozen = false, positions = new Map(), expected = '', previousFocus = null;
  const key = typeof documentKey === 'function' ? documentKey : value => String(value);
  const own = event => event.composedPath().some(node => ownIds.has(node?.id));
  function requestCancel() {
    if (token) document.dispatchEvent(new CustomEvent('__harvestts_reader_cancel', { detail: { jobId: token } }));
  }
  function block(event) {
    if (!token || own(event)) return;
    const stopButton=event.composedPath().some(node=>node?.dataset?.action==='cancel'&&host?.shadowRoot?.contains(node));
    if(stopButton&&! ['wheel','touchmove'].includes(event.type)&&(event.type!=='keydown'||['Enter',' '].includes(event.key)))return;
    if (event.type === 'keydown' && event.key === 'Escape') requestCancel();
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
  }
  function rememberPositions() {
    positions = new Map();
    for (const el of [document.scrollingElement, ...document.querySelectorAll('*')]) {
      if (!el || el === host || host?.contains(el) || el.closest?.('#__harvestts_manga_translate__')) continue;
      if (el === document.scrollingElement || (el.clientHeight > 150 && el.scrollHeight > el.clientHeight + 3))
        positions.set(el, { left: el.scrollLeft, top: el.scrollTop });
    }
  }
  function restorePosition(event) {
    if (!token || !frozen || own(event)) return;
    if (key(location.href) !== expected) { release(token); return; }
    const el = event.target === document || event.target === window ? document.scrollingElement : event.target;
    const saved = positions.get(el);
    if (saved && (Math.abs(el.scrollTop - saved.top) > .5 || Math.abs(el.scrollLeft - saved.left) > .5))
      el.scrollTo({ top: saved.top, left: saved.left, behavior: 'instant' });
  }
  const events = ['wheel', 'touchmove', 'pointerdown', 'mousedown', 'click', 'dblclick', 'contextmenu', 'keydown'];
  function acquire(jobId) {
    if (!jobId) throw Error('Reader lock requires a job ID');
    if (token === jobId) return { locked: true, jobId: token };
    if (token) release(token);
    token = String(jobId); expected = key(location.href); frozen = false; previousFocus = document.activeElement;
    host = document.createElement('div'); host.id = ID; host.dataset.jobId = token;
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483645;pointer-events:auto;touch-action:none;background:rgba(0,0,0,.07);';
    const shadow = host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(':host{all:initial}.notice{position:absolute;top:12px;left:50%;transform:translateX(-50%);max-width:calc(100vw - 32px);display:flex;gap:12px;align-items:center;background:#171a24;color:#eef1fb;border:1px solid #555b70;border-radius:12px;padding:10px 14px;font:12px/1.5 "Segoe UI",Tahoma,sans-serif;box-shadow:0 4px 20px #0005}.copy{display:grid;gap:2px}.hint{font-size:11px;color:#aab2c8}button{font:inherit;white-space:nowrap;border:1px solid #8a779f;border-radius:7px;background:#332944;color:white;padding:7px 10px;cursor:pointer}');
    shadow.adoptedStyleSheets = [sheet];
    const notice = document.createElement('div'); notice.className = 'notice';
    const copy = document.createElement('div'); copy.className = 'copy';
    const status = document.createElement('b'); status.dataset.status = ''; status.setAttribute('role', 'status');
    status.textContent = 'ล็อกหน้าอ่านชั่วคราว • กำลังเตรียมคำแปล';
    const hint = document.createElement('span'); hint.className = 'hint'; hint.textContent = 'เสร็จแล้วเลื่อนอ่านได้ตามปกติ • กด Esc เพื่อยกเลิก';
    const stop = document.createElement('button'); stop.type = 'button'; stop.dataset.action = 'cancel'; stop.textContent = 'ยกเลิกและปลดล็อก';
    stop.addEventListener('click', requestCancel);
    copy.append(status, hint); notice.append(copy, stop); shadow.append(notice); document.documentElement.append(host);
    for (const name of events) window.addEventListener(name, block, { capture: true, passive: false });
    window.addEventListener('scroll', restorePosition, true);
    return { locked: true, jobId: token };
  }
  function freeze(jobId) {
    if (token !== jobId) return false;
    rememberPositions(); frozen = true; host.dataset.phase = 'translate'; return true;
  }
  function update(jobId, message) {
    if (token !== jobId) return;
    const status = host?.shadowRoot?.querySelector('[data-status]');
    if (status && message) status.textContent = 'ล็อกหน้าอ่าน • ' + message;
  }
  function release(jobId) {
    if (!token || (jobId && token !== jobId)) return false;
    token = ''; frozen = false; positions.clear();
    for (const name of events) window.removeEventListener(name, block, true);
    window.removeEventListener('scroll', restorePosition, true);
    host?.remove(); host = null;
    if (previousFocus?.isConnected) previousFocus.focus?.({ preventScroll: true });
    previousFocus = null; return true;
  }
  window.addEventListener('pagehide', () => release(token), { once: true });
  return { acquire, freeze, update, release, stats: () => ({ locked: Boolean(token), jobId: token, frozen }) };
}
module.exports = { createReaderInteractionLock };
