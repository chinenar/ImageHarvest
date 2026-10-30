'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const sharp = require('sharp');
const { createAuditServer } = require('../scripts/serve-ocr-audit.cjs');
test('audit viewer rejects arbitrary routes, stale results, escaped clean paths and foreign browser access', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-audit-routes-')), output = path.join(root, 'corpus'), source = path.join(root, 'source');
  await fs.mkdir(output); await fs.mkdir(source);
  const id = 'page-0001-abcdef01', file = path.join(source, 'page.png');
  await sharp({ create: { width: 13, height: 17, channels: 3, background: '#ffffff' } }).png().toFile(file);
  const manifest = { source, implementationDigest: 'current', totalImages: 1, totalGroups: 1, cases: [{ id, file, sourceHash: 'h', relative: 'page.png', group: 'g', width: 13, height: 17 }] };
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(output, id + '.json'), JSON.stringify({ implementationDigest: 'old', sourceHash: 'h', ocrRegions: [{ text: 'stale' }] }));
  const server = createAuditServer({ output }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, base = 'http://127.0.0.1:' + port;
  try {
    let catalog = await fetch(base + '/api/catalog').then(r => r.json()); assert.equal(catalog.cases[0].state, 'pending'); assert.equal(catalog.cases[0].text, '');
    assert.equal((await fetch(base + '/api/result/' + id)).status, 202);
    assert.equal((await fetch(base + '/image/page-9999-deadbeef')).status, 404);
    assert.equal((await fetch(base + '/image/%2e%2e%2fpackage.json')).status, 404);
    assert.equal((await fetch(base + '/api/catalog', { headers: { Origin: 'https://example.com' } })).status, 403);
    assert.equal((await fetch(base + '/api/catalog', { method: 'POST' })).status, 405);
    const foreignHost = await new Promise(resolve => { const req = http.get(base + '/api/catalog', { headers: { Host: 'example.com:' + port } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', error => { throw error; }); }); assert.equal(foreignHost, 403);
    await fs.writeFile(path.join(output, id + '.json'), JSON.stringify({ implementationDigest: 'current', sourceHash: 'h', cleanedPath: '../source/page.png' }));
    assert.equal((await fetch(base + '/clean/' + id)).status, 403);
    const original = await fetch(base + '/image/' + id); assert.equal(original.status, 200); assert.equal(original.headers.get('content-type'), 'image/png'); const pixels = await sharp(Buffer.from(await original.arrayBuffer())).metadata(); assert.equal(pixels.width, 13); assert.equal(pixels.height, 17);
    await fs.writeFile(path.join(output, id + '.json'), JSON.stringify({ implementationDigest: 'current', sourceHash: 'changed' })); catalog = await fetch(base + '/api/catalog').then(r => r.json()); assert.equal(catalog.cases[0].state, 'pending');
  } finally {
    await new Promise(resolve => server.close(resolve));
    for (const name of await fs.readdir(path.join(output, '.web-cache')).catch(() => [])) await fs.unlink(path.join(output, '.web-cache', name));
    await fs.rmdir(path.join(output, '.web-cache')).catch(() => {});
    await fs.unlink(path.join(output, 'manifest.json')); await fs.unlink(path.join(output, id + '.json')); await fs.unlink(file); await fs.rmdir(source); await fs.rmdir(output); await fs.rmdir(root);
  }
});
