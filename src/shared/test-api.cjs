'use strict';
function createTestApi(features) {
  return {
    openPage: features.collectorBrowser.openPage,
    scan: features.collectorCollection.scan,
    startCaptureSession: features.collectorCapture.startCaptureSession,
    stopCaptureSession: features.collectorCapture.stopCaptureSession,
    download: features.collectorFiles.download,
    getImage: features.collectorFiles.getImage,
    changeNetworkMode: features.collectorBrowser.changeNetworkMode,
    renameImages: (input) => features.collectorFiles.renameImages(input, true),
    setOutput: (value) => {
      features.collectorCollection.outputRoot = value;
    },
    setRenameFolder: (value) => {
      features.collectorCollection.renameFolder = value;
    },
    runPage: features.collectorBrowser.runPage,
    closeChrome: () => features.collectorBrowser.chromeBrowser.close(),
    chromeInfo: () => ({
      profile: features.collectorBrowser.chromeBrowser.profile,
      url: features.collectorBrowser.chromeBrowser.url(),
      status: features.collectorBrowser.chromeBrowser.lastStatus,
      navigation: features.collectorBrowser.chromeBrowser.navigation,
      networkMode: features.collectorBrowser.chromeBrowser.networkMode,
      compatibility: features.collectorBrowser.chromeBrowser.compatibilityInfo(),
    }),
    getState: () => ({
      browserMode: features.collectorBrowser.browserMode,
      networkMode: features.collectorBrowser.networkMode,
      activeNetworkMode: features.collectorBrowser.activeNetworkMode,
      autoFallbackHosts: Object.fromEntries(features.collectorBrowser.autoFallbackHosts),
      compatibilityActive: features.collectorBrowser.compatibilityActive,
      captureActive: Boolean(features.collectorCapture.captureSession),
      busy: features.collectorBrowser.busy,
      count:
        features.collectorCollection.records.size - features.collectorCollection.excludedIds.size,
      excluded: features.collectorCollection.excludedIds.size,
      canvasTempDir: features.collectorCollection.canvasTempDir,
      browserId: features.collectorBrowser.browser?.webContents.id,
      activeWorkspaceId: features.collectorWorkspaces.activeWorkspaceId,
      storedWorkspaces: features.collectorWorkspaces.workspaceStates.size,
      electronCapture: features.collectorBrowser.electronImageStore?.info() || null,
    }),
    harvestTranslationStart: () => {
      const tab = features.tabs.activeHarvestTsTab();
      if (!tab) throw new Error('ไม่พบแท็บ HarvestTS');
      return features.translation.runHarvestTsTranslationJob(tab);
    },
    harvestTranslationScan: () => {
      const tab = features.tabs.activeHarvestTsTab();
      if (!tab) throw new Error('ไม่พบแท็บ HarvestTS');
      return features.pageAcquisition.scanHarvestTsTranslationPages(tab, {
        id: 'test-scan-' + Date.now(),
        abort: new AbortController(),
      });
    },
    harvestTranslationAcquireFirst: async () => {
      const tab = features.tabs.activeHarvestTsTab();
      if (!tab) throw new Error('ไม่พบแท็บ HarvestTS');
      const job = {
        id: 'test-acquire-' + Date.now(),
        abort: new AbortController(),
      };
      const scan = await features.pageAcquisition.scanHarvestTsTranslationPages(tab, job);
      if (!scan.pages.length) throw new Error('ไม่พบหน้าทดสอบ');
      const data = await features.pageAcquisition.acquireHarvestTsTranslationImage(
        tab,
        { ...scan.pages[0], referrer: scan.startURL },
        job.abort.signal,
      );
      return {
        bytes: data.buffer.length,
        ext: data.ext,
        mime: data.mime,
        imageStore: tab.imageStore?.info?.() || null,
      };
    },
    harvestTranslationImageStoreInfo: () => {
      const tab = features.tabs.activeHarvestTsTab();
      return tab?.imageStore?.info?.() || null;
    },
    harvestTranslationRetry: () =>
      features.translation.retryHarvestTsTranslation(features.tabs.activeHarvestTsTab()),
    harvestTranslationState: () => {
      const tab = features.tabs.activeHarvestTsTab(),
        state = features.translation.harvestTranslationJobFor(tab);
      return state
        ? {
            id: state.id,
            running: state.running,
            dir: state.dir,
            manifest: state.manifest || null,
          }
        : null;
    },
    ocrLabAddFiles: (files) => features.ocrLab.ocrLab.addFiles(files),
    translationTestEndpoint: (value) => {
      features.translation.harvestTranslationClient.baseUrl = value;
      features.translation.harvestTranslationProbeCache = null;
    },
    harvestTranslateSettings: () => features.translation.harvestTsTranslateSettings(),
    harvestTranslateSettingsUpdate: (input) =>
      features.translation.updateHarvestTsTranslateSettings(input),
    harvestScreenLensToggle: (enabled) => {
      const tab = features.tabs.activeHarvestTsTab();
      if (!tab) throw new Error('ไม่พบแท็บ HarvestTS');
      return enabled
        ? features.translation.startHarvestScreenLens(tab)
        : features.translation.stopHarvestScreenLens(tab);
    },
    harvestScreenLensState: () =>
      features.translation.harvestScreenLensSnapshot(features.tabs.activeHarvestTsTab()),
    cancel: () => {
      if (features.collectorBrowser.job) {
        features.collectorBrowser.job.cancelled = true;
        features.collectorBrowser.job.abort.abort();
      }
      if (features.collectorCapture.captureSession) features.collectorCapture.stopCaptureSession();
    },
  };
}
module.exports = { createTestApi };
