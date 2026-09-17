'use strict';
const { _electron } = require('playwright-core');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const fallback = path.resolve(__dirname, '../installer-dist/win-unpacked/ImageHarvest.exe');
  const executablePath = path.resolve(process.argv[2] || fallback);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const instance = await _electron.launch({ executablePath, args: ['--eiw-test'], env });
  try {
    const page = await instance.firstWindow();
    await page.waitForFunction(() => !!window.eiw);
    const settings = await page.evaluate(() => window.eiw.settings());
    assert.equal(settings.ok, true);
    assert.equal(await page.locator('#scan').count(), 1);
    assert.equal(await page.locator('#download').count(), 1);
    assert.equal(await page.locator('#canvases').count(), 1);
    for (const id of ['removeSelected','clearResults','undoRemove','hideChrome','mainOnly','sourceFilter','browserMode','networkMode','capturePages','applyNetwork']) assert.equal(await page.locator('#'+id).count(),1);
    assert.equal(settings.data.version, require('../package.json').version);
    assert.equal(await page.locator('#siteCompatibility').count(), 1);
    assert.equal(await page.isChecked('#siteCompatibility'), false);
    assert.equal(await page.locator('#networkMode option[value="adguard"]').count(), 1);
    assert.equal(await page.locator('#reverseOrder').count(), 1);
    assert.equal(await page.locator('#renameTool').count(), 1);
    const packaged = await instance.evaluate(({ app }) => app.isPackaged);
    assert.equal(packaged, true);
    console.log('PASS: packaged Windows EXE opens, IPC works, scan/export controls present');
  } finally { await instance.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
