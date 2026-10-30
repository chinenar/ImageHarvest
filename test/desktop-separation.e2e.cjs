'use strict';
const { _electron: electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
let app, server;

(async () => {
  const image = await fs.readFile(path.join(__dirname, 'fixtures', 'first.png'));
  server = http.createServer((req, res) => {
    if (req.url === '/page.png') {
      res.setHeader('Content-Type', 'image/png');
      res.end(image);
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<title>Feature separation</title><main class="manga-reader"><img src="/page.png" width="420" height="560"></main>',
      );
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/chapter`;
  const output = path.join(root, 'test-results');
  await fs.mkdir(output, { recursive: true });
  const profile = await fs.mkdtemp(path.join(output, 'desktop-separation-'));
  const env = { ...process.env, EIW_TEST_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [root, '--eiw-test'], env, timeout: 45000 });
  const page = await app.firstWindow();
  const uiErrors = [];
  page.on('pageerror', (error) => uiErrors.push(error.message));
  await page.waitForFunction(() => document.getElementById('appVersion').textContent !== '—');
  const settings = await page.evaluate(() => window.eiw.settings());
  assert.equal(settings.ok, true);
  assert.equal(
    (await page.evaluate(() => window.eiw.harvestTsAdblockSet({ enabled: false }))).ok,
    true,
  );
  const created = await page.evaluate(
    (url) => window.eiw.harvestTsCreate({ url, activate: true }),
    url,
  );
  assert.equal(created.ok, true);
  const harvestId = created.data.activeId;
  await page.evaluate(() => document.getElementById('harvestTsNav').click());
  await page.waitForFunction(() => !document.getElementById('harvestSendToCollector').disabled);
  await page.evaluate(() => {
    document.getElementById('browserMode').value = 'electron';
    document.getElementById('harvestSendToCollector').click();
  });
  await page.waitForFunction(
    () =>
      document
        .getElementById('status')
        .textContent.includes('ส่งจาก HarvestTS มา ImageHarvest แล้ว'),
    null,
    { timeout: 45000 },
  );
  assert.equal(await page.inputValue('#url'), url);
  const scanned = await page.evaluate(() => window.eiw.scan({ waitMs: 50, maxSteps: 3 }));
  assert.equal(scanned.ok, true);
  assert.equal(scanned.data.items.length, 1);
  await page.evaluate(() => window.eiw.workspaceSwitch({ id: 'tab-2' }));
  assert.equal(await app.evaluate(() => global.__eiwTest.getState().count), 0);
  const harvest = await page.evaluate(() => window.eiw.harvestTsState());
  assert.equal(harvest.data.activeId, harvestId);
  assert.equal(harvest.data.tabs.find((t) => t.id === harvestId).url, url);
  await page.evaluate(() => window.eiw.workspaceSwitch({ id: 'tab-1' }));
  assert.equal(await app.evaluate(() => global.__eiwTest.getState().count), 1);
  const acquired = await app.evaluate(() => global.__eiwTest.harvestTranslationAcquireFirst());
  assert.equal(acquired.bytes, image.length);
  assert.deepEqual(uiErrors, []);
  console.log(
    'PASS: separate Collector and HarvestTS state, UI handoff, scan, workspace restore and translation image acquisition',
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
