'use strict';
const { _electron: electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const sharp = require('sharp');
const root = path.resolve(__dirname, '..');
let app,
  server,
  page,
  historyId,
  faviconRequests = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function historyJS(code) {
  return app.evaluate(
    ({ webContents }, { id, code }) => webContents.fromId(id).executeJavaScript(code),
    { id: historyId, code },
  );
}
async function waitFor(code) {
  for (let i = 0; i < 100; i++) {
    if (await historyJS(code)) return;
    await sleep(100);
  }
  throw new Error('History condition timed out: ' + code);
}
(async () => {
  const icon = await sharp({
    create: { width: 32, height: 32, channels: 4, background: '#40bba0' },
  })
    .png()
    .toBuffer();
  server = http.createServer((req, res) => {
    if (req.url === '/favicon.ico') {
      faviconRequests++;
      res.setHeader('Content-Type', 'image/png');
      res.end(icon);
    } else if (req.url === '/custom.svg') {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="15" fill="#d783ee"/></svg>',
      );
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<title>Fresh website</title><link rel="icon" href="/custom.svg"><h1>History fixture</h1>',
      );
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const output = path.join(root, 'test-results');
  const profile = await fs.mkdtemp(path.join(output, 'history-favicons-'));
  await fs.mkdir(path.join(profile, 'harvestts'));
  await fs.writeFile(
    path.join(profile, 'harvestts', 'history.json'),
    JSON.stringify({
      version: 1,
      items: Array.from({ length: 20 }, (_, i) => ({
        id: 'old-' + i,
        url: base + '/chapter/' + i,
        title: 'Chapter ' + i + ' — Manga website with a long chapter title',
        visitedAt: Date.now() - i * 60000,
      })),
    }),
  );
  const launch = async () => {
    const env = { ...process.env, EIW_TEST_USER_DATA: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ args: [root, '--eiw-test'], env, timeout: 45000 });
    page = await app.firstWindow();
    await page.waitForFunction(() => document.getElementById('appVersion').textContent !== '—');
    await page.evaluate(() => window.eiw.harvestTsAdblockSet({ enabled: false }));
    const opened = await page.evaluate(() => window.eiw.harvestTsOpenHistory());
    assert.equal(opened.ok, true);
    await page.evaluate(() => document.getElementById('harvestTsNav').click());
    historyId = null;
    for (let i = 0; i < 100 && !historyId; i++) {
      historyId = await app.evaluate(
        ({ webContents }) =>
          webContents.getAllWebContents().find((wc) => wc.getURL().endsWith('/history.html'))?.id,
      );
      if (!historyId) await sleep(100);
    }
    assert.ok(historyId);
    await waitFor("document.querySelectorAll('.history-row').length === 20");
    await waitFor(
      "[...document.querySelectorAll('.history-icon img')].filter(x=>x.complete && x.naturalWidth>0).length === 20",
    );
  };
  await launch();
  assert.equal(faviconRequests, 1, 'Legacy rows share one request per site');
  const heights = await historyJS(
    "[...document.querySelectorAll('.history-row')].map(x=>x.getBoundingClientRect().height)",
  );
  assert.ok(
    heights.every((height) => height <= 48),
    JSON.stringify(heights),
  );
  await historyJS(
    "document.getElementById('historySearch').value='Chapter 19'; document.getElementById('historySearch').dispatchEvent(new Event('input'))",
  );
  await waitFor(
    "document.querySelectorAll('.history-row').length === 1 && document.querySelector('.history-icon img').naturalWidth > 0",
  );
  const forbidden = await historyJS(
    "window.harvestInternal.historyFavicons({urls:['https://example.invalid/']})",
  );
  assert.deepEqual(forbidden.icons, {});
  await historyJS(
    "document.getElementById('historySearch').value=''; document.getElementById('historySearch').dispatchEvent(new Event('input'))",
  );
  const png = await app.evaluate(
    ({ webContents }, id) =>
      webContents
        .fromId(id)
        .capturePage()
        .then((image) => image.toPNG().toString('base64')),
    historyId,
  );
  await fs.writeFile(path.join(output, 'history-compact-logos.png'), Buffer.from(png, 'base64'));
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setMinimumSize(600, 450);
    window.setSize(760, 800);
  });
  await waitFor('window.innerWidth < 720');
  assert.equal(
    await historyJS('document.documentElement.scrollWidth <= document.documentElement.clientWidth'),
    true,
  );
  assert.equal(
    await historyJS("getComputedStyle(document.querySelector('.history-time')).display !== 'none'"),
    true,
  );
  const narrow = await app.evaluate(
    ({ webContents }, id) =>
      webContents
        .fromId(id)
        .capturePage()
        .then((image) => image.toPNG().toString('base64')),
    historyId,
  );
  await fs.writeFile(
    path.join(output, 'history-compact-logos-narrow.png'),
    Buffer.from(narrow, 'base64'),
  );
  await app.close();
  app = null;
  await launch();
  assert.equal(faviconRequests, 1, 'Favicon cache survives relaunch');
  await historyJS('document.querySelector(\'[data-history-id="old-0"] .remove\').click()');
  await waitFor("document.querySelectorAll('.history-row').length === 19");
  const oldFavicon = (await page.evaluate(() => window.eiw.harvestTsHistoryList())).data.items[0]
    .favicon;
  await page.evaluate((url) => window.eiw.harvestTsCreate({ url }), base + '/fresh');
  let fresh;
  for (let i = 0; i < 100; i++) {
    fresh = await page.evaluate(() => window.eiw.harvestTsHistoryList({ limit: 1000 }));
    const item = fresh.data.items.find((item) => item.url.endsWith('/fresh'));
    if (item?.favicon && item.favicon !== oldFavicon) break;
    await sleep(100);
  }
  assert.ok(
    fresh.data.items.find((item) => item.url.endsWith('/fresh'))?.favicon,
    JSON.stringify(
      fresh.data.items.map((item) => ({ url: item.url, favicon: Boolean(item.favicon) })),
    ),
  );
  assert.notEqual(fresh.data.items.find((item) => item.url.endsWith('/fresh')).favicon, oldFavicon);
  assert.equal(
    fresh.data.items.some((item) => item.id === 'old-0'),
    false,
  );
  console.log(
    'PASS: legacy history logos, one request per site, compact rows, search/delete, persistent cache and visited-page icons',
  );
})()
  .catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await app?.close().catch(() => {});
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
