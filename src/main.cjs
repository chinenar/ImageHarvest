'use strict';
const {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  dialog,
  shell,
  Menu,
  globalShortcut,
} = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { compatibilitySettings } = require('./compatibility-settings.cjs');
const { normalizeNetworkMode, isCompatibility } = require('./network.cjs');
const { createFeatures } = require('./shared/features.cjs');
const { registerAppProtocols } = require('./shared/protocols.cjs');
const { createTestApi } = require('./shared/test-api.cjs');

const MAX_IMAGE = 32 * 1024 * 1024;

const MAX_IMAGES = 5000;

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'eiw',
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
  {
    scheme: 'eiw-image',
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

const testMode = process.argv.includes('--eiw-test');

if (testMode)
  app.setPath(
    'userData',
    process.env.EIW_TEST_USER_DATA
      ? path.resolve(process.env.EIW_TEST_USER_DATA)
      : path.join(app.getPath('temp'), `eiw-test-${process.pid}`),
  );

let startupNetworkMode = 'auto';

let protectionCompatibilityEnabled = true;

let startupBrowserMode = 'chrome';

let chromeControl = 'standard';

try {
  const startupSettings = JSON.parse(
    fsSync.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8'),
  );
  startupNetworkMode = normalizeNetworkMode(startupSettings.networkMode);
  chromeControl = startupSettings.chromeControl === 'minimal' ? 'minimal' : 'standard';
  const migrated = compatibilitySettings(startupSettings);
  protectionCompatibilityEnabled = migrated.protectionCompatibility;
  startupBrowserMode = migrated.browserMode;
} catch {}

if (isCompatibility(startupNetworkMode)) {
  app.commandLine.appendSwitch('disable-http2');
  app.commandLine.appendSwitch('disable-quic');
}

app.setName('ImageHarvest');

let mainWindow;

let quitting = false;

let screenClipBusy = false;

let printScreenRegistered = false;

async function openWindowsScreenClip() {
  if (process.platform !== 'win32' || screenClipBusy) return false;
  screenClipBusy = true;
  try {
    await shell.openExternal('ms-screenclip:');
    return true;
  } finally {
    setTimeout(() => {
      screenClipBusy = false;
    }, 700);
  }
}

function screenshotInput(event, input = {}) {
  if (process.platform !== 'win32') return false;
  const key = String(input.key || '').toLowerCase();
  const isPrintScreen = key === 'printscreen';
  const isSystemSnip = key === 's' && Boolean(input.shift) && Boolean(input.meta);
  if (!isPrintScreen && !isSystemSnip) return false;
  try {
    event.preventDefault();
  } catch {}
  openWindowsScreenClip().catch(() => {});
  return true;
}

function screenshotWindowFocused() {
  const mainFocused = mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused();
  const popup =
    features.blockManager.harvestBlockManagerWindow &&
    !features.blockManager.harvestBlockManagerWindow.isDestroyed()
      ? features.blockManager.harvestBlockManagerWindow
      : null;
  return Boolean(mainFocused || popup?.isFocused());
}

function syncPrintScreenShortcut() {
  if (process.platform !== 'win32' || !app.isReady()) return;
  const shouldRegister = screenshotWindowFocused();
  if (shouldRegister && !printScreenRegistered) {
    printScreenRegistered = globalShortcut.register('PrintScreen', () => {
      openWindowsScreenClip().catch(() => {});
    });
  } else if (!shouldRegister && printScreenRegistered) {
    globalShortcut.unregister('PrintScreen');
    printScreenRegistered = false;
  }
}

function bindScreenshotWindow(win) {
  if (!win || win.isDestroyed()) return;
  const sync = () => setTimeout(syncPrintScreenShortcut, 0);
  win.on('focus', sync);
  win.on('blur', sync);
  win.webContents.on('before-input-event', (event, input) => {
    screenshotInput(event, input);
  });
}

const emit = (type, data = {}) => {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send('eiw:event', { type, ...data });
};

function validateSender(event) {
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame ||
    !['eiw://app/', 'eiw://app/index.html'].includes(event.senderFrame.url)
  )
    throw new Error('Unauthorized request');
}

function handle(name, fn) {
  ipcMain.handle(`eiw:${name}`, async (event, arg) => {
    validateSender(event);
    try {
      return { ok: true, data: await fn(arg) };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  });
}

function allowedWeb(url) {
  try {
    return ['https:', 'http:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

async function withTimeout(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const features = createFeatures({
  get MAX_IMAGE() {
    return MAX_IMAGE;
  },
  get MAX_IMAGES() {
    return MAX_IMAGES;
  },
  get testMode() {
    return testMode;
  },
  get startupNetworkMode() {
    return startupNetworkMode;
  },
  get protectionCompatibilityEnabled() {
    return protectionCompatibilityEnabled;
  },
  set protectionCompatibilityEnabled(value) {
    protectionCompatibilityEnabled = value;
  },
  get startupBrowserMode() {
    return startupBrowserMode;
  },
  get chromeControl() {
    return chromeControl;
  },
  set chromeControl(value) {
    chromeControl = value;
  },
  get mainWindow() {
    return mainWindow;
  },
  get quitting() {
    return quitting;
  },
  screenshotInput,
  bindScreenshotWindow,
  get emit() {
    return emit;
  },
  allowedWeb,
  withTimeout,
});

async function main() {
  await fs.mkdir(app.getPath('userData'), { recursive: true });

  // Memory-only login session.

  await features.collector.initialize();
  await features.harvestTS.initialize();
  registerAppProtocols(features);
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    backgroundColor: '#10111a',
    title: 'ImageHarvest',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  mainWindow.setContentProtection(false); // HarvestTS must remain capturable by normal Windows screenshot tools.
  bindScreenshotWindow(mainWindow);

  mainWindow.on('close', () => {
    features.tabs.saveHarvestTabsSync();
  });
  mainWindow.on('closed', () => {
    features.harvestTS.disposeWindows();
    mainWindow = null;
    app.quit();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.once('ready-to-show', () => {
    if (!testMode) mainWindow.show();
  });

  if (testMode) global.__eiwTest = createTestApi(features);
  features.collector.registerIpc(handle);
  features.harvestTS.registerIpc(handle);
  await mainWindow.loadURL('eiw://app/');
  if (process.argv.includes('--ocr-lab')) await features.ocrLab.ocrLab.open();
}

app
  .whenReady()
  .then(main)
  .catch((error) => {
    if (testMode) console.error(error.stack || error.message);
    else dialog.showErrorBox('ImageHarvest', error.stack || error.message);
    app.exit(1);
  });

app.on('before-quit', () => {
  features.harvestTS.shutdown();
  if (printScreenRegistered) {
    try {
      globalShortcut.unregister('PrintScreen');
    } catch {}
    printScreenRegistered = false;
  }
  quitting = true;
  features.collector.cancelAndClean();
});

app.on('before-quit', (event) => {
  const closing = features.collector.closeResources();
  if (closing) {
    event.preventDefault();
    closing.finally(() => app.quit());
  }
});

app.on('window-all-closed', () => app.quit());

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});
