'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pageURL, imageURL, safeName, imageType, orderItems, uniqueItems, idFor, ByteCache } = require('../src/core.cjs');
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
