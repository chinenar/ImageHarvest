'use strict';
const { _electron: electron } = require('playwright-core');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
let app, server;
(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/frame')
      return res.end(
        '<style>body{height:2000px;margin:0}</style><script>window.addEventListener("wheel",e=>{window.__pageWheel={ctrl:e.ctrlKey,trusted:e.isTrusted,delta:e.deltaY};e.preventDefault();e.stopImmediatePropagation()},{capture:true,passive:false})</script>Frame reader',
      );
    if (req.url !== '/chapter') return res.end('<title>Reader destination</title>Chapter');
    res.end(
      '<style>body{margin:0;height:2000px}a,button{display:block;padding:15px}iframe{width:600px;height:400px}</style><a id="reader" target="_blank" href="/reader">Read chapter</a><a id="ad" target="_blank" href="https://ad.twinrengine.com/adraw?zone=test">Ad</a><button id="hijack" onclick="window.open(\'/spam\')">Reader area</button><iframe src="http://localhost:' +
        server.address().port +
        '/frame"></iframe><script>window.addEventListener("wheel",e=>{window.__pageWheel={ctrl:e.ctrlKey,trusted:e.isTrusted,delta:e.deltaY};e.preventDefault();e.stopImmediatePropagation()},{capture:true,passive:false});setTimeout(()=>window.open("/automatic"),300)</script>',
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/chapter`;
  const dir = path.join(root, 'test-results', 'harvest-input-popup');
  await fs.mkdir(dir, { recursive: true });
  const profile = await fs.mkdtemp(path.join(dir, 'profile-'));
  const env = { ...process.env, EIW_TEST_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    ...(env.EIW_OCR_EXE ? { executablePath: env.EIW_OCR_EXE } : {}),
    args: env.EIW_OCR_EXE ? ['--eiw-test'] : [root, '--eiw-test'],
    env,
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!window.eiw);
  await app.evaluate(({ app, ipcMain }) => {
    global.__preloadErrors = [];
    app.on('web-contents-created', (_e, wc) =>
      wc.on('preload-error', (_e, file, error) =>
        global.__preloadErrors.push({ file, error: error.message }),
      ),
    );
  });
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
  const tabId = created.data.activeId;
  await page.evaluate(() => document.getElementById('harvestTsNav').click());
  await page.waitForTimeout(700);
  const snapshot = () => page.evaluate(() => window.eiw.harvestTsState());
  const initial = (await snapshot()).data.tabs.length;
  assert.ok(
    (await snapshot()).data.tabs.every((t) => !t.url.endsWith('/automatic')),
    'automatic popup must not create a tab',
  );
  const wcId = await app.evaluate(
    ({ webContents }, url) => webContents.getAllWebContents().find((w) => w.getURL() === url).id,
    url,
  );
  await app.evaluate(({ BrowserWindow, webContents }, id) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win.isMinimized()) win.restore();
    win.setSize(1280, 900);
    win.show();
    win.focus();
    const wc = webContents.fromId(id);
    wc.focus();
    global.__inputEvents = [];
    wc.on('before-mouse-event', (_event, input) => global.__inputEvents.push(input));
    wc.on('zoom-changed', (_event, direction) => global.__inputEvents.push({ direction }));
  }, wcId);
  await page.waitForTimeout(1000);
  await page.evaluate((id) => window.eiw.harvestTsSwitch({ id }), tabId);
  await page.waitForTimeout(200);
  await app.evaluate(async ({ webContents }, id) => {
    const wc = webContents.fromId(id);
    wc.focus();
    await wc.capturePage();
    await wc.executeJavaScript(
      'window.__inputReady=0;addEventListener("mousemove",()=>window.__inputReady++,{passive:true})',
    );
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: 750,
      y: 400,
    });
  }, wcId);
  await page.waitForTimeout(250);
  const wheel = async (x, y, control = true) => {
    await app.evaluate(
      async ({ webContents }, { id, x, y, control }) => {
        const wc = webContents.fromId(id);
        if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
        wc.sendInputEvent({
          type: 'mouseWheel',
          x,
          y,
          deltaY: 120,
          deltaX: 0,
          wheelTicksY: 3,
          canScroll: true,
          hasPreciseScrollingDeltas: false,
          modifiers: control ? ['control'] : [],
        });
      },
      { id: wcId, x, y, control },
    );
    await page.waitForTimeout(250);
  };
  const zoom = async () => (await snapshot()).data.tabs.find((t) => t.id === tabId).zoomFactor;
  await wheel(750, 400);
  assert.equal(await zoom(), 1.1, 'Ctrl+wheel must zoom despite the page cancelling wheel events');
  await wheel(250, 320);
  assert.equal(await zoom(), 1.25, 'Ctrl+wheel must zoom inside an iframe');
  await wheel(750, 400, false);
  assert.equal(await zoom(), 1.25, 'ordinary wheel must not zoom');
  async function click(selector) {
    const point = await app.evaluate(
      async ({ webContents }, { id, selector }) =>
        webContents
          .fromId(id)
          .executeJavaScript(
            `(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
          ),
      { id: wcId, selector },
    );
    await app.evaluate(
      ({ webContents }, { id, point }) => {
        const wc = webContents.fromId(id);
        wc.focus();
        wc.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
      },
      { id: wcId, point },
    );
    await page.waitForTimeout(350);
  }
  await click('#hijack');
  assert.equal(
    (await snapshot()).data.tabs.length,
    initial,
    'click-triggered script popup must be blocked',
  );
  await click('#ad');
  assert.equal(
    (await snapshot()).data.tabs.length,
    initial,
    'known advertising destination must be blocked even on a link click',
  );
  await click('#reader');
  assert.equal(
    (await snapshot()).data.tabs.length,
    initial + 1,
    'trusted reader link must still open a tab',
  );
  const opened = (await snapshot()).data.tabs.find((t) => t.url.endsWith('/reader'));
  assert.ok(opened.url.endsWith('/reader'));
  await page.evaluate((id) => window.eiw.harvestTsClose({ id }), opened.id);
  await page.evaluate(() => window.eiw.harvestTsAdblockSet({ enabled: false }));
  await click('#hijack');
  assert.equal(
    (await snapshot()).data.tabs.length,
    initial + 1,
    'turning off adblock must honor the popup setting',
  );
  await fs.writeFile(
    path.join(dir, 'input-events.json'),
    JSON.stringify(await app.evaluate(() => global.__inputEvents), null, 2),
  );
  const frameSecurity = await app.evaluate(async ({ webContents }, id) => {
    const wc = webContents.fromId(id),
      frame = wc.mainFrame.frames[0];
    return frame.executeJavaScript(
      '({require:typeof require,process:typeof process,launcher:!!document.getElementById("__harvestts_manga_translate__")})',
    );
  }, wcId);
  assert.deepEqual(
    frameSecurity,
    { require: 'undefined', process: 'undefined', launcher: false },
    'iframe content must stay isolated from Node and main-frame tools',
  );
  assert.deepEqual(await app.evaluate(() => global.__preloadErrors), []);
  console.log(
    'PASS: native Ctrl+wheel on cancelling pages and iframes, script/ad popups blocked, explicit reader links and disabled adblock preserved',
  );
})()
  .catch(async (error) => {
    console.error(error);
    console.dir(
      await app?.evaluate(async ({ webContents, session }) => ({
        events: global.__inputEvents,
        errors: global.__preloadErrors,
        preloads: session.fromPartition('persist:harvestts').getPreloadScripts(),
        views: await Promise.all(
          webContents
            .getAllWebContents()
            .map(async (w) => ({
              url: w.getURL(),
              focused: w.isFocused(),
              dom: await w.executeJavaScript(
                '({width:innerWidth,height:innerHeight,ready:window.__inputReady,wheel:window.__pageWheel})',
              ),
            })),
        ),
      })),
      { depth: 5 },
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await app?.close().catch(() => {});
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
