'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {OcrResultCache}=require('../src/ocr-result-cache.cjs');
test('cached OCR observations stay immutable when corrections and translations change',()=>{
 const cache=new OcrResultCache(),run={regions:[{text:'ต้นฉบับ',bbox:{x0:1,y0:2,x1:3,y1:4}}],passes:[]};
 cache.set('image+settings',run);run.regions[0].text='changed';
 const copy=cache.get('image+settings');copy.regions[0].bbox.x0=99;copy.regions[0].translation='translated';
 assert.deepEqual(cache.get('image+settings').regions[0],{text:'ต้นฉบับ',bbox:{x0:1,y0:2,x1:3,y1:4}});
 assert.equal(cache.get('different settings'),null);cache.clear();assert.equal(cache.get('image+settings'),null);
});
test('OCR cache bounds memory and evicts least recently used entries',()=>{
 const cache=new OcrResultCache({maxBytes:60,maxEntries:2});cache.set('a',{text:'a'});cache.set('b',{text:'b'});cache.get('a');cache.set('c',{text:'c'});
 assert.equal(cache.get('b'),null);assert.ok(cache.get('a'));assert.ok(cache.get('c'));
 cache.set('too large',{text:'x'.repeat(100)});assert.equal(cache.get('too large'),null);assert.ok(cache.bytes<=60);
 cache.set('a',{text:'replacement'});assert.equal(cache.get('a').text,'replacement');assert.ok(cache.bytes<=60);
});
