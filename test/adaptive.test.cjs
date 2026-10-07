'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { SiteObserver, digest } = require('../src/site-observer.cjs');
const { SiteProfiles, scopeFor, fingerprint, classifyChange, verification } = require('../src/adaptive-core.cjs');
const { AdaptiveSession } = require('../src/adaptive-session.cjs');
const probe = { family: 'img', images: 2, decoded: 2, lazyAttributes: [], topology: ['IMG/MAIN/BODY'] };
const images = [1, 2].map(id => ({ id: String(id), source: 'img', decoded: true, width: 600, height: 900, filterHints: { mainKind: 'main' } }));
async function memory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ih-adaptive-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new SiteProfiles(path.join(directory, 'profiles.json'));
  await store.load(); return store;
}
test('build changes and reader changes are distinct; missing body hashes are not a build change', () => {
  const before = fingerprint(probe, { scriptIdentity: digest('build1') });
  assert.equal(classifyChange(null, before), 'first-seen');
  assert.equal(classifyChange(before, fingerprint(probe, { scriptIdentity: digest('build2') })), 'build-change');
  assert.equal(classifyChange(before, fingerprint({ ...probe, family: 'canvas' }, {})), 'reader-change');
  assert.equal(classifyChange({ ...before, hashedScripts: 1, scriptBytes: digest('bytes') }, before), 'stable');
});
test('profile scope distinguishes reader routes and browser modes without saving chapter tokens', () => {
  const a = scopeFor('https://example.test/read/123?token=SECRET', 'electron');
  assert.equal(a.key, scopeFor('https://example.test/read/456', 'electron').key);
  assert.notEqual(a.key, scopeFor('https://example.test/gallery/123', 'electron').key);
  assert.notEqual(a.key, scopeFor('https://example.test/read/123', 'chrome-plain').key);
  assert.ok(!JSON.stringify(a).includes('SECRET'));
});
test('passive observer has bounded memory and no commands or raw URL storage in snapshots', () => {
  const observer = new SiteObserver(), cdp = new EventEmitter();
  observer.attach(cdp, 'main');
  cdp.emit('Network.requestWillBeSent', { type: 'Document', frameId: 'main', request: { url: 'https://example.test/read/1' } });
  for (let i = 0; i < 300; i++) observer.response({ type: 'script', status: 200, url: `https://example.test/${i}.js?token=SECRET`, headers: { ETag: 'PRIVATE' } });
  const snapshot = observer.snapshot();
  assert.equal(snapshot.scriptCount, 256); assert.equal(snapshot.dropped, 44);
  assert.ok(!/SECRET|PRIVATE|example/.test(JSON.stringify(snapshot)));
  observer.detach(); assert.equal(cdp.eventNames().length, 0);
});
test('observed image MIME is not by itself a verified reader page', () => {
  assert.deepEqual(verification([{ ...images[0], decoded: false }]), { candidates: 1, verified: 0 });
  assert.deepEqual(verification([{ ...images[0], decoded: false, capturePath: '/local/test.png' }]), { candidates: 1, verified: 1 });
  assert.deepEqual(verification([{ ...images[0], filterHints: { chrome: true } }]), { candidates: 0, verified: 0 });
});
test('only successful observations replace the last usable baseline', async t => {
  const store = await memory(t), scope = scopeFor('https://example.test/read/1', 'electron');
  const good = fingerprint(probe, { scriptIdentity: digest('good') });
  await store.remember(scope, good, { outcome: 'usable', verified: 2, attempts: [{ strategy: 'dom', verified: 2 }] });
  const changed = fingerprint({ ...probe, family: 'canvas' }, {});
  for (const outcome of ['partial', 'empty', 'cancelled', 'blocked', 'error'])
    await store.remember(scope, changed, { outcome, verified: 0, attempts: [{ strategy: 'dom', verified: 0 }] });
  assert.deepEqual(store.baseline(scope), good);
  const restored = new SiteProfiles(store.file); await restored.load();
  assert.deepEqual(restored.baseline(scope), good);
});
test('corrupt memory is left intact and does not stop a new scan', async t => {
  const store = await memory(t); await fs.writeFile(store.file, 'invalid-json');
  const restored = new SiteProfiles(store.file); await restored.load();
  assert.equal(restored.warning, 'profile-store-unavailable');
  await restored.remember(scopeFor('https://example.test/read/1', 'electron'), fingerprint(probe, {}), { outcome: 'usable', verified: 2 });
  assert.equal(await fs.readFile(store.file, 'utf8'), 'invalid-json');
});
test('cross-site hints need repeated successes and the same browser mode', async t => {
  const store = await memory(t), scope = scopeFor('https://one.test/read/1', 'electron');
  const snap = fingerprint({ ...probe, family: 'background' }, {});
  for (let i = 0; i < 2; i++) await store.remember(scope, snap, { outcome: 'usable', verified: 2, attempts: [{ strategy: 'css-backgrounds', verified: 2 }] });
  assert.equal(store.suggest(scopeFor('https://two.test/read/1', 'electron'), 'background', ['css-backgrounds']).source, 'reader-family');
  assert.equal(store.suggest(scopeFor('https://two.test/read/1', 'chrome-plain'), 'background', ['css-backgrounds']), null);
});
test('strategy recovery uses only the finite built-in choices', async t => {
  const store = await memory(t), options = { autoScroll: true };
  const session = new AdaptiveSession({ store, url: 'https://example.test/read/1', mode: 'electron',
    probe: async () => ({ ...probe, lazyAttributes: ['data-image-src'], backgrounds: 2 }), observation: () => ({}) });
  await session.start(options);
  assert.deepEqual(options.lazyAttributes, ['data-image-src']);
  assert.equal(session.strategySource, 'page-observation');
  assert.equal(await session.recover(options, []), true); assert.equal(options.backgrounds, true);
  assert.equal(await session.recover(options, [], true), true); assert.equal(options.conservativeScroll, true);
  assert.equal(await session.recover(options, [], true), false);
  assert.equal(session.attempts.length, 4);
  assert.equal(session.apply('arbitrary-script', options), false);
});
test('usable results never claim chapter completeness', async t => {
  const store = await memory(t), session = new AdaptiveSession({ store, url: 'https://example.test/read/1', mode: 'electron',
    probe: async () => ({ ...probe, expectedTotal: 2 }), observation: () => ({}) });
  await session.start({}); const result = await session.finish({ items: images });
  assert.equal(result.outcome, 'usable'); assert.equal(result.declaredTotalMatched, true);
  assert.equal(result.completeness, 'unverified'); assert.equal(result.verified, 2);
});
test('failed probe is diagnostic rather than a claim that content is absent', async t => {
  const store = await memory(t), session = new AdaptiveSession({ store, url: 'https://example.test/read/1', mode: 'electron',
    probe: async () => { throw new Error('fixture failure'); }, observation: () => ({}) });
  await session.start({}); const result = await session.finish({ error: true });
  assert.equal(result.probeUnavailable, true); assert.equal(result.outcome, 'error');
  assert.equal(store.baseline(session.scope)?.family, 'unknown');
});
