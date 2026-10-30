'use strict';
const $ = (id) => document.getElementById(id);
let all = [],
  loadingIcons = false;
const icons = new Map(),
  attempted = new Set(),
  queued = new Set();
const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
};
const time = (ms) => {
  try {
    return new Date(Number(ms) || Date.now()).toLocaleString('th-TH', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return '';
  }
};
function paintIcon(host, data) {
  host.replaceChildren();
  const fallback = document.createElement('span');
  fallback.textContent = '◎';
  host.append(fallback);
  if (!data) return;
  const image = document.createElement('img');
  image.alt = '';
  image.addEventListener('load', () => {
    fallback.hidden = true;
  });
  image.addEventListener('error', () => {
    image.remove();
    fallback.hidden = false;
  });
  image.src = data;
  host.append(image);
}
async function loadQueuedIcons() {
  if (loadingIcons) return;
  loadingIcons = true;
  try {
    while (queued.size) {
      const urls = [...queued].slice(0, 16);
      for (const url of urls) {
        queued.delete(url);
        attempted.add(url);
      }
      const result = await window.harvestInternal
        .historyFavicons({ urls })
        .catch(() => ({ icons: {} }));
      for (const [origin, data] of Object.entries(result.icons || {})) {
        if (!data) continue;
        icons.set(origin, data);
        for (const host of document.querySelectorAll('.history-icon'))
          if (host.dataset.origin === origin) paintIcon(host, data);
      }
    }
  } finally {
    loadingIcons = false;
  }
}
const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      const origin = entry.target.dataset.origin;
      if (origin && !icons.has(origin) && !attempted.has(origin)) queued.add(origin);
    }
    loadQueuedIcons();
  },
  { rootMargin: '150px' },
);
function render() {
  observer.disconnect();
  const q = $('historySearch').value.trim().toLowerCase();
  const items = !q
    ? all
    : all.filter((x) => ((x.title || '') + ' ' + (x.url || '')).toLowerCase().includes(q));
  $('historyMeta').textContent = (q ? 'ผลการค้นหา ' : '') + items.length + ' รายการ';
  $('clearHistory').disabled = !all.length;
  if (!items.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = q ? 'ไม่พบประวัติที่ตรงกับคำค้น' : 'ยังไม่มีประวัติการเข้าเว็บ';
    $('historyList').replaceChildren(e);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const row = document.createElement('article');
    row.className = 'history-row';
    row.dataset.historyId = item.id;
    const icon = document.createElement('div');
    icon.className = 'history-icon';
    icon.dataset.origin = originOf(item.url);
    icon.setAttribute('aria-hidden', 'true');
    paintIcon(icon, icons.get(icon.dataset.origin) || item.favicon);
    const main = document.createElement('div');
    main.className = 'history-main';
    const title = document.createElement('div');
    title.className = 'history-title';
    title.textContent = item.title || item.url;
    title.title = title.textContent;
    const meta = document.createElement('div');
    meta.className = 'history-details';
    const url = document.createElement('span');
    url.className = 'history-url';
    url.textContent = item.url;
    url.title = item.url;
    const stamp = document.createElement('time');
    stamp.className = 'history-time';
    stamp.textContent = time(item.visitedAt);
    meta.append(url, stamp);
    main.append(title, meta);
    const actions = document.createElement('div');
    actions.className = 'history-actions';
    const open = document.createElement('button');
    open.className = 'open';
    open.textContent = 'เปิด';
    open.type = 'button';
    open.title = 'เปิด ' + (item.title || item.url);
    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.textContent = 'ลบ';
    remove.type = 'button';
    remove.title = 'ลบรายการนี้จากประวัติ';
    open.addEventListener('click', () => window.harvestInternal.openUrl(item.url));
    remove.addEventListener('click', async () => {
      await window.harvestInternal.historyRemove(item.id);
      await refresh();
    });
    actions.append(open, remove);
    row.append(icon, main, actions);
    fragment.append(row);
  }
  $('historyList').replaceChildren(fragment);
  for (const host of document.querySelectorAll('.history-icon')) observer.observe(host);
}
async function refresh() {
  const [history, settings] = await Promise.all([
    window.harvestInternal.historyList({ limit: 1000 }),
    window.harvestInternal.historySettings(),
  ]);
  all = history?.data?.items || history.items || [];
  for (const item of all) if (item.favicon) icons.set(originOf(item.url), item.favicon);
  const s = settings?.data || settings || {};
  $('historyEnabled').checked = s.historyEnabled !== false;
  render();
}
$('historySearch').addEventListener('input', render);
$('historyEnabled').addEventListener('change', async () => {
  await window.harvestInternal.historySetEnabled($('historyEnabled').checked);
  await refresh();
});
$('clearHistory').addEventListener('click', async () => {
  await window.harvestInternal.historyClear();
  await refresh();
});
refresh();
