'use strict';
const fs = require('node:fs/promises');
const { ByteCache } = require('../core.cjs');

function createCollectorWorkspaces({
  collectorBrowser: collectorBrowserService,
  collectorCollection: collectorCollectionService,
  host: hostService,
}) {
  let activeWorkspaceId = 'tab-1';

  const workspaceStates = new Map();

  function emptyWorkspaceState() {
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

  function snapshotWorkspaceState() {
    return {
      records: collectorCollectionService.records,
      cache: collectorCollectionService.cache,
      pending: collectorCollectionService.pending,
      failedImages: collectorCollectionService.failedImages,
      generation: collectorCollectionService.generation,
      pageInfo: { ...collectorCollectionService.pageInfo },
      canvasTempDir: collectorCollectionService.canvasTempDir,
      blockedHosts: collectorCollectionService.blockedHosts,
      queue: collectorCollectionService.queue,
      requestGate: collectorCollectionService.requestGate,
      excludedIds: collectorCollectionService.excludedIds,
      lastRemoval: [...collectorCollectionService.lastRemoval],
    };
  }

  function restoreWorkspaceState(state) {
    collectorCollectionService.records = state.records;
    collectorCollectionService.cache = state.cache;
    collectorCollectionService.pending = state.pending;
    collectorCollectionService.failedImages = state.failedImages;
    collectorCollectionService.generation = state.generation;
    collectorCollectionService.pageInfo = { ...state.pageInfo };
    collectorCollectionService.canvasTempDir = state.canvasTempDir;
    collectorCollectionService.blockedHosts = state.blockedHosts;
    collectorCollectionService.queue = state.queue;
    collectorCollectionService.requestGate = state.requestGate;
    collectorCollectionService.excludedIds = state.excludedIds;
    collectorCollectionService.lastRemoval = [...state.lastRemoval];
  }

  function workspaceId(input) {
    const id = String(input?.id || '');
    if (!/^tab-[1-9][0-9]{0,3}$/.test(id)) throw new Error('รหัสแท็บไม่ถูกต้อง');
    return id;
  }

  async function switchWorkspace(input = {}) {
    collectorBrowserService.ensureIdle();
    const id = workspaceId(input);
    if (id === activeWorkspaceId)
      return {
        id,
        title: collectorCollectionService.pageInfo.title,
        url: collectorCollectionService.pageInfo.url,
        count:
          collectorCollectionService.records.size - collectorCollectionService.excludedIds.size,
        browserURL: collectorBrowserService.webURL(),
      };
    if (collectorCollectionService.pending.size)
      await hostService.withTimeout(
        Promise.allSettled([...collectorCollectionService.pending.values()]),
        4000,
        'รอภาพตัวอย่างให้เสร็จก่อนสลับแท็บ',
      );
    workspaceStates.set(activeWorkspaceId, snapshotWorkspaceState());
    activeWorkspaceId = id;
    restoreWorkspaceState(workspaceStates.get(id) || emptyWorkspaceState());
    return {
      id,
      title: collectorCollectionService.pageInfo.title,
      url: collectorCollectionService.pageInfo.url,
      count: collectorCollectionService.records.size - collectorCollectionService.excludedIds.size,
      browserURL: collectorBrowserService.webURL(),
    };
  }

  async function closeWorkspace(input = {}) {
    collectorBrowserService.ensureIdle();
    const id = workspaceId(input);
    if (id === activeWorkspaceId) throw new Error('ต้องสลับไปแท็บอื่นก่อนปิดแท็บนี้');
    const state = workspaceStates.get(id);
    workspaceStates.delete(id);
    if (state?.cache) state.cache.clear();
    if (state?.canvasTempDir)
      await fs.rm(state.canvasTempDir, { recursive: true, force: true }).catch(() => {});
    return { closed: true, id };
  }
  return {
    get activeWorkspaceId() {
      return activeWorkspaceId;
    },
    get workspaceStates() {
      return workspaceStates;
    },
    switchWorkspace,
    closeWorkspace,
  };
}
module.exports = { createCollectorWorkspaces };
