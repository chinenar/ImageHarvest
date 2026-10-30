'use strict';
const { _electron: electron } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
let app, server;

(async () => {
  server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      '<title>Launcher zoom</title><style>body{margin:0;background:white}main{height:1500px}</style><main>HarvestTS zoom fixture</main>',
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/chapter`;
  const output = path.join(root, 'test-results', 'launcher-zoom');
  await fs.mkdir(output, { recursive: true });
  const profile = await fs.mkdtemp(path.join(output, 'profile-'));
  const env = { ...process.env, EIW_TEST_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    ...(env.EIW_OCR_EXE ? { executablePath: env.EIW_OCR_EXE } : {}),
    args: env.EIW_OCR_EXE ? ['--eiw-test'] : [root, '--eiw-test'],
    env,
    timeout: 45000,
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!window.eiw);
  await page.evaluate(() => window.eiw.harvestTsAdblockSet({ enabled: false }));
  await page.evaluate(() =>
    window.eiw.harvestTsLayout({
      visible: true,
      bounds: { x: 0, y: 100, width: 900, height: 700 },
    }),
  );
  const created = await page.evaluate(
    (url) => window.eiw.harvestTsCreate({ url, activate: true }),
    url,
  );
  assert.equal(created.ok, true);
  const id = created.data.activeId;
  const metrics = () =>
    app.evaluate(async ({ webContents }, url) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL() === url);
      if (!wc) return null;
      const zoom = wc.getZoomFactor();
      const rect = await wc.executeJavaScript(`(() => {
      const host = document.getElementById('__harvestts_manga_translate__');
      if (!host) return null;
      const r = host.getBoundingClientRect();
      return { width:r.width, height:r.height, left:r.left, top:r.top, right:r.right, bottom:r.bottom, viewportWidth:innerWidth, viewportHeight:innerHeight, uiZoom:Number(host.style.zoom) || 1 };
    })()`);
      return rect ? { ...rect, zoom } : null;
    }, url);
  async function stableMetrics() {
    for (let n = 0; n < 100; n++) {
      const result = await metrics();
      if (result && Math.abs(result.uiZoom * result.zoom - 1) < 0.001) return result;
      await page.waitForTimeout(50);
    }
    throw Error('Launcher did not compensate for page zoom');
  }
  const results = [];
  async function check() {
    const r = await stableMetrics();
    assert.ok(Math.abs(r.width * r.zoom - 54) < 1, JSON.stringify(r));
    assert.ok(Math.abs(r.height * r.zoom - 54) < 1, JSON.stringify(r));
    assert.ok(
      r.left >= 0 && r.top >= 0 && r.right <= r.viewportWidth && r.bottom <= r.viewportHeight,
      JSON.stringify(r),
    );
    results.push(r);
  }
  await check();
  for (const action of [...Array(5).fill('zoom-out'), ...Array(12).fill('zoom-in')]) {
    assert.equal(
      (
        await page.evaluate(({ id, action }) => window.eiw.harvestTsAction({ id, action }), {
          id,
          action,
        })
      ).ok,
      true,
    );
    await check();
  }
  // A navigation restores saved 300% zoom before the preload initializes.
  await page.evaluate((id) => window.eiw.harvestTsAction({ id, action: 'reload' }), id);
  await page.waitForTimeout(250);
  await check();
  for (const [width, height] of [
    [390, 480],
    [640, 280],
    [900, 700],
  ]) {
    await page.evaluate(
      ({ width, height }) =>
        window.eiw.harvestTsLayout({ visible: true, bounds: { x: 0, y: 100, width, height } }),
      { width, height },
    );
    await page.waitForTimeout(100);
    await check();
  }
  const screenshot = await app.evaluate(async ({ webContents }, url) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL() === url);
    return (await wc.capturePage()).toPNG().toString('base64');
  }, url);
  await fs.writeFile(path.join(output, 'zoom-300.png'), Buffer.from(screenshot, 'base64'));
  await fs.writeFile(path.join(output, 'geometry.json'), JSON.stringify(results, null, 2));
  console.log('PASS: fixed 54 DIP launcher at 50%-300% page zoom, resize and reload at saved zoom');
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await app?.close().catch(() => {});
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
