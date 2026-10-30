'use strict';
const { BrowserWindow } = require('electron');
const path = require('node:path');
const sourceDir = require('node:path').resolve(__dirname, '..');

function createBlockManager({
  collectorBlocks: collectorBlocksService,
  blocks: blocksService,
  tabs: tabsService,
  host: hostService,
}) {
  let harvestBlockManagerWindow = null;

  let harvestBlockManagerTabId = null;

  let harvestBlockManagerKind = 'harvestts';

  let harvestBlockManagerCollapsed = false;

  function liveHarvestBlockManager() {
    return harvestBlockManagerWindow && !harvestBlockManagerWindow.isDestroyed()
      ? harvestBlockManagerWindow
      : null;
  }

  function harvestBlockManagerSender(event) {
    const win = liveHarvestBlockManager();
    if (!win || event.sender !== win.webContents) throw new Error('Unauthorized block manager IPC');
  }

  async function closeHarvestBlockManagerWindow() {
    const win = liveHarvestBlockManager();
    harvestBlockManagerTabId = null;
    harvestBlockManagerKind = 'harvestts';
    harvestBlockManagerCollapsed = false;
    harvestBlockManagerWindow = null;
    if (win) {
      try {
        win.setAlwaysOnTop(false);
      } catch {}
      try {
        win.hide();
      } catch {}
      try {
        win.destroy();
      } catch {}
    }
  }

  async function cancelHarvestBlockManagerDraft(message = '') {
    const kind = harvestBlockManagerKind,
      id = harvestBlockManagerTabId;
    if (kind === 'collector')
      await collectorBlocksService.collectorBlockDraftCancel().catch(() => {});
    else if (id) {
      const tab = tabsService.harvestTsTabs.get(id);
      await blocksService.finishHarvestBlockDraft(tab, true).catch(() => {});
    }
    await closeHarvestBlockManagerWindow();
    if (message)
      hostService.emit(
        kind === 'collector' ? 'collector-block-finished' : 'harvestts-block-finished',
        { cancelled: true, message },
      );
  }

  function defaultHarvestBlockManagerBounds(width = 350, height = 520) {
    const parent =
      hostService.mainWindow && !hostService.mainWindow.isDestroyed()
        ? hostService.mainWindow.getBounds()
        : { x: 100, y: 100, width: 1360, height: 920 };
    return {
      x: Math.round(parent.x + Math.max(12, parent.width - width - 28)),
      y: Math.round(parent.y + 118),
      width,
      height,
    };
  }

  function createHarvestBlockManagerWindow() {
    const existing = liveHarvestBlockManager();
    if (existing) return existing;
    const bounds = defaultHarvestBlockManagerBounds();
    const win = new BrowserWindow({
      ...bounds,
      parent:
        hostService.mainWindow && !hostService.mainWindow.isDestroyed()
          ? hostService.mainWindow
          : undefined,
      modal: false,
      frame: false,
      transparent: false,
      show: false,
      resizable: true,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: false,
      backgroundColor: '#151821',
      webPreferences: {
        partition: 'harvest-block-ui',
        preload: path.join(sourceDir, 'block-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
      },
    });
    harvestBlockManagerWindow = win;
    hostService.bindScreenshotWindow(win);
    win.setMenu(null);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('closed', () => {
      if (harvestBlockManagerWindow === win) harvestBlockManagerWindow = null;
    });
    win.__harvestBlockReady = win.loadFile(path.join(sourceDir, 'block-manager.html'));
    return win;
  }

  async function showHarvestBlockManager(tabId, kind = 'harvestts') {
    harvestBlockManagerKind = kind === 'collector' ? 'collector' : 'harvestts';
    harvestBlockManagerTabId =
      harvestBlockManagerKind === 'harvestts'
        ? String(tabId || tabsService.activeHarvestTsId || '')
        : null;
    harvestBlockManagerCollapsed = false;
    const win = createHarvestBlockManagerWindow();
    try {
      await win.__harvestBlockReady;
    } catch (error) {
      await closeHarvestBlockManagerWindow();
      throw new Error('เปิดหน้าต่าง Block element ไม่สำเร็จ: ' + error.message);
    }
    if (win.isDestroyed()) return;
    const bounds = defaultHarvestBlockManagerBounds();
    try {
      win.setBounds(bounds);
    } catch {}
    try {
      win.setMinimumSize(300, 56);
    } catch {}
    win.show();
    win.focus();
  }

  function setHarvestBlockManagerCollapsed(collapsed) {
    const win = liveHarvestBlockManager();
    if (!win) return false;
    harvestBlockManagerCollapsed = Boolean(collapsed);
    const [width] = win.getSize();
    const height = harvestBlockManagerCollapsed ? 58 : 520;
    try {
      if (harvestBlockManagerCollapsed) {
        win.setSize(Math.max(300, width), height, true);
        win.setResizable(false);
      } else {
        win.setResizable(true);
        win.setSize(Math.max(300, width), height, true);
      }
    } catch {}
    return harvestBlockManagerCollapsed;
  }
  return {
    get harvestBlockManagerWindow() {
      return harvestBlockManagerWindow;
    },
    set harvestBlockManagerWindow(value) {
      harvestBlockManagerWindow = value;
    },
    get harvestBlockManagerTabId() {
      return harvestBlockManagerTabId;
    },
    set harvestBlockManagerTabId(value) {
      harvestBlockManagerTabId = value;
    },
    get harvestBlockManagerKind() {
      return harvestBlockManagerKind;
    },
    liveHarvestBlockManager,
    harvestBlockManagerSender,
    closeHarvestBlockManagerWindow,
    cancelHarvestBlockManagerDraft,
    showHarvestBlockManager,
    setHarvestBlockManagerCollapsed,
  };
}
module.exports = { createBlockManager };
