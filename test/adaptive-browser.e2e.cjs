'use strict';
// Isolated local-fixture prototype. Does not activate adaptive retries in the production UI.
const { chromium } = require('playwright-core');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { SiteObserver } = require('../src/site-observer.cjs');
const { SiteProfiles } = require('../src/adaptive-core.cjs');
const { AdaptiveSession } = require('../src/adaptive-session.cjs');
const { ChromeImageStore } = require('../src/chrome-image-store.cjs');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'test-results', `adaptive-prototype-${Date.now()}`);
let browser, server, imageStore, version = 1, observer;
const results = [];
(async () => {
  await fs.mkdir(directory, { recursive: true });
  const fixtures = await Promise.all(['first.png', 'second.png'].map(name => fs.readFile(path.join(__dirname, 'fixtures', name))));
  const probeSource = await fs.readFile(path.join(root, 'src/reader-probe.js'), 'utf8');
  const collectorSource = await fs.readFile(path.join(root, 'src/collector.js'), 'utf8');
  const filterSource = await fs.readFile(path.join(root, 'src/content-filter.js'), 'utf8');
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/image/')) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(fixtures[Number(url.pathname.split('/').pop()) === 2 ? 1 : 0]); return;
    }
    if (url.pathname.startsWith('/app-')) {
      res.writeHead(200, { 'Content-Type': 'application/javascript', ETag: `build-${version}` });
      res.end(`globalThis.fixtureBuild = ${version};`); return;
    }
    const cards = [1, 2].map(i => version === 3
      ? `<div class="page" style="background-image:url('/image/${i}')"></div>`
      : version === 4 ? `<img class="page" data-image-src="/image/${i}">`
      : `<img class="page" src="/image/${i}">`).join('');
    res.writeHead(version === 5 ? 403 : 200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end(`<title>Adaptive local fixture</title><style>.page{display:block;width:420px;height:560px}main{width:600px}</style><main data-total-pages="2">${version === 5 ? 'Access denied' : cards}</main><script src="/app-${version}.js"></script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/read/1`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext(), page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Page.enable');
  const { frameTree } = await cdp.send('Page.getFrameTree');
  observer = new SiteObserver(); observer.attach(cdp, frameTree.frame.id);
  imageStore = new ChromeImageStore(cdp, path.join(directory, 'responses')); await imageStore.install();
  let store = new SiteProfiles(path.join(directory, 'profiles.json')); await store.load();
  async function run(build) {
    version = build; await page.goto(url, { waitUntil: 'load' });
    const session = new AdaptiveSession({ store, url, mode: 'fixture-chrome',
      probe: () => page.evaluate(`(${probeSource})({})`),
      observation: sources => { observer.seedScripts(sources); return observer.snapshot(); } });
    const options = { backgrounds: false, canvases: false, autoScroll: false };
    await session.start(options);
    let items = [];
    if (observer.snapshot().documentStatus < 400) for (let attempt = 0; attempt < 4; attempt++) {
      const snap = await page.evaluate(`(() => { ${filterSource}\nreturn (${collectorSource})(${JSON.stringify(options)}); })()`);
      items = snap.items.map(item => ({ ...item, id: item.key }));
      await imageStore.settle();
      for (const [index, item] of items.entries()) {
        const data = await imageStore.read(item.url);
        if (!data) continue;
        const file = path.join(directory, `build-${build}-page-${index}.${data.ext}`);
        await fs.writeFile(file, data.buffer); item.capturePath = file;
      }
      session.update(items);
      if (!await session.recover(options, items)) break;
    }
    const result = await session.finish({ items });
    results.push({ build, result, found: items.length });
    return result;
  }
  const initial = await run(1); assert.equal(initial.outcome, 'usable'); assert.equal(initial.verified, 2);
  assert.equal(initial.change, 'first-seen'); console.log('PASS: normal image reader provides a verified baseline');
  const rebuilt = await run(2); assert.equal(rebuilt.change, 'build-change'); assert.equal(rebuilt.outcome, 'usable');
  console.log('PASS: changing JS build alone does not stop collection');
  const css = await run(3); assert.equal(css.change, 'reader-change'); assert.equal(css.verified, 2);
  assert.ok(css.attempts.some(x => x.strategy === 'css-backgrounds'));
  console.log('PASS: IMG to CSS backgrounds selects the built-in fallback and validates image bytes');
  store = new SiteProfiles(path.join(directory, 'profiles.json')); await store.load();
  const repeated = await run(3); assert.equal(repeated.strategySource, 'site-history'); assert.equal(repeated.verified, 2);
  console.log('PASS: a new session loads the previously successful strategy from disk');
  const lazy = await run(4); assert.ok(lazy.attempts.some(x => x.strategy === 'lazy-attributes'));
  assert.equal(lazy.candidates, 2); assert.equal(lazy.verified, 0); assert.equal(lazy.outcome, 'partial');
  console.log('PASS: a new lazy attribute is recognized without calling un-loaded URLs verified pages');
  const blocked = await run(5); assert.equal(blocked.outcome, 'blocked'); assert.equal(blocked.verified, 0);
  assert.equal(blocked.completeness, 'unverified');
  console.log('PASS: HTTP 403 is reported as blocked, not bypassed or learned as success');
  await fs.writeFile(path.join(directory, 'results.json'), JSON.stringify({ passed: 6, results }, null, 2));
  console.log(`ALL 6 ADAPTIVE PROTOTYPE CHECKS PASSED. Artifacts: ${directory}`);
})().catch(async error => {
  console.error(error.stack || error); process.exitCode = 1;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'failure.txt'), String(error.stack || error));
}).finally(async () => {
  observer?.detach(); await imageStore?.close().catch(() => {});
  await browser?.close().catch(() => {});
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
