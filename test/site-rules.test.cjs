'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { siteForURL, ntrBlockedScript, patchPengi, classifyPengi, PENGI_PATH, PENGI_HASH, sha256, modifiedHeaders } = require('../src/site-rules.cjs');
const { SiteCompatibility } = require('../src/site-compatibility.cjs');
test('site rules match exact HTTPS origins, never lookalikes or credentials', () => {
  assert.equal(siteForURL('https://pengi.co/read/test'), 'pengi');
  assert.equal(siteForURL('https://ntrnaja.com/manga/'), 'ntrnaja');
  for (const url of ['https://pengi.co.evil.test/', 'http://pengi.co/', 'https://pengi.co:1234/', 'https://u:p@pengi.co/', 'https://ccharem.cileclo.com/', 'invalid']) assert.equal(siteForURL(url), '');
});
test('NTR rules never block all jsDelivr or arbitrary index.js', () => {
  assert.ok(ntrBlockedScript('https://cdn.jsdelivr.net/npm/disable-devtool@0.3.9?ver=0.3.9'));
  assert.ok(ntrBlockedScript('https://ntrnaja.com/wp-content/plugins/wccp-pro/index.js'));
  for (const url of ['https://cdn.jsdelivr.net/npm/vue', 'https://ntrnaja.com/index.js', 'https://cdn.jsdelivr.net/npm/disable-devtool@0.3.99', 'https://other.test/wp-content/plugins/wccp-pro/index.js']) assert.equal(ntrBlockedScript(url), false);
});
test('Pengi rejects unreviewed bytes and recognizes renamed suspect bundles', () => {
  assert.throws(() => patchPengi(Buffer.from('anything')), /Pengi/);
  assert.equal(classifyPengi(PENGI_PATH, Buffer.from('export default {}')), 'unknown-guard');
  assert.equal(classifyPengi('/_nuxt/new.js', Buffer.from('const n="DevtoolsDetector"')), 'unknown-guard');
  assert.equal(classifyPengi('/_nuxt/vue.js', Buffer.from('export const version=1')), 'unrelated');
});
test('modified response preserves security headers and fixes representation metadata', () => {
  const headers = modifiedHeaders([{name:'Content-Encoding',value:'br'},{name:'ETag',value:'old'},{name:'Content-Security-Policy',value:"default-src 'self'"},{name:'Access-Control-Allow-Origin',value:'https://pengi.co'}],120);
  assert.equal(headers.some(h=>h.name==='ETag'||h.name==='Content-Encoding'),false);
  assert.equal(headers.find(h=>h.name==='Content-Length').value,'120');
  assert.ok(headers.some(h=>h.name==='Content-Security-Policy'));
});
test('controller scopes blocking to active site and preserves 403 responses', async () => {
  const calls=[], cdp={send:async (method,args)=>{calls.push([method,args]);return {};}};
  const page={url:()=> 'https://ntrnaja.com/manga/test'};
  const ntr=new SiteCompatibility('ntrnaja',page,cdp);
  await ntr.paused({requestId:'1',request:{url:'https://cdn.jsdelivr.net/npm/disable-devtool@0.3.9'}});
  assert.equal(calls.at(-1)[0],'Fetch.failRequest');
  page.url=()=> 'https://example.com/';
  await ntr.paused({requestId:'2',request:{url:'https://cdn.jsdelivr.net/npm/disable-devtool@0.3.9'}});
  assert.equal(calls.at(-1)[0],'Fetch.continueRequest');
  const pengi=new SiteCompatibility('pengi',{url:()=> 'https://pengi.co/read/test'},cdp);
  await pengi.paused({requestId:'3',request:{url:'https://pengi.co'+PENGI_PATH},responseStatusCode:403});
  assert.equal(calls.at(-1)[0],'Fetch.continueRequest');
  assert.equal(calls.some(x=>x[0]==='Fetch.fulfillRequest'),false);
});
const archive=path.join(__dirname,'../test-results/pengi-comparison-20260918/pengi-asset-9.js');
test('reviewed local Pengi asset: exact hash, surgical transform and unchanged module syntax', {skip:!fs.existsSync(archive)},()=>{
  const original=fs.readFileSync(archive);assert.equal(sha256(original),PENGI_HASH);
  const patched=patchPengi(original).toString('utf8');
  assert.ok(patched.length>original.toString('utf8').length-2000);
  assert.equal(patched.includes('ut.launch()'),false);assert.equal(patched.includes('window.startBoom'),false);
  assert.ok(patched.includes('MutationObserver'));assert.ok(patched.includes('/api/frontend/'));
  const parsed=spawnSync(process.execPath,['--input-type=module','--check'],{input:patched,encoding:'utf8'});
  assert.equal(parsed.status,0,(parsed.stderr||'').slice(-800));
});
