'use strict';
const { app, session, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { normalizeNetworkMode } = require('../network.cjs');
const sourceDir = path.resolve(__dirname, '..');
function createCollector(features) {
  async function initialize() {
    features.collectorCollection.readerProbe = await fs.readFile(
      path.join(sourceDir, 'reader-probe.js'),
      'utf8',
    );
    await features.collectorCollection.siteProfiles.load();
    features.collectorCollection.collector = await fs.readFile(
      path.join(sourceDir, 'collector.js'),
      'utf8',
    );
    const filterSource = await fs.readFile(path.join(sourceDir, 'content-filter.js'), 'utf8');
    features.collectorCollection.collector = `(options => { ${filterSource}\nreturn (${features.collectorCollection.collector})(options); })`;
    features.collectorCollection.scrollScript = await fs.readFile(
      path.join(sourceDir, 'scroll.js'),
      'utf8',
    );
    features.collectorCollection.canvasCaptureScript = await fs.readFile(
      path.join(sourceDir, 'canvas-capture.js'),
      'utf8',
    );
    try {
      const value = JSON.parse(
        await fs.readFile(path.join(app.getPath('userData'), 'settings.json'), 'utf8'),
      );
      if (typeof value.outputRoot === 'string')
        features.collectorCollection.outputRoot = value.outputRoot;
      features.collectorBrowser.networkMode = normalizeNetworkMode(value.networkMode);
    } catch {}
    features.collectorBrowser.browsingSession = session.fromPartition('eiw-website');
    features.collectorBrowser.secureSession(features.collectorBrowser.browsingSession);
    features.collectorBrowser.secureSession(session.defaultSession);
    await features.collectorBrowser.applyNetworkRuntime(features.collectorBrowser.networkMode);
  }
  function registerIpc(handle) {
    handle('open', features.collectorBrowser.openPage);
    handle('showBrowser', async () => {
      if (features.collectorBrowser.browserMode === 'chrome')
        return features.collectorBrowser.chromeBrowser.show();
      if (!features.collectorBrowser.browser) throw new Error('กรุณาเปิดเว็บก่อน');
      features.collectorBrowser.browser.show();
      features.collectorBrowser.browser.focus();
      return true;
    });
    handle('collectorBlockElement', features.collectorBlocks.collectorBlockDraftBegin);
    handle('browserProfile', features.collectorBrowser.getBrowserProfile);
    handle('openBrowserLogin', features.collectorBrowser.openBrowserLogin);
    handle('useBrowserProfile', features.collectorBrowser.useBrowserProfile);
    handle('scan', features.collectorCollection.scan);
    handle('nextChapter', features.collectorNavigation.detectNextChapter);
    handle('advanceNextChapter', features.collectorNavigation.advanceNextChapterControl);
    handle('startCapture', features.collectorCapture.startCaptureSession);
    handle('stopCapture', features.collectorCapture.stopCaptureSession);
    handle('networkMode', features.collectorBrowser.changeNetworkMode);
    handle('restartForNetwork', features.collectorBrowser.restartForNetwork);
    handle('removeItems', features.collectorCollection.removeItems);
    handle('undoRemove', features.collectorCollection.undoRemove);
    handle('clearResults', features.collectorCollection.clearResults);
    handle('workspaceSwitch', features.collectorWorkspaces.switchWorkspace);
    handle('workspaceClose', features.collectorWorkspaces.closeWorkspace);
    handle('continuousLog', features.collectorFiles.continuousLog);
    handle('cancel', () => {
      if (features.collectorBrowser.job) {
        features.collectorBrowser.job.cancelled = true;
        features.collectorBrowser.job.abort.abort();
      }
      if (features.collectorCapture.captureSession) features.collectorCapture.stopCaptureSession();
      return true;
    });
    handle('chooseFolder', features.collectorFiles.chooseFolder);
    handle('chooseRenameFolder', features.collectorFiles.chooseRenameFolder);
    handle('previewRename', features.collectorFiles.previewRename);
    handle('renameImages', features.collectorFiles.renameImages);
    handle('download', features.collectorFiles.download);
    handle('exportLinks', features.collectorFiles.exportLinks);
    handle('openFolder', async () => {
      const folder =
        features.collectorCollection.lastFolder || features.collectorCollection.outputRoot;
      if (!folder) throw new Error('ยังไม่มีโฟลเดอร์');
      const error = await shell.openPath(folder);
      if (error) throw new Error(error);
      return true;
    });
    handle('settings', () => ({
      outputRoot: features.collectorCollection.outputRoot,
      version: app.getVersion(),
      browserMode: features.collectorBrowser.browserMode,
      chromeControl: features.host.chromeControl,
      networkMode: features.collectorBrowser.networkMode,
      activeNetworkMode: features.collectorBrowser.activeNetworkMode,
      compatibilityActive: features.collectorBrowser.compatibilityActive,
      protectionCompatibility: features.host.protectionCompatibilityEnabled,
    }));
  }
  function cancelAndClean() {
    if (features.collectorBrowser.job) features.collectorBrowser.job.abort.abort();
    if (features.collectorCapture.captureSession) {
      features.collectorCapture.captureSession.cancelled = true;
      features.collectorCapture.captureSession.abort.abort();
    }
    const dirs = new Set(
      [
        features.collectorCollection.canvasTempDir,
        ...[...features.collectorWorkspaces.workspaceStates.values()].map((x) => x.canvasTempDir),
      ].filter(Boolean),
    );
    for (const dir of dirs) fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  function closeResources() {
    const imageStore = features.collectorBrowser.electronImageStore;
    features.collectorBrowser.electronImageStore = null;
    if (
      features.collectorBrowser.chromeBrowser.context ||
      features.collectorBrowser.manualChromeLogin.alive() ||
      imageStore
    ) {
      return Promise.allSettled([
        features.collectorBrowser.chromeBrowser.close(),
        features.collectorBrowser.manualChromeLogin.close(),
        imageStore?.close(),
      ]);
    }
    return null;
  }
  return { initialize, registerIpc, cancelAndClean, closeResources };
}
module.exports = { createCollector };
