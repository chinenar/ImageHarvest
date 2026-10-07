'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {OcrResultCache}=require('../src/ocr-result-cache.cjs');
const {LocalOcrBackend,ocrCacheRoot}=require('../src/ocr-backend.cjs');
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
test('local OCR models use a versioned per-user cache instead of the legacy ACL-prone folder',()=>{
 assert.match(ocrCacheRoot(),/ImageHarvest[\\/]ocr-models-v2$/);
 const custom=new LocalOcrBackend({cacheRoot:'custom-model-cache'});assert.equal(custom.cacheRoot,'custom-model-cache');
});
test('local OCR backend serializes worker commands so queued pages do not consume their timeout while waiting',async()=>{
 class FakeBackend extends LocalOcrBackend{
  constructor(){super({timeout:20});this.active=0;this.maxActive=0;this.started=[];}
  async requestNow(data){this.active++;this.maxActive=Math.max(this.maxActive,this.active);this.started.push(data.id);await new Promise(r=>setTimeout(r,data.delay));this.active--;return data.id;}
 }
 const backend=new FakeBackend();
 const values=await Promise.all([backend.request({id:'a',delay:35}),backend.request({id:'b',delay:5}),backend.request({id:'c',delay:5})]);
 assert.deepEqual(values,['a','b','c']);assert.deepEqual(backend.started,['a','b','c']);assert.equal(backend.maxActive,1);
});
