'use strict';
const { _electron: electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const sharp = require('sharp');
const root = path.resolve(__dirname, '..');
let app, server;

(async () => {
  const icon = await sharp({
    create: { width: 32, height: 32, channels: 4, background: '#42c8a8' },
  })
    .png()
    .toBuffer();
  const icoHeader = Buffer.alloc(22);
  icoHeader.writeUInt16LE(1, 2);
  icoHeader.writeUInt16LE(1, 4);
  icoHeader[6] = icoHeader[7] = 32;
  icoHeader.writeUInt16LE(1, 10);
  icoHeader.writeUInt16LE(32, 12);
  icoHeader.writeUInt32LE(icon.length, 14);
  icoHeader.writeUInt32LE(22, 18);
  const ico = Buffer.concat([icoHeader, icon]);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="6" fill="#ee6688"/></svg>';
  server = http.createServer((req, res) => {
    if (req.url === '/icon.png') {
      res.setHeader('Content-Type', 'image/png');
      res.end(icon);
    } else if (req.url === '/icon.svg') {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.end(svg);
    } else if (req.url === '/icon.ico') {
      res.setHeader('Content-Type', 'image/x-icon');
      res.end(ico);
    } else if (req.url === '/broken.png') {
      res.writeHead(404);
      res.end();
    } else {
      const kind = req.url.includes('ico')
        ? 'ico'
        : req.url.includes('svg')
          ? 'svg'
          : req.url.includes('broken')
            ? 'broken'
            : 'png';
      const href = req.url.includes('data')
        ? 'data:image/png;base64,' + icon.toString('base64')
        : kind === 'broken'
          ? '/broken.png'
          : '/icon.' + kind;
      res.setHeader('Content-Type', 'text/html');
      res.end(
        `<title>Website ${req.url}</title><link rel="icon" href="${href}"><h1>Tab fixture</h1>`,
      );
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const output = path.join(root, 'test-results');
  await fs.mkdir(output, { recursive: true });
  const profile = await fs.mkdtemp(path.join(output, 'harvest-tabs-'));
  const env = { ...process.env, EIW_TEST_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [root, '--eiw-test'], env, timeout: 45000 });
  const page = await app.firstWindow(),
    errors = [];
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setMinimumSize(600, 450),
  );
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => document.getElementById('appVersion').textContent !== '—');
  await page.evaluate(() => window.eiw.harvestTsAdblockSet({ enabled: false }));
  const created = await page.evaluate((url) => window.eiw.harvestTsCreate({ url }), base + '/png');
  assert.equal(created.ok, true);
  const id = created.data.activeId;
  await page.evaluate(() => document.getElementById('harvestTsNav').click());
  const iconSelector = `[data-tab-id="${id}"] .harvest-tab-favicon`;
  await page.waitForFunction((selector) => {
    const image = document.querySelector(selector);
    return image?.complete && image.naturalWidth > 0;
  }, iconSelector);
  const first = await page.locator(iconSelector).getAttribute('src');
  assert.match(first, /^data:image\/png;base64,/);
  for (const kind of ['ico', 'data']) {
    await page.evaluate(({ id, url }) => window.eiw.harvestTsNavigate({ id, url }), {
      id,
      url: base + '/' + kind,
    });
    await page.waitForFunction(
      async ({ id, kind }) => {
        const state = await window.eiw.harvestTsState(),
          tab = state.data.tabs.find((tab) => tab.id === id);
        const image = document.querySelector(`[data-tab-id="${id}"] img`);
        return (
          tab?.url.endsWith('/' + kind) && !tab.loading && tab.favicon && image?.naturalWidth > 0
        );
      },
      { id, kind },
    );
  }
  await page.evaluate(({ id, url }) => window.eiw.harvestTsNavigate({ id, url }), {
    id,
    url: base + '/svg',
  });
  await page.waitForFunction(
    ({ selector, first }) => {
      const image = document.querySelector(selector);
      return image?.complete && image.naturalWidth > 0 && image.src !== first;
    },
    { selector: iconSelector, first },
  );
  await page.evaluate(({ id, url }) => window.eiw.harvestTsNavigate({ id, url }), {
    id,
    url: base + '/broken',
  });
  await page.waitForFunction((id) => {
    const tab = document.querySelector(`[data-tab-id="${id}"]`);
    return (
      !tab.querySelector('.harvest-tab-icon.loading') &&
      !tab.querySelector('img') &&
      !tab.querySelector('.harvest-tab-fallback').hidden
    );
  }, id);
  await page.evaluate(({ id, url }) => window.eiw.harvestTsNavigate({ id, url }), {
    id,
    url: base + '/png',
  });
  await page.waitForFunction(
    (selector) => document.querySelector(selector)?.naturalWidth > 0,
    iconSelector,
  );
  const counts = [1, 8, 25];
  for (const count of counts) {
    await page.evaluate(
      async ({ count, base }) => {
        const state = await window.eiw.harvestTsState();
        for (let i = state.data.tabs.length; i < count; i++)
          await window.eiw.harvestTsCreate({ url: base + '/png?tab=' + i, activate: false });
      },
      { count, base },
    );
    await page.waitForFunction(
      (count) => document.querySelectorAll('.harvest-browser-tab').length === count,
      count,
    );
    for (const width of [1685, 1050, 760]) {
      await app.evaluate(
        ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 800),
        width,
      );
      await page.waitForFunction(
        (width) =>
          Math.abs(window.outerWidth - width) < 4 &&
          window.innerWidth >= width - 25 &&
          window.innerWidth <= width,
        width,
      );
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      const layout = await page.evaluate(() => {
        const host = document.getElementById('harvestTabs'),
          box = host.getBoundingClientRect();
        const tabs = [...host.children].map((tab) => {
          const rect = tab.getBoundingClientRect(),
            icon = tab.querySelector('.harvest-tab-icon').getBoundingClientRect();
          return { left: rect.left, right: rect.right, width: rect.width, iconWidth: icon.width };
        });
        return {
          client: host.clientWidth,
          scroll: host.scrollWidth,
          left: box.left,
          right: box.right,
          newTab: document.getElementById('harvestNewTab').getBoundingClientRect().right,
          newTabLeft: document.getElementById('harvestNewTab').getBoundingClientRect().left,
          viewport: window.innerWidth,
          tabs,
        };
      });
      assert.ok(
        layout.scroll <= layout.client + 1,
        `${count} tabs at ${width}: horizontal overflow`,
      );
      assert.ok(
        layout.newTab <= layout.viewport,
        'New tab remains visible: ' + JSON.stringify(layout),
      );
      const newTabGap = layout.newTabLeft - layout.tabs.at(-1).right;
      assert.ok(
        newTabGap >= 7 && newTabGap <= 9,
        `${count} tabs at ${width}: + must follow the last tab; gap=${newTabGap}`,
      );
      for (const tab of layout.tabs) {
        assert.ok(tab.left >= layout.left - 1 && tab.right <= layout.right + 1);
        assert.ok(tab.iconWidth > 0 && tab.width > 0);
      }
      console.log(
        `PASS: ${count} tabs fit ${width}px; tab width ${layout.tabs[0].width.toFixed(1)}px`,
      );
      if (count === 1 && width === 1685)
        await page.screenshot({ path: path.join(output, 'harvest-tabs-plus-adjacent.png') });
    }
  }
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.harvest-tab-favicon')].every(
      (image) => image.complete && image.naturalWidth > 0,
    ),
  );
  await page.locator('.harvest-tab-main').last().click();
  await page.waitForFunction(() =>
    document.querySelector('.harvest-browser-tab:last-child').classList.contains('active'),
  );
  await page.locator('.harvest-tab-main').last().click({ button: 'middle' });
  await page.waitForFunction(() => document.querySelectorAll('.harvest-browser-tab').length === 24);
  await page.screenshot({ path: path.join(output, 'harvest-tabs-compact.png') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1685, 800));
  await page.waitForFunction(() => window.outerWidth > 1600);
  await page.screenshot({ path: path.join(output, 'harvest-tabs-wide.png') });
  assert.deepEqual(errors, []);
  console.log(
    'PASS: PNG/SVG/ICO/data favicons, fallback after navigation, compact tab selection and middle-click close',
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
