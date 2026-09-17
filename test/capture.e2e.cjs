'use strict';
const { _electron: electron } = require('playwright-core');
const http = require('node:http');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = hex => crypto.createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');
let app, server;
(async () => {
  server = http.createServer((req, res) => {
    if (req.url !== '/pager') { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>Same canvas pager</title>
      <main class="reading-strip"><canvas id="page" width="420" height="560" aria-label="same canvas"></canvas></main>
      <button id="next">next</button><button id="same">same</button>
      <script>
      const c=document.getElementById('page'),x=c.getContext('2d'); let page=1;
      function paint(){x.clearRect(0,0,c.width,c.height);x.fillStyle=['#aa2233','#22aa44','#3344aa'][page-1];x.fillRect(0,0,c.width,c.height);x.fillStyle='#fff';x.fillRect(page*20,40,80,80)}
      paint();
      document.getElementById('next').onclick=()=>{page=Math.min(3,page+1);x.clearRect(0,0,c.width,c.height);setTimeout(paint,850)};
      document.getElementById('same').onclick=()=>paint();
      </script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const launch = process.argv[2] ? { executablePath: path.resolve(process.argv[2]), args: ['--eiw-test'], env, timeout: 45000 } : { args: [root, '--eiw-test'], env, timeout: 45000 };
  app = await electron.launch(launch);
  const ui = await app.firstWindow(); await ui.waitForFunction(() => !!window.eiw);
  await app.evaluate((_, url) => global.__eiwTest.openPage({ url, show: false, backend: 'electron' }), `${base}/pager`);
  const started = await app.evaluate(() => global.__eiwTest.startCaptureSession({ canvases: true, intervalMs: 500 }));
  assert.equal(started.started, true);
  for (let i = 0; i < 20; i++) {
    if ((await app.evaluate(() => global.__eiwTest.getState())).count >= 1) break;
    await sleep(150);
  }
  assert.equal((await app.evaluate(() => global.__eiwTest.getState())).count, 1, 'page 1 should be captured once');
  await app.evaluate(() => global.__eiwTest.runPage("document.getElementById('next').click(); true"));
  await sleep(600);
  assert.equal((await app.evaluate(() => global.__eiwTest.getState())).count, 1, 'blank transition must not be marked successful');
  for (let i = 0; i < 20; i++) {
    if ((await app.evaluate(() => global.__eiwTest.getState())).count >= 2) break;
    await sleep(150);
  }
  assert.equal((await app.evaluate(() => global.__eiwTest.getState())).count, 2, 'failed blank attempt must retry and capture page 2');
  await app.evaluate(() => global.__eiwTest.runPage("document.getElementById('same').click(); true"));
  await sleep(1200);
  assert.equal((await app.evaluate(() => global.__eiwTest.getState())).count, 2, 'same rendered bytes must deduplicate');
  await app.evaluate(() => global.__eiwTest.runPage("document.getElementById('next').click(); true"));
  for (let i = 0; i < 25; i++) {
    if ((await app.evaluate(() => global.__eiwTest.getState())).count >= 3) break;
    await sleep(150);
  }
  assert.equal((await app.evaluate(() => global.__eiwTest.getState())).count, 3, 'page 3 should be captured');
  const ids = await ui.evaluate(() => all.map(item => item.id));
  assert.equal(ids.length, 3);
  const snapshots = [];
  for (const id of ids) snapshots.push(await app.evaluate(async (_, value) => {
    const data = await global.__eiwTest.getImage(value);
    return { hex: data.buffer.toString('hex'), ext: data.ext };
  }, id));
  assert.ok(snapshots.every(item => item.ext === 'png'));
  assert.equal(new Set(snapshots.map(item => hash(item.hex))).size, 3, 'stored snapshots must survive later canvas redraws');
  await app.evaluate(() => global.__eiwTest.stopCaptureSession());
  for (let i = 0; i < 20; i++) {
    if (!(await app.evaluate(() => global.__eiwTest.getState())).captureActive) break;
    await sleep(100);
  }
  assert.equal((await app.evaluate(() => global.__eiwTest.getState())).captureActive, false);
  const cf = await app.evaluate(() => global.__eiwTest.changeNetworkMode({ mode: 'cloudflare' }));
  assert.equal(cf.mode, 'cloudflare'); assert.equal(cf.restartRequired, false);
  assert.equal((await app.evaluate(() => global.__eiwTest.getState())).networkMode, 'cloudflare');
  const compat = await app.evaluate(() => global.__eiwTest.changeNetworkMode({ mode: 'compat' }));
  assert.equal(compat.mode, 'compat'); assert.equal(compat.restartRequired, true);
  const auto = await app.evaluate(() => global.__eiwTest.changeNetworkMode({ mode: 'auto' }));
  assert.equal(auto.mode, 'auto'); assert.equal(auto.restartRequired, false);
  console.log('PASS: capture session retries failures, content-dedupes reused canvas, persists snapshots, and network modes apply safely');
})().catch(error => {
  console.error(error.stack || error); process.exitCode = 1;
}).finally(async () => {
  if (app) await app.close().catch(() => {});
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
