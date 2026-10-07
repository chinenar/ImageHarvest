'use strict';
const http = require('node:http');
const assert = require('node:assert/strict');
const { ChromeBrowser } = require('../src/chrome-browser.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (req.url === '/b') return res.end('<title>Reader Popup</title><h1>reader</h1>');
    res.end('<title>Library</title><a id="reader" target="_blank" href="/b">read</a>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    for (const mode of ['standard', 'minimal']) {
      const browser = new ChromeBrowser(() => {});
      await browser.setControlMode(mode);
      try {
        await browser.open(base + '/a');
        const point = await browser.evaluate("(() => { const r=document.getElementById('reader').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()");
        await browser.cdp.send('Input.dispatchMouseEvent', {type:'mousePressed', x:point.x, y:point.y, button:'left', clickCount:1});
        await browser.cdp.send('Input.dispatchMouseEvent', {type:'mouseReleased', x:point.x, y:point.y, button:'left', clickCount:1});
        const deadline = Date.now() + 8000;
        while (!browser.url().endsWith('/b') && Date.now() < deadline) await sleep(100);
        assert.ok(browser.url().endsWith('/b'), mode + ' did not adopt popup');
        assert.equal(await browser.title(), 'Reader Popup');
      } finally { await browser.close(); }
    }
    console.log('PASS: Standard and Minimal follow a reader popup without closing it');
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
