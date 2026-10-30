'use strict';
// Registered for every frame, including image readers and cross-origin embeds.
const { ipcRenderer } = require('electron');
let lastWheelAt = 0;
addEventListener(
  'wheel',
  (event) => {
    if (!event.isTrusted || !event.ctrlKey || !event.deltaY) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const now = Date.now();
    if (now - lastWheelAt < 90) return;
    lastWheelAt = now;
    ipcRenderer
      .invoke('harvest-guest:zoom', { direction: event.deltaY < 0 ? 1 : -1, wheel: true })
      .catch(() => {});
  },
  { capture: true, passive: false },
);

// A trusted link click authorizes that destination, rather than arbitrary
// window.open calls piggybacked onto a click elsewhere in the reader.
function rememberLink(event) {
  if (!event.isTrusted || event.button > 1) return;
  const link = event.composedPath().find((node) => node?.matches?.('a[href],area[href]'));
  if (!link || !/^https?:\/\//i.test(link.href || '')) return;
  ipcRenderer.send('harvest-guest:link-intent', { url: link.href });
}
addEventListener('pointerdown', rememberLink, { capture: true });
addEventListener('click', rememberLink, { capture: true });
addEventListener('auxclick', rememberLink, { capture: true });
