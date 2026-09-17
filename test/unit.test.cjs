'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pageURL, imageURL, safeName, imageType, orderItems, uniqueItems, renamePlan, idFor, ByteCache } = require('../src/core.cjs');
test('normalizes plain domain; keeps http loopback for development', () => {
  assert.equal(pageURL('example.com/a'), 'https://example.com/a');
  assert.equal(pageURL('http://127.0.0.1:123/a'), 'http://127.0.0.1:123/a');
});
test('rejects privileged schemes and inline credentials', () => {
  for (const value of ['file:///C:/test', 'javascript:alert(1)', 'https://user:pass@example.com', '', 'data:text/html,x']) assert.throws(() => pageURL(value));
});
test('image URLs preserve signed query strings and resolve relative paths', () => {
  assert.equal(imageURL('../img.png?token=a%2Fb&v=1', 'https://example.com/ch/1'), 'https://example.com/img.png?token=a%2Fb&v=1');
  assert.equal(imageURL('file:///etc/passwd'), null);
  assert.equal(imageURL('data:text/html,x'), null);
  assert.ok(imageURL('data:image/png;base64,aGVsbG8='));
});
test('safe output names reject Windows path hazards and devices', () => {
  assert.equal(safeName('CON'), '_CON'); assert.equal(safeName('LPT1.txt'), '_LPT1.txt');
  assert.equal(safeName('ทดสอบ / test:*?'), 'ทดสอบ _ test___');
  assert.equal(safeName('..'), 'images'); assert.ok(safeName('../unsafe').includes('_'));
});
test('identifies real image bytes instead of trusting filename or MIME', () => {
  assert.equal(imageType(Buffer.from([137,80,78,71,13,10,26,10]), 'text/html').ext, 'png');
  assert.equal(imageType(Buffer.from('GIF89a')).ext, 'gif');
  assert.equal(imageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).ext, 'svg');
  assert.throws(() => imageType(Buffer.from('<html>access denied</html>'), 'image/png'));
});
test('visual, DOM and natural filename order are independent', () => {
  const rows = [{url:'https://a/10.png',top:1,left:5,order:0}, {url:'https://a/2.png',top:0,left:8,order:1}, {url:'https://a/1.png',top:0,left:1,order:2}];
  assert.deepEqual(orderItems(rows).map(x=>x.order), [2,1,0]);
  assert.deepEqual(orderItems(rows,'dom').map(x=>x.order), [0,1,2]);
  assert.deepEqual(orderItems(rows,'name').map(x=>x.order), [2,1,0]);
  assert.deepEqual(orderItems(rows,'right').map(x=>x.order), [1,2,0]);
});
test('deduplicates exact URLs only, preserving differing query strings', () => {
  const rows = [{url:'https://a/1?t=x'},{url:'https://a/1?t=x'},{url:'https://a/1?t=y'}];
  assert.equal(uniqueItems(rows).length,2);
  assert.notEqual(idFor(rows[0].url),idFor(rows[2].url));
});
test('bounded LRU cache accounts for replacement and eviction', () => {
  const c = new ByteCache(5); c.set('a',{buffer:Buffer.alloc(3)}); c.set('b',{buffer:Buffer.alloc(2)});
  c.get('a'); c.set('c',{buffer:Buffer.alloc(2)});
  assert.equal(c.get('b'), undefined); assert.ok(c.get('a')); assert.equal(c.bytes,5);
  c.set('a',{buffer:Buffer.alloc(1)}); assert.equal(c.bytes,3);
  c.set('z',{buffer:Buffer.alloc(10)}); assert.equal(c.bytes,3);
  c.clear(); assert.equal(c.bytes,0);
});

test('page rename plan uses natural order and can reverse it', () => {
  const files = ['10.jpg','2.png','1.webp','note.txt'];
  assert.deepEqual(renamePlan(files).map(x=>[x.from,x.to]), [['1.webp','0001.webp'],['2.png','0002.png'],['10.jpg','0003.jpg']]);
  assert.deepEqual(renamePlan(files,{reverse:true,start:5,padding:3}).map(x=>[x.from,x.to]), [['10.jpg','005.jpg'],['2.png','006.png'],['1.webp','007.webp']]);
});

const filters = require('../src/content-filter.js');
test('metadata filter recognizes explicit logo names without inspecting host or signed query', () => {
  assert.equal(filters.classify({ url: 'https://cdn.test/site-logo@2x.png' }).chrome, true);
  assert.equal(filters.classify({ url: 'https://logo.example/logo-story/page-02.png?avatar=yes' }).chrome, false);
  assert.equal(filters.classify({ url: 'https://example.com/dialogo.png' }).chrome, false);
  assert.equal(filters.classify({ identity: 'siteLogo' }).chrome, true);
  assert.equal(filters.classify({ alt: 'โลโก้เว็บไซต์' }).chrome, true);
});
test('main-content scope prefers reader regions but unknown layouts retain uncertain images', () => {
  const items = ['unknown', 'main', 'reader'].map(mainKind => ({ filterHints: filters.classify({ mainKind }) }));
  assert.equal(filters.mainScope(items), 'reader');
  assert.equal(filters.mainScope(items.slice(0, 2)), 'main');
  assert.equal(filters.mainScope(items.slice(0, 1)), 'unknown');
  assert.equal(filters.matches(items[0], { mainOnly: true, mainScope: 'unknown' }), true);
  assert.equal(filters.matches(items[1], { mainOnly: true, mainScope: 'reader' }), false);
});
test('metadata filtering is opt-in and does not reject short or wide reader pages', () => {
  const logo = { source: 'img', filterHints: filters.classify({ alt: 'Logo', mainKind: 'reader' }) };
  assert.equal(filters.matches(logo), true); assert.equal(filters.matches(logo, { hideChrome: true }), false);
  const short = { width: 1400, height: 100, source: 'canvas', filterHints: filters.classify({ mainKind: 'reader' }) };
  assert.equal(filters.matches(short, { mainOnly: true, mainScope: 'reader' }), true);
  assert.equal(filters.matches(short, { source: 'img' }), false);
  assert.equal(filters.matches(short, { source: 'canvas', minHeight: 300 }), false);
});

const network = require('../src/network.cjs');
test('network modes normalize and expose deterministic DNS settings', () => {
  assert.equal(network.normalizeNetworkMode('CLOUDFLARE'), 'cloudflare');
  assert.equal(network.normalizeNetworkMode('unknown'), 'auto');
  assert.deepEqual(network.electronResolverOptions('cloudflare').secureDnsServers, ['https://cloudflare-dns.com/dns-query']);
  assert.deepEqual(network.electronResolverOptions('google').secureDnsServers, ['https://dns.google/dns-query']);
  assert.equal(network.electronResolverOptions('auto').secureDnsMode, 'automatic');
  assert.deepEqual(network.electronResolverOptions('auto').secureDnsServers, ['https://cloudflare-dns.com/dns-query', 'https://dns.google/dns-query']);
});
test('compatibility mode disables HTTP2 and QUIC only when selected', () => {
  assert.deepEqual(network.chromeArgs('auto'), []);
  assert.ok(network.chromeArgs('cloudflare').some(x => x.startsWith('--dns-over-https-templates=')));
  assert.ok(network.chromeArgs('compat').includes('--disable-http2'));
  assert.ok(network.chromeArgs('compat').includes('--disable-quic'));
  assert.equal(network.isCompatibility('compat'), true);
  assert.equal(network.isCompatibility('google'), false);
});
test('Smart Auto retries only retryable network failures and remembers public DNS order', () => {
  for (const error of [
    new Error('net::ERR_CONNECTION_TIMED_OUT'),
    new Error('net::ERR_NAME_NOT_RESOLVED'),
    new Error('ETIMEDOUT'),
    new Error('page.goto: Timeout 45000ms exceeded')
  ]) assert.equal(network.isRetryableNetworkError(error), true);
  assert.equal(network.isRetryableNetworkError(new Error('HTTP 403')), false);
  assert.deepEqual(network.autoFallbackModes(''), ['cloudflare', 'google']);
  assert.deepEqual(network.autoFallbackModes('cloudflare'), ['cloudflare', 'google']);
  assert.deepEqual(network.autoFallbackModes('google'), ['google', 'cloudflare']);
});