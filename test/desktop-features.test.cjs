'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ByteCache } = require('../src/core.cjs');
const { createCollectorWorkspaces } = require('../src/collector/workspaces.cjs');
const { createOfflineLibrary } = require('../src/harvestts/offline-library.cjs');

function collectionState() {
  return {
    records: new Map(),
    cache: new ByteCache(),
    pending: new Map(),
    failedImages: new Map(),
    generation: 0,
    pageInfo: { title: '', url: '' },
    canvasTempDir: '',
    blockedHosts: new Map(),
    queue: Promise.resolve(),
    requestGate: 0,
    excludedIds: new Set(),
    lastRemoval: [],
  };
}

test('Collector workspace switches preserve each collection and publish the current state to consumers', async () => {
  const state = collectionState();
  const workspaces = createCollectorWorkspaces({
    collectorBrowser: { ensureIdle() {}, webURL: () => 'https://example.test/' },
    collectorCollection: state,
    host: { withTimeout: (promise) => promise },
  });
  const currentItems = () => [...state.records.keys()];
  state.records.set('first', { id: 'first' });
  state.pageInfo = { title: 'First chapter', url: 'https://example.test/1' };
  const firstRecords = state.records;
  await workspaces.switchWorkspace({ id: 'tab-2' });
  assert.deepEqual(currentItems(), []);
  assert.notEqual(state.records, firstRecords);
  state.records.set('second', { id: 'second' });
  await workspaces.switchWorkspace({ id: 'tab-1' });
  assert.deepEqual(currentItems(), ['first']);
  assert.equal(state.records, firstRecords);
  assert.equal(state.pageInfo.title, 'First chapter');
  await workspaces.closeWorkspace({ id: 'tab-2' });
  assert.deepEqual(currentItems(), ['first']);
  await assert.rejects(workspaces.closeWorkspace({ id: 'tab-1' }), /สลับ/);
});

test('a busy Collector refuses a workspace switch before changing any state', async () => {
  const state = collectionState();
  const records = state.records;
  const workspaces = createCollectorWorkspaces({
    collectorBrowser: {
      ensureIdle() {
        throw Error('busy');
      },
    },
    collectorCollection: state,
    host: {},
  });
  await assert.rejects(workspaces.switchWorkspace({ id: 'tab-2' }), /busy/);
  assert.equal(workspaces.activeWorkspaceId, 'tab-1');
  assert.equal(state.records, records);
  assert.equal(workspaces.workspaceStates.size, 0);
});

test('Offline libraries isolate their storage and serialize concurrent writes without losing groups', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ih-feature-storage-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const library = (name) =>
    createOfflineLibrary({
      storage: { harvestTsDataDir: path.join(dir, name) },
      translation: {},
    });
  const a = library('a'),
    b = library('b');
  const groups = await Promise.all(
    ['One', 'Two', 'Three'].map((title) => a.harvestOfflineGroupCreate({ title })),
  );
  await b.harvestOfflineGroupCreate({ title: 'Separate' });
  assert.deepEqual((await a.harvestOfflineList()).groups.map((g) => g.title).sort(), [
    'One',
    'Three',
    'Two',
  ]);
  assert.deepEqual(
    (await b.harvestOfflineList()).groups.map((g) => g.title),
    ['Separate'],
  );
  await a.harvestOfflineGroupRemove({ id: groups[1].id });
  await assert.rejects(a.harvestOfflineGroupRename({ id: 'missing', title: 'Invalid' }), /ไม่พบ/);
  await a.harvestOfflineGroupRename({ id: groups[0].id, title: 'Renamed' });
  assert.deepEqual((await library('a').harvestOfflineList()).groups.map((g) => g.title).sort(), [
    'Renamed',
    'Three',
  ]);
  assert.deepEqual(
    (await b.harvestOfflineList()).groups.map((g) => g.title),
    ['Separate'],
  );
});
