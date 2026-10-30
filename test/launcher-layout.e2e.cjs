'use strict';
const { chromium } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const source = await fs.readFile(
    path.join(__dirname, '../src/harvest-guest-preload.cjs'),
    'utf8',
  );
  const launcherCode = source.slice(
    source.indexOf('function ensureTranslationLauncher()'),
    source.indexOf('function handleTranslationProgress('),
  );
  const symbol =
    'data:image/png;base64,' +
    (await fs.readFile(path.join(__dirname, '../assets/translate-symbol.png'))).toString('base64');
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<style>body{margin:0;background:#181921;color:white;font:16px sans-serif}main{height:100vh;display:grid;place-content:center}</style><main>HarvestTS</main>',
    );
    await page.evaluate(
      `(() => {` +
        launcherCode +
        `
      let translationHost, translationShadow, launcherMenuOpen=false, translateSymbolDataUrl=${JSON.stringify(symbol)}, refreshTranslationLauncherZoom;
      let translateSettings={engine:'ai',sourceLanguage:'auto',targetLanguage:'th',contentType:'manga',fontScale:1};
      let screenLensState={},translationPages=[],translationModelText='',translationScanProgress=0,translationRunning=false;
      let testPageZoom=1;
      const ipcRenderer={invoke:async channel=>channel==='harvest-guest:zoom-factor'?testPageZoom:null};
      ensureTranslationLauncher();
      window.launcherTest={host:translationHost,shadow:translationShadow,setZoom:async factor=>{testPageZoom=factor;await refreshTranslationLauncherZoom();}};
    })()`,
    );
    const geometry = () =>
      page.evaluate(() => {
        const { host, shadow } = launcherTest;
        const rect = (el) => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        };
        return {
          host: rect(host),
          logo: rect(shadow.querySelector('.launcher img')),
          buttons: [...shadow.querySelectorAll('.toolbtn')].map(rect),
        };
      });
    const toggle = () =>
      page.evaluate(() => {
        const button = launcherTest.shadow.querySelector('.launcher');
        button.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1 }));
        button.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 1 }));
        launcherTest.shadow.querySelector('.quickmenu').classList.remove('opening');
      });
    for (const [width, height] of [
      [1124, 765],
      [900, 700],
      [390, 844],
      [320, 480],
      [640, 280],
    ]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(50);
      for (const [x, y] of [
        [0, 0],
        [0.5, 0],
        [1, 0],
        [0, 0.5],
        [0.5, 0.5],
        [1, 0.5],
        [0, 1],
        [0.5, 1],
        [1, 1],
      ]) {
        await page.evaluate(
          ({ x, y }) => {
            const { host } = launcherTest,
              r = host.getBoundingClientRect();
            Object.assign(host.style, {
              left: 8 + x * (innerWidth - r.width - 16) + 'px',
              top: 8 + y * (innerHeight - r.height - 16) + 'px',
              right: 'auto',
              bottom: 'auto',
            });
          },
          { x, y },
        );
        const before = (await geometry()).host;
        await toggle();
        const result = await geometry();
        assert.equal(result.host.w, 54, 'logo size must stay fixed across window sizes');
        assert.ok(Math.abs(result.logo.w - result.logo.h) < 0.1, 'logo must stay square');
        assert.ok(
          result.logo.w <= result.host.w && result.logo.h <= result.host.h,
          'logo must fit the button',
        );
        assert.deepEqual(result.host, before, 'opening must keep the launcher in place');
        const all = [result.host, ...result.buttons];
        for (const r of all)
          assert.ok(
            r.x >= 7.5 && r.y >= 7.5 && r.x + r.w <= width - 7.5 && r.y + r.h <= height - 7.5,
            JSON.stringify({ width, height, x, y, r }),
          );
        for (let a = 0; a < all.length; a++)
          for (let b = a + 1; b < all.length; b++) {
            const p = all[a],
              q = all[b];
            assert.ok(
              Math.hypot(p.x + p.w / 2 - q.x - q.w / 2, p.y + p.h / 2 - q.y - q.h / 2) >=
                (p.w + q.w) / 2 + 3,
              'circular buttons must have a visible gap',
            );
          }
        if (width === 1124 && x === 0 && y === 1) {
          const dir = path.resolve(__dirname, '../test-results/launcher-layout');
          await fs.mkdir(dir, { recursive: true });
          await page.screenshot({ path: path.join(dir, 'bottom-left.png') });
        }
        await toggle();
      }
    }
    // Exercise actual dragging and preserve the relative position across a resize round trip.
    await page.setViewportSize({ width: 900, height: 700 });
    await page.waitForTimeout(50);
    await page.evaluate(() =>
      Object.assign(launcherTest.host.style, { left: '600px', top: '450px' }),
    );
    await page.mouse.move(627, 477);
    await page.mouse.down();
    await page.mouse.move(327, 277, { steps: 5 });
    await page.mouse.up();
    const before = (await geometry()).host;
    await toggle();
    await page.setViewportSize({ width: 390, height: 480 });
    await page.waitForTimeout(50);
    const small = await geometry();
    assert.equal(small.host.w, before.w, 'launcher must keep its size on resize');
    for (const r of small.buttons)
      assert.ok(
        r.x >= 7.5 && r.y >= 7.5 && r.x + r.w <= 382.5 && r.y + r.h <= 472.5,
        'open menu should reflow on resize',
      );
    await page.setViewportSize({ width: 900, height: 700 });
    await page.waitForTimeout(50);
    const restored = (await geometry()).host;
    assert.ok(
      Math.abs(before.x - restored.x) < 1 && Math.abs(before.y - restored.y) < 1,
      'dragged anchor must survive resize round trip',
    );
    await page.evaluate(() => launcherTest.shadow.querySelector('.settings-tool').click());
    const panel = await page.evaluate(() => {
      const p = launcherTest.shadow.querySelector('.settings-panel'),
        r = p.getBoundingClientRect();
      return { hidden: p.hidden, x: r.x, y: r.y, right: r.right, bottom: r.bottom };
    });
    assert.equal(panel.hidden, false);
    assert.ok(panel.x >= 8 && panel.y >= 8 && panel.right <= 892 && panel.bottom <= 692);
    for (const factor of [0.5, 2, 3]) {
      await page.setViewportSize({
        width: Math.round(900 / factor),
        height: Math.round(700 / factor),
      });
      await page.waitForTimeout(50);
      await page.evaluate((factor) => launcherTest.setZoom(factor), factor);
      await page.waitForTimeout(50);
      await page.evaluate(() => {
        const { host, shadow } = launcherTest;
        Object.assign(host.style, { left: '600px', top: '450px' });
        shadow.querySelector('.close').click();
        shadow.querySelector('.settings-panel .close').click();
      });
      const before = (await geometry()).host;
      assert.ok(Math.abs(before.w * factor - 54) < 0.1, 'inverse zoom must preserve logo size');
      await page.mouse.move(before.x + before.w / 2, before.y + before.h / 2);
      await page.mouse.down();
      await page.mouse.move(
        before.x + before.w / 2 - 120 / factor,
        before.y + before.h / 2 - 80 / factor,
        { steps: 5 },
      );
      await page.mouse.up();
      const dragged = (await geometry()).host;
      assert.ok(
        Math.abs((before.x - dragged.x) * factor - 120) < 1,
        'drag must follow the pointer at page zoom: ' + JSON.stringify({ factor, before, dragged }),
      );
      assert.ok(
        Math.abs((before.y - dragged.y) * factor - 80) < 1,
        'vertical drag must follow the pointer at page zoom',
      );
      await toggle();
      for (const r of (await geometry()).buttons)
        assert.ok(
          r.x * factor >= 7.5 &&
            r.y * factor >= 7.5 &&
            (r.x + r.w) * factor <= 892.5 &&
            (r.y + r.h) * factor <= 692.5,
          'menu must fit after a zoomed drag',
        );
      await page.evaluate(() => launcherTest.shadow.querySelector('.settings-tool').click());
      const zoomedPanel = await page.evaluate(() => {
        const p = launcherTest.shadow.querySelector('.settings-panel'),
          r = p.getBoundingClientRect();
        return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width };
      });
      assert.ok(
        Math.abs(zoomedPanel.width * factor - 324) < 1,
        'settings must keep a readable width at page zoom',
      );
      assert.ok(
        zoomedPanel.x * factor >= 7.5 &&
          zoomedPanel.y * factor >= 7.5 &&
          zoomedPanel.right * factor <= 892.5 &&
          zoomedPanel.bottom * factor <= 692.5,
        'settings must fit at page zoom',
      );
    }
    console.log(
      'PASS: 45 fan layouts, fixed square logo, no launcher jump, no overlap, drag/resize round trip and settings panel',
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
